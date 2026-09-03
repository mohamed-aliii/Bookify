import json
import logging
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from ..config import PROMPTS_DIR
from ..database import get_db
from ..models import Book, Concept, ConceptAlias, ConceptMention, ConceptRelation, Section

logger = logging.getLogger(__name__)
router = APIRouter(tags=["concepts"])


def _prompt_text(name: str, subs: dict[str, object] | None = None) -> str:
    text = (PROMPTS_DIR / name).read_text(encoding="utf-8")
    for key, value in (subs or {}).items():
        text = text.replace("{%s}" % key, str(value))
    return text


def _norm(s: str) -> str:
    return " ".join(s.strip().lower().split())


@router.get("/concepts")
def list_concepts(q: str | None = None, course_id: int | None = None, book_id: int | None = None, limit: int = 100, db: Session = Depends(get_db)):
    """Global deduped concepts, optionally filtered by provenance (course/book)."""
    query = select(Concept).order_by(Concept.canonical_name)
    concepts = list(db.scalars(query))

    # Filter by provenance if requested
    if q or course_id is not None or book_id is not None:
        filtered = []
        # course -> book ids
        course_book_ids: set[int] | None = None
        if course_id is not None:
            from ..models import CourseBook
            course_book_ids = set(db.scalars(select(CourseBook.book_id).where(CourseBook.course_id == course_id)))
            if not course_book_ids:
                return []
        q_norm = _norm(q) if q else None
        for c in concepts:
            # Check provenance
            if course_book_ids is not None or book_id is not None:
                mentions = list(db.scalars(select(ConceptMention).where(ConceptMention.concept_id == c.id)))
                if course_book_ids is not None and not any(m.book_id in course_book_ids for m in mentions):
                    continue
                if book_id is not None and not any(m.book_id == book_id for m in mentions):
                    continue
            if q_norm:
                # Match canonical name, aliases, description
                hay = (c.canonical_name + " " + c.canonical_description).lower()
                alias_terms = [a.alias_term.lower() for a in db.scalars(select(ConceptAlias).where(ConceptAlias.concept_id == c.id))]
                if q_norm not in hay and not any(q_norm in a for a in alias_terms):
                    continue
            filtered.append(c)
            if len(filtered) >= limit:
                break
        concepts = filtered
    else:
        concepts = concepts[:limit]

    result = []
    for c in concepts:
        mentions = list(db.scalars(select(ConceptMention).where(ConceptMention.concept_id == c.id)))
        aliases = list(db.scalars(select(ConceptAlias).where(ConceptAlias.concept_id == c.id)))
        result.append({
            "id": c.id,
            "canonical_name": c.canonical_name,
            "canonical_description": c.canonical_description,
            "difficulty": c.difficulty,
            "mention_count": len(mentions),
            "aliases": [a.alias_term for a in aliases],
            "mentions": [
                {
                    "book_id": m.book_id,
                    "book_title": (db.get(Book, m.book_id).title if db.get(Book, m.book_id) else "?"),
                    "section_id": m.section_id,
                    "section_title": m.section_title_snapshot or (db.get(Section, m.section_id).title if db.get(Section, m.section_id) else "?"),
                }
                for m in mentions[:8]
            ],
        })
    return result


@router.get("/concepts/{concept_id}")
def get_concept(concept_id: int, db: Session = Depends(get_db)):
    c = db.get(Concept, concept_id)
    if c is None:
        raise HTTPException(status_code=404, detail="Concept not found")
    mentions = list(db.scalars(select(ConceptMention).where(ConceptMention.concept_id == c.id).order_by(ConceptMention.book_id, ConceptMention.section_id)))
    aliases = list(db.scalars(select(ConceptAlias).where(ConceptAlias.concept_id == c.id)))
    # relations
    out_rels = list(db.scalars(select(ConceptRelation).where(ConceptRelation.source_concept_id == c.id)))
    in_rels = list(db.scalars(select(ConceptRelation).where(ConceptRelation.target_concept_id == c.id)))

    relations = []
    for r in out_rels:
        tgt = db.get(Concept, r.target_concept_id)
        relations.append({
            "id": r.id,
            "direction": "outgoing",
            "other_concept_id": r.target_concept_id,
            "other_name": tgt.canonical_name if tgt else "?",
            "relationship_type": r.relationship_type,
            "strength": r.strength,
            "explanation_long": r.explanation_long,
            "explanation_short": r.explanation_short,
        })
    for r in in_rels:
        src = db.get(Concept, r.source_concept_id)
        relations.append({
            "id": r.id,
            "direction": "incoming",
            "other_concept_id": r.source_concept_id,
            "other_name": src.canonical_name if src else "?",
            "relationship_type": r.relationship_type,
            "strength": r.strength,
            "explanation_long": r.explanation_long,
            "explanation_short": r.explanation_short,
        })

    # courses involved via mentions
    book_ids = {m.book_id for m in mentions}
    from ..models import CourseBook
    course_ids: set[int] = set()
    for bid in book_ids:
        for cb in db.scalars(select(CourseBook).where(CourseBook.book_id == bid)):
            course_ids.add(cb.course_id)

    return {
        "id": c.id,
        "canonical_name": c.canonical_name,
        "canonical_description": c.canonical_description,
        "difficulty": c.difficulty,
        "aliases": [a.alias_term for a in aliases],
        "mentions": [
            {
                "id": m.id,
                "book_id": m.book_id,
                "book_title": (db.get(Book, m.book_id).title if db.get(Book, m.book_id) else "?"),
                "section_id": m.section_id,
                "section_title": m.section_title_snapshot or (db.get(Section, m.section_id).title if db.get(Section, m.section_id) else "?"),
                "snippet": m.snippet,
            }
            for m in mentions
        ],
        "relations": relations,
        "courses_involved": list(course_ids),
        "books_involved": list(book_ids),
    }


