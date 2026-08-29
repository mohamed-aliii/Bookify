import json
import logging
import math

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import select
from sqlalchemy.orm import Session

from ..config import PROMPTS_DIR
from ..database import get_db
from ..embeddings import embedding_client
from ..llm import llm_client
from ..models import (
    Book,
    ConceptCluster,
    ConceptClusterMember,
    ConceptEdge,
    CrossBookLink,
    KnowledgePoint,
    Section,
    UserKnowledgePoint,
)
from ..schemas import (
    ConceptGraphEdge,
    ConceptGraphNode,
    CrossBookLinkOut,
    RelatedSectionOut,
    UnifiedGraphOut,
)
from ..xp_engine import award_xp

logger = logging.getLogger(__name__)
router = APIRouter(tags=["crossbook"])


def _prompt_text(name: str, subs: dict[str, object] | None = None) -> str:
    text = (PROMPTS_DIR / name).read_text(encoding="utf-8")
    for key, value in (subs or {}).items():
        text = text.replace("{%s}" % key, str(value))
    return text


def _extract_json(text: str) -> dict:
    cleaned = text.strip()
    if cleaned.startswith("```"):
        cleaned = "\n".join(cleaned.splitlines()[1:-1]).strip()
    start, end = cleaned.find("{"), cleaned.rfind("}")
    if start == -1 or end <= start:
        raise ValueError("No JSON object found")
    return json.loads(cleaned[start : end + 1])


def _cosine_similarity(a: list[float], b: list[float]) -> float:
    dot = sum(x * y for x, y in zip(a, b))
    na = math.sqrt(sum(x * x for x in a))
    nb = math.sqrt(sum(x * x for x in b))
    if na == 0 or nb == 0:
        return 0.0
    return dot / (na * nb)


@router.post("/cross-book/extract")
def extract_cross_book_links(db: Session = Depends(get_db)):
    kps = list(db.scalars(select(KnowledgePoint).order_by(KnowledgePoint.id)))
    if len(kps) < 2:
        return {"ok": True, "created": 0, "clusters": 0}

    texts = [f"{kp.name}: {kp.description}" for kp in kps]
    embeddings = embedding_client.embed_texts(texts)
    kp_map = {kp.id: kp for kp in kps}
    book_cache: dict[int, Book] = {}

    existing = list(db.scalars(select(CrossBookLink)))
    existing_pairs = {(l.source_kp_id, l.target_kp_id) for l in existing}

    created = 0
    for i in range(len(kps)):
        for j in range(i + 1, len(kps)):
            a, b = kps[i], kps[j]
            if a.book_id == b.book_id:
                continue
            pair = (min(a.id, b.id), max(a.id, b.id))
            if pair in existing_pairs:
                continue

            sim = _cosine_similarity(embeddings[i], embeddings[j])
            if sim < 0.60:
                continue

            if sim >= 0.80:
                label = "same_concept"
                explanation = f"Both describe closely related concepts (similarity: {sim:.0%})"
            else:
                ba = book_cache.setdefault(a.book_id, db.get(Book, a.book_id))
                bb = book_cache.setdefault(b.book_id, db.get(Book, b.book_id))
                try:
                    messages = [
                        {"role": "system", "content": _prompt_text("cross_book_link.txt", {
                            "concept_a_name": a.name, "book_a_title": ba.title if ba else "?",
                            "concept_a_desc": a.description,
                            "concept_b_name": b.name, "book_b_title": bb.title if bb else "?",
                            "concept_b_desc": b.description,
                        })},
                        {"role": "user", "content": "Evaluate now."},
                    ]
                    raw = llm_client.complete(messages)
                    result = _extract_json(raw)
                    if not result.get("related"):
                        continue
                    label = result.get("label", "related")
                    explanation = result.get("explanation", "")
                except Exception:
                    label = "related"
                    explanation = f"Concepts with {sim:.0%} similarity"

            src_id, tgt_id = pair
            db.add(CrossBookLink(
                source_kp_id=src_id,
                target_kp_id=tgt_id,
                similarity=sim,
                relationship_label=label,
                explanation=explanation,
            ))
            created += 1
            existing_pairs.add(pair)

    db.commit()

    try:
        award_xp(db, "cross_book_discovery", xp_override=created * 25)
    except Exception:
        pass

    return {"ok": True, "created": created}


@router.get("/cross-book/links")
def get_links(book_id: int | None = None, db: Session = Depends(get_db)):
    query = select(CrossBookLink)
    links = list(db.scalars(query))
    results = []
    for link in links:
        src_kp = db.get(KnowledgePoint, link.source_kp_id)
        tgt_kp = db.get(KnowledgePoint, link.target_kp_id)
        if src_kp is None or tgt_kp is None:
            continue
        src_book = db.get(Book, src_kp.book_id)
        tgt_book = db.get(Book, tgt_kp.book_id)
        if book_id and src_kp.book_id != book_id and tgt_kp.book_id != book_id:
            continue
        results.append({
            "id": link.id,
            "source_kp_id": link.source_kp_id,
            "target_kp_id": link.target_kp_id,
            "similarity": link.similarity,
            "relationship_label": link.relationship_label,
            "explanation": link.explanation,
            "source_book_title": src_book.title if src_book else None,
            "target_book_title": tgt_book.title if tgt_book else None,
            "source_kp_name": src_kp.name,
            "target_kp_name": tgt_kp.name,
        })
    return results


