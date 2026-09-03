import logging
from pathlib import Path

from sqlalchemy import select

from .chunker import ChunkDraft, SectionDraft, make_chunks
from .config import settings
from .embeddings import embedding_client
from .models import Book, Chunk, Section
from .parser import is_hashlike_title, parse_pdf
from .vectorstore import get_vector_store

logger = logging.getLogger(__name__)

COVER_MAX_HEIGHT = 600

# Pending remap stash for reindex with preserved user data (ReadingProgress etc).
# Keyed by book_id, consumed by ingest_book after new Sections are created.
# Stored in-memory; safe because reindex and ingest run in same process.
_pending_remaps: dict[int, dict] = {}


def stash_pending_remap(book_id: int, payload: dict) -> None:
    _pending_remaps[book_id] = payload


def _pop_pending_remap(book_id: int) -> dict | None:
    return _pending_remaps.pop(book_id, None)


def _normalize_for_remap(title: str) -> str:
    import re

    return re.sub(r"[^a-z0-9]+", " ", title.lower()).strip()


def extract_cover(book_path: str, dest_dir: Path | None = None) -> str | None:
    """Render the first page of a PDF as a PNG thumbnail (max-height anchored)."""
    import pymupdf

    dest_dir = dest_dir or (settings.data.uploads_dir / "covers")
    try:
        doc = pymupdf.open(book_path)
        try:
            page = doc[0]
            rect = page.rect
            if rect.height <= 0:
                return None
            scale = min(COVER_MAX_HEIGHT / rect.height, 3.0)
            if rect.width * scale < 10:
                return None
            pix = page.get_pixmap(matrix=pymupdf.Matrix(scale, scale))
            dest_dir.mkdir(parents=True, exist_ok=True)
            out = dest_dir / f"{Path(book_path).stem}.png"
            if not hasattr(pix, "tobytes"):
                pix.save(str(out))
            else:
                out.write_bytes(pix.tobytes())
            return str(out)
        finally:
            doc.close()
    except Exception:
        logger.debug("Could not extract cover from %s", book_path)
        return None


def _slides_to_chunks(slides, chunk_chars: int, chunk_overlap: int) -> tuple[list[SectionDraft], list[ChunkDraft], int]:
    """Build slide-aware sections (one per slide) and chunk drafts that group slides."""
    sections: list[SectionDraft] = []
    for s in slides:
        title = (s.title or f"Slide {s.slide_number}").strip()
        if len(title) > 200:
            title = title[:200]
        sections.append(SectionDraft(title=title, level=1, page_start=s.slide_number))

    # Group slides into chunks of ~chunk_chars
    chunk_drafts: list[ChunkDraft] = []
    current_texts: list[str] = []
    current_pages: list[int] = []
    cur_len = 0
    start_idx = 0
    ord_counter = 0

    def _flush():
        nonlocal current_texts, current_pages, cur_len, start_idx, ord_counter
        if not current_texts:
            return
        text = "\n\n".join(current_texts).strip()
        if text:
            chunk_drafts.append(
                ChunkDraft(
                    text=text,
                    section_index=start_idx,
                    section_title=sections[start_idx].title,
                    page_start=min(current_pages),
                    page_end=max(current_pages),
                    ord=ord_counter,
                    is_code=False,
                )
            )
            ord_counter += 1
        current_texts, current_pages, cur_len = [], [], 0

    tail = ""
    for idx, s in enumerate(slides):
        raw = (s.raw_text or "").strip()
        if not raw:
            continue
        # If single slide text is longer than chunk_chars, split it
        if len(raw) > chunk_chars:
            # flush current before splitting long slide
            if current_texts:
                _flush()
                start_idx = idx
                tail = ""
            # split long slide text
            from .chunker import _split_long

            parts = _split_long(raw, chunk_chars, chunk_overlap)
            for piece in parts:
                chunk_drafts.append(
                    ChunkDraft(
                        text=piece,
                        section_index=idx,
                        section_title=sections[idx].title,
                        page_start=s.slide_number,
                        page_end=s.slide_number,
                        ord=ord_counter,
                        is_code=False,
                    )
                )
                ord_counter += 1
            start_idx = idx + 1 if idx + 1 < len(slides) else idx
            continue

        if cur_len and cur_len + len(raw) + 2 > chunk_chars:
            _flush()
            start_idx = idx
            if chunk_overlap > 0 and tail:
                head = tail[-chunk_overlap:]
                current_texts.append(head)
                cur_len = len(head)

        if not current_texts:
            start_idx = idx
        current_texts.append(raw)
        current_pages.append(s.slide_number)
        cur_len += len(raw) + 2
        tail = "\n\n".join(current_texts)

    _flush()
    return sections, chunk_drafts, 0


