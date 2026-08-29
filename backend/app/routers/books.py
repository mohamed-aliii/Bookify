import logging
import uuid
from contextlib import contextmanager
from pathlib import Path

from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException, UploadFile
from fastapi.responses import FileResponse
from sqlalchemy import delete, func, or_, select, text, update
from sqlalchemy.orm import Session

from ..config import settings
from ..database import get_db
from ..ingest import ingest_book
from ..models import Book, Chunk, CodeBlock, ConceptEdge, CrossBookLink, Flashcard, KnowledgePoint, Note, Notebook, QuizAttempt, ReadingProgress, Section, SectionSummary, UserKnowledgePoint, utcnow_naive
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
async def upload_book(file: UploadFile, background_tasks: BackgroundTasks, db: Session = Depends(get_db)):
    if not file.filename or not file.filename.lower().endswith(".pdf"):
        raise HTTPException(status_code=400, detail="Only PDF files are supported")
    content = await file.read()
    if not content:
        raise HTTPException(status_code=400, detail="Empty file")

    dest = settings.data.uploads_dir / f"{uuid.uuid4().hex}.pdf"
    dest.write_bytes(content)

    book = Book(title=Path(file.filename).stem, filename=file.filename, path=str(dest), status="pending")
    db.add(book)
    db.commit()
    db.refresh(book)

    background_tasks.add_task(ingest_book, book.id)
    return book


@router.get("", response_model=list[BookOut])
def list_books(db: Session = Depends(get_db)):
    return list(db.scalars(select(Book).order_by(Book.created_at.desc(), Book.id.desc())))


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

    with _with_fks_off(db):
        get_vector_store().delete_book(book_id)
        get_vector_store().delete_book_code(book_id)
        db.execute(delete(Flashcard).where(Flashcard.book_id == book_id))
        db.execute(delete(QuizAttempt).where(QuizAttempt.book_id == book_id))
        db.execute(delete(SectionSummary).where(SectionSummary.book_id == book_id))
        db.execute(delete(Chunk).where(Chunk.book_id == book_id))
        db.execute(delete(Section).where(Section.book_id == book_id))
        db.execute(delete(CodeBlock).where(CodeBlock.book_id == book_id))
        kp_ids = select(KnowledgePoint.id).where(KnowledgePoint.book_id == book_id)
        db.execute(delete(UserKnowledgePoint).where(UserKnowledgePoint.knowledge_point_id.in_(kp_ids)))
        db.execute(delete(ConceptEdge).where(ConceptEdge.source_point_id.in_(kp_ids)))
        db.execute(delete(CrossBookLink).where(or_(CrossBookLink.source_kp_id.in_(kp_ids), CrossBookLink.target_kp_id.in_(kp_ids))))
        db.execute(delete(KnowledgePoint).where(KnowledgePoint.book_id == book_id))
        db.execute(update(Note).where(Note.book_id == book_id).values(section_id=None))
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
        db.delete(book)
        db.commit()
    try:
        path.unlink(missing_ok=True)
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
    return {
        "content_start_section_id": book.content_start_section_id,
        "content_start_page": book.content_start_page,
        "first_section_title": first_title,
        "sections": [
            {"id": s.id, "title": s.title, "level": s.level, "page_start": s.page_start}
            for s in sections
        ],
    }


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
    book.content_start_page = page
    db.commit()
    reindex_book(book_id, background_tasks, db)
    return {"ok": True}


@router.get("/{book_id}/pdf")
def serve_pdf(book_id: int, db: Session = Depends(get_db)):
    book = db.get(Book, book_id)
    if book is None:
        raise HTTPException(status_code=404, detail="Book not found")
    path = Path(book.path)
    if not path.exists():
        raise HTTPException(status_code=404, detail="PDF file not found on disk")
    return FileResponse(
        path=str(path),
        media_type="application/pdf",
        filename=book.filename,
    )


@router.get("/{book_id}/cover")
def serve_cover(book_id: int, db: Session = Depends(get_db)):
    book = db.get(Book, book_id)
    if book is None:
        raise HTTPException(status_code=404, detail="Book not found")

    cover_path = Path(book.cover_path) if book.cover_path else None
    if cover_path is None or not cover_path.exists():
        if book.path and Path(book.path).exists():
            from ..ingest import extract_cover

            cover = extract_cover(book.path)
            if cover:
                book.cover_path = cover
                db.commit()
                cover_path = Path(cover)
            else:
                raise HTTPException(status_code=404, detail="No cover available")
        else:
            raise HTTPException(status_code=404, detail="No cover available")

    return FileResponse(path=str(cover_path), media_type="image/png")
