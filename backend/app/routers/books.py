import logging
import uuid
from contextlib import contextmanager
from pathlib import Path

from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException, Query, UploadFile
from fastapi.responses import FileResponse
from sqlalchemy import delete, func, or_, select, text, update
from sqlalchemy.orm import Session

from ..config import settings
from ..database import get_db
from ..ingest import ingest_book
from ..models import Book, Chunk, CodeBlock, ConceptEdge, CourseBook, CrossBookLink, Flashcard, KnowledgePoint, Note, Notebook, QuizAttempt, QuizError, ReadingProgress, Section, SectionSummary, UserKnowledgePoint, VocabWord, utcnow_naive
from ..schemas import BookOut, DashboardBook, DashboardOut, QuizAttemptOut, SectionOut
from ..vectorstore import get_vector_store

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/books", tags=["books"])

MASTERED_INTERVAL_DAYS = 3


@contextmanager
def _with_fks_off(db: Session):
    db.execute(text("PRAGMA foreign_keys = OFF"))
    try:
        yield
    finally:
        db.execute(text("PRAGMA foreign_keys = ON"))


def _guard_no_other_indexing(db: Session, book_id: int) -> None:
    other_pending = db.scalar(
        select(Book.id).where(Book.id != book_id, Book.status == "pending").limit(1)
    )
    if other_pending is not None:
        raise HTTPException(
            status_code=409,
            detail="Another book is currently being indexed; try again when it finishes.",
        )


@router.get("/dashboard", response_model=DashboardOut)
def dashboard(db: Session = Depends(get_db)):
    """Library-wide study overview: due cards, mastery and notes per book."""
    now = utcnow_naive()

    card_rows = db.execute(
        select(
            Flashcard.book_id,
            func.count(),
            func.sum(Flashcard.due_at <= now),
            func.sum(Flashcard.interval_days >= MASTERED_INTERVAL_DAYS),
        ).group_by(Flashcard.book_id)
    ).all()
    note_rows = db.execute(select(Note.book_id, func.count()).group_by(Note.book_id)).all()
    section_rows = db.execute(select(Section.book_id, func.count()).group_by(Section.book_id)).all()
    read_rows = db.execute(
        select(Section.book_id, func.count())
        .join(ReadingProgress, ReadingProgress.section_id == Section.id)
        .group_by(Section.book_id)
    ).all()
    attempts_by_book: dict[int, QuizAttempt] = {}
    for attempt in db.scalars(select(QuizAttempt).order_by(QuizAttempt.id.desc())):
        attempts_by_book.setdefault(attempt.book_id, attempt)

    cards_by_book = {bid: (int(total), int(due or 0), int(mastered or 0)) for bid, total, due, mastered in card_rows}
    notes_by_book = dict(note_rows)
    sections_by_book = dict(section_rows)
    read_by_book = dict(read_rows)

    books = []
    total_due = total_cards = total_mastered = 0
    for book in db.scalars(select(Book).order_by(Book.created_at.desc(), Book.id.desc())):
        c_total, c_due, c_mastered = cards_by_book.get(book.id, (0, 0, 0))
        attempt = attempts_by_book.get(book.id)
        books.append(
            DashboardBook(
                id=book.id,
                title=book.title,
                status=book.status,
                num_pages=book.num_pages,
                sections_count=sections_by_book.get(book.id, 0),
                sections_read=read_by_book.get(book.id, 0),
                cards_total=c_total,
                cards_due=c_due,
                cards_mastered=c_mastered,
                notes_count=notes_by_book.get(book.id, 0),
                last_quiz=QuizAttemptOut.model_validate(attempt) if attempt else None,
                last_activity=max((a.created_at for a in [attempt] if a), default=None),
            )
        )
        total_due += c_due
        total_cards += c_total
        total_mastered += c_mastered

    return DashboardOut(cards_total=total_cards, cards_due=total_due, cards_mastered=total_mastered, books=books)


