import os
from pathlib import Path

from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from ..config import settings
from ..database import get_db
from ..models import Book, Chunk, Course, CourseBook, Flashcard, QuizAttempt, ReadingProgress, Section

router = APIRouter(prefix="/courses", tags=["courses"])

UPLOAD_DIR = settings.data.uploads_dir


def _apply_course_defaults(book: Book) -> None:
    """Apply course defaults: L1+L2 only, auto-confirm (no popup)."""
    if getattr(book, "ingestion_max_level", 3) != 2:
        book.ingestion_max_level = 2
    if not book.content_start_confirmed:
        book.content_start_confirmed = True


def _course_out(course: Course, db: Session) -> dict:
    book_rows = db.scalars(
        select(CourseBook).where(CourseBook.course_id == course.id).order_by(CourseBook.ord)
    ).all()
    books = []
    for cb in book_rows:
        b = db.get(Book, cb.book_id)
        if not b:
            continue
        books.append({
            "id": cb.id,
            "book_id": cb.book_id,
            "ord": cb.ord,
            "book_title": b.title,
            "book_filename": b.filename,
            "book_content_type": b.content_type,
            "book_num_pages": b.num_pages,
            "book_cover_path": b.cover_path,
            "book_status": b.status,
        })
    return {
        "id": course.id,
        "title": course.title,
        "description": course.description or "",
        "cover_path": course.cover_path,
        "created_at": course.created_at,
        "updated_at": course.updated_at,
        "book_count": len(books),
        "books": books,
    }


@router.get("")
def list_courses(db: Session = Depends(get_db)):
    courses = list(db.scalars(select(Course).order_by(Course.created_at.desc())))
    return [_course_out(c, db) for c in courses]


@router.post("")
def create_course(body: dict, background_tasks: BackgroundTasks, db: Session = Depends(get_db)):
    title = (body.get("title") or "").strip()
    if not title:
        raise HTTPException(400, "Title is required")
    desc = (body.get("description") or "").strip()
    book_ids = body.get("book_ids") or []

    course = Course(title=title, description=desc)
    db.add(course)
    db.flush()

    for i, bid in enumerate(book_ids):
        b = db.get(Book, bid)
        if not b:
            continue
        _apply_course_defaults(b)
        cb = CourseBook(course_id=course.id, book_id=bid, ord=i)
        db.add(cb)

    db.commit()
    db.refresh(course)

    if course.books:
        first_cb = course.books[0]
        first_book = db.get(Book, first_cb.book_id)
        if first_book and first_book.cover_path:
            course.cover_path = first_book.cover_path
            db.commit()

    return _course_out(course, db)


@router.get("/{course_id}")
def get_course(course_id: int, db: Session = Depends(get_db)):
    course = db.get(Course, course_id)
    if not course:
        raise HTTPException(404, "Course not found")
    return _course_out(course, db)


@router.put("/{course_id}")
def update_course(course_id: int, body: dict, db: Session = Depends(get_db)):
    course = db.get(Course, course_id)
    if not course:
        raise HTTPException(404, "Course not found")
    if "title" in body and body["title"] is not None:
        t = body["title"].strip()
        if t:
            course.title = t
    if "description" in body:
        course.description = (body["description"] or "").strip()
    db.commit()
    db.refresh(course)
    return _course_out(course, db)


@router.delete("/{course_id}")
def delete_course(course_id: int, db: Session = Depends(get_db)):
    course = db.get(Course, course_id)
    if not course:
        raise HTTPException(404, "Course not found")
    db.delete(course)
    db.commit()
    return {"ok": True}


@router.post("/{course_id}/books")
def add_books_to_course(course_id: int, body: dict, background_tasks: BackgroundTasks, db: Session = Depends(get_db)):
    course = db.get(Course, course_id)
    if not course:
        raise HTTPException(404, "Course not found")
    book_ids = body.get("book_ids") or []
    max_ord = db.scalar(select(func.max(CourseBook.ord)).where(CourseBook.course_id == course_id)) or -1
    added = 0
    for i, bid in enumerate(book_ids):
        b = db.get(Book, bid)
        if not b:
            continue
        existing = db.scalar(
            select(CourseBook).where(CourseBook.course_id == course_id, CourseBook.book_id == bid)
        )
        if existing:
            continue
        _apply_course_defaults(b)
        max_ord += 1
        db.add(CourseBook(course_id=course_id, book_id=bid, ord=max_ord))
        added += 1
    db.commit()

    if added > 0 and not course.cover_path:
        first_cb = db.scalars(
            select(CourseBook).where(CourseBook.course_id == course_id).order_by(CourseBook.ord)
        ).first()
        if first_cb:
            fb = db.get(Book, first_cb.book_id)
            if fb and fb.cover_path:
                course.cover_path = fb.cover_path
                db.commit()

    return {"ok": True, "added": added}


@router.delete("/{course_id}/books/{book_id}")
def remove_book_from_course(course_id: int, book_id: int, db: Session = Depends(get_db)):
    cb = db.scalar(
        select(CourseBook).where(CourseBook.course_id == course_id, CourseBook.book_id == book_id)
    )
    if not cb:
        raise HTTPException(404, "Book not in course")
    db.delete(cb)
    db.commit()

    course = db.get(Course, course_id)
    if course and course.cover_path:
        remaining = db.scalars(
            select(CourseBook).where(CourseBook.course_id == course_id).order_by(CourseBook.ord)
        ).all()
        if remaining:
            first_cb = remaining[0]
            fb = db.get(Book, first_cb.book_id)
            if fb and fb.cover_path and fb.cover_path != course.cover_path:
                course.cover_path = fb.cover_path
                db.commit()
        else:
            course.cover_path = None
            db.commit()

    return {"ok": True}


