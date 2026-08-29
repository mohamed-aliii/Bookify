import json
import logging
from datetime import datetime

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy import delete, func, or_, select
from sqlalchemy.orm import Session

from ..config import PROMPTS_DIR
from ..database import get_db
from ..llm import llm_client
from ..models import (
    Book,
    Chunk,
    ConceptEdge,
    Flashcard,
    KnowledgePoint,
    Section,
    UserKnowledgePoint,
    utcnow_naive,
)
from ..schemas import KnowledgePointOut, UserKnowledgePointOut, WeakAreaOut

logger = logging.getLogger(__name__)
router = APIRouter(tags=["intelligence"])

KP_TARGET_PER_SECTION = 5


def _sse(payload: dict) -> str:
    return f"data: {json.dumps(payload)}\n\n"


def _load_book(db: Session, book_id: int) -> Book:
    book = db.get(Book, book_id)
    if book is None:
        raise HTTPException(status_code=404, detail="Book not found")
    return book


def _prompt_text(name: str, subs: dict[str, object] | None = None) -> str:
    text = (PROMPTS_DIR / name).read_text(encoding="utf-8")
    for key, value in (subs or {}).items():
        text = text.replace("{%s}" % key, str(value))
    return text


def _extract_json_array(text: str) -> list[dict]:
    cleaned = text.strip()
    if cleaned.startswith("```"):
        cleaned = "\n".join(cleaned.splitlines()[1:-1]).strip()
    start, end = cleaned.find("["), cleaned.rfind("]")
    if start == -1 or end <= start:
        raise ValueError("Model response contained no JSON array")
    items = json.loads(cleaned[start : end + 1])
    if not isinstance(items, list) or not all(isinstance(item, dict) for item in items):
        raise ValueError("Unexpected JSON structure")
    return items


def _section_all_chunks(db: Session, book_id: int, section_id: int) -> list[Chunk]:
    from .study import _descendant_section_ids

    ids = _descendant_section_ids(db, book_id, section_id)
    return list(db.scalars(select(Chunk).where(Chunk.section_id.in_(ids)).order_by(Chunk.ord)))


def _excerpts_text(chunks: list[Chunk]) -> str:
    return "\n\n".join(
        f"[Excerpt {i} | {c.section_title} | pages {c.page_start}-{c.page_end}]\n{c.text}"
        for i, c in enumerate(chunks, start=1)
    )


def _spread(items: list[Chunk], limit: int) -> list[Chunk]:
    if len(items) <= limit:
        return items
    step = len(items) / limit
    return [items[int(i * step)] for i in range(limit)]


def compute_mastery(ukp: UserKnowledgePoint) -> float:
    quiz_component = (ukp.quiz_correct / ukp.quiz_total) if ukp.quiz_total > 0 else 0.0
    socratic_component = 1.0 - (ukp.socratic_reveals / ukp.socratic_total) if ukp.socratic_total > 0 else 0.0
    practice_component = (ukp.practice_score_sum / ukp.practice_count) if ukp.practice_count > 0 else 0.0
    weights = sum([
        (0.40, quiz_component) if ukp.quiz_total > 0 else (0, 0),
        (0.30, socratic_component) if ukp.socratic_total > 0 else (0, 0),
        (0.30, practice_component) if ukp.practice_count > 0 else (0, 0),
    ])
    total_weight = sum(w for w, _ in weights) or 1.0
    return round(sum(w * v for w, v in weights) / total_weight, 3)


def update_mastery(db: Session, kp_id: int, quiz_correct: int = 0, quiz_total: int = 0, socratic_reveals: int = 0, practice_score: float | None = None) -> UserKnowledgePoint:
    ukp = db.scalar(select(UserKnowledgePoint).where(UserKnowledgePoint.knowledge_point_id == kp_id))
    if ukp is None:
        ukp = UserKnowledgePoint(knowledge_point_id=kp_id)
        db.add(ukp)
        db.flush()

    if quiz_total > 0:
        ukp.quiz_correct += quiz_correct
        ukp.quiz_total += quiz_total
    if socratic_reveals > 0:
        ukp.socratic_total += 1
        ukp.socratic_reveals += socratic_reveals
    if practice_score is not None:
        ukp.practice_score_sum += practice_score
        ukp.practice_count += 1
    ukp.last_practiced = utcnow_naive()
    ukp.mastery = compute_mastery(ukp)
    ukp.updated_at = utcnow_naive()
    return ukp


