import logging
from pathlib import Path

from .chunker import make_chunks
from .config import settings
from .embeddings import embedding_client
from .models import Book, Chunk, Section
from .parser import is_hashlike_title, parse_pdf
from .vectorstore import get_vector_store

logger = logging.getLogger(__name__)

COVER_MAX_HEIGHT = 600


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


def ingest_book(book_id: int) -> None:
    from .database import SessionLocal

    db = SessionLocal()
    try:
        book = db.get(Book, book_id)
        if book is None:
            return

        parsed = parse_pdf(
            book.path,
            settings.ingestion.min_heading_ratio,
            fallback_title=Path(book.filename or "").stem,
        )
        sections, chunk_drafts, content_start_index = make_chunks(parsed, book.content_start_page)

        if is_hashlike_title(book.title) or not (book.title or "").strip():
            book.title = parsed.title
        book.num_pages = parsed.num_pages

        cover = extract_cover(book.path)
        if cover:
            book.cover_path = cover

        section_rows: list[Section] = []
        stack: list[Section] = []
        section_by_index: dict[int, Section] = {}
        for i, sec in enumerate(sections):
            if i < content_start_index:
                continue
            end = sections[i + 1].page_start if i + 1 < len(sections) else parsed.num_pages
            if end < sec.page_start:
                end = sec.page_start
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
        for start, batch_embeddings in embedding_client.embed_batches([d.text for d in chunk_drafts]):
            store.add(
                [d.text for d in chunk_drafts][start : start + len(batch_embeddings)],
                batch_embeddings,
                metas[start : start + len(batch_embeddings)],
            )
            done += len(batch_embeddings)
            logger.info("Embedded %d/%d chunks for book %d", done, total, book.id)

        book.status = "ready"
        book.error = None
        db.commit()
        logger.info("Book %d ingested: %d sections, %d chunks", book.id, len(sections), total)

        try:
            from .routers.crossbook import extract_cross_book_links
            result = extract_cross_book_links(db=db)
            logger.info("Cross-book extraction after book %d: %s", book.id, result)
        except Exception:
            logger.debug("Cross-book extraction skipped after book %d", book.id)

        try:
            from .routers.playground import extract_code_blocks
            result = extract_code_blocks(book_id=book.id, force=True, db=db)
            logger.info("Auto code-block extraction for book %d: %s", book.id, result)
        except Exception:
            logger.debug("Auto code-block extraction skipped for book %d", book.id)
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
