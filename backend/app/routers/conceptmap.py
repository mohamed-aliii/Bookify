import json
import logging

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from ..config import PROMPTS_DIR
from ..database import get_db
from ..llm import llm_client
from ..models import Book, Concept, ConceptEdge, ConceptMention, ConceptRelation, KnowledgePoint, Section, UserKnowledgePoint
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
    """Book-scoped view of the GLOBAL canonical graph — shows Concepts that have a mention in this book."""
    book = _load_book(db, book_id)

    # Canonical concepts with at least one mention in this book
    mention_concept_ids = set(db.scalars(select(ConceptMention.concept_id).where(ConceptMention.book_id == book_id)))
    if not mention_concept_ids:
        # Fallback to legacy KnowledgePoints if no canonical mentions yet (pre-migration)
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
                    id=edge.id, source=edge.source_point_id, target=edge.target_point_id,
                    relationship_type=edge.relationship_type, strength=edge.strength, explanation=edge.explanation or None))
        return ConceptGraphOut(nodes=nodes, edges=graph_edges)

    concepts = list(db.scalars(select(Concept).where(Concept.id.in_(mention_concept_ids)).order_by(Concept.id)))
    # Mastery: aggregate UKP average if Concept has multiple legacy KP mappings? For now None
    nodes: list[ConceptGraphNode] = []
    for c in concepts:
        # pick primary mention for section/title
        primary = db.scalar(select(ConceptMention).where(ConceptMention.concept_id == c.id, ConceptMention.book_id == book_id).limit(1))
        section = db.get(Section, primary.section_id) if primary else None
        # Legacy mastery fallback: look up any old KP with same canonical name in this book
        ukp = None
        legacy_kp = db.scalar(select(KnowledgePoint).where(KnowledgePoint.book_id == book_id, KnowledgePoint.name == c.canonical_name).limit(1))
        if legacy_kp:
            ukp = db.scalar(select(UserKnowledgePoint).where(UserKnowledgePoint.knowledge_point_id == legacy_kp.id))
        nodes.append(ConceptGraphNode(
            id=c.id,
            name=c.canonical_name,
            description=c.canonical_description,
            difficulty=c.difficulty,
            mastery=ukp.mastery if ukp else None,
            section_id=primary.section_id if primary else 0,
            section_title=section.title if section else (primary.section_title_snapshot if primary else ""),
            book_id=book_id,
            book_title=book.title,
        ))

    # Edges: both legacy ConceptEdge (via legacy KP mapping) + new ConceptRelation for these concepts
    concept_ids = {c.id for c in concepts}
    # New canonical edges
    rels = list(db.scalars(select(ConceptRelation).where(
        ConceptRelation.source_concept_id.in_(concept_ids),
        ConceptRelation.target_concept_id.in_(concept_ids),
    )))
    graph_edges: list[ConceptGraphEdge] = [
        ConceptGraphEdge(id=r.id, source=r.source_concept_id, target=r.target_concept_id,
                         relationship_type=r.relationship_type, strength=r.strength, explanation=r.explanation_long or r.explanation_short)
        for r in rels
    ]
    # Legacy fallback edges (map legacy KP ids → concept ids). If no canonical edges yet, add legacy ones translated.
    if not graph_edges:
        kps = list(db.scalars(select(KnowledgePoint).where(KnowledgePoint.book_id == book_id)))
        kp_to_concept: dict[int, int] = {}
        for kp in kps:
            cand = db.scalar(select(Concept).where(Concept.canonical_name_norm == kp.name.strip().lower()).limit(1))
            if cand and cand.id in concept_ids:
                kp_to_concept[kp.id] = cand.id
        legacy_edges = list(db.scalars(select(ConceptEdge).where(ConceptEdge.source_point_id.in_(kp_to_concept.keys()))))
        for e in legacy_edges:
            src = kp_to_concept.get(e.source_point_id)
            tgt = kp_to_concept.get(e.target_point_id)
            if src and tgt and src != tgt:
                if not any(ge.source == src and ge.target == tgt or ge.source == tgt and ge.target == src for ge in graph_edges):
                    graph_edges.append(ConceptGraphEdge(id=e.id + 100000, source=src, target=tgt, relationship_type=e.relationship_type, strength=e.strength, explanation=e.explanation))

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
        raw = llm_client.complete_for_cross_kg(messages)
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
        raw = llm_client.complete_for_cross_kg(messages)
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