class ConceptUpdate(BaseModel):
    canonical_name: str | None = None
    canonical_description: str | None = None


@router.patch("/concepts/{concept_id}")
def update_concept(concept_id: int, body: ConceptUpdate, db: Session = Depends(get_db)):
    c = db.get(Concept, concept_id)
    if c is None:
        raise HTTPException(status_code=404, detail="Concept not found")
    if body.canonical_name is not None and body.canonical_name.strip() != c.canonical_name:
        old_norm = c.canonical_name_norm
        new_name = body.canonical_name.strip()
        new_norm = _norm(new_name)
        # keep old as alias for search
        alias_exists = db.scalar(select(ConceptAlias).where(ConceptAlias.concept_id == c.id, ConceptAlias.alias_norm == old_norm))
        if alias_exists is None and old_norm:
            db.add(ConceptAlias(concept_id=c.id, alias_term=c.canonical_name, alias_norm=old_norm, source_book_id=None))
        # uniqueness check
        conflict = db.scalar(select(Concept).where(Concept.canonical_name_norm == new_norm, Concept.id != c.id))
        if conflict is not None:
            raise HTTPException(status_code=409, detail=f"Another concept already uses name '{new_name}'")
        c.canonical_name = new_name
        c.canonical_name_norm = new_norm
        # also ensure alias for new name
        alias_new = db.scalar(select(ConceptAlias).where(ConceptAlias.concept_id == c.id, ConceptAlias.alias_norm == new_norm))
        if alias_new is None:
            db.add(ConceptAlias(concept_id=c.id, alias_term=new_name, alias_norm=new_norm, source_book_id=None))
    if body.canonical_description is not None:
        c.canonical_description = body.canonical_description.strip()
    db.commit()
    db.refresh(c)
    return {"ok": True, "id": c.id, "canonical_name": c.canonical_name}


@router.get("/concepts-stats")
def concepts_stats(db: Session = Depends(get_db)):
    total_concepts = db.scalar(select(func.count()).select_from(Concept)) or 0
    total_mentions = db.scalar(select(func.count()).select_from(ConceptMention)) or 0
    total_aliases = db.scalar(select(func.count()).select_from(ConceptAlias)) or 0
    total_relations = db.scalar(select(func.count()).select_from(ConceptRelation)) or 0
    return {
        "total_concepts": total_concepts,
        "total_mentions": total_mentions,
        "total_aliases": total_aliases,
        "total_relations": total_relations,
    }