@router.get("/books/{book_id}/knowledge-points", response_model=list[KnowledgePointOut])
def list_knowledge_points(book_id: int, db: Session = Depends(get_db)):
    _load_book(db, book_id)
    return list(db.scalars(select(KnowledgePoint).where(KnowledgePoint.book_id == book_id).order_by(KnowledgePoint.section_id, KnowledgePoint.id)))


class KPExtractRequest(BaseModel):
    force: bool = False
    limit: int = 12


def _extract_section_kps(db: Session, book_id: int, section: Section, force: bool = False) -> int:
    from ..models import Section as SectionModel

    existing_in_section = db.scalar(select(KnowledgePoint).where(KnowledgePoint.section_id == section.id).limit(1))
    if existing_in_section is not None and not force:
        return 0

    chunks = _section_all_chunks(db, book_id, section.id)
    if not chunks:
        return 0
    total_chars = sum(len(c.text) for c in chunks)
    auto_count = max(3, min(KP_TARGET_PER_SECTION, round(total_chars / 4000)))
    excerpt_chunks = _spread(chunks, 20)
    excerpts = _excerpts_text(excerpt_chunks)

    messages = [
        {"role": "system", "content": _prompt_text("knowledge_points.txt", {"count": auto_count})},
        {"role": "user", "content": f"Excerpts from \"{section.title}\":\n\n{excerpts}\n\nExtract the knowledge points now."},
    ]
    try:
        raw = llm_client.complete(messages)
        items = _extract_json_array(raw)
    except Exception as exc:
        logger.warning("KP extraction failed for section %s: %s", section.title, exc)
        return 0

    total_created = 0
    for item in items:
        name = str(item.get("name", "")).strip()
        desc = str(item.get("description", "")).strip()
        diff = float(item.get("difficulty", 0.5))
        if not name or not desc:
            continue
        kp = KnowledgePoint(
            book_id=book_id,
            section_id=section.id,
            name=name,
            description=desc,
            difficulty=max(0.0, min(1.0, diff)),
        )
        db.add(kp)
        total_created += 1
    return total_created


@router.post("/books/{book_id}/knowledge-points/extract")
def extract_knowledge_points(book_id: int, body: KPExtractRequest, db: Session = Depends(get_db)):
    _load_book(db, book_id)

    from ..models import Section as SectionModel

    sections = list(db.scalars(select(SectionModel).where(SectionModel.book_id == book_id, SectionModel.level == 1).order_by(SectionModel.ord)))
    sections = sections[:body.limit]
    total_created = 0

    for section in sections:
        if body.force:
            existing_ids = list(db.scalars(select(KnowledgePoint.id).where(KnowledgePoint.section_id == section.id)))
            if existing_ids:
                db.execute(delete(KnowledgePoint).where(KnowledgePoint.section_id == section.id))
                db.execute(delete(ConceptEdge).where(or_(ConceptEdge.source_point_id.in_(existing_ids), ConceptEdge.target_point_id.in_(existing_ids))))
            db.flush()
        total_created += _extract_section_kps(db, book_id, section, force=body.force)

    db.commit()
    total_sections = db.scalar(select(func.count()).select_from(SectionModel).where(SectionModel.book_id == book_id, SectionModel.level == 1))
    processed = db.scalar(select(func.count()).select_from(KnowledgePoint).where(KnowledgePoint.book_id == book_id))
    return {"ok": True, "created": total_created, "total_sections": total_sections or 0, "total_kps": processed or 0}


class KPSectionExtractRequest(BaseModel):
    force: bool = False


