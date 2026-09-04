import json
import logging
import math
from datetime import datetime

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy import delete, func, or_, select
from sqlalchemy.orm import Session

from ..config import PROMPTS_DIR
from ..database import get_db
from ..embeddings import embedding_client
from ..llm import llm_client
from ..models import (
    Book,
    Chunk,
    Concept,
    ConceptAlias,
    ConceptEdge,
    ConceptMention,
    ConceptRelation,
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


def _extract_json_obj(text: str) -> dict:
    cleaned = text.strip()
    if cleaned.startswith("```"):
        cleaned = "\n".join(cleaned.splitlines()[1:-1]).strip()
    start, end = cleaned.find("{"), cleaned.rfind("}")
    if start == -1 or end <= start:
        raise ValueError("No JSON object found")
    return json.loads(cleaned[start : end + 1])


def _norm_name(s: str) -> str:
    return " ".join(s.strip().lower().split())


def _cosine(a: list[float], b: list[float]) -> float:
    dot = sum(x * y for x, y in zip(a, b))
    na = math.sqrt(sum(x * x for x in a))
    nb = math.sqrt(sum(x * x for x in b))
    if na == 0 or nb == 0:
        return 0.0
    return dot / (na * nb)


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


def _extract_chapter_learning_map(db: Session, book_id: int, chapter: Section) -> list[dict]:
    """Extract a structured learning map for an entire chapter in a single LLM call.

    Collects all chunks from all leaf sections under this chapter,
    then asks the LLM to produce 5-15 high-quality concepts with
    prerequisites, importance, bloom level, and why-it-matters.
    """
    leaves = _leaf_sections_for_chapter(db, book_id, chapter)
    all_chunks: list[Chunk] = []
    for leaf in leaves:
        all_chunks.extend(_section_all_chunks(db, book_id, leaf.id))
    if not all_chunks:
        return []

    total_chars = sum(len(c.text) for c in all_chunks)
    # Soft guidance based on chapter density
    hint_count = max(5, min(15, round(total_chars / 3000) if total_chars > 0 else 8))
    hint_text = f"This chapter '{chapter.title}' has ~{total_chars} chars across {len(leaves)} subsections. Aim for {hint_count} concepts (5-15 range)."

    # Use up to 40 spread excerpts to give the LLM full chapter context
    excerpt_chunks = _spread(all_chunks, 40)
    excerpts = _excerpts_text(excerpt_chunks)

    messages = [
        {"role": "system", "content": _prompt_text("knowledge_points_deep.txt", {"hint_text": hint_text})},
        {"role": "user", "content": f"Chapter: \"{chapter.title}\"\n\n{excerpts}\n\nExtract the learning map now."},
    ]
    try:
        raw = llm_client.complete_for_cross_kg(messages)
        items = _extract_json_array(raw)
        return items
    except Exception as exc:
        logger.warning("Chapter learning map extraction failed for %s: %s", chapter.title, exc)
        return []


def _resolve_or_create_concept(
    db: Session,
    book: Book,
    section: Section,
    proposed_name: str,
    proposed_desc: str,
    proposed_diff: float,
    section_snippet: str,
    importance: str = "core",
    bloom_level: str = "understand",
    why_it_matters: str = "",
) -> tuple[int, bool, str]:
    """Global dedup: resolve proposed concept against existing Concepts.

    Uses a tiered strategy:
    - Exact alias match → duplicate (no LLM)
    - Cosine ≥ 0.85 with exact/substring name → duplicate (no LLM)
    - Cosine 0.65-0.85 → LLM adjudication (ambiguous zone)
    - Cosine < 0.65 → new concept (no LLM)

    Returns (concept_id, is_new, decision).
    """
    norm = _norm_name(proposed_name)

    # --- Fast path: alias table match ---
    alias_hit = db.scalar(select(ConceptAlias).where(ConceptAlias.alias_norm == norm).limit(1))
    if alias_hit is not None:
        existing_mention = db.scalar(select(ConceptMention).where(
            ConceptMention.concept_id == alias_hit.concept_id,
            ConceptMention.book_id == book.id,
            ConceptMention.section_id == section.id,
        ))
        if existing_mention is None:
            db.add(ConceptMention(concept_id=alias_hit.concept_id, book_id=book.id, section_id=section.id, section_title_snapshot=section.title, snippet=section_snippet[:1200]))
            db.flush()
        return alias_hit.concept_id, False, "alias_duplicate"

    # --- Embedding recall ---
    existing_concepts = list(db.scalars(select(Concept).order_by(Concept.id)))
    if not existing_concepts:
        return _create_new_concept(db, book, section, proposed_name, norm, proposed_desc, proposed_diff, section_snippet, importance, bloom_level, why_it_matters)

    best_sim = 0.0
    best_cand: Concept | None = None
    try:
        prop_text = f"[{book.title} | {section.title}] {proposed_name}: {proposed_desc}"
        prop_emb = embedding_client.embed_texts([prop_text])[0]
        cand_texts = [f"{c.canonical_name}: {c.canonical_description}" for c in existing_concepts]
        cand_embs: list[list[float]] = []
        for _, batch in embedding_client.embed_batches(cand_texts):
            cand_embs.extend(batch)
        for c, emb in zip(existing_concepts, cand_embs):
            s = _cosine(prop_emb, emb)
            if s > best_sim:
                best_sim = s
                best_cand = c
    except Exception as exc:
        logger.warning("Embedding recall failed for %s: %s", proposed_name, exc)
        # Fallback: exact name match only
        exact = db.scalar(select(Concept).where(Concept.canonical_name_norm == norm))
        if exact is not None:
            best_cand = exact
            best_sim = 1.0

    # --- Tier 1: Clear duplicate (high similarity + name overlap) ---
    if best_cand is not None and best_sim >= 0.85:
        is_name_match = (norm == best_cand.canonical_name_norm or
                         norm in best_cand.canonical_name_norm or
                         best_cand.canonical_name_norm in norm)
        if is_name_match:
            return _link_existing_concept(db, book, section, best_cand, proposed_name, norm, section_snippet)

    # --- Tier 2: Clear new (low similarity) ---
    if best_cand is None or best_sim < 0.65:
        return _create_new_concept(db, book, section, proposed_name, norm, proposed_desc, proposed_diff, section_snippet, importance, bloom_level, why_it_matters)

    # --- Tier 3: Ambiguous zone (0.65-0.85) — use LLM adjudication ---
    try:
        cand_mentions = list(db.scalars(select(ConceptMention).where(ConceptMention.concept_id == best_cand.id).limit(3)))
        cand_books = []
        cand_sections = []
        for m in cand_mentions:
            b = db.get(Book, m.book_id)
            if b:
                cand_books.append(b.title)
            cand_sections.append(m.section_title_snapshot)
        cand_snippet = (cand_mentions[0].snippet or "")[:400] if cand_mentions else best_cand.canonical_description[:400]
        cand_aliases = ", ".join(a.alias_term for a in db.scalars(select(ConceptAlias).where(ConceptAlias.concept_id == best_cand.id).limit(5))) or "—"

        prompt = _prompt_text("concept_resolve.txt", {
            "existing_id": str(best_cand.id),
            "existing_name": best_cand.canonical_name,
            "existing_desc": best_cand.canonical_description,
            "existing_book_title": cand_books[0] if cand_books else "?",
            "existing_section_title": cand_sections[0] if cand_sections else "?",
            "existing_snippet": cand_snippet,
            "existing_aliases": cand_aliases,
            "proposed_name": proposed_name,
            "proposed_desc": proposed_desc,
            "proposed_difficulty": str(proposed_diff),
            "proposed_book_title": book.title,
            "proposed_section_title": section.title,
            "proposed_snippet": section_snippet[:500],
            "similarity": f"{best_sim:.3f}",
        })
        raw = llm_client.complete_for_cross_kg([
            {"role": "system", "content": prompt},
            {"role": "user", "content": "Decide now. Return JSON only."},
        ])
        result = _extract_json_obj(raw)
        decision = str(result.get("decision", "unrelated")).strip()

        if decision == "duplicate_same_context":
            return _link_existing_concept(db, book, section, best_cand, proposed_name, norm, section_snippet)

        if decision in ("same_term_different_context", "distinct_related"):
            concept_id, _, _ = _create_new_concept(db, book, section, proposed_name, norm, proposed_desc, proposed_diff, section_snippet, importance, bloom_level, why_it_matters)
            # Create typed relation
            rel_type = str(result.get("relationship") or "related").strip()
            if rel_type not in ("prerequisite", "builds_on", "related", "contrasts_with", "analogous"):
                rel_type = "related"
            strength = float(result.get("strength") or 0.5)
            expl_long = str(result.get("explanation_long") or "").strip()[:2000]
            expl_short = str(result.get("explanation_short") or "").strip()[:500]
            existing_rel = db.scalar(select(ConceptRelation).where(
                or_(
                    (ConceptRelation.source_concept_id == best_cand.id) & (ConceptRelation.target_concept_id == concept_id),
                    (ConceptRelation.source_concept_id == concept_id) & (ConceptRelation.target_concept_id == best_cand.id),
                )
            ))
            if existing_rel is None:
                db.add(ConceptRelation(
                    source_concept_id=best_cand.id,
                    target_concept_id=concept_id,
                    relationship_type=rel_type,
                    strength=max(0.0, min(1.0, strength)),
                    explanation_long=expl_long,
                    explanation_short=expl_short,
                ))
                db.flush()
            return concept_id, True, decision

    except Exception as exc:
        logger.warning("concept_resolve LLM failed for %s vs %s: %s", proposed_name, best_cand.canonical_name, exc)

    # Fallback for ambiguous zone when LLM fails: use name overlap heuristic
    if norm == best_cand.canonical_name_norm and best_sim >= 0.70:
        return _link_existing_concept(db, book, section, best_cand, proposed_name, norm, section_snippet)

    return _create_new_concept(db, book, section, proposed_name, norm, proposed_desc, proposed_diff, section_snippet, importance, bloom_level, why_it_matters)


def _create_new_concept(
    db: Session, book: Book, section: Section,
    name: str, norm: str, desc: str, diff: float, snippet: str,
    importance: str = "core", bloom_level: str = "understand", why_it_matters: str = "",
) -> tuple[int, bool, str]:
    """Create a new Concept + ConceptMention + ConceptAlias."""
    concept = Concept(
        canonical_name=name.strip(),
        canonical_name_norm=norm,
        canonical_description=desc.strip(),
        difficulty=max(0.0, min(1.0, diff)),
        importance=importance,
        bloom_level=bloom_level,
        why_it_matters=why_it_matters,
    )
    db.add(concept)
    db.flush()
    db.add(ConceptMention(concept_id=concept.id, book_id=book.id, section_id=section.id, section_title_snapshot=section.title, snippet=snippet[:1200]))
    db.add(ConceptAlias(concept_id=concept.id, alias_term=name.strip(), alias_norm=norm, source_book_id=book.id))
    db.flush()
    return concept.id, True, "new"


def _link_existing_concept(
    db: Session, book: Book, section: Section,
    existing: Concept, proposed_name: str, norm: str, snippet: str,
) -> tuple[int, bool, str]:
    """Link to an existing Concept by adding a ConceptMention (+ alias if name differs)."""
    exists = db.scalar(select(ConceptMention).where(
        ConceptMention.concept_id == existing.id,
        ConceptMention.book_id == book.id,
        ConceptMention.section_id == section.id,
    ))
    if exists is None:
        db.add(ConceptMention(concept_id=existing.id, book_id=book.id, section_id=section.id, section_title_snapshot=section.title, snippet=snippet[:1200]))
    if norm != existing.canonical_name_norm:
        alias_exists = db.scalar(select(ConceptAlias).where(ConceptAlias.concept_id == existing.id, ConceptAlias.alias_norm == norm))
        if alias_exists is None:
            db.add(ConceptAlias(concept_id=existing.id, alias_term=proposed_name.strip(), alias_norm=norm, source_book_id=book.id))
    db.flush()
    return existing.id, False, "duplicate_same_context"


def _extract_section_kps(db: Session, book_id: int, section: Section, force: bool = False) -> int:
    """Extract a structured learning map for an entire chapter.

    1. Single LLM call produces 5-15 concepts with importance, bloom_level, prerequisites, why_it_matters.
    2. Concepts are resolved globally (Tier 1 alias/exact cosine dedup, Tier 2 new concept, Tier 3 LLM adjudication).
    3. Prerequisite edges are created automatically from the `prerequisites` field.
    4. Legacy KnowledgePoint and ConceptEdge tables are kept in sync for backward compatibility.
    """
    book = db.get(Book, book_id)
    if book is None:
        return 0

    leaves = _leaf_sections_for_chapter(db, book_id, section)
    if not leaves:
        leaves = [section]

    leaf_ids = [lf.id for lf in leaves]

    if not force:
        # Skip if chapter leaves already have ConceptMention records
        has_mention = db.scalar(
            select(ConceptMention.id)
            .where(ConceptMention.book_id == book_id, ConceptMention.section_id.in_(leaf_ids))
            .limit(1)
        )
        if has_mention is not None:
            return 0

    # 1. Single LLM call for the chapter
    items = _extract_chapter_learning_map(db, book_id, section)
    if not items:
        return 0

    # Prepare leaf text snippets to associate each concept with the most relevant leaf
    leaf_snippets: dict[int, str] = {}
    for leaf in leaves:
        chunks = _section_all_chunks(db, book_id, leaf.id)
        leaf_snippets[leaf.id] = " ".join(c.text for c in _spread(chunks, 6))[:1200] if chunks else leaf.title

    def _best_leaf(concept_name: str, concept_desc: str) -> Section:
        tokens = set((concept_name + " " + concept_desc).lower().split())
        best_lf = leaves[0]
        best_score = -1
        for lf in leaves:
            snip = leaf_snippets.get(lf.id, "").lower()
            score = sum(1 for t in tokens if len(t) > 3 and t in snip)
            if score > best_score:
                best_score = score
                best_lf = lf
        return best_lf

    concepts_created = 0
    name_to_concept_id: dict[str, int] = {}
    name_to_kp_id: dict[str, int] = {}
    concept_prereqs: dict[int, list[dict[str, str]]] = {}

    for item in items:
        name = str(item.get("name", "")).strip()
        desc = str(item.get("description", "")).strip()
        if not name or not desc:
            continue

        diff = float(item.get("difficulty", 0.5))
        importance = str(item.get("importance", "core")).strip().lower()
        if importance not in ("core", "supporting"):
            importance = "core"

        bloom_level = str(item.get("bloom_level", "understand")).strip().lower()
        if bloom_level not in ("remember", "understand", "apply", "analyze"):
            bloom_level = "understand"

        why_it_matters = str(item.get("why_it_matters", "")).strip()
        prereqs = item.get("prerequisites", [])
        if not isinstance(prereqs, list):
            prereqs = []

        norm = _norm_name(name)
        target_leaf = _best_leaf(name, desc)
        snippet = leaf_snippets.get(target_leaf.id, "")

        concept_id, is_new, _ = _resolve_or_create_concept(
            db, book, target_leaf, name, desc, diff, snippet,
            importance=importance, bloom_level=bloom_level, why_it_matters=why_it_matters
        )
        if is_new:
            concepts_created += 1

        name_to_concept_id[norm] = concept_id
        if prereqs:
            parsed_prereqs: list[dict[str, str]] = []
            for p in prereqs:
                if isinstance(p, dict):
                    pn = str(p.get("name", "")).strip()
                    pr = str(p.get("reason", "")).strip()
                    if pn:
                        parsed_prereqs.append({"name": pn, "reason": pr})
                elif isinstance(p, str) and p.strip():
                    parsed_prereqs.append({"name": p.strip(), "reason": ""})
            if parsed_prereqs:
                concept_prereqs[concept_id] = parsed_prereqs

        # Maintain legacy KnowledgePoint
        legacy_kp = db.scalar(
            select(KnowledgePoint)
            .where(KnowledgePoint.book_id == book_id, KnowledgePoint.section_id == target_leaf.id, KnowledgePoint.name == name)
            .limit(1)
        )
        if legacy_kp is None:
            legacy_kp = KnowledgePoint(
                book_id=book_id,
                section_id=target_leaf.id,
                name=name,
                description=desc,
                difficulty=max(0.0, min(1.0, diff)),
                importance=importance,
                bloom_level=bloom_level,
            )
            db.add(legacy_kp)
            db.flush()
        name_to_kp_id[norm] = legacy_kp.id

    # 3. Create intra-chapter prerequisite relations automatically from prerequisites
    for target_cid, prereq_list in concept_prereqs.items():
        tgt_concept = db.get(Concept, target_cid)
        for p_item in prereq_list:
            p_name = p_item["name"]
            p_reason = p_item.get("reason", "").strip()
            p_norm = _norm_name(p_name)
            source_cid = name_to_concept_id.get(p_norm)
            if not source_cid or source_cid == target_cid:
                continue

            src_concept = db.get(Concept, source_cid)

            # Pedagogically rich explanation: bridges the two concepts and explains why understanding breaks without it
            if p_reason and len(p_reason) >= 20:
                expl_long = p_reason
                expl_short = p_reason[:140] + ("…" if len(p_reason) > 140 else "")
            elif src_concept and tgt_concept:
                expl_long = (
                    f"{src_concept.canonical_name} ({src_concept.canonical_description.rstrip('.')}) provides "
                    f"the foundational mechanics required to understand {tgt_concept.canonical_name} "
                    f"({tgt_concept.canonical_description.rstrip('.')}). Without mastering this foundation, "
                    f"the principles and implementation of {tgt_concept.canonical_name} cannot be effectively applied."
                )
                expl_short = f"{src_concept.canonical_name} provides the foundational concepts required to master {tgt_concept.canonical_name}."
            else:
                expl_long = f"Understanding {p_name} is essential before studying this concept."
                expl_short = f"{p_name} is a foundational prerequisite."

            strength = 0.90 if (src_concept and tgt_concept and src_concept.importance == "core" and tgt_concept.importance == "core") else 0.80

            exists_cr = db.scalar(select(ConceptRelation).where(
                ConceptRelation.source_concept_id == source_cid,
                ConceptRelation.target_concept_id == target_cid,
            ).limit(1))
            if exists_cr is None:
                db.add(ConceptRelation(
                    source_concept_id=source_cid,
                    target_concept_id=target_cid,
                    relationship_type="prerequisite",
                    strength=strength,
                    explanation_short=expl_short,
                    explanation_long=expl_long,
                ))
            elif "Mastering" in (exists_cr.explanation_long or "") and expl_long:
                exists_cr.explanation_long = expl_long
                exists_cr.explanation_short = expl_short
                exists_cr.strength = strength

            source_kpid = name_to_kp_id.get(p_norm)
            target_norm = next((n for n, cid in name_to_concept_id.items() if cid == target_cid), None)
            target_kpid = name_to_kp_id.get(target_norm) if target_norm else None
            if source_kpid and target_kpid and source_kpid != target_kpid:
                exists_ce = db.scalar(select(ConceptEdge).where(
                    ConceptEdge.source_point_id == source_kpid,
                    ConceptEdge.target_point_id == target_kpid,
                ).limit(1))
                if exists_ce is None:
                    db.add(ConceptEdge(
                        source_point_id=source_kpid,
                        target_point_id=target_kpid,
                        relationship_type="prerequisite",
                        strength=strength,
                        explanation=expl_long,
                    ))
                elif "is a foundational prerequisite" in (exists_ce.explanation or ""):
                    exists_ce.explanation = expl_long
                    exists_ce.strength = strength

    db.flush()
    return concepts_created


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
            # Clean canonical mentions for this chapter (not just legacy KPs)
            if leaf_ids:
                # Delete ConceptMentions for these leaves (keep Concepts — they may be shared elsewhere)
                db.execute(delete(ConceptMention).where(ConceptMention.book_id == book_id, ConceptMention.section_id.in_(leaf_ids)))
                # Also clean legacy KP/edges for backward compat
                existing_ids = list(db.scalars(select(KnowledgePoint.id).where(KnowledgePoint.section_id.in_(leaf_ids))))
                if existing_ids:
                    db.execute(delete(KnowledgePoint).where(KnowledgePoint.section_id.in_(leaf_ids)))
                    db.execute(delete(ConceptEdge).where(or_(ConceptEdge.source_point_id.in_(existing_ids), ConceptEdge.target_point_id.in_(existing_ids))))
            db.flush()
        total_created += _extract_section_kps(db, book_id, section, force=body.force)

    db.commit()
    total_sections = db.scalar(select(func.count()).select_from(SectionModel).where(SectionModel.book_id == book_id, SectionModel.level == 1))
    # Report canonical counts (global dedup) + legacy KP
    total_concepts = db.scalar(select(func.count()).select_from(Concept))
    total_mentions = db.scalar(select(func.count()).select_from(ConceptMention).where(ConceptMention.book_id == book_id))
    processed = db.scalar(select(func.count()).select_from(KnowledgePoint).where(KnowledgePoint.book_id == book_id))
    return {"ok": True, "created": total_created, "total_sections": total_sections or 0, "total_kps": processed or 0, "total_concepts": total_concepts or 0, "total_mentions": total_mentions or 0}


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
        db.execute(delete(ConceptMention).where(ConceptMention.book_id == book_id, ConceptMention.section_id.in_(leaf_ids)))
        existing_ids = list(db.scalars(select(KnowledgePoint.id).where(KnowledgePoint.section_id.in_(leaf_ids))))
        if existing_ids:
            db.execute(delete(KnowledgePoint).where(KnowledgePoint.section_id.in_(leaf_ids)))
            db.execute(delete(ConceptEdge).where(or_(ConceptEdge.source_point_id.in_(existing_ids), ConceptEdge.target_point_id.in_(existing_ids))))
        db.flush()

    created = _extract_section_kps(db, book_id, section, force=body.force)
    db.commit()
    total_kps = db.scalar(select(func.count()).select_from(KnowledgePoint).where(KnowledgePoint.book_id == book_id))
    total_mentions = db.scalar(select(func.count()).select_from(ConceptMention).where(ConceptMention.book_id == book_id))
    return {"ok": True, "created": created, "total_kps": total_kps or 0, "total_mentions": total_mentions or 0}


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
