import json
import logging

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from ..config import PROMPTS_DIR
from ..database import get_db
from ..llm import llm_client
from ..models import Book, ConceptEdge, KnowledgePoint, Section, UserKnowledgePoint
from ..schemas import ConceptGraphEdge, ConceptGraphOut, ConceptGraphNode

logger = logging.getLogger(__name__)
router = APIRouter(tags=["conceptmap"])


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
    if not isinstance(items, list):
        raise ValueError("Unexpected JSON structure")
    return items


@router.get("/books/{book_id}/concept-graph", response_model=ConceptGraphOut)
def get_concept_graph(book_id: int, db: Session = Depends(get_db)):
    book = _load_book(db, book_id)

    kps = list(db.scalars(select(KnowledgePoint).where(KnowledgePoint.book_id == book_id).order_by(KnowledgePoint.id)))
    edges = list(db.scalars(select(ConceptEdge).where(ConceptEdge.source_point_id.in_([kp.id for kp in kps]))))

    kp_map = {kp.id: kp for kp in kps}
    nodes: list[ConceptGraphNode] = []
    for kp in kps:
        ukp = db.scalar(select(UserKnowledgePoint).where(UserKnowledgePoint.knowledge_point_id == kp.id))
        section = db.get(Section, kp.section_id)
        nodes.append(ConceptGraphNode(
            id=kp.id,
            name=kp.name,
            description=kp.description,
            difficulty=kp.difficulty,
            mastery=ukp.mastery if ukp else None,
            section_id=kp.section_id,
            section_title=section.title if section else "",
            book_id=kp.book_id,
            book_title=book.title,
        ))

    graph_edges: list[ConceptGraphEdge] = []
    for edge in edges:
        if edge.target_point_id in kp_map:
            graph_edges.append(ConceptGraphEdge(
                id=edge.id,
                source=edge.source_point_id,
                target=edge.target_point_id,
                relationship_type=edge.relationship_type,
                strength=edge.strength,
                explanation=edge.explanation or None,
            ))

    return ConceptGraphOut(nodes=nodes, edges=graph_edges)


class GraphExtractRequest(BaseModel):
    force: bool = False


@router.post("/books/{book_id}/concept-graph/extract")
def extract_concept_edges(book_id: int, body: GraphExtractRequest, db: Session = Depends(get_db)):
    _load_book(db, book_id)

    if not body.force:
        existing = db.scalar(select(ConceptEdge).where(ConceptEdge.source_point_id.in_(
            select(KnowledgePoint.id).where(KnowledgePoint.book_id == book_id)
        )).limit(1))
        if existing is not None:
            return {"ok": True, "message": "Edges already exist"}
    else:
        kp_ids = list(db.scalars(select(KnowledgePoint.id).where(KnowledgePoint.book_id == book_id)))
        old_edges = list(db.scalars(select(ConceptEdge).where(ConceptEdge.source_point_id.in_(kp_ids))))
        for edge in old_edges:
            db.delete(edge)
        db.flush()

    kps = list(db.scalars(select(KnowledgePoint).where(KnowledgePoint.book_id == book_id).order_by(KnowledgePoint.id)))
    if len(kps) < 2:
        raise HTTPException(status_code=400, detail="Need at least 2 knowledge points to extract relationships")

    kp_map = {kp.id: kp for kp in kps}
    kp_list = "\n".join(f"- ID {kp.id}: {kp.name} — {kp.description}" for kp in kps)

    book = db.get(Book, book_id)
    messages = [
        {"role": "system", "content": _prompt_text("concept_edges.txt", {"book_title": book.title, "knowledge_points_list": kp_list})},
        {"role": "user", "content": "Identify the relationships between these knowledge points now."},
    ]

    try:
        raw = llm_client.complete(messages)
        items = _extract_json_array(raw)
    except Exception as exc:
        logger.exception("Concept edge extraction failed")
        raise HTTPException(status_code=502, detail=f"Extraction failed: {exc}") from exc

    created = 0
    seen: set[tuple[int, int]] = set()
    for item in items:
        src = item.get("source_id")
        tgt = item.get("target_id")
        rel = str(item.get("relationship", "related")).strip()
        strength = float(item.get("strength", 0.5))
        explanation = str(item.get("explanation", "")).strip()[:2000]

        if not isinstance(src, int) or not isinstance(tgt, int) or src == tgt:
            continue
        if src not in kp_map or tgt not in kp_map:
            continue
        if rel not in ("prerequisite", "related", "builds_on", "contrasts_with"):
            rel = "related"

        pair = (min(src, tgt), max(src, tgt))
        if pair in seen:
            continue
        seen.add(pair)

        edge = ConceptEdge(
            source_point_id=src,
            target_point_id=tgt,
            relationship_type=rel,
            strength=max(0.0, min(1.0, strength)),
            explanation=explanation,
        )
        db.add(edge)
        created += 1

    db.commit()
    return {"ok": True, "created": created}


class SectionGraphExtractRequest(BaseModel):
    force: bool = False