@router.post("/books/{book_id}/sections/{section_id}/knowledge-points/extract")
def extract_section_knowledge_points(book_id: int, section_id: int, body: KPSectionExtractRequest, db: Session = Depends(get_db)):
    _load_book(db, book_id)
    section = db.get(Section, section_id)
    if section is None or section.book_id != book_id:
        raise HTTPException(status_code=404, detail="Section not found")

    if body.force:
        existing_ids = list(db.scalars(select(KnowledgePoint.id).where(KnowledgePoint.section_id == section_id)))
        if existing_ids:
            db.execute(delete(KnowledgePoint).where(KnowledgePoint.section_id == section_id))
            db.execute(delete(ConceptEdge).where(or_(ConceptEdge.source_point_id.in_(existing_ids), ConceptEdge.target_point_id.in_(existing_ids))))
        db.flush()

    created = _extract_section_kps(db, book_id, section, force=body.force)
    db.commit()
    total_kps = db.scalar(select(func.count()).select_from(KnowledgePoint).where(KnowledgePoint.book_id == book_id))
    return {"ok": True, "created": created, "total_kps": total_kps or 0}


@router.get("/books/{book_id}/weak-areas", response_model=list[WeakAreaOut])
def weak_areas(book_id: int, limit: int = 20, db: Session = Depends(get_db)):
    _load_book(db, book_id)

    kps = list(db.scalars(select(KnowledgePoint).where(KnowledgePoint.book_id == book_id).order_by(KnowledgePoint.section_id)))

    results: list[WeakAreaOut] = []
    for kp in kps:
        ukp = db.scalar(select(UserKnowledgePoint).where(UserKnowledgePoint.knowledge_point_id == kp.id))
        section = db.get(Section, kp.section_id)
        section_title = section.title if section else ""

        if ukp is None:
            recommendation = "Start studying this concept — no activity recorded yet."
        elif ukp.mastery < 0.3:
            recommendation = "Struggling — review flashcards and try a practice problem."
        elif ukp.mastery < 0.6:
            recommendation = "Developing — take a quiz to solidify understanding."
        elif ukp.mastery < 0.8:
            recommendation = "Getting there — try teaching it back to confirm mastery."
        else:
            recommendation = "Strong — keep up with periodic review."

        results.append(WeakAreaOut(
            knowledge_point=KnowledgePointOut.model_validate(kp),
            user_kp=UserKnowledgePointOut.model_validate(ukp) if ukp else None,
            section_title=section_title,
            recommendation=recommendation,
        ))

    results.sort(key=lambda w: (w.user_kp.mastery if w.user_kp else 0.0))
    return results[:limit]


class ActivityReportRequest(BaseModel):
    activity_type: str
    knowledge_point_id: int | None = None
    result: str = "correct"
    reveal_level: int | None = None
    duration_seconds: int = 0


@router.post("/books/{book_id}/intelligence/report")
def report_activity(book_id: int, body: ActivityReportRequest, db: Session = Depends(get_db)):
    _load_book(db, book_id)

    if body.knowledge_point_id is None:
        return {"ok": True, "mastery_updated": False}

    kp = db.get(KnowledgePoint, body.knowledge_point_id)
    if kp is None or kp.book_id != book_id:
        raise HTTPException(status_code=404, detail="Knowledge point not found")

    if body.activity_type == "socratic":
        reveals = body.reveal_level if body.reveal_level is not None else (0 if body.result == "correct" else 1)
        update_mastery(db, kp.id, socratic_reveals=reveals)
    elif body.activity_type == "practice":
        score = 1.0 if body.result == "correct" else (0.5 if body.result == "partial" else 0.0)
        update_mastery(db, kp.id, practice_score=score)
    elif body.activity_type == "teachback":
        score = 1.0 if body.result == "correct" else (0.5 if body.result == "partial" else 0.0)
        update_mastery(db, kp.id, practice_score=score)

    db.commit()
    try:
        from ..xp_engine import award_xp
        xp_type = f"{body.activity_type}_complete"
        if xp_type not in ("socratic_complete", "practice_complete", "teachback_complete"):
            xp_type = "practice_complete"
        award_xp(db, xp_type)
    except Exception:
        pass
    return {"ok": True, "mastery_updated": True}
