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
    Concept,
    ConceptAlias,
    ConceptCluster,
    ConceptClusterMember,
    ConceptEdge,
    ConceptMention,
    ConceptRelation,
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
    """Reconciliation/backfill for canonical Concepts — replaces old KP-pair logic.

    With global dedup, true duplicates are already merged via ConceptMention.
    This endpoint now ensures remaining *distinct* Concepts that are related
    get a ConceptRelation edge with long technical explanation (50-200w).
    Legacy KP pairs are ignored; canonical Concepts are the source of truth.
    """
    concepts = list(db.scalars(select(Concept).order_by(Concept.id)))
    if len(concepts) < 2:
        # Fallback: try legacy KP path for pre-migration DBs
        kps = list(db.scalars(select(KnowledgePoint).order_by(KnowledgePoint.id)))
        if len(kps) >= 2:
            return _legacy_extract_from_kps(db, kps)
        return {"ok": True, "created": 0, "clusters": 0}

    # If no canonical mentions yet but KPs exist, use legacy path to seed
    if not db.scalar(select(ConceptMention).limit(1)):
        kps = list(db.scalars(select(KnowledgePoint).order_by(KnowledgePoint.id)))
        if len(kps) >= 2:
            return _legacy_extract_from_kps(db, kps)

    # Build embeddings with book/section context from primary mention
    texts = []
    book_cache: dict[int, Book] = {}
    mention_cache: dict[int, ConceptMention | None] = {}
    for c in concepts:
        primary = db.scalar(select(ConceptMention).where(ConceptMention.concept_id == c.id).limit(1))
        mention_cache[c.id] = primary
        if primary:
            bk = book_cache.get(primary.book_id)
            if bk is None:
                bk = db.get(Book, primary.book_id)
                if bk: book_cache[primary.book_id] = bk
            ctx = (primary.snippet or "")[:300]
            texts.append(f"[{bk.title if bk else '?'} | {primary.section_title_snapshot}] {c.canonical_name}: {c.canonical_description} | {ctx}")
        else:
            texts.append(f"{c.canonical_name}: {c.canonical_description}")

    embeddings = embedding_client.embed_texts(texts)

    existing_rels = list(db.scalars(select(ConceptRelation)))
    existing_pairs = {(min(r.source_concept_id, r.target_concept_id), max(r.source_concept_id, r.target_concept_id)) for r in existing_rels}

    created = 0
    for i in range(len(concepts)):
        for j in range(i + 1, len(concepts)):
            a, b = concepts[i], concepts[j]
            pair = (min(a.id, b.id), max(a.id, b.id))
            if pair in existing_pairs:
                continue
            sim = _cosine_similarity(embeddings[i], embeddings[j])
            if sim < 0.58:
                continue
            # Check if they already share a mention book (same book) — still allow but require LLM to confirm non-trivial link
            # Require LLM adjudication for all pairs now (no 0.80 shortcut) to ensure context-aware + long explanation
            ma = mention_cache.get(a.id)
            mb = mention_cache.get(b.id)
            ba_title = (book_cache.get(ma.book_id).title if ma and book_cache.get(ma.book_id) else "?") if ma else "?"
            bb_title = (book_cache.get(mb.book_id).title if mb and book_cache.get(mb.book_id) else "?") if mb else "?"
            try:
                from ..routers.intelligence import _extract_json_obj  # reuse helper

                prompt = _prompt_text("concept_resolve.txt", {
                    "existing_id": str(a.id),
                    "existing_name": a.canonical_name,
                    "existing_desc": a.canonical_description,
                    "existing_book_title": ba_title,
                    "existing_section_title": ma.section_title_snapshot if ma else "?",
                    "existing_snippet": (ma.snippet[:400] if ma and ma.snippet else a.canonical_description[:400]),
                    "existing_aliases": ", ".join(x.alias_term for x in db.scalars(select(ConceptAlias).where(ConceptAlias.concept_id == a.id).limit(5))) or "—",
                    "proposed_name": b.canonical_name,
                    "proposed_desc": b.canonical_description,
                    "proposed_difficulty": str(b.difficulty),
                    "proposed_book_title": bb_title,
                    "proposed_section_title": mb.section_title_snapshot if mb else "?",
                    "proposed_snippet": (mb.snippet[:400] if mb and mb.snippet else b.canonical_description[:400]),
                    "similarity": f"{sim:.3f}",
                })
                raw = llm_client.complete([
                    {"role": "system", "content": prompt},
                    {"role": "user", "content": "Decide now. Return JSON only."},
                ])
                res = _extract_json(raw)
                decision = res.get("decision", "unrelated")
                if decision == "duplicate_same_context":
                    # Already canonicals — do not merge here; reconciliation merges via /concepts/reconcile
                    continue
                if decision not in ("same_term_different_context", "distinct_related"):
                    continue
                label = res.get("relationship") or "related"
                if label not in ("prerequisite", "builds_on", "related", "contrasts_with", "analogous"):
                    label = "related"
                expl_long = str(res.get("explanation_long") or res.get("explanation") or "").strip()[:2000]
                expl_short = str(res.get("explanation_short") or "").strip()[:500]
                if not expl_long:
                    expl_long = f"Concepts share {sim:.0%} semantic overlap across '{ba_title}' and '{bb_title}'."
                strength = float(res.get("strength") or sim)
            except Exception as exc:
                logger.warning("cross-book LLM failed for %s — %s: %s", a.canonical_name, b.canonical_name, exc)
                label = "related"
                expl_long = f"Concepts with {sim:.0%} similarity between '{ba_title}' and '{bb_title}'. Mastering one aids the other via shared principles."
                expl_short = f"Related ({sim:.0%})"
                strength = sim

            # Preserve intended direction: LLM evaluated a as existing → b as proposed
            src_id, tgt_id = a.id, b.id
            # Check no duplicate (ordered)
            exists = db.scalar(select(ConceptRelation).where(
                ((ConceptRelation.source_concept_id == src_id) & (ConceptRelation.target_concept_id == tgt_id)) |
                ((ConceptRelation.source_concept_id == tgt_id) & (ConceptRelation.target_concept_id == src_id))
            ))
            if exists:
                continue
            db.add(ConceptRelation(
                source_concept_id=src_id,
                target_concept_id=tgt_id,
                relationship_type=label,
                strength=max(0.0, min(1.0, strength)),
                explanation_long=expl_long,
                explanation_short=expl_short,
                evidence_json=json.dumps({"similarity": sim, "source_book": ba_title, "target_book": bb_title}),
            ))
            created += 1
            existing_pairs.add(pair)

    db.commit()
    try:
        award_xp(db, "cross_book_discovery", xp_override=created * 25)
    except Exception:
        pass
    return {"ok": True, "created": created}


