import json
import logging

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.orm import Session

from ..config import PROMPTS_DIR
from ..database import get_db
from ..llm import llm_client
from ..models import Book, Section, VocabWord
from ..schemas import TranslateRequest, TranslateResult, TranslateWord, VocabWordCreate, VocabWordOut
from .study import _load_book

logger = logging.getLogger(__name__)
router = APIRouter(tags=["vocab"])


class VocabBatchCreate(BaseModel):
    words: list[VocabWordCreate]
    section_id: int | None = None


def _load_word(db: Session, book_id: int, word_id: int) -> VocabWord:
    word = db.get(VocabWord, word_id)
    if word is None or word.book_id != book_id:
        raise HTTPException(status_code=404, detail="Vocab word not found")
    return word


@router.get("/books/{book_id}/vocab", response_model=list[VocabWordOut])
def list_vocab(book_id: int, db: Session = Depends(get_db)):
    _load_book(db, book_id)
    return list(db.scalars(select(VocabWord).where(VocabWord.book_id == book_id).order_by(VocabWord.id.desc())))


@router.post("/books/{book_id}/vocab", response_model=VocabWordOut, status_code=201)
def create_vocab(book_id: int, body: VocabWordCreate, db: Session = Depends(get_db)):
    _load_book(db, book_id)
    term = (body.term or "").strip()
    translation = (body.translation or "").strip()
    if not term or not translation:
        raise HTTPException(status_code=422, detail="term and translation are required")
    if body.section_id is not None:
        section = db.get(Section, body.section_id)
        if section is None or section.book_id != book_id:
            raise HTTPException(status_code=404, detail="Section not found")
    existing = db.scalar(
        select(VocabWord).where(VocabWord.book_id == book_id, VocabWord.term == term)
    )
    if existing:
        existing.translation = translation
        if body.note:
            existing.note = body.note
        if body.context:
            existing.context = body.context
        db.commit()
        db.refresh(existing)
        return existing
    word = VocabWord(
        book_id=book_id,
        section_id=body.section_id,
        term=term,
        translation=translation,
        note=body.note,
        context=body.context,
        page=body.page,
    )
    db.add(word)
    db.commit()
    db.refresh(word)
    return word


@router.post("/books/{book_id}/vocab/batch", response_model=list[VocabWordOut], status_code=201)
def create_vocab_batch(book_id: int, body: VocabBatchCreate, db: Session = Depends(get_db)):
    _load_book(db, book_id)
    results: list[VocabWord] = []
    for item in body.words:
        term = (item.term or "").strip()
        translation = (item.translation or "").strip()
        if not term or not translation:
            continue
        existing = db.scalar(
            select(VocabWord).where(VocabWord.book_id == book_id, VocabWord.term == term)
        )
        if existing:
            existing.translation = translation
            if item.context:
                existing.context = item.context
            results.append(existing)
            continue
        word = VocabWord(
            book_id=book_id,
            section_id=body.section_id,
            term=term,
            translation=translation,
            note=item.note,
            context=item.context,
            page=None,
        )
        db.add(word)
        results.append(word)
    db.commit()
    for word in results:
        db.refresh(word)
    return results


@router.delete("/books/{book_id}/vocab/{word_id}")
def delete_vocab(book_id: int, word_id: int, db: Session = Depends(get_db)):
    _load_book(db, book_id)
    word = _load_word(db, book_id, word_id)
    db.delete(word)
    db.commit()
    return {"ok": True}


def _prompt_text(name: str, subs: dict[str, object] | None = None) -> str:
    text = (PROMPTS_DIR / name).read_text(encoding="utf-8")
    for key, value in (subs or {}).items():
        text = text.replace("{%s}" % key, str(value))
    return text


@router.post("/books/{book_id}/vocab/translate", response_model=TranslateResult)
def translate_selection(book_id: int, body: TranslateRequest, db: Session = Depends(get_db)):
    _load_book(db, book_id)
    text = (body.text or "").strip()
    if not text:
        raise HTTPException(status_code=422, detail="text is required")

    system_msg = _prompt_text("read_translate_words.txt", {"selected_text": text})
    messages = [
        {"role": "system", "content": system_msg},
        {"role": "user", "content": f"Selected text:\n\"{text}\""},
    ]
    try:
        raw = llm_client.complete(messages)
    except Exception as exc:
        logger.exception("Vocab translate LLM call failed")
        raise HTTPException(status_code=502, detail=f"Translation failed: {exc}")

    words = _parse_words(raw)
    if not words:
        raise HTTPException(status_code=502, detail="Could not extract words from the selection.")
    return TranslateResult(words=words, context=text[:400])


def _parse_words(raw: str) -> list[TranslateWord]:
    text = raw.strip()
    if "```" in text:
        parts = text.split("```")
        for part in parts:
            p = part.strip().lstrip("json").strip()
            if p.startswith("{"):
                text = p
                break
    try:
        data = json.loads(text)
    except Exception:
        try:
            start = text.index("{")
            data = json.loads(text[start:])
        except Exception:
            return []
    words: list[TranslateWord] = []
    for item in (data.get("words") or []):
        term = (item.get("term") or "").strip()
        translation = (item.get("translation") or "").strip()
        if term and translation:
            words.append(TranslateWord(term=term, translation=translation, note=(item.get("note") or "").strip() or None))
    return words