def _clear_chapter_kg(db: Session, book_id: int, section: Section) -> dict:
    """Remove all KG output (ConceptMentions + legacy KPs/edges) for the given chapter/section.

    - Deletes ConceptMentions for all leaf sections under `section` for this book.
    - Orphan Concepts (no remaining mentions) are deleted along with their aliases and relations.
    - Legacy KnowledgePoints + ConceptEdges for those leaves are also removed.

    Returns stats dict.
    """
    from sqlalchemy import delete as sa_delete
    from ..models import ConceptAlias as CA, ConceptMention as CM, ConceptRelation as CR

    # Resolve leaf ids for this chapter
    try:
        from .intelligence import _leaf_sections_for_chapter
        leaf_ids = [lf.id for lf in _leaf_sections_for_chapter(db, book_id, section)]
        if not leaf_ids:
            leaf_ids = [section.id]
    except Exception:
        leaf_ids = [section.id]

    # Gather affected concept ids before deletion (for orphan check)
    affected_cids: set[int] = set()
    for leaf_id in leaf_ids:
        for mid in db.scalars(select(CM.concept_id).where(CM.book_id == book_id, CM.section_id == leaf_id)):
            affected_cids.add(mid)

    # Delete ConceptMentions for this chapter
    mentions_deleted = 0
    if leaf_ids:
        result = db.execute(sa_delete(CM).where(CM.book_id == book_id, CM.section_id.in_(leaf_ids)))
        mentions_deleted = result.rowcount or 0

    # Legacy cleanup: KnowledgePoints + ConceptEdges for those leaves
    legacy_kp_ids = list(db.scalars(select(KnowledgePoint.id).where(KnowledgePoint.book_id == book_id, KnowledgePoint.section_id.in_(leaf_ids)))) if leaf_ids else []
    legacy_kps_deleted = 0
    legacy_edges_deleted = 0
    if legacy_kp_ids:
        legacy_kps_deleted = db.execute(sa_delete(KnowledgePoint).where(KnowledgePoint.id.in_(legacy_kp_ids))).rowcount or 0
        # ConceptEdge stores both source/target as KnowledgePoint ids; delete where either is in legacy set
        if legacy_kp_ids:
            # Need to handle both source and target
            for eid in list(db.scalars(select(ConceptEdge.id).where((ConceptEdge.source_point_id.in_(legacy_kp_ids)) | (ConceptEdge.target_point_id.in_(legacy_kp_ids))))):
                obj = db.get(ConceptEdge, eid)
                if obj:
                    db.delete(obj)
                    legacy_edges_deleted += 1

    # Orphan Concept cleanup: concepts that now have zero mentions
    orphan_concepts = 0
    orphan_relations = 0
    orphan_aliases = 0
    for cid in list(affected_cids):
        remaining = db.scalar(select(func.count()).select_from(CM).where(CM.concept_id == cid))
        if not remaining:
            # Delete aliases first
            for alias in list(db.scalars(select(CA).where(CA.concept_id == cid))):
                db.delete(alias)
                orphan_aliases += 1
            # Delete relations where this concept is source or target
            for rel in list(db.scalars(select(CR).where((CR.source_concept_id == cid) | (CR.target_concept_id == cid)))):
                db.delete(rel)
                orphan_relations += 1
            # Delete concept itself
            cobj = db.get(Concept, cid)
            if cobj:
                db.delete(cobj)
                orphan_concepts += 1

    db.flush()
    return {
        "leaf_sections": len(leaf_ids),
        "mentions_deleted": mentions_deleted,
        "legacy_kps_deleted": legacy_kps_deleted,
        "legacy_edges_deleted": legacy_edges_deleted,
        "orphan_concepts_deleted": orphan_concepts,
        "orphan_relations_deleted": orphan_relations,
        "orphan_aliases_deleted": orphan_aliases,
    }