@router.post("/concepts/reconcile")
def reconcile_concepts(dry_run: bool = False, db: Session = Depends(get_db)):
    """Backfill: deduplicate any duplicate canonicals that slipped through (e.g., legacy KP migration).

    Groups by normalized alias overlap + embedding similarity, LLM-confirms duplicates.
    dry_run=True returns what would be merged without committing.
    """
    from ..embeddings import embedding_client
    import math

    def _cosine(a: list[float], b: list[float]) -> float:
        dot = sum(x * y for x, y in zip(a, b))
        na = math.sqrt(sum(x * x for x in a))
        nb = math.sqrt(sum(x * x for x in b))
        if na == 0 or nb == 0:
            return 0.0
        return dot / (na * nb)

    concepts = list(db.scalars(select(Concept).order_by(Concept.id)))
    if len(concepts) < 2:
        return {"ok": True, "merged": 0}

    # Build embeddings
    texts = [f"{c.canonical_name}: {c.canonical_description}" for c in concepts]
    embs: list[list[float]] = []
    for _, batch in embedding_client.embed_batches(texts):
        embs.extend(batch)

    merged = 0
    to_delete: set[int] = set()
    for i in range(len(concepts)):
        if concepts[i].id in to_delete:
            continue
        for j in range(i + 1, len(concepts)):
            if concepts[j].id in to_delete:
                continue
            # Quick norm exact alias collision → likely duplicate
            if concepts[i].canonical_name_norm == concepts[j].canonical_name_norm:
                sim = 1.0
            else:
                sim = _cosine(embs[i], embs[j])
                if sim < 0.82:
                    continue
            # LLM confirm
            try:
                from ..llm import llm_client
                prompt = _prompt_text("concept_resolve.txt", {
                    "existing_id": str(concepts[i].id),
                    "existing_name": concepts[i].canonical_name,
                    "existing_desc": concepts[i].canonical_description,
                    "existing_book_title": "?",
                    "existing_section_title": "?",
                    "existing_snippet": concepts[i].canonical_description[:400],
                    "existing_aliases": ", ".join(a.alias_term for a in db.scalars(select(ConceptAlias).where(ConceptAlias.concept_id == concepts[i].id).limit(5))) or "—",
                    "proposed_name": concepts[j].canonical_name,
                    "proposed_desc": concepts[j].canonical_description,
                    "proposed_difficulty": str(concepts[j].difficulty),
                    "proposed_book_title": "?",
                    "proposed_section_title": "?",
                    "proposed_snippet": concepts[j].canonical_description[:400],
                    "similarity": f"{sim:.3f}",
                })
                raw = llm_client.complete([
                    {"role": "system", "content": prompt},
                    {"role": "user", "content": "Decide now. Return JSON only."},
                ])
                import json
                cleaned = raw.strip()
                if cleaned.startswith("```"):
                    cleaned = "\n".join(cleaned.splitlines()[1:-1]).strip()
                start, end = cleaned.find("{"), cleaned.rfind("}")
                if start != -1 and end > start:
                    data = json.loads(cleaned[start:end+1])
                    decision = data.get("decision", "unrelated")
                else:
                    decision = "unrelated"
            except Exception:
                decision = "duplicate_same_context" if sim >= 0.92 else "unrelated"

            if decision != "duplicate_same_context":
                continue

            # Merge j into i
            if dry_run:
                merged += 1
                continue
            # Move mentions
            mentions_j = list(db.scalars(select(ConceptMention).where(ConceptMention.concept_id == concepts[j].id)))
            for m in mentions_j:
                # avoid duplicate mention unique constraint
                exists = db.scalar(select(ConceptMention).where(ConceptMention.concept_id == concepts[i].id, ConceptMention.book_id == m.book_id, ConceptMention.section_id == m.section_id))
                if exists is None:
                    m.concept_id = concepts[i].id
                else:
                    db.delete(m)
            # Move aliases
            aliases_j = list(db.scalars(select(ConceptAlias).where(ConceptAlias.concept_id == concepts[j].id)))
            for a in aliases_j:
                exists = db.scalar(select(ConceptAlias).where(ConceptAlias.concept_id == concepts[i].id, ConceptAlias.alias_norm == a.alias_norm))
                if exists is None:
                    a.concept_id = concepts[i].id
                else:
                    db.delete(a)
            # Move relations
            rels_out = list(db.scalars(select(ConceptRelation).where(ConceptRelation.source_concept_id == concepts[j].id)))
            for r in rels_out:
                r.source_concept_id = concepts[i].id
            rels_in = list(db.scalars(select(ConceptRelation).where(ConceptRelation.target_concept_id == concepts[j].id)))
            for r in rels_in:
                r.target_concept_id = concepts[i].id
            # Ensure new name alias
            alias_new = db.scalar(select(ConceptAlias).where(ConceptAlias.concept_id == concepts[i].id, ConceptAlias.alias_norm == concepts[j].canonical_name_norm))
            if alias_new is None:
                db.add(ConceptAlias(concept_id=concepts[i].id, alias_term=concepts[j].canonical_name, alias_norm=concepts[j].canonical_name_norm, source_book_id=None))
            to_delete.add(concepts[j].id)
            merged += 1

    if not dry_run and to_delete:
        for cid in to_delete:
            obj = db.get(Concept, cid)
            if obj:
                db.delete(obj)
        db.commit()
    return {"ok": True, "merged": merged, "dry_run": dry_run}
