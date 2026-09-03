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


def _resolve_or_create_concept(
    db: Session,
    book: Book,
    leaf: Section,
    proposed_name: str,
    proposed_desc: str,
    proposed_diff: float,
    leaf_snippet: str,
) -> tuple[int, bool, str]:
    """
    Global dedup: try to resolve proposed concept against all existing Concepts.
    Returns (concept_id, is_new, decision).
    Links already-extracted concepts by creating a ConceptMention instead of a duplicate Concept.
    """
    norm = _norm_name(proposed_name)
    # Fast path: exact normalized name match → check context via LLM
    # Otherwise embed + cosine recall
    existing_concepts = list(db.scalars(select(Concept).order_by(Concept.id)))
    if not existing_concepts:
        # No concepts yet — create first
        concept = Concept(
            canonical_name=proposed_name.strip(),
            canonical_name_norm=norm,
            canonical_description=proposed_desc.strip(),
            difficulty=max(0.0, min(1.0, proposed_diff)),
        )
        db.add(concept)
        db.flush()
        # provenance
        db.add(ConceptMention(
            concept_id=concept.id,
            book_id=book.id,
            section_id=leaf.id,
            section_title_snapshot=leaf.title,
            snippet=leaf_snippet[:1200],
        ))
        db.add(ConceptAlias(concept_id=concept.id, alias_term=proposed_name.strip(), alias_norm=norm, source_book_id=book.id))
        db.flush()
        return concept.id, True, "new"

    # Try exact norm match — but still compute embedding similarity to judge context
    # Don't auto-accept exact as duplicate; let LLM (or fallback) decide context
    candidates: list[Concept] = []
    sim_map: dict[int, float] = {}
    existing_by_id = {c.id: c for c in existing_concepts}
    # Embed contextual texts for recall (even for exact matches, we need sim to judge context diff)
    try:
        prop_text = f"[{book.title} | {leaf.title}] {proposed_name}: {proposed_desc} | {leaf_snippet[:400]}"
        prop_emb = embedding_client.embed_texts([prop_text])[0]
        cand_texts = [f"{c.canonical_name}: {c.canonical_description}" for c in existing_concepts]
        cand_embs: list[list[float]] = []
        for _, batch in embedding_client.embed_batches(cand_texts):
            cand_embs.extend(batch)
        scored = []
        for c, emb in zip(existing_concepts, cand_embs):
            s = _cosine(prop_emb, emb)
            sim_map[c.id] = s  # store for all
            if s >= 0.58:
                scored.append((s, c))
        scored.sort(key=lambda x: -x[0])
        candidates = [c for _, c in scored[:8]]
        # Ensure exact norm is included even if cosine slightly below 0.58 (so LLM can decide context diff)
        exact = db.scalar(select(Concept).where(Concept.canonical_name_norm == norm))
        if exact is not None and exact not in candidates:
            # include with actual sim (already in sim_map, may be 0.4-0.6)
            candidates.insert(0, exact)
            if len(candidates) > 8:
                candidates = candidates[:8]
        # Also include substring name matches even if cosine lower
        if not candidates:
            for c in existing_concepts:
                if norm in c.canonical_name_norm or c.canonical_name_norm in norm:
                    if c not in candidates:
                        sim_map.setdefault(c.id, 0.55)
                        candidates.append(c)
                        if len(candidates) >= 4:
                            break
    except Exception as exc:
        logger.warning("Embedding recall failed for %s: %s", proposed_name, exc)
        candidates = []
        exact = db.scalar(select(Concept).where(Concept.canonical_name_norm == norm))
        if exact is not None:
            candidates = [exact]
            sim_map[exact.id] = 1.0

    if not candidates:
        # No similar canonical — create new concept
        concept = Concept(
            canonical_name=proposed_name.strip(),
            canonical_name_norm=norm,
            canonical_description=proposed_desc.strip(),
            difficulty=max(0.0, min(1.0, proposed_diff)),
        )
        db.add(concept)
        db.flush()
        db.add(ConceptMention(concept_id=concept.id, book_id=book.id, section_id=leaf.id, section_title_snapshot=leaf.title, snippet=leaf_snippet[:1200]))
        db.add(ConceptAlias(concept_id=concept.id, alias_term=proposed_name.strip(), alias_norm=norm, source_book_id=book.id))
        db.flush()
        return concept.id, True, "new"

    # For alias exact match via alias table (covers wording variants)
    if exact is None:
        alias_hit = db.scalar(select(ConceptAlias).where(ConceptAlias.alias_norm == norm).limit(1))
        if alias_hit is not None:
            # Mentions-only duplicate via alias
            # ensure not already mentioned in this leaf
            existing_mention = db.scalar(select(ConceptMention).where(
                ConceptMention.concept_id == alias_hit.concept_id,
                ConceptMention.book_id == book.id,
                ConceptMention.section_id == leaf.id,
            ))
            if existing_mention is None:
                # add mention provenance
                hit_concept = db.get(Concept, alias_hit.concept_id)
                db.add(ConceptMention(concept_id=hit_concept.id, book_id=book.id, section_id=leaf.id, section_title_snapshot=leaf.title, snippet=leaf_snippet[:1200]))
                db.flush()
            return alias_hit.concept_id, False, "alias_duplicate"

    # LLM adjudication for each candidate (usually 1-3) — pick best
    best_decision = "unrelated"
    best_candidate: Concept | None = None
    best_result: dict | None = None
    for cand in candidates:
        # Gather cand provenance for context
        cand_mentions = list(db.scalars(select(ConceptMention).where(ConceptMention.concept_id == cand.id).limit(3)))
        cand_books = []
        cand_sections = []
        for m in cand_mentions:
            b = db.get(Book, m.book_id)
            if b:
                cand_books.append(b.title)
            cand_sections.append(m.section_title_snapshot)
        cand_snippet = ""
        if cand_mentions:
            cand_snippet = (cand_mentions[0].snippet or "")[:400]
        cand_aliases = ", ".join(a.alias_term for a in db.scalars(select(ConceptAlias).where(ConceptAlias.concept_id == cand.id).limit(5))) or "—"
        similarity = sim_map.get(cand.id, 0.0)
        try:
            prompt = _prompt_text("concept_resolve.txt", {
                "existing_id": str(cand.id),
                "existing_name": cand.canonical_name,
                "existing_desc": cand.canonical_description,
                "existing_book_title": cand_books[0] if cand_books else "?",
                "existing_section_title": cand_sections[0] if cand_sections else "?",
                "existing_snippet": cand_snippet or cand.canonical_description[:400],
                "existing_aliases": cand_aliases,
                "proposed_name": proposed_name,
                "proposed_desc": proposed_desc,
                "proposed_difficulty": str(proposed_diff),
                "proposed_book_title": book.title,
                "proposed_section_title": leaf.title,
                "proposed_snippet": leaf_snippet[:500],
                "similarity": f"{similarity:.3f}",
            })
            raw = llm_client.complete([
                {"role": "system", "content": prompt},
                {"role": "user", "content": "Decide now. Return JSON only."},
            ])
            result = _extract_json_obj(raw)
            decision = str(result.get("decision", "unrelated")).strip()
            # Priority: duplicate > same_term_different_context > distinct_related > unrelated
            prio = {"duplicate_same_context": 4, "same_term_different_context": 3, "distinct_related": 2, "unrelated": 1}
            if prio.get(decision, 0) > prio.get(best_decision, 0):
                best_decision = decision
                best_candidate = cand
                best_result = result
                if decision == "duplicate_same_context":
                    break
        except Exception as exc:
            logger.warning("concept_resolve LLM failed for %s vs %s: %s", proposed_name, cand.canonical_name, exc)
            # Fallback (no LLM): conservative — avoid merging distinct contexts.
            # Use embedding similarity + name overlap to decide duplicate vs context-diff vs related.
            is_exact = (norm == cand.canonical_name_norm)
            is_substring = (norm in cand.canonical_name_norm or cand.canonical_name_norm in norm)
            if is_exact:
                if similarity >= 0.70:
                    best_decision = "duplicate_same_context"
                    best_candidate = cand
                    best_result = {"relationship": None, "strength": 1.0, "explanation_long": "", "explanation_short": "", "alias_term": ""}
                    break
                else:
                    if "unrelated" in best_decision:
                        best_decision = "same_term_different_context"
                        best_candidate = cand
                        best_result = {
                            "relationship": "contrasts_with" if similarity < 0.60 else "related",
                            "strength": 0.6,
                            "explanation_long": f"Both use the term '{proposed_name}' but in different technical contexts: '{cand.canonical_description[:120]}' vs '{proposed_desc[:120]}'. Surface term overlaps yet constraints differ; keep separate and compare trade-offs. Shared terminology masks distinct abstraction levels.",
                            "explanation_short": "Same term, different context — keep distinct.",
                        }
            elif is_substring:
                if similarity >= 0.60:
                    # e.g., "Dot Product" ⊂ "Vector Dot Product" with similar descriptions → duplicate
                    best_decision = "duplicate_same_context"
                    best_candidate = cand
                    best_result = {"relationship": None, "strength": 1.0, "explanation_long": "", "explanation_short": "", "alias_term": ""}
                    break
                elif similarity >= 0.45 and "unrelated" in best_decision:
                    best_decision = "distinct_related"
                    best_candidate = cand
                    best_result = {
                        "relationship": "related",
                        "strength": similarity,
                        "explanation_long": f"Concepts '{cand.canonical_name}' and '{proposed_name}' share {similarity:.0%} semantic overlap and overlapping terminology. One extends the other; review shared principle.",
                        "explanation_short": f"Related via terminology ({similarity:.0%})",
                    }
            else:
                if similarity >= 0.62 and "unrelated" in best_decision:
                    best_decision = "distinct_related"
                    best_candidate = cand
                    best_result = {
                        "relationship": "related",
                        "strength": similarity,
                        "explanation_long": f"Concepts '{cand.canonical_name}' and '{proposed_name}' share {similarity:.0%} semantic overlap in their descriptions. Review both to see shared principle and differing application.",
                        "explanation_short": f"Related ({similarity:.0%})",
                    }
            continue

    if best_candidate is not None and best_decision == "duplicate_same_context":
        # Link — create mention, alias if wording differs
        exists = db.scalar(select(ConceptMention).where(
            ConceptMention.concept_id == best_candidate.id,
            ConceptMention.book_id == book.id,
            ConceptMention.section_id == leaf.id,
        ))
        if exists is None:
            db.add(ConceptMention(concept_id=best_candidate.id, book_id=book.id, section_id=leaf.id, section_title_snapshot=leaf.title, snippet=leaf_snippet[:1200]))
        # alias for surface variance
        if norm != best_candidate.canonical_name_norm:
            alias_exists = db.scalar(select(ConceptAlias).where(ConceptAlias.concept_id == best_candidate.id, ConceptAlias.alias_norm == norm))
            if alias_exists is None:
                db.add(ConceptAlias(concept_id=best_candidate.id, alias_term=proposed_name.strip(), alias_norm=norm, source_book_id=book.id))
        db.flush()
        return best_candidate.id, False, "duplicate_same_context"

    if best_candidate is not None and best_decision in ("same_term_different_context", "distinct_related"):
        # Create new concept, then create typed edge to existing
        concept = Concept(
            canonical_name=proposed_name.strip(),
            canonical_name_norm=norm,
            canonical_description=proposed_desc.strip(),
            difficulty=max(0.0, min(1.0, proposed_diff)),
        )
        db.add(concept)
        db.flush()
        db.add(ConceptMention(concept_id=concept.id, book_id=book.id, section_id=leaf.id, section_title_snapshot=leaf.title, snippet=leaf_snippet[:1200]))
        db.add(ConceptAlias(concept_id=concept.id, alias_term=proposed_name.strip(), alias_norm=norm, source_book_id=book.id))
        db.flush()
        # Create relation existing -> new (or reverse if needed — we keep as resolved; LLM says existing prerequisite for proposed)
        rel_type = str((best_result or {}).get("relationship") or "related").strip()
        if rel_type not in ("prerequisite", "builds_on", "related", "contrasts_with", "analogous"):
            rel_type = "related"
        strength = float((best_result or {}).get("strength") or 0.5)
        expl_long = str((best_result or {}).get("explanation_long") or "").strip()[:2000]
        expl_short = str((best_result or {}).get("explanation_short") or "").strip()[:500]
        # Deduplicate edge pair
        a, b = best_candidate.id, concept.id
        src, tgt = (a, b) if a < b else (b, a)  # store ordered pair to avoid duplicates, but keep semantic direction in evidence
        existing_rel = db.scalar(select(ConceptRelation).where(
            or_(
                (ConceptRelation.source_concept_id == src) & (ConceptRelation.target_concept_id == tgt),
                (ConceptRelation.source_concept_id == tgt) & (ConceptRelation.target_concept_id == src),
            )
        ))
        # Actually check both orientations — we want no duplicate, regardless of order
        if existing_rel is None:
            # Preserve intended direction: if LLM said prerequisite/builds_on existing→proposed, keep that; otherwise use ordered
            # For simplicity store as LLM intended if a==best_candidate.id, else swap
            if best_candidate.id == a:
                src_dir, tgt_dir = best_candidate.id, concept.id
            else:
                # candidate was tgt in ordered — reverse to intended
                src_dir, tgt_dir = best_candidate.id, concept.id
            evidence = json.dumps({
                "source_section": best_candidate.canonical_name,
                "target_section": leaf.title,
                "candidate_provenance_book": (db.get(Book, best_candidate.id) and "") or "",
                "similarity": sim_map.get(best_candidate.id, 0.0),
            })
            db.add(ConceptRelation(
                source_concept_id=src_dir,
                target_concept_id=tgt_dir,
                relationship_type=rel_type,
                strength=max(0.0, min(1.0, strength)),
                explanation_long=expl_long,
                explanation_short=expl_short,
                evidence_json=evidence,
            ))
            db.flush()
        return concept.id, True, best_decision

    # unrelated or no candidate → create new concept isolated
    concept = Concept(
        canonical_name=proposed_name.strip(),
        canonical_name_norm=norm,
        canonical_description=proposed_desc.strip(),
        difficulty=max(0.0, min(1.0, proposed_diff)),
    )
    db.add(concept)
    db.flush()
    db.add(ConceptMention(concept_id=concept.id, book_id=book.id, section_id=leaf.id, section_title_snapshot=leaf.title, snippet=leaf_snippet[:1200]))
    db.add(ConceptAlias(concept_id=concept.id, alias_term=proposed_name.strip(), alias_norm=norm, source_book_id=book.id))
    db.flush()
    return concept.id, True, "new_unrelated"