@router.get("/cross-book/clusters")
def get_clusters(db: Session = Depends(get_db)):
    clusters = list(db.scalars(select(ConceptCluster).order_by(ConceptCluster.id)))
    results = []
    for cluster in clusters:
        members = list(db.scalars(
            select(ConceptClusterMember).where(ConceptClusterMember.cluster_id == cluster.id)
        ))
        book_ids = {m.book_id for m in members}
        book_titles = []
        for bid in book_ids:
            b = db.get(Book, bid)
            if b:
                book_titles.append(b.title)
        results.append({
            "id": cluster.id,
            "name": cluster.name,
            "description": cluster.description,
            "member_count": len(members),
            "books_involved": book_titles,
        })
    return results


@router.get("/cross-book/unified-graph")
def get_unified_graph(db: Session = Depends(get_db)):
    kps = list(db.scalars(select(KnowledgePoint).order_by(KnowledgePoint.id)))
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
        ))

    intra_edges = list(db.scalars(select(ConceptEdge)))
    intra = [
        ConceptGraphEdge(
            id=e.id, source=e.source_point_id, target=e.target_point_id,
            relationship_type=e.relationship_type, strength=e.strength,
        )
        for e in intra_edges
        if e.target_point_id in kp_map
    ]

    cross_links = list(db.scalars(select(CrossBookLink)))
    inter: list[dict] = []
    for link in cross_links:
        src_kp = db.get(KnowledgePoint, link.source_kp_id)
        tgt_kp = db.get(KnowledgePoint, link.target_kp_id)
        if not src_kp or not tgt_kp:
            continue
        src_book = db.get(Book, src_kp.book_id)
        tgt_book = db.get(Book, tgt_kp.book_id)
        inter.append({
            "id": link.id,
            "source_kp_id": link.source_kp_id,
            "target_kp_id": link.target_kp_id,
            "similarity": link.similarity,
            "relationship_label": link.relationship_label,
            "explanation": link.explanation,
            "source_book_title": src_book.title if src_book else None,
            "target_book_title": tgt_book.title if tgt_book else None,
            "source_kp_name": src_kp.name,
            "target_kp_name": tgt_kp.name,
        })

    return {
        "nodes": [n.model_dump() for n in nodes],
        "intra_edges": [e.model_dump() for e in intra],
        "inter_edges": inter,
    }


@router.get("/cross-book/related/{book_id}/{section_id}")
def get_related_sections(book_id: int, section_id: int, db: Session = Depends(get_db)):
    section = db.get(Section, section_id)
    if section is None:
        raise HTTPException(status_code=404, detail="Section not found")

    section_kps = list(db.scalars(
        select(KnowledgePoint).where(KnowledgePoint.section_id == section_id)
    ))
    if not section_kps:
        return []

    kp_ids = {kp.id for kp in section_kps}
    related_kp_ids: dict[int, float] = {}

    for link in db.scalars(select(CrossBookLink)):
        if link.source_kp_id in kp_ids:
            related_kp_ids[link.target_kp_id] = max(related_kp_ids.get(link.target_kp_id, 0), link.similarity)
        elif link.target_kp_id in kp_ids:
            related_kp_ids[link.source_kp_id] = max(related_kp_ids.get(link.source_kp_id, 0), link.similarity)

    if not related_kp_ids:
        return []

    section_scores: dict[tuple[int, int], dict] = {}
    for rkp_id, sim in related_kp_ids.items():
        rkp = db.get(KnowledgePoint, rkp_id)
        if rkp is None:
            continue
        key = (rkp.book_id, rkp.section_id)
        if key not in section_scores:
            book = db.get(Book, rkp.book_id)
            sect = db.get(Section, rkp.section_id)
            section_scores[key] = {
                "book_id": rkp.book_id,
                "book_title": book.title if book else "?",
                "section_id": rkp.section_id,
                "section_title": sect.title if sect else "?",
                "page_start": sect.page_start if sect else 0,
                "page_end": sect.page_end if sect else 0,
                "max_similarity": 0,
                "shared_clusters": [],
                "explanation": "",
            }
        section_scores[key]["max_similarity"] = max(section_scores[key]["max_similarity"], sim)

    results = sorted(section_scores.values(), key=lambda x: x["max_similarity"], reverse=True)[:10]

    current_book = db.get(Book, book_id)
    for r in results:
        other_book = db.get(Book, r["book_id"])
        try:
            messages = [
                {"role": "system", "content": _prompt_text("related_sections.txt", {
                    "section_a_title": section.title,
                    "book_a_title": current_book.title if current_book else "?",
                    "section_a_topics": ", ".join(kp.name for kp in section_kps),
                    "section_b_title": r["section_title"],
                    "book_b_title": r["book_title"],
                    "section_b_topics": "",
                    "shared_clusters": ", ".join(r["shared_clusters"]) if r["shared_clusters"] else "none yet",
                })},
                {"role": "user", "content": "Explain why these sections are related."},
            ]
            r["explanation"] = llm_client.complete(messages).strip()[:300]
        except Exception:
            r["explanation"] = f"Both sections share related concepts ({r['max_similarity']:.0%} similarity)"

    return results
