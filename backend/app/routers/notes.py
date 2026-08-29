from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.orm import Session

from ..database import get_db
from ..models import Note, Section
from ..schemas import NoteCreate, NoteOut, NoteUpdate
from .study import _load_book

router = APIRouter(tags=["notes"])


def _load_note(db: Session, book_id: int, note_id: int) -> Note:
    note = db.get(Note, note_id)
    if note is None or note.book_id != book_id:
        raise HTTPException(status_code=404, detail="Note not found")
    return note


def _validate_section(db: Session, book_id: int, section_id: int | None) -> None:
    if section_id is not None:
        section = db.get(Section, section_id)
        if section is None or section.book_id != book_id:
            raise HTTPException(status_code=404, detail="Section not found")


@router.get("/books/{book_id}/notes", response_model=list[NoteOut])
def list_notes(book_id: int, db: Session = Depends(get_db)):
    _load_book(db, book_id)
    return list(db.scalars(select(Note).where(Note.book_id == book_id).order_by(Note.id.desc())))


@router.post("/books/{book_id}/notes", response_model=NoteOut, status_code=201)
def create_note(book_id: int, body: NoteCreate, db: Session = Depends(get_db)):
    _load_book(db, book_id)
    content = (body.content or "").strip()
    if not content:
        raise HTTPException(status_code=422, detail="Note content cannot be empty")
    _validate_section(db, book_id, body.section_id)
    note = Note(
        book_id=book_id,
        section_id=body.section_id,
        page=body.page,
        quote=(body.quote or "").strip() or None,
        content=content,
    )
    db.add(note)
    db.commit()
    db.refresh(note)
    try:
        from ..xp_engine import award_xp
        award_xp(db, "note_created")
    except Exception:
        pass
    return note


@router.patch("/books/{book_id}/notes/{note_id}", response_model=NoteOut)
def update_note(book_id: int, note_id: int, body: NoteUpdate, db: Session = Depends(get_db)):
    _load_book(db, book_id)
    note = _load_note(db, book_id, note_id)
    data = body.model_dump(exclude_unset=True)
    if "section_id" in data:
        _validate_section(db, book_id, data["section_id"])
    if "content" in data and data["content"] is not None:
        data["content"] = data["content"].strip()
        if not data["content"]:
            raise HTTPException(status_code=422, detail="Note content cannot be empty")
    for field, value in data.items():
        setattr(note, field, value)
    db.commit()
    db.refresh(note)
    return note


@router.delete("/books/{book_id}/notes/{note_id}")
def delete_note(book_id: int, note_id: int, db: Session = Depends(get_db)):
    _load_book(db, book_id)
    note = _load_note(db, book_id, note_id)
    db.delete(note)
    db.commit()
    return {"ok": True}