@router.post("", response_model=BookOut)
async def upload_book(
    file: UploadFile,
    background_tasks: BackgroundTasks,
    db: Session = Depends(get_db),
    max_level: int | None = Query(default=None, ge=2, le=3),
    auto_confirm: bool = Query(default=False),
):
    if not file.filename or not (file.filename.lower().endswith(".pdf") or file.filename.lower().endswith(".pptx")):
        raise HTTPException(status_code=400, detail="Only PDF and PPTX files are supported")
    content = await file.read()
    if not content:
        raise HTTPException(status_code=400, detail="Empty file")

    is_pptx = file.filename.lower().endswith(".pptx")
    stem = uuid.uuid4().hex
    if is_pptx:
        # Save original PPTX
        dest_pptx = settings.data.uploads_dir / f"{stem}.pptx"
        dest_pptx.write_bytes(content)
        dest_pdf = settings.data.uploads_dir / f"{stem}.pdf"
        pdf_ready = False
        try:
            from ..pptx_converter import convert_pptx_to_pdf

            pdf_path = convert_pptx_to_pdf(dest_pptx, dest_pptx.parent)
            # ensure dest_pdf matches returned
            if Path(pdf_path) != dest_pdf and Path(pdf_path).exists():
                # move to expected location if needed
                if dest_pdf.exists():
                    dest_pdf.unlink()
                Path(pdf_path).rename(dest_pdf)
            pdf_ready = dest_pdf.exists()
        except RuntimeError as e:
            logger.warning("PPTX to PDF conversion skipped for %s: %s", file.filename, e)
            pdf_ready = False
        except Exception as e:
            logger.warning("PPTX conversion failed for %s: %s", file.filename, e)
            pdf_ready = False

        # Book.path points to PDF for viewer if available, else to PPTX
        viewer_path = str(dest_pdf) if pdf_ready else str(dest_pptx)
        book = Book(
            title=Path(file.filename).stem,
            filename=file.filename,
            path=viewer_path,
            status="pending",
            content_type="slides",
        )
    else:
        dest = settings.data.uploads_dir / f"{stem}.pdf"
        dest.write_bytes(content)
        book = Book(title=Path(file.filename).stem, filename=file.filename, path=str(dest), status="pending", content_type="book")
    # Course defaults: L1+L2 only, auto-confirm (skip first-chapter picker)
    if max_level in (2, 3):
        book.ingestion_max_level = max_level
    if auto_confirm:
        book.content_start_confirmed = True
    db.add(book)
    db.commit()
    db.refresh(book)

    background_tasks.add_task(ingest_book, book.id)
    return book


@router.get("", response_model=list[BookOut])
def list_books(db: Session = Depends(get_db)):
    # Exclude books that belong to any course (course folder) per user request
    course_book_ids = select(CourseBook.book_id)
    return list(db.scalars(select(Book).where(Book.id.not_in(course_book_ids)).order_by(Book.created_at.desc(), Book.id.desc())))


@router.get("/{book_id}", response_model=BookOut)
def get_book(book_id: int, db: Session = Depends(get_db)):
    book = db.get(Book, book_id)
    if book is None:
        raise HTTPException(status_code=404, detail="Book not found")
    return book


@router.get("/{book_id}/sections", response_model=list[SectionOut])
def get_sections(book_id: int, db: Session = Depends(get_db)):
    if db.get(Book, book_id) is None:
        raise HTTPException(status_code=404, detail="Book not found")
    return list(db.scalars(select(Section).where(Section.book_id == book_id).order_by(Section.ord)))


