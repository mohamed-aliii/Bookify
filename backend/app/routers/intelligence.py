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

KP_SOFT_MIN = 6
KP_SOFT_MAX = 30


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


def _leaf_sections_for_chapter(db: Session, book_id: int, chapter: Section) -> list[Section]:
    """Return leaf descendant sections for a chapter, section-by-section.
    If chapter has no children, returns [chapter]."""
    from ..models import Section as SectionModel
    # All sections for this book ordered by ord
    all_secs = list(db.scalars(select(SectionModel).where(SectionModel.book_id == book_id).order_by(SectionModel.ord)))
    # Build parent -> children map
    children_map: dict[int | None, list[SectionModel]] = {}
    for s in all_secs:
        children_map.setdefault(s.parent_id, []).append(s)
    # Get all descendant ids under chapter (including chapter)
    from .study import _descendant_section_ids
    desc_ids = set(_descendant_section_ids(db, book_id, chapter.id))
    # Leaves = ids that are not a parent of anyone in desc set
    parent_ids = {s.parent_id for s in all_secs if s.parent_id in desc_ids}
    leaves = [s for s in all_secs if s.id in desc_ids and s.id not in parent_ids]
    # If chapter itself is leaf (no children), leaves will be [chapter]
    if not leaves:
        leaves = [chapter]
    # Sort by ord to keep reading order
    leaves.sort(key=lambda s: s.ord)
    return leaves


def _extract_single_leaf_kps(db: Session, book_id: int, leaf: Section) -> list[dict]:
    """Extract KPs for a single leaf section, soft 6-30 hint, 50-200w not needed here."""
    chunks = _section_all_chunks(db, book_id, leaf.id)
    if not chunks:
        return []
    total_chars = sum(len(c.text) for c in chunks)
    # Soft hint: denser leaves suggest more points, but LLM decides
    hint_count = max(KP_SOFT_MIN, min(KP_SOFT_MAX, round(total_chars / 1600) if total_chars > 0 else KP_SOFT_MIN))
    if total_chars < 800:
        hint_count = max(4, hint_count)  # thin leaf still 4-6
    hint_text = f"This leaf section '{leaf.title}' has ~{total_chars} chars. Soft guidance: aim for thorough coverage (typically {hint_count} points within {KP_SOFT_MIN}-{KP_SOFT_MAX} per chapter when summed across leaves). No hard cap."

    # For leaf, use up to 30 excerpts (leaf is small, often all)
    excerpt_chunks = _spread(chunks, 30)
    excerpts = _excerpts_text(excerpt_chunks)

    messages = [
        {"role": "system", "content": _prompt_text("knowledge_points_deep.txt", {"hint_text": hint_text})},
        {"role": "user", "content": f"Excerpts from \"{leaf.title}\" (chapter: leaf):\n\n{excerpts}\n\nExtract knowledge points now."},
    ]
    try:
        raw = llm_client.complete(messages)
        items = _extract_json_array(raw)
        return items
    except Exception as exc:
        logger.warning("Deep KP extraction failed for leaf %s: %s", leaf.title, exc)
        return []


def _extract_section_kps(db: Session, book_id: int, section: Section, force: bool = False) -> int:
    """Deep section-by-section extraction with soft cap 6-30 per chapter (summed across leaves)."""
    from ..models import Section as SectionModel

    # If this is a leaf-level section (no children) and not a chapter, keep single-leaf path for direct calls
    # Check existing at chapter level: if any leaf already has KPs and not force, skip
    leaves = _leaf_sections_for_chapter(db, book_id, section)
    if not force:
        # If any leaf under this chapter already has KPs, skip to avoid re-extract
        for lf in leaves:
            existing = db.scalar(select(KnowledgePoint).where(KnowledgePoint.section_id == lf.id).limit(1))
            if existing is not None:
                return 0

    # Collect per leaf
    all_items: list[dict] = []
    leaf_id_for_item: list[int] = []  # parallel to all_items to know which leaf produced it
    for leaf in leaves:
        items = _extract_single_leaf_kps(db, book_id, leaf)
        for it in items:
            all_items.append(it)
            leaf_id_for_item.append(leaf.id)

    if not all_items:
        return 0

    # Dedup by normalized name (case-insensitive) to keep graph clean
    seen_names: set[str] = set()
    deduped: list[tuple[dict, int]] = []
    for it, leaf_id in zip(all_items, leaf_id_for_item):
        name_norm = str(it.get("name", "")).strip().lower()
        if not name_norm or name_norm in seen_names:
            continue
        seen_names.add(name_norm)
        deduped.append((it, leaf_id))

    # Soft cap: if deduped exceeds KP_SOFT_MAX per chapter, keep highest quality (keep insertion order, LLM already prioritized)
    if len(deduped) > KP_SOFT_MAX:
        deduped = deduped[:KP_SOFT_MAX]
    # Ensure at least soft min if possible (if LLM returned very few, keep as is)

    total_created = 0
    for item, leaf_id in deduped:
        name = str(item.get("name", "")).strip()
        desc = str(item.get("description", "")).strip()
        diff = float(item.get("difficulty", 0.5))
        if not name or not desc:
            continue
        # Store against the leaf section for precise provenance, not the chapter
        kp = KnowledgePoint(
            book_id=book_id,
            section_id=leaf_id,
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
            leaf_ids = [lf.id for lf in _leaf_sections_for_chapter(db, book_id, section)]
            existing_ids = list(db.scalars(select(KnowledgePoint.id).where(KnowledgePoint.section_id.in_(leaf_ids)))) if leaf_ids else []
            if existing_ids:
                db.execute(delete(KnowledgePoint).where(KnowledgePoint.section_id.in_(leaf_ids)))
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
        leaf_ids = [lf.id for lf in _leaf_sections_for_chapter(db, book_id, section)]
        if not leaf_ids:
            leaf_ids = [section_id]
        existing_ids = list(db.scalars(select(KnowledgePoint.id).where(KnowledgePoint.section_id.in_(leaf_ids))))
        if existing_ids:
            db.execute(delete(KnowledgePoint).where(KnowledgePoint.section_id.in_(leaf_ids)))
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