@router.post("/books/{book_id}/sections/{section_id}/concept-graph/extract")
def extract_section_graph(book_id: int, section_id: int, body: SectionGraphExtractRequest, db: Session = Depends(get_db)):
    _load_book(db, book_id)
    section = db.get(Section, section_id)
    if section is None or section.book_id != book_id:
        raise HTTPException(status_code=404, detail="Section not found")

    from .intelligence import _extract_section_kps

    kp_created = _extract_section_kps(db, book_id, section, force=body.force)
    db.commit()

    # Deep: collect KPs from all leaf sections under this chapter
    from ..routers.intelligence import _leaf_sections_for_chapter
    leaf_ids = [lf.id for lf in _leaf_sections_for_chapter(db, book_id, section)]
    if not leaf_ids:
        leaf_ids = [section_id]
    section_kp_ids = list(db.scalars(select(KnowledgePoint.id).where(KnowledgePoint.section_id.in_(leaf_ids)).order_by(KnowledgePoint.id)))
    if not section_kp_ids:
        return {"ok": True, "created": 0, "message": "No knowledge points extracted for this chapter"}

    kps = list(db.scalars(select(KnowledgePoint).where(KnowledgePoint.book_id == book_id).order_by(KnowledgePoint.id)))
    new_set = set(section_kp_ids)
    kp_map = {kp.id: kp for kp in kps}

    def _tag(kp: KnowledgePoint) -> str:
        return "NEW" if kp.id in new_set else "EXISTING"

    kp_list = "\n".join(f"- ID {kp.id} [{_tag(kp)}]: {kp.name} — {kp.description}" for kp in kps)

    book = db.get(Book, book_id)
    messages = [
        {"role": "system", "content": _prompt_text("concept_edges.txt", {"book_title": book.title, "knowledge_points_list": kp_list})},
        {"role": "user", "content": "Identify the relationships now."},
    ]

    try:
        raw = llm_client.complete(messages)
        items = _extract_json_array(raw)
    except Exception as exc:
        logger.exception("Section concept edge extraction failed")
        raise HTTPException(status_code=502, detail=f"Extraction failed: {exc}") from exc

    created = 0
    seen: set[tuple[int, int]] = set()
    for item in items:
        src = item.get("source_id")
        tgt = item.get("target_id")
        rel = str(item.get("relationship", "related")).strip()
        strength = float(item.get("strength", 0.5))
        explanation = str(item.get("explanation", "")).strip()[:2000]

        if not isinstance(src, int) or not isinstance(tgt, int) or src == tgt:
            continue
        if src not in kp_map or tgt not in kp_map:
            continue
        if src not in new_set and tgt not in new_set:
            continue
        if rel not in ("prerequisite", "related", "builds_on", "contrasts_with"):
            rel = "related"

        pair = (min(src, tgt), max(src, tgt))
        if pair in seen:
            continue
        seen.add(pair)

        edge = ConceptEdge(
            source_point_id=src,
            target_point_id=tgt,
            relationship_type=rel,
            strength=max(0.0, min(1.0, strength)),
            explanation=explanation,
        )
        db.add(edge)
        created += 1

    db.commit()
    total_edges = db.scalar(select(func.count()).select_from(ConceptEdge).where(
        ConceptEdge.source_point_id.in_(select(KnowledgePoint.id).where(KnowledgePoint.book_id == book_id))
    ))
    return {"ok": True, "kp_created": kp_created, "created": created, "total_edges": total_edges or 0}


@router.get("/books/{book_id}/concept-graph/{kp_id}")
def get_kp_detail(book_id: int, kp_id: int, db: Session = Depends(get_db)):
    _load_book(db, book_id)
    kp = db.get(KnowledgePoint, kp_id)
    if kp is None or kp.book_id != book_id:
        raise HTTPException(status_code=404, detail="Knowledge point not found")

    ukp = db.scalar(select(UserKnowledgePoint).where(UserKnowledgePoint.knowledge_point_id == kp.id))
    section = db.get(Section, kp.section_id)

    outgoing = list(db.scalars(select(ConceptEdge).where(ConceptEdge.source_point_id == kp.id)))
    incoming = list(db.scalars(select(ConceptEdge).where(ConceptEdge.target_point_id == kp.id)))

    connections = []
    for edge in outgoing:
        target = db.get(KnowledgePoint, edge.target_point_id)
        if target:
            connections.append({"kp_id": target.id, "name": target.name, "direction": "outgoing", "relationship_type": edge.relationship_type, "strength": edge.strength, "explanation": edge.explanation or ""})
    for edge in incoming:
        source = db.get(KnowledgePoint, edge.source_point_id)
        if source:
            connections.append({"kp_id": source.id, "name": source.name, "direction": "incoming", "relationship_type": edge.relationship_type, "strength": edge.strength, "explanation": edge.explanation or ""})

    return {
        "id": kp.id,
        "name": kp.name,
        "description": kp.description,
        "difficulty": kp.difficulty,
        "mastery": ukp.mastery if ukp else None,
        "section_id": kp.section_id,
        "section_title": section.title if section else "",
        "connections": connections,
    }