@router.post("/{book_id}/reindex")
def reindex_book(book_id: int, background_tasks: BackgroundTasks, db: Session = Depends(get_db)):
    book = db.get(Book, book_id)
    if book is None:
        raise HTTPException(status_code=404, detail="Book not found")
    if book.status == "pending":
        raise HTTPException(status_code=409, detail="Book is already being indexed")
    _guard_no_other_indexing(db, book_id)

    # --- Stash user data that should be preserved and remapped after ingest ---
    try:
        from ..ingest import stash_pending_remap

        old_sections = list(db.scalars(select(Section).where(Section.book_id == book_id).order_by(Section.ord)))
        sec_by_id = {s.id: s for s in old_sections}
        # ReadingProgress via Section.book_id
        rp_rows = []
        if old_sections:
            old_ids = [s.id for s in old_sections]
            # ReadingProgress has no book_id, join via Section
            rp_rows = list(
                db.scalars(
                    select(ReadingProgress).where(ReadingProgress.section_id.in_(old_ids))
                )
            )
        vocab_rows = list(
            db.scalars(select(VocabWord).where(VocabWord.book_id == book_id, VocabWord.section_id.is_not(None)))
        )
        note_rows = list(
            db.scalars(select(Note).where(Note.book_id == book_id, Note.section_id.is_not(None)))
        )
        notebook_rows = list(
            db.scalars(select(Notebook).where(Notebook.book_id == book_id, Notebook.section_id.is_not(None)))
        )

        def _pack(rows, get_sid):
            out = []
            for r in rows:
                sid = get_sid(r)
                sec = sec_by_id.get(sid)
                parent = sec_by_id.get(sec.parent_id) if sec and sec.parent_id else None
                out.append(
                    {
                        "id": r.id,
                        "old_section_id": sid,
                        "old_page": sec.page_start if sec else None,
                        "old_title": sec.title if sec else None,
                        "old_level": sec.level if sec else None,
                        "old_parent_id": sec.parent_id if sec else None,
                        "old_parent_page": parent.page_start if parent else None,
                        "old_parent_title": parent.title if parent else None,
                    }
                )
            return out

        stash_pending_remap(
            book_id,
            {
                "reading_progress": _pack(rp_rows, lambda r: r.section_id),
                "vocab": _pack(vocab_rows, lambda r: r.section_id),
                "notes": _pack(note_rows, lambda r: r.section_id),
                "notebooks": _pack(notebook_rows, lambda r: r.section_id),
            },
        )
    except Exception as e:
        logger.warning("Failed to stash remap data for book %d: %s", book_id, e)

    with _with_fks_off(db):
        # Clear FK to Sections before deleting them to avoid orphan FK violation
        # when FKs are re-enabled. Otherwise next UPDATE to Book fails with
        # FOREIGN KEY constraint while the book is pending.
        book.content_start_section_id = None
        db.flush()
        get_vector_store().delete_book(book_id)
        get_vector_store().delete_book_code(book_id)
        db.execute(delete(Flashcard).where(Flashcard.book_id == book_id))
        db.execute(delete(QuizAttempt).where(QuizAttempt.book_id == book_id))
        db.execute(delete(QuizError).where(QuizError.book_id == book_id))
        db.execute(delete(SectionSummary).where(SectionSummary.book_id == book_id))
        db.execute(delete(Chunk).where(Chunk.book_id == book_id))
        db.execute(delete(Section).where(Section.book_id == book_id))
        db.execute(delete(CodeBlock).where(CodeBlock.book_id == book_id))
        kp_ids = select(KnowledgePoint.id).where(KnowledgePoint.book_id == book_id)
        db.execute(delete(UserKnowledgePoint).where(UserKnowledgePoint.knowledge_point_id.in_(kp_ids)))
        db.execute(delete(ConceptEdge).where(ConceptEdge.source_point_id.in_(kp_ids)))
        db.execute(delete(CrossBookLink).where(or_(CrossBookLink.source_kp_id.in_(kp_ids), CrossBookLink.target_kp_id.in_(kp_ids))))
        db.execute(delete(KnowledgePoint).where(KnowledgePoint.book_id == book_id))
        # Do NOT nullify Notes.section_id – they will be remapped in ingest
        # (orphaned notes that cannot be remapped will be nulled there).
        book.status = "pending"
        book.error = None
        db.commit()

    background_tasks.add_task(ingest_book, book_id)
    return {"ok": True}


@router.delete("/{book_id}")
def delete_book(book_id: int, db: Session = Depends(get_db)):
    book = db.get(Book, book_id)
    if book is None:
        raise HTTPException(status_code=404, detail="Book not found")
    with _with_fks_off(db):
        get_vector_store().delete_book(book_id)
        get_vector_store().delete_book_code(book_id)
        db.execute(delete(Flashcard).where(Flashcard.book_id == book_id))
        db.execute(delete(QuizAttempt).where(QuizAttempt.book_id == book_id))
        db.execute(delete(SectionSummary).where(SectionSummary.book_id == book_id))
        db.execute(delete(Note).where(Note.book_id == book_id))
        db.execute(delete(Notebook).where(Notebook.book_id == book_id))
        db.execute(delete(CodeBlock).where(CodeBlock.book_id == book_id))
        kp_ids = select(KnowledgePoint.id).where(KnowledgePoint.book_id == book_id)
        db.execute(delete(UserKnowledgePoint).where(UserKnowledgePoint.knowledge_point_id.in_(kp_ids)))
        db.execute(delete(ConceptEdge).where(ConceptEdge.source_point_id.in_(kp_ids)))
        db.execute(delete(CrossBookLink).where(or_(CrossBookLink.source_kp_id.in_(kp_ids), CrossBookLink.target_kp_id.in_(kp_ids))))
        db.execute(delete(KnowledgePoint).where(KnowledgePoint.book_id == book_id))
        path = Path(book.path)
        # For slides, path may be PDF; also try to remove sibling PPTX + cover
        sibling_pptx = path.with_suffix(".pptx") if path.suffix.lower() == ".pdf" else None
        sibling_pdf = path.with_suffix(".pdf") if path.suffix.lower() == ".pptx" else None
        cover_p = Path(book.cover_path) if book.cover_path else None
        db.delete(book)
        db.commit()
    try:
        path.unlink(missing_ok=True)
        if sibling_pptx and sibling_pptx.exists():
            sibling_pptx.unlink(missing_ok=True)
        if sibling_pdf and sibling_pdf.exists():
            sibling_pdf.unlink(missing_ok=True)
        if cover_p and cover_p.exists():
            cover_p.unlink(missing_ok=True)
    except OSError:
        logger.warning("Could not delete file %s", path)
    return {"ok": True}