@router.delete("/books/{book_id}/concept-graph")
def delete_book_concept_graph(book_id: int, db: Session = Depends(get_db)):
    """Remove all KG extraction output for the entire book."""
    book = _load_book(db, book_id)
    from sqlalchemy import delete as sa_delete
    from ..models import ConceptAlias as CA, ConceptMention as CM, ConceptRelation as CR

    affected_cids = set(db.scalars(select(CM.concept_id).where(CM.book_id == book_id)))
    mentions_deleted = db.execute(sa_delete(CM).where(CM.book_id == book_id)).rowcount or 0

    legacy_kp_ids = list(db.scalars(select(KnowledgePoint.id).where(KnowledgePoint.book_id == book_id)))
    legacy_edges_deleted = 0
    if legacy_kp_ids:
        for eid in list(db.scalars(select(ConceptEdge.id).where((ConceptEdge.source_point_id.in_(legacy_kp_ids)) | (ConceptEdge.target_point_id.in_(legacy_kp_ids))))):
            obj = db.get(ConceptEdge, eid)
            if obj:
                db.delete(obj)
                legacy_edges_deleted += 1
        db.flush()
    legacy_kps_deleted = db.execute(sa_delete(KnowledgePoint).where(KnowledgePoint.book_id == book_id)).rowcount or 0

    orphan_concepts = 0
    orphan_relations = 0
    orphan_aliases = 0
    for cid in list(affected_cids):
        remaining = db.scalar(select(func.count()).select_from(CM).where(CM.concept_id == cid))
        if not remaining:
            for alias in list(db.scalars(select(CA).where(CA.concept_id == cid))):
                db.delete(alias)
                orphan_aliases += 1
            for rel in list(db.scalars(select(CR).where((CR.source_concept_id == cid) | (CR.target_concept_id == cid)))):
                db.delete(rel)
                orphan_relations += 1
            cobj = db.get(Concept, cid)
            if cobj:
                db.delete(cobj)
                orphan_concepts += 1

    db.commit()
    return {"ok": True, "book_id": book_id, "mentions_deleted": mentions_deleted, "legacy_kps_deleted": legacy_kps_deleted, "legacy_edges_deleted": legacy_edges_deleted, "orphan_concepts_deleted": orphan_concepts, "orphan_relations_deleted": orphan_relations}


@router.delete("/books/{book_id}/sections/{section_id}/concept-graph")
def delete_section_concept_graph(book_id: int, section_id: int, db: Session = Depends(get_db)):
    """Remove KG extraction output for a single chapter/section (and its leaves)."""
    book = _load_book(db, book_id)
    section = db.get(Section, section_id)
    if section is None or section.book_id != book_id:
        raise HTTPException(status_code=404, detail="Section not found")
    stats = _clear_chapter_kg(db, book_id, section)
    db.commit()
    return {"ok": True, "book_id": book_id, "section_id": section_id, **stats}


