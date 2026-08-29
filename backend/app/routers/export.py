import csv
import datetime as dt
import io

from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import Response
from sqlalchemy import select
from sqlalchemy.orm import Session

from ..database import get_db
from ..models import Flashcard, Note, Section
from .study import _load_book

router = APIRouter(prefix="/books", tags=["export"])


def _slug(title: str) -> str:
    slug = "".join(c if c.isalnum() else "-" for c in title.lower()).strip("-")
    return slug[:60] or "book"


def _attachment(name: str, media_type: str) -> dict[str, str]:
    safe = name.replace('"', "")
    return {"Content-Disposition": f'attachment; filename="{safe}"'}


@router.get("/{book_id}/export/flashcards.csv")
def export_flashcards(book_id: int, db: Session = Depends(get_db)):
    """Anki-importable CSV: front, back, tags."""
    book = _load_book(db, book_id)
    cards = list(
        db.scalars(select(Flashcard).where(Flashcard.book_id == book_id).order_by(Flashcard.section_id, Flashcard.ord))
    )
    if not cards:
        raise HTTPException(status_code=404, detail="No flashcards to export yet")

    section_titles = {
        s.id: s.title for s in db.scalars(select(Section).where(Section.book_id == book_id))
    }

    buf = io.StringIO()
    writer = csv.writer(buf, quoting=csv.QUOTE_ALL, lineterminator="\n")
    for card in cards:
        tag = section_titles.get(card.section_id, "general")[:50].replace('"', "'").replace(",", " ")
        writer.writerow([card.front, card.back, tag])

    return Response(
        content=buf.getvalue(),
        media_type="text/csv",
        headers=_attachment(f"{_slug(book.title)}-flashcards.csv", "text/csv"),
    )


@router.get("/{book_id}/export/notes.md")
def export_notes(book_id: int, db: Session = Depends(get_db)):
    """All notes as a Markdown file, grouped by section."""
    book = _load_book(db, book_id)
    notes = list(db.scalars(select(Note).where(Note.book_id == book_id).order_by(Note.id)))
    if not notes:
        raise HTTPException(status_code=404, detail="No notes to export yet")

    sections = {s.id: s for s in db.scalars(select(Section).where(Section.book_id == book_id))}
    grouped: dict[str, list[Note]] = {}
    order: list[str] = []
    for note in notes:
        sec = sections.get(note.section_id) if note.section_id is not None else None
        key = sec.title if sec else "General"
        if key not in grouped:
            grouped[key] = []
            order.append(key)
        grouped[key].append(note)

    lines = [
        f"# Notes — {book.title}",
        "",
        f"_Exported from Bookify on {dt.date.today().isoformat()}_",
        "",
    ]
    for key in order:
        lines.append(f"## {key}")
        lines.append("")
        for note in grouped[key]:
            loc = f" (p.{note.page})" if note.page is not None else ""
            lines.append(f"- {note.content}{loc}")
            if note.quote:
                lines.append(f'  > “{note.quote}”')
        lines.append("")

    return Response(
        content="\n".join(lines),
        media_type="text/markdown",
        headers=_attachment(f"{_slug(book.title)}-notes.md", "text/markdown"),
    )