def _legacy_extract_from_kps(db: Session, kps: list[KnowledgePoint]):
    """Legacy fallback for pre-migration DBs without canonical Concepts."""
    texts = [f"{kp.name}: {kp.description}" for kp in kps]
    embeddings = embedding_client.embed_texts(texts)
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
            db.add(CrossBookLink(source_kp_id=pair[0], target_kp_id=pair[1], similarity=sim, relationship_label=label, explanation=explanation))
            created += 1
            existing_pairs.add(pair)
    db.commit()
    return {"ok": True, "created": created, "legacy": True}


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
def get_unified_graph(course_id: int | None = None, book_id: int | None = None, db: Session = Depends(get_db)):
    """Unified graph — canonical Concepts. Supports ?course_id= & ?book_id= provenance filtering."""
    # If canonical Concepts exist, serve them; else fallback to legacy KP graph
    has_concepts = db.scalar(select(Concept).limit(1)) is not None
    has_mentions = db.scalar(select(ConceptMention).limit(1)) is not None
    if has_concepts and has_mentions:
        # course -> book ids for filtering
        allowed_book_ids: set[int] | None = None
        if course_id is not None:
            from ..models import CourseBook
            allowed_book_ids = set(db.scalars(select(CourseBook.book_id).where(CourseBook.course_id == course_id)))
            if not allowed_book_ids:
                return {"nodes": [], "intra_edges": [], "inter_edges": []}
            # also allow explicit book_id intersection
            if book_id is not None:
                allowed_book_ids = allowed_book_ids.intersection({book_id}) if book_id in allowed_book_ids else set()
        elif book_id is not None:
            allowed_book_ids = {book_id}

        # Gather concepts that have at least one mention in allowed books (if filter), else all
        if allowed_book_ids is not None:
            concept_ids = set(db.scalars(select(ConceptMention.concept_id).where(ConceptMention.book_id.in_(allowed_book_ids))))
            concepts = list(db.scalars(select(Concept).where(Concept.id.in_(concept_ids)).order_by(Concept.id))) if concept_ids else []
        else:
            concepts = list(db.scalars(select(Concept).order_by(Concept.id)))
            concept_ids = {c.id for c in concepts}

        nodes: list[dict] = []
        book_cache: dict[int, Book] = {}
        # mastery cache via legacy KP mapping (canonical_name_norm -> UKP)
        for c in concepts:
            # primary mention for display (prefer filtered book, else first)
            q = select(ConceptMention).where(ConceptMention.concept_id == c.id)
            if allowed_book_ids is not None:
                q = q.where(ConceptMention.book_id.in_(allowed_book_ids))
            primary = db.scalar(q.limit(1).order_by(ConceptMention.book_id))
            if primary is None:
                primary = db.scalar(select(ConceptMention).where(ConceptMention.concept_id == c.id).limit(1))
            section = db.get(Section, primary.section_id) if primary else None
            bk = book_cache.get(primary.book_id) if primary else None
            if primary and bk is None:
                bk = db.get(Book, primary.book_id)
                if bk: book_cache[primary.book_id] = bk
            # mastery via legacy KP
            legacy_kp = db.scalar(select(KnowledgePoint).where(KnowledgePoint.name == c.canonical_name).limit(1))
            ukp = db.scalar(select(UserKnowledgePoint).where(UserKnowledgePoint.knowledge_point_id == legacy_kp.id)) if legacy_kp else None
            # collect all mentions for tooltip counts
            all_mentions = list(db.scalars(select(ConceptMention).where(ConceptMention.concept_id == c.id)))
            # courses/books involved
            from ..models import CourseBook
            courses_involved: set[str] = set()
            books_involved: set[str] = set()
            for m in all_mentions:
                b = db.get(Book, m.book_id)
                if b: books_involved.add(b.title)
                for cb in db.scalars(select(CourseBook).where(CourseBook.book_id == m.book_id)):
                    cc = db.get(Book, cb.course_id)  # wrong, should be Course
                    from ..models import Course
                    course = db.get(Course, cb.course_id)
                    if course: courses_involved.add(course.title)
            nodes.append(ConceptGraphNode(
                id=c.id,
                name=c.canonical_name,
                description=c.canonical_description,
                difficulty=c.difficulty,
                mastery=ukp.mastery if ukp else None,
                section_id=primary.section_id if primary else 0,
                section_title=section.title if section else (primary.section_title_snapshot if primary else ""),
                book_id=primary.book_id if primary else None,
                book_title=bk.title if bk else (list(books_involved)[0] if books_involved else None),
            ).model_dump() | {"mention_count": len(all_mentions), "books_involved": list(books_involved), "courses_involved": list(courses_involved)})

        # Edges: canonical relations filtered to visible concepts
        rels = list(db.scalars(select(ConceptRelation).where(
            ConceptRelation.source_concept_id.in_(concept_ids),
            ConceptRelation.target_concept_id.in_(concept_ids),
        ))) if concept_ids else []
        intra = [
            ConceptGraphEdge(id=r.id, source=r.source_concept_id, target=r.target_concept_id,
                             relationship_type=r.relationship_type, strength=r.strength, explanation=r.explanation_long or r.explanation_short).model_dump()
            for r in rels
        ]
        # Inter_edges: derive from relations where source/target mentions span multiple books (cross-book)
        inter: list[dict] = []
        for r in rels:
            src_mentions = list(db.scalars(select(ConceptMention).where(ConceptMention.concept_id == r.source_concept_id).limit(3)))
            tgt_mentions = list(db.scalars(select(ConceptMention).where(ConceptMention.concept_id == r.target_concept_id).limit(3)))
            src_books = {m.book_id for m in src_mentions}
            tgt_books = {m.book_id for m in tgt_mentions}
            if src_books.isdisjoint(tgt_books):
                # cross-book
                src_book_title = (db.get(Book, src_mentions[0].book_id).title if src_mentions and db.get(Book, src_mentions[0].book_id) else None)
                tgt_book_title = (db.get(Book, tgt_mentions[0].book_id).title if tgt_mentions and db.get(Book, tgt_mentions[0].book_id) else None)
                inter.append({
                    "id": r.id,
                    "source_kp_id": r.source_concept_id,
                    "target_kp_id": r.target_concept_id,
                    "similarity": r.strength,
                    "relationship_label": r.relationship_type,
                    "explanation": r.explanation_long,
                    "explanation_short": r.explanation_short,
                    "source_book_title": src_book_title,
                    "target_book_title": tgt_book_title,
                    "source_kp_name": db.get(Concept, r.source_concept_id).canonical_name if db.get(Concept, r.source_concept_id) else "?",
                    "target_kp_name": db.get(Concept, r.target_concept_id).canonical_name if db.get(Concept, r.target_concept_id) else "?",
                })
        # Also include legacy CrossBookLinks translated to canonical ids for backward compat when no canonical rels yet
        if not inter and not rels:
            legacy_links = list(db.scalars(select(CrossBookLink)))
            for link in legacy_links:
                src_kp = db.get(KnowledgePoint, link.source_kp_id)
                tgt_kp = db.get(KnowledgePoint, link.target_kp_id)
                if not src_kp or not tgt_kp:
                    continue
                src_c = db.scalar(select(Concept).where(Concept.canonical_name_norm == src_kp.name.strip().lower()).limit(1))
                tgt_c = db.scalar(select(Concept).where(Concept.canonical_name_norm == tgt_kp.name.strip().lower()).limit(1))
                if src_c and tgt_c and src_c.id in concept_ids and tgt_c.id in concept_ids:
                    inter.append({
                        "id": link.id + 100000,
                        "source_kp_id": src_c.id,
                        "target_kp_id": tgt_c.id,
                        "similarity": link.similarity,
                        "relationship_label": link.relationship_label,
                        "explanation": link.explanation,
                        "source_book_title": db.get(Book, src_kp.book_id).title if db.get(Book, src_kp.book_id) else None,
                        "target_book_title": db.get(Book, tgt_kp.book_id).title if db.get(Book, tgt_kp.book_id) else None,
                        "source_kp_name": src_c.canonical_name,
                        "target_kp_name": tgt_c.canonical_name,
                    })
        return {"nodes": nodes, "intra_edges": intra, "inter_edges": inter}

    # Legacy fallback
    kps = list(db.scalars(select(KnowledgePoint).order_by(KnowledgePoint.id)))
    kp_map = {kp.id: kp for kp in kps}
    book_cache: dict[int, Book] = {}
    nodes_legacy: list[ConceptGraphNode] = []
    for kp in kps:
        ukp = db.scalar(select(UserKnowledgePoint).where(UserKnowledgePoint.knowledge_point_id == kp.id))
        section = db.get(Section, kp.section_id)
        bk = book_cache.get(kp.book_id)
        if bk is None:
            bk = db.get(Book, kp.book_id)
            if bk: book_cache[kp.book_id] = bk
        nodes_legacy.append(ConceptGraphNode(id=kp.id, name=kp.name, description=kp.description, difficulty=kp.difficulty, mastery=ukp.mastery if ukp else None, section_id=kp.section_id, section_title=section.title if section else "", book_id=kp.book_id, book_title=bk.title if bk else None))
    intra_edges = list(db.scalars(select(ConceptEdge)))
    intra = [ConceptGraphEdge(id=e.id, source=e.source_point_id, target=e.target_point_id, relationship_type=e.relationship_type, strength=e.strength).model_dump() for e in intra_edges if e.target_point_id in kp_map]
    cross_links = list(db.scalars(select(CrossBookLink)))
    inter = []
    for link in cross_links:
        src_kp = db.get(KnowledgePoint, link.source_kp_id)
        tgt_kp = db.get(KnowledgePoint, link.target_kp_id)
        if not src_kp or not tgt_kp:
            continue
        src_book = db.get(Book, src_kp.book_id)
        tgt_book = db.get(Book, tgt_kp.book_id)
        inter.append({"id": link.id, "source_kp_id": link.source_kp_id, "target_kp_id": link.target_kp_id, "similarity": link.similarity, "relationship_label": link.relationship_label, "explanation": link.explanation, "source_book_title": src_book.title if src_book else None, "target_book_title": tgt_book.title if tgt_book else None, "source_kp_name": src_kp.name, "target_kp_name": tgt_kp.name})
    return {"nodes": [n.model_dump() for n in nodes_legacy], "intra_edges": [e for e in intra], "inter_edges": inter}