@router.get("/books/{book_id}/concept-graph/{kp_id}")
def get_kp_detail(book_id: int, kp_id: int, db: Session = Depends(get_db)):
    """Dual path: if kp_id is a canonical Concept id (has mention in this book), serve canonical; else fall back to legacy KnowledgePoint."""
    _load_book(db, book_id)
    # Try canonical first
    concept = db.get(Concept, kp_id)
    has_mention = db.scalar(select(ConceptMention).where(ConceptMention.concept_id == kp_id, ConceptMention.book_id == book_id).limit(1)) if concept else None
    if concept and has_mention:
        # Legacy mastery via KP alias
        legacy_kp = db.scalar(select(KnowledgePoint).where(KnowledgePoint.book_id == book_id, KnowledgePoint.name == concept.canonical_name).limit(1))
        ukp = db.scalar(select(UserKnowledgePoint).where(UserKnowledgePoint.knowledge_point_id == legacy_kp.id)) if legacy_kp else None
        section = db.get(Section, has_mention.section_id) if has_mention else None
        # Fetch TXT snippets for current concept
        current_mention = db.scalar(select(ConceptMention).where(ConceptMention.concept_id == concept.id).limit(1))
        current_txt = concept.canonical_description
        current_snippet = current_mention.snippet if current_mention else None
        outgoing = list(db.scalars(select(ConceptRelation).where(ConceptRelation.source_concept_id == concept.id)))
        incoming = list(db.scalars(select(ConceptRelation).where(ConceptRelation.target_concept_id == concept.id)))
        connections = []
        for r in outgoing:
            tgt = db.get(Concept, r.target_concept_id)
            if tgt:
                tgt_mention = db.scalar(select(ConceptMention).where(ConceptMention.concept_id == tgt.id).limit(1))
                connections.append({
                    "kp_id": tgt.id,
                    "name": tgt.canonical_name,
                    "description": tgt.canonical_description,
                    "snippet": tgt_mention.snippet if tgt_mention else None,
                    "section_title": tgt_mention.section_title_snapshot if tgt_mention else None,
                    "book_title": (db.get(Book, tgt_mention.book_id).title if tgt_mention and db.get(Book, tgt_mention.book_id) else None),
                    "direction": "outgoing",
                    "relationship_type": r.relationship_type,
                    "strength": r.strength,
                    "explanation": r.explanation_long or r.explanation_short,
                    "source_txt": current_txt,
                    "source_snippet": current_snippet,
                    "target_txt": tgt.canonical_description,
                    "target_snippet": tgt_mention.snippet if tgt_mention else None,
                })
        for r in incoming:
            src = db.get(Concept, r.source_concept_id)
            if src:
                src_mention = db.scalar(select(ConceptMention).where(ConceptMention.concept_id == src.id).limit(1))
                connections.append({
                    "kp_id": src.id,
                    "name": src.canonical_name,
                    "description": src.canonical_description,
                    "snippet": src_mention.snippet if src_mention else None,
                    "section_title": src_mention.section_title_snapshot if src_mention else None,
                    "book_title": (db.get(Book, src_mention.book_id).title if src_mention and db.get(Book, src_mention.book_id) else None),
                    "direction": "incoming",
                    "relationship_type": r.relationship_type,
                    "strength": r.strength,
                    "explanation": r.explanation_long or r.explanation_short,
                    "source_txt": src.canonical_description,
                    "source_snippet": src_mention.snippet if src_mention else None,
                    "target_txt": current_txt,
                    "target_snippet": current_snippet,
                })
        # Include legacy ConceptEdge-based connections if no canonical relations yet
        if not connections and legacy_kp:
            for e in db.scalars(select(ConceptEdge).where(ConceptEdge.source_point_id == legacy_kp.id)):
                tgt = db.get(KnowledgePoint, e.target_point_id)
                if tgt:
                    cand = db.scalar(select(Concept).where(Concept.canonical_name_norm == tgt.name.strip().lower()).limit(1))
                    connections.append({"kp_id": cand.id if cand else tgt.id, "name": cand.canonical_name if cand else tgt.name, "direction": "outgoing", "relationship_type": e.relationship_type, "strength": e.strength, "explanation": e.explanation or ""})
            for e in db.scalars(select(ConceptEdge).where(ConceptEdge.target_point_id == legacy_kp.id)):
                src = db.get(KnowledgePoint, e.source_point_id)
                if src:
                    cand = db.scalar(select(Concept).where(Concept.canonical_name_norm == src.name.strip().lower()).limit(1))
                    connections.append({"kp_id": cand.id if cand else src.id, "name": cand.canonical_name if cand else src.name, "direction": "incoming", "relationship_type": e.relationship_type, "strength": e.strength, "explanation": e.explanation or ""})
        return {
            "id": concept.id,
            "name": concept.canonical_name,
            "description": concept.canonical_description,
            "difficulty": concept.difficulty,
            "mastery": ukp.mastery if ukp else None,
            "section_id": has_mention.section_id,
            "section_title": section.title if section else has_mention.section_title_snapshot,
            "connections": connections,
        }

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
            connections.append({
                "kp_id": target.id,
                "name": target.name,
                "description": target.description,
                "snippet": None,
                "direction": "outgoing",
                "relationship_type": edge.relationship_type,
                "strength": edge.strength,
                "explanation": edge.explanation or "",
                "source_txt": kp.description,
                "target_txt": target.description,
            })
    for edge in incoming:
        source = db.get(KnowledgePoint, edge.source_point_id)
        if source:
            connections.append({
                "kp_id": source.id,
                "name": source.name,
                "description": source.description,
                "snippet": None,
                "direction": "incoming",
                "relationship_type": edge.relationship_type,
                "strength": edge.strength,
                "explanation": edge.explanation or "",
                "source_txt": source.description,
                "target_txt": kp.description,
            })

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