@router.get("/{book_id}/content-start")
def get_content_start(book_id: int, db: Session = Depends(get_db)):
    book = db.get(Book, book_id)
    if book is None:
        raise HTTPException(status_code=404, detail="Book not found")
    sections = list(db.scalars(select(Section).where(Section.book_id == book_id).order_by(Section.ord)))
    first_title = None
    if book.content_start_section_id is not None:
        s = db.get(Section, book.content_start_section_id)
        if s is not None:
            first_title = s.title
    # Per-book depth: 2 = chapters+sections, 3 = +subsections
    ingestion_max_level = getattr(book, "ingestion_max_level", 2) or 2
    # Available depth: if L3 exists in current sections, or if book could have L3 (offer as optional)
    # We offer L3 as optional for any book that has at least L2, so user can toggle.
    has_l2 = any(s.level >= 2 for s in sections)
    available_max_level = 3 if (has_l2 or ingestion_max_level == 3 or any(s.level == 3 for s in sections)) else 2
    # If no sections yet (pending), keep available as current
    if not sections:
        available_max_level = ingestion_max_level
    return {
        "content_start_section_id": book.content_start_section_id,
        "content_start_page": book.content_start_page,
        "content_start_confirmed": bool(book.content_start_confirmed),
        "needs_selection": not bool(book.content_start_confirmed) and book.status == "ready",
        "first_section_title": first_title,
        "ingestion_max_level": ingestion_max_level,
        "available_max_level": available_max_level,
        "sections": [
            {"id": s.id, "title": s.title, "level": s.level, "page_start": s.page_start, "page_end": s.page_end}
            for s in sections
        ],
    }


@router.post("/{book_id}/content-start/confirm")
def confirm_content_start(book_id: int, db: Session = Depends(get_db)):
    book = db.get(Book, book_id)
    if book is None:
        raise HTTPException(status_code=404, detail="Book not found")
    if book.status == "pending":
        raise HTTPException(status_code=409, detail="Book is still indexing")
    if not book.content_start_confirmed:
        book.content_start_confirmed = True
        # If auto-detected and user confirms, pin the detected page so it survives reindex.
        if book.content_start_page is None and book.content_start_section_id is not None:
            sec = db.get(Section, book.content_start_section_id)
            if sec is not None:
                book.content_start_page = sec.page_start
        db.commit()
    return {"ok": True}