def _extract_section_kps(db: Session, book_id: int, section: Section, force: bool = False) -> int:
    """Deep section-by-section extraction with GLOBAL dedup via Concept/ConceptMention.

    Links already-extracted concepts: a proposed KP that matches an existing canonical
    creates a ConceptMention (provenance) instead of a duplicate Concept row.
    Only novel meanings (context-different) create new Concept rows.
    """
    from ..models import Section as SectionModel

    book = db.get(Book, book_id)
    if book is None:
        return 0
    leaves = _leaf_sections_for_chapter(db, book_id, section)
    if not force:
        # Skip chapter if all leaves already have at least one ConceptMention provenance
        already_done = True
        for lf in leaves:
            has_mention = db.scalar(select(ConceptMention).where(ConceptMention.book_id == book_id, ConceptMention.section_id == lf.id).limit(1))
            if has_mention is None:
                already_done = False
                break
        if already_done:
            return 0
        # Also skip if legacy KnowledgePoints exist but no ConceptMention yet — allow migration to create Concepts from them
        # (force will handle)

    # Collect per leaf: need leaf snippet for context
    leaf_to_items: dict[int, list[dict]] = {}
    leaf_snippets: dict[int, str] = {}
    for leaf in leaves:
        items = _extract_single_leaf_kps(db, book_id, leaf)
        if items:
            leaf_to_items[leaf.id] = items
            chunks = _section_all_chunks(db, book_id, leaf.id)
            leaf_snippets[leaf.id] = " ".join(c.text for c in _spread(chunks, 6))[:1200] if chunks else leaf.title

    if not leaf_to_items:
        return 0

    # Flatten dedup within this chapter batch by normalized name (intra-batch)
    seen_names: set[str] = set()
    deduped: list[tuple[dict, int]] = []
    for leaf_id, items in leaf_to_items.items():
        for it in items:
            name_norm = _norm_name(str(it.get("name", "")))
            if not name_norm or name_norm in seen_names:
                continue
            seen_names.add(name_norm)
            deduped.append((it, leaf_id))

    if len(deduped) > KP_SOFT_MAX:
        deduped = deduped[:KP_SOFT_MAX]

    concepts_created = 0
    mentions_created = 0
    for item, leaf_id in deduped:
        name = str(item.get("name", "")).strip()
        desc = str(item.get("description", "")).strip()
        diff = float(item.get("difficulty", 0.5))
        if not name or not desc:
            continue
        leaf = db.get(Section, leaf_id)
        if leaf is None:
            continue
        # Global resolve — may create Concept or just Mention
        snippet = leaf_snippets.get(leaf_id, "")
        concept_id, is_new, decision = _resolve_or_create_concept(db, book, leaf, name, desc, diff, snippet)
        if is_new:
            concepts_created += 1
        else:
            mentions_created += 1

    # Still create legacy KnowledgePoint rows for backward compat (until front fully migrates)
    # — but only for newly created concepts, to keep legacy KP table from diverging
    # This block keeps legacy KP in sync: one KP per new ConceptMention in this book
    for item, leaf_id in deduped:
        # We already flushed; ensure legacy KP exists for those is_new
        # Look up concept for this item to see if it was newly created
        norm = _norm_name(str(item.get("name", "")))
        concept = db.scalar(select(Concept).where(Concept.canonical_name_norm == norm))
        if concept is None:
            continue
        # if this leaf already has this concept mention and concept was new, create legacy KP if not exists
        legacy_exists = db.scalar(select(KnowledgePoint).where(KnowledgePoint.book_id == book_id, KnowledgePoint.section_id == leaf_id, KnowledgePoint.name == str(item.get("name", "")).strip()).limit(1))
        if legacy_exists is None and concept is not None:
            # only mirror when the concept has a mention in this leaf (to avoid fabricating)
            has_mention = db.scalar(select(ConceptMention).where(ConceptMention.concept_id == concept.id, ConceptMention.book_id == book_id, ConceptMention.section_id == leaf_id).limit(1))
            if has_mention is not None:
                # check if this concept was the one we just created for this leaf (approx by alias source)
                alias = db.scalar(select(ConceptAlias).where(ConceptAlias.concept_id == concept.id, ConceptAlias.alias_norm == norm, ConceptAlias.source_book_id == book_id).limit(1))
                if alias is not None or is_new:
                    kp = KnowledgePoint(book_id=book_id, section_id=leaf_id, name=str(item.get("name", "")).strip(), description=str(item.get("description", "")).strip(), difficulty=max(0.0, min(1.0, float(item.get("difficulty", 0.5)))))
                    db.add(kp)
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