@router.get("/cross-book/related/{book_id}/{section_id}")
def get_related_sections(book_id: int, section_id: int, db: Session = Depends(get_db)):
    """Section relatedness via canonical ConceptRelations (with legacy fallback)."""
    section = db.get(Section, section_id)
    if section is None:
        raise HTTPException(status_code=404, detail="Section not found")

    # Prefer canonical: find concept ids with a mention in this section (any book)
    has_canonical = db.scalar(select(Concept).limit(1)) is not None
    if has_canonical:
        section_mentions = list(db.scalars(select(ConceptMention).where(ConceptMention.section_id == section_id)))
        if section_mentions:
            section_concept_ids = {m.concept_id for m in section_mentions}
            related: dict[int, float] = {}
            for r in db.scalars(select(ConceptRelation).where(
                (ConceptRelation.source_concept_id.in_(section_concept_ids)) | (ConceptRelation.target_concept_id.in_(section_concept_ids))
            )):
                other = r.target_concept_id if r.source_concept_id in section_concept_ids else r.source_concept_id
                related[other] = max(related.get(other, 0), r.strength)
            if related:
                # Map related concept → sections (via mentions)
                section_scores: dict[tuple[int, int], dict] = {}
                for other_cid, sim in related.items():
                    for m in db.scalars(select(ConceptMention).where(ConceptMention.concept_id == other_cid)):
                        if m.book_id == book_id and m.section_id == section_id:
                            continue
                        key = (m.book_id, m.section_id)
                        if key not in section_scores:
                            b = db.get(Book, m.book_id)
                            s = db.get(Section, m.section_id)
                            section_scores[key] = {
                                "book_id": m.book_id,
                                "book_title": b.title if b else "?",
                                "section_id": m.section_id,
                                "section_title": s.title if s else m.section_title_snapshot,
                                "page_start": s.page_start if s else 0,
                                "page_end": s.page_end if s else 0,
                                "max_similarity": 0,
                                "shared_clusters": [],
                                "explanation": "",
                            }
                        section_scores[key]["max_similarity"] = max(section_scores[key]["max_similarity"], sim)
                results = sorted(section_scores.values(), key=lambda x: x["max_similarity"], reverse=True)[:10]
                # Enrich explanation via LLM for top 3 only to keep latency
                current_book = db.get(Book, book_id)
                section_concept_names = [db.get(Concept, cid).canonical_name for cid in section_concept_ids if db.get(Concept, cid)]
                for r in results[:3]:
                    try:
                        messages = [
                            {"role": "system", "content": _prompt_text("related_sections.txt", {
                                "section_a_title": section.title,
                                "book_a_title": current_book.title if current_book else "?",
                                "section_a_topics": ", ".join(section_concept_names[:10]),
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
                for r in results[3:]:
                    r["explanation"] = f"Both sections share related concepts ({r['max_similarity']:.0%} similarity)"
                return results
        # fall through to legacy if no canonical mentions in this section

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