@router.put("/{course_id}/books/{book_id}/order")
def reorder_course_book(course_id: int, book_id: int, body: dict, db: Session = Depends(get_db)):
    direction = body.get("direction", "down")
    cb = db.scalar(
        select(CourseBook).where(CourseBook.course_id == course_id, CourseBook.book_id == book_id)
    )
    if not cb:
        raise HTTPException(404, "Book not in course")

    all_cbs = list(db.scalars(
        select(CourseBook).where(CourseBook.course_id == course_id).order_by(CourseBook.ord)
    ))
    idx = next((i for i, c in enumerate(all_cbs) if c.id == cb.id), None)
    if idx is None:
        raise HTTPException(404, "Book not found in course order")

    if direction == "up" and idx > 0:
        swap = all_cbs[idx - 1]
        swap.ord, cb.ord = cb.ord, swap.ord
    elif direction == "down" and idx < len(all_cbs) - 1:
        swap = all_cbs[idx + 1]
        swap.ord, cb.ord = cb.ord, swap.ord
    else:
        return {"ok": True, "unchanged": True}

    db.commit()
    return {"ok": True}


@router.get("/{course_id}/progress")
def course_progress(course_id: int, db: Session = Depends(get_db)):
    course = db.get(Course, course_id)
    if not course:
        raise HTTPException(404, "Course not found")

    book_ids = [cb.book_id for cb in db.scalars(
        select(CourseBook).where(CourseBook.course_id == course_id)
    ).all()]

    if not book_ids:
        return {
            "book_count": 0, "total_cards": 0, "cards_due": 0, "cards_mastered": 0,
            "sections_read": 0, "total_sections": 0, "books_progress": [],
        }

    total_cards = db.scalar(
        select(func.count(Flashcard.id)).where(Flashcard.book_id.in_(book_ids))
    ) or 0
    cards_mastered = db.scalar(
        select(func.count(Flashcard.id)).where(Flashcard.book_id.in_(book_ids), Flashcard.reps >= 3)
    ) or 0
    now_func = func.now()
    cards_due = db.scalar(
        select(func.count(Flashcard.id)).where(Flashcard.book_id.in_(book_ids), Flashcard.due_at <= now_func)
    ) or 0
    sections_read = db.scalar(
        select(func.count(ReadingProgress.id)).join(Section).where(Section.book_id.in_(book_ids))
    ) or 0
    total_sections = db.scalar(
        select(func.count(Section.id)).where(Section.book_id.in_(book_ids))
    ) or 0

    books_progress = []
    for bid in book_ids:
        b = db.get(Book, bid)
        if not b:
            continue
        secs = list(db.scalars(select(Section).where(Section.book_id == bid)))
        read_ids = {r.section_id for r in db.scalars(
            select(ReadingProgress).join(Section).where(Section.book_id == bid)
        ).all()}
        read_count = sum(1 for s in secs if s.id in read_ids)
        bc = db.scalar(select(func.count(Flashcard.id)).where(Flashcard.book_id == bid)) or 0
        bm = db.scalar(select(func.count(Flashcard.id)).where(Flashcard.book_id == bid, Flashcard.reps >= 3)) or 0
        bd = db.scalar(select(func.count(Flashcard.id)).where(Flashcard.book_id == bid, Flashcard.due_at <= now_func)) or 0
        last_qa = db.scalars(
            select(QuizAttempt).where(QuizAttempt.book_id == bid).order_by(QuizAttempt.created_at.desc())
        ).first()
        books_progress.append({
            "id": b.id, "title": b.title, "status": b.status, "num_pages": b.num_pages,
            "sections_count": len(secs), "sections_read": read_count,
            "cards_total": bc, "cards_due": bd, "cards_mastered": bm,
            "notes_count": 0, "last_quiz": last_qa, "last_activity": None,
        })

    return {
        "book_count": len(book_ids),
        "total_cards": total_cards,
        "cards_due": cards_due,
        "cards_mastered": cards_mastered,
        "sections_read": sections_read,
        "total_sections": total_sections,
        "books_progress": books_progress,
    }


@router.get("/{course_id}/due-cards")
def course_due_cards(course_id: int, limit: int = 30, db: Session = Depends(get_db)):
    course = db.get(Course, course_id)
    if not course:
        raise HTTPException(404, "Course not found")

    book_ids = [cb.book_id for cb in db.scalars(
        select(CourseBook).where(CourseBook.course_id == course_id)
    ).all()]

    if not book_ids:
        return []

    now_func = func.now()
    cards = db.scalars(
        select(Flashcard)
        .where(Flashcard.book_id.in_(book_ids), Flashcard.due_at <= now_func)
        .order_by(Flashcard.due_at)
        .limit(limit)
    ).all()

    result = []
    for c in cards:
        sec = db.get(Section, c.section_id)
        b = db.get(Book, c.book_id)
        result.append({
            "id": c.id,
            "section_id": c.section_id,
            "front": c.front,
            "back": c.back,
            "ord": c.ord,
            "ease": c.ease,
            "interval_days": c.interval_days,
            "due_at": c.due_at,
            "reps": c.reps,
            "lapses": c.lapses,
            "book_title": b.title if b else "",
            "section_title": sec.title if sec else "",
        })
    return result