@router.post("/{book_id}/content-start")
def set_content_start(book_id: int, payload: dict, background_tasks: BackgroundTasks, db: Session = Depends(get_db)):
    book = db.get(Book, book_id)
    if book is None:
        raise HTTPException(status_code=404, detail="Book not found")
    if book.status == "pending":
        raise HTTPException(status_code=409, detail="Book is already being indexed")
    _guard_no_other_indexing(db, book_id)
    page = payload.get("page")
    if page is not None and not isinstance(page, int):
        raise HTTPException(status_code=400, detail="page must be an integer or null")
    # Optional depth toggle: 2 = chapters+sections, 3 = +subsections
    requested_max = payload.get("max_level")
    max_level_changed = False
    if requested_max is not None:
        if not isinstance(requested_max, int) or requested_max not in (2, 3):
            raise HTTPException(status_code=400, detail="max_level must be 2 or 3")
        current_max = getattr(book, "ingestion_max_level", 2) or 2
        if requested_max != current_max:
            book.ingestion_max_level = requested_max
            max_level_changed = True

    # No-op confirm: user confirms current first chapter without changing page.
    # Detect current effective first page (from persisted first section).
    current_first_page = None
    if book.content_start_section_id is not None:
        cur = db.get(Section, book.content_start_section_id)
        if cur is not None:
            current_first_page = cur.page_start
    # If max_level changed, we must reindex even if page is same – skip no-op returns
    if not max_level_changed:
        # If payload matches current effective state, just mark confirmed without reindex.
        # Cases: both None (auto), or same page number, or payload is None and we are
        # still on auto-detected first section.
        if page == book.content_start_page and bool(book.content_start_confirmed):
            return {"ok": True, "reindexed": False}
        if page is not None and current_first_page is not None and page == current_first_page and book.content_start_page == page:
            book.content_start_confirmed = True
            db.commit()
            return {"ok": True, "reindexed": False}
        if page is None and book.content_start_page is None:
            # Auto confirm without reindex if already on auto and user chooses Auto.
            # But if never confirmed, mark confirmed without reindex.
            if not book.content_start_confirmed:
                book.content_start_confirmed = True
                db.commit()
                return {"ok": True, "reindexed": False}
            # Already confirmed Auto -> no-op
            return {"ok": True, "reindexed": False}
        if page is not None and current_first_page is not None and page == current_first_page and not book.content_start_confirmed:
            # User picks the auto-detected chapter explicitly -> confirm without reindex.
            book.content_start_confirmed = True
            # Persist explicit page so future reindexes stay pinned.
            book.content_start_page = page
            db.commit()
            return {"ok": True, "reindexed": False}

    # Either page changed or max_level changed – need reindex
    book.content_start_page = page
    # Mark as confirmed before reindex so ingest preserves the flag (see ingest.py)
    book.content_start_confirmed = True
    # ingestion_max_level already set above if changed; ensure it is persisted
    db.commit()
    reindex_book(book_id, background_tasks, db)
    return {"ok": True, "reindexed": True}


@router.get("/{book_id}/pdf")
def serve_pdf(book_id: int, db: Session = Depends(get_db)):
    book = db.get(Book, book_id)
    if book is None:
        raise HTTPException(status_code=404, detail="Book not found")
    path = Path(book.path)
    # For slides, path may be PPTX if LibreOffice was unavailable; try sibling PDF
    if getattr(book, "content_type", "book") == "slides":
        if path.suffix.lower() == ".pptx":
            pdf_sibling = path.with_suffix(".pdf")
            if pdf_sibling.exists():
                path = pdf_sibling
            else:
                raise HTTPException(status_code=404, detail="Slide preview PDF not available. Install LibreOffice and re-upload as PDF, or view slides as text.")
        if not path.exists():
            # try PPTX sibling's PDF
            alt = path.with_suffix(".pdf")
            if alt.exists():
                path = alt
    if not path.exists():
        raise HTTPException(status_code=404, detail="PDF file not found on disk")
    return FileResponse(
        path=str(path),
        media_type="application/pdf",
        filename=book.filename if book.filename.lower().endswith(".pdf") else Path(book.filename).stem + ".pdf",
    )


@router.get("/{book_id}/cover")
def serve_cover(book_id: int, db: Session = Depends(get_db)):
    book = db.get(Book, book_id)
    if book is None:
        raise HTTPException(status_code=404, detail="Book not found")

    cover_path = Path(book.cover_path) if book.cover_path else None
    if cover_path is None or not cover_path.exists():
        # Resolve a PDF path for cover (slides store PPTX+sibling PDF)
        src_path = Path(book.path) if book.path else None
        if src_path and getattr(book, "content_type", "book") == "slides" and src_path.suffix.lower() == ".pptx":
            pdf_sib = src_path.with_suffix(".pdf")
            if pdf_sib.exists():
                src_path = pdf_sib
        if src_path and src_path.exists() and src_path.suffix.lower() == ".pdf":
            from ..ingest import extract_cover

            cover = extract_cover(str(src_path))
            if cover:
                book.cover_path = cover
                db.commit()
                cover_path = Path(cover)
            else:
                raise HTTPException(status_code=404, detail="No cover available")
        else:
            raise HTTPException(status_code=404, detail="No cover available")

    return FileResponse(path=str(cover_path), media_type="image/png")