def ingest_book(book_id: int) -> None:
    from .database import SessionLocal

    db = SessionLocal()
    try:
        book = db.get(Book, book_id)
        if book is None:
            return

        is_slides = getattr(book, "content_type", "book") == "slides"
        if is_slides:
            # Resolve original PPTX path (sibling of PDF if needed)
            pptx_path = None
            p = Path(book.path)
            if p.suffix.lower() == ".pptx" and p.exists():
                pptx_path = p
            else:
                cand = p.with_suffix(".pptx")
                if cand.exists():
                    pptx_path = cand
                elif p.suffix.lower() == ".pptx":
                    pptx_path = p
            if pptx_path and pptx_path.exists():
                try:
                    from .pptx_parser import parse_pptx

                    parsed_slides = parse_pptx(pptx_path, fallback_title=Path(book.filename or "").stem)
                    sections, chunk_drafts, content_start_index = _slides_to_chunks(
                        parsed_slides.slides, settings.ingestion.chunk_chars, settings.ingestion.chunk_overlap
                    )
                    # Update book metadata from slides
                    if is_hashlike_title(book.title) or not (book.title or "").strip():
                        book.title = parsed_slides.title
                    book.num_pages = parsed_slides.num_pages
                except Exception as e:
                    logger.warning("PPTX parse failed for book %d (%s), falling back to PDF: %s", book_id, pptx_path, e)
                    parsed = parse_pdf(
                        book.path,
                        settings.ingestion.min_heading_ratio,
                        fallback_title=Path(book.filename or "").stem,
                    )
                    max_level = getattr(book, "ingestion_max_level", None) or settings.ingestion.max_toc_level
                    try:
                        max_level = int(max_level)
                    except Exception:
                        max_level = settings.ingestion.max_toc_level
                    max_level = max(1, min(3, max_level))
                    sections, chunk_drafts, content_start_index = make_chunks(parsed, book.content_start_page, max_level=max_level)
                    if is_hashlike_title(book.title) or not (book.title or "").strip():
                        book.title = parsed.title
                    book.num_pages = parsed.num_pages
            else:
                # No PPTX found — treat as PDF (converted PDF should exist)
                # Try PDF parse directly
                parsed = parse_pdf(
                    book.path,
                    settings.ingestion.min_heading_ratio,
                    fallback_title=Path(book.filename or "").stem,
                )
                max_level = getattr(book, "ingestion_max_level", None) or settings.ingestion.max_toc_level
                try:
                    max_level = int(max_level)
                except Exception:
                    max_level = settings.ingestion.max_toc_level
                max_level = max(1, min(3, max_level))
                sections, chunk_drafts, content_start_index = make_chunks(parsed, book.content_start_page, max_level=max_level)
                if is_hashlike_title(book.title) or not (book.title or "").strip():
                    book.title = parsed.title
                book.num_pages = parsed.num_pages
        else:
            parsed = parse_pdf(
                book.path,
                settings.ingestion.min_heading_ratio,
                fallback_title=Path(book.filename or "").stem,
            )
            max_level = getattr(book, "ingestion_max_level", None) or settings.ingestion.max_toc_level
            try:
                max_level = int(max_level)
            except Exception:
                max_level = settings.ingestion.max_toc_level
            max_level = max(1, min(3, max_level))
            sections, chunk_drafts, content_start_index = make_chunks(parsed, book.content_start_page, max_level=max_level)
            if is_hashlike_title(book.title) or not (book.title or "").strip():
                book.title = parsed.title
            book.num_pages = parsed.num_pages

        # For slides, skip front-matter handling – every slide is content
        if is_slides:
            # If content_start_page was set for books, ignore for slides
            content_start_index = 0
            # Auto-confirm slides so they don't block with first-chapter picker
            if not book.content_start_confirmed:
                book.content_start_confirmed = True
            # Resolve PDF for cover (slides have sibling PDF if conversion succeeded)
            cover_src = book.path
            if Path(cover_src).suffix.lower() == ".pptx":
                cand = Path(cover_src).with_suffix(".pdf")
                if cand.exists():
                    cover_src = str(cand)
                else:
                    cover_src = None
            cover = extract_cover(cover_src) if cover_src else None
        else:
            cover_src = book.path
            cover = extract_cover(cover_src) if cover_src else None
        if cover:
            book.cover_path = cover

        section_rows: list[Section] = []
        stack: list[Section] = []
        section_by_index: dict[int, Section] = {}
        for i, sec in enumerate(sections):
            if i < content_start_index:
                continue
            if is_slides:
                # Each slide is a single page
                end = sec.page_start
            else:
                end = sections[i + 1].page_start if i + 1 < len(sections) else book.num_pages
                if end < sec.page_start:
                    end = sec.page_start
                else:
                    # book sections use exclusive end (next start), convert to inclusive for page_end
                    if i + 1 < len(sections):
                        end = end - 1 if end > sec.page_start else end
            while stack and stack[-1].level >= sec.level:
                stack.pop()
            parent_id = stack[-1].id if stack else None
            row = Section(
                book_id=book.id,
                parent_id=parent_id,
                title=sec.title,
                level=sec.level,
                page_start=sec.page_start,
                page_end=end,
                ord=len(section_rows),
            )
            db.add(row)
            db.flush()
            section_rows.append(row)
            section_by_index[i] = row
            stack.append(row)

        if content_start_index < len(sections) and content_start_index in section_by_index:
            book.content_start_section_id = section_by_index[content_start_index].id

        # --- Remap preserved user data (ReadingProgress, Notes, Vocab, Notebooks) ---
        pending = _pop_pending_remap(book.id)
        if pending:
            # Build lookup for new sections: page -> id, normalized title -> id
            new_by_page: dict[int, int] = {}
            new_by_title: dict[str, int] = {}
            for r in section_rows:
                if r.page_start not in new_by_page:
                    new_by_page[r.page_start] = r.id
                norm = _normalize_for_remap(r.title)
                if norm not in new_by_title:
                    new_by_title[norm] = r.id
            # Helper for L3 -> L2 parent fallback via page range
            def _find_parent_l2(old_page: int | None) -> int | None:
                if old_page is None:
                    return None
                for r in section_rows:
                    if r.level == 2 and r.page_start <= old_page <= r.page_end:
                        return r.id
                # Fallback: closest L2 before page
                best = None
                best_dist = None
                for r in section_rows:
                    if r.level != 2:
                        continue
                    dist = old_page - r.page_start if old_page >= r.page_start else None
                    if dist is not None and dist >= 0 and (best_dist is None or dist < best_dist):
                        best = r.id
                        best_dist = dist
                return best

            # Also include page->title map for debugging
            def _find_new_id(old_page: int | None, old_title: str | None, old_level: int | None = None, old_parent_page: int | None = None, old_parent_title: str | None = None) -> int | None:
                if old_page is not None and old_page in new_by_page:
                    return new_by_page[old_page]
                if old_title:
                    n = _normalize_for_remap(old_title)
                    if n in new_by_title:
                        return new_by_title[n]
                    # contains fallback: if old title is substring of new or vice versa
                    for nt, nid in new_by_title.items():
                        if n and (n in nt or nt in n):
                            return nid
                # L3 -> L2 fallback: if old was a subsection and new max is 2, map to parent
                if old_level == 3:
                    # Try parent page/title first
                    if old_parent_page is not None and old_parent_page in new_by_page:
                        return new_by_page[old_parent_page]
                    if old_parent_title:
                        pn = _normalize_for_remap(old_parent_title)
                        if pn in new_by_title:
                            return new_by_title[pn]
                    # Fallback to containing L2 by page range
                    parent_via_range = _find_parent_l2(old_page)
                    if parent_via_range is not None:
                        return parent_via_range
                return None

            from sqlalchemy import select as _select
            from .models import Note as _Note, Notebook as _Notebook, ReadingProgress as _RP, VocabWord as _VW

            # ReadingProgress: section_id -> new_id or delete if front-matter removed
            for item in pending.get("reading_progress", []):
                old_id = item["id"]
                old_section_id = item["old_section_id"]
                # Current row still points to old_section_id (orphaned). Fetch it.
                rp = db.get(_RP, old_id)
                if rp is None:
                    continue
                # If its section_id was already changed (shouldn't happen), skip
                if rp.section_id != old_section_id:
                    continue
                new_id = _find_new_id(item.get("old_page"), item.get("old_title"), item.get("old_level"), item.get("old_parent_page"), item.get("old_parent_title"))
                if new_id is not None:
                    # Handle unique constraint: if another progress already points to new_id, merge/delete duplicate
                    existing = db.scalar(_select(_RP).where(_RP.section_id == new_id))
                    if existing is not None and existing.id != rp.id:
                        # Keep the existing one, delete the duplicate (preserve time_spent as max)
                        try:
                            # Merge time_spent if useful
                            existing.time_spent_seconds = max(existing.time_spent_seconds, rp.time_spent_seconds)
                            db.delete(rp)
                            db.flush()
                        except Exception:
                            db.delete(rp)
                            db.flush()
                    else:
                        rp.section_id = new_id
                        db.flush()
                else:
                    # Front-matter section removed – delete progress (no longer relevant)
                    db.delete(rp)
                    db.flush()

            # VocabWord: remap or unlink (set null)
            for item in pending.get("vocab", []):
                vw = db.get(_VW, item["id"])
                if vw is None or vw.section_id != item["old_section_id"]:
                    continue
                new_id = _find_new_id(item.get("old_page"), item.get("old_title"), item.get("old_level"), item.get("old_parent_page"), item.get("old_parent_title"))
                vw.section_id = new_id  # None if not found → unlink but preserve vocab
                db.flush()

            # Notes: remap or unlink
            for item in pending.get("notes", []):
                note = db.get(_Note, item["id"])
                if note is None or note.section_id != item["old_section_id"]:
                    continue
                new_id = _find_new_id(item.get("old_page"), item.get("old_title"), item.get("old_level"), item.get("old_parent_page"), item.get("old_parent_title"))
                note.section_id = new_id
                db.flush()

            # Notebooks (section-specific): remap or unlink
            for item in pending.get("notebooks", []):
                nb = db.get(_Notebook, item["id"])
                if nb is None or nb.section_id != item["old_section_id"]:
                    continue
                new_id = _find_new_id(item.get("old_page"), item.get("old_title"), item.get("old_level"), item.get("old_parent_page"), item.get("old_parent_title"))
                nb.section_id = new_id
                db.flush()

            db.flush()
            logger.info("Remapped preserved data for book %d: %d RP, %d vocab, %d notes, %d notebooks", book.id, len(pending.get("reading_progress", [])), len(pending.get("vocab", [])), len(pending.get("notes", [])), len(pending.get("notebooks", [])))

        chunk_rows = [
            Chunk(
                book_id=book.id,
                section_id=section_by_index[draft.section_index].id,
                section_title=draft.section_title,
                text=draft.text,
                page_start=draft.page_start,
                page_end=draft.page_end,
                ord=draft.ord,
                is_code=draft.is_code,
            )
            for draft in chunk_drafts
        ]
        db.add_all(chunk_rows)
        db.commit()

        metas = [
            {
                "book_id": book.id,
                "section_id": section_by_index[draft.section_index].id,
                "section_title": draft.section_title[:300],
                "page_start": draft.page_start,
                "page_end": draft.page_end,
            }
            for draft in chunk_drafts
        ]
        store = get_vector_store()
        total = len(chunk_drafts)
        done = 0
        texts = [d.text for d in chunk_drafts]
        for start, batch_embeddings in embedding_client.embed_batches(texts):
            end = start + len(batch_embeddings)
            store.add(
                texts[start:end],
                batch_embeddings,
                metas[start:end],
            )
            done += len(batch_embeddings)
            logger.info("Embedded %d/%d chunks for book %d", done, total, book.id)

        book.status = "ready"
        book.error = None
        # Preserve manual confirmation if this ingest was triggered by an explicit
        # user choice (reindex after picking a chapter). Initial uploads have
        # content_start_confirmed=False, so they stay unconfirmed and the UI
        # will force a prompt. If the flag was already True (user just set
        # content_start_page + confirmed before reindex), keep it True.
        if not book.content_start_confirmed:
            # If content_start_page is still None this is the auto-detected path
            # from an upload — require explicit user confirmation.
            # If it is not None but flag is still False (legacy row), keep False
            # so first-time uploads still prompt.
            pass  # stay False, will need confirmation
        db.commit()
        logger.info("Book %d ingested: %d sections, %d chunks (confirmed=%s)", book.id, len(sections), total, book.content_start_confirmed)

        # Cross-book extraction (skip for course slide batches to keep ingestion blazing fast)
        from .models import CourseBook as _CourseBook
        is_course_book = db.scalar(select(_CourseBook.id).where(_CourseBook.book_id == book.id).limit(1)) is not None
        if not is_course_book:
            try:
                from .routers.crossbook import extract_cross_book_links
                result = extract_cross_book_links(db=db)
                logger.info("Cross-book extraction after book %d: %s", book.id, result)
            except Exception:
                logger.debug("Cross-book extraction skipped after book %d", book.id)

        # Lazy code extraction: skip auto extraction on ingest to save free-tier quota.
        # Code blocks will be extracted on demand when user opens the Code tab.
        logger.info("Skipping auto code-block extraction for book %d (lazy mode)", book.id)
    except Exception as exc:
        db.rollback()
        logger.exception("Ingestion failed for book %d", book_id)
        book = db.get(Book, book_id)
        if book is not None:
            book.status = "failed"
            book.error = str(exc)[:1000]
            db.commit()
    finally:
        db.close()
