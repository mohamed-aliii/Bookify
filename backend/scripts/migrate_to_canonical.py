"""
Backfill: migrates legacy KnowledgePoints into clean canonical Concepts.

Global dedup: one Concept per meaning-in-context across all PDFs/Courses.
Duplicate detection: normalized name exact match + cosine ≥0.82 + LLM confirm (concept_resolve).
Only distinct contexts remain separate; same meaning becomes ConceptMention provenance.

Run: python -m backend.scripts.migrate_to_canonical [--dry-run] [--force]
"""
import argparse
import json
import logging
import math
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(ROOT / "backend"))

from sqlalchemy import select

from backend.app.database import SessionLocal, engine, Base  # noqa: E402
from backend.app.models import Book, Concept, ConceptAlias, ConceptMention, ConceptRelation, KnowledgePoint, Section  # noqa: E402
from backend.app.config import PROMPTS_DIR  # noqa: E402
from backend.app.embeddings import embedding_client  # noqa: E402
from backend.app.llm import llm_client  # noqa: E402

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)


def _norm(s: str) -> str:
    return " ".join(s.strip().lower().split())


def _cosine(a, b):
    dot = sum(x*y for x,y in zip(a,b))
    na = math.sqrt(sum(x*x for x in a))
    nb = math.sqrt(sum(x*x for x in b))
    if na==0 or nb==0: return 0.0
    return dot/(na*nb)


def _prompt_text(name, subs=None):
    text = (PROMPTS_DIR / name).read_text(encoding="utf-8")
    for k,v in (subs or {}).items():
        text = text.replace("{%s}"%k, str(v))
    return text


def _extract_json(text: str) -> dict:
    cleaned=text.strip()
    if cleaned.startswith("```"):
        cleaned="\n".join(cleaned.splitlines()[1:-1]).strip()
    s,e=cleaned.find("{"),cleaned.rfind("}")
    if s==-1 or e<=s: raise ValueError("no json")
    return json.loads(cleaned[s:e+1])


def migrate(dry_run=False, force=False):
    Base.metadata.create_all(engine)
    with SessionLocal() as db:
        existing_concepts = db.scalar(select(Concept).limit(1))
        if existing_concepts and not force:
            logger.info("Concepts already exist — use --force to re-run")
            return {"migrated":0, "skipped":"already migrated"}

        kps = list(db.scalars(select(KnowledgePoint).order_by(KnowledgePoint.id)))
        if not kps:
            logger.info("No KnowledgePoints to migrate")
            return {"migrated":0}

        logger.info("Migrating %d legacy KPs → canonical Concepts (global dedup)", len(kps))
        # Order by book then section to keep deterministic first-seen canonical
        kps_sorted = sorted(kps, key=lambda kp: (kp.book_id, kp.section_id, kp.id))

        created_concepts = 0
        created_mentions = 0
        deduped = 0

        # For embedding batching
        # We'll process sequentially using resolve logic (embed recall against current canonicals)
        # For speed, cache embeddings of canonicals; rebuild after each new concept or periodically

        canonicals: list[Concept] = list(db.scalars(select(Concept).order_by(Concept.id)))  # may be empty
        canonical_embs: list[list[float]] = []
        if canonicals:
            texts = [f"{c.canonical_name}: {c.canonical_description}" for c in canonicals]
            # batch
            for _, batch in embedding_client.embed_batches(texts):
                canonical_embs.extend(batch)

        for kp in kps_sorted:
            book = db.get(Book, kp.book_id)
            section = db.get(Section, kp.section_id)
            snippet = ""
            # Try to get a chunk snippet for richer context
            try:
                from backend.app.models import Chunk
                chunks = list(db.scalars(select(Chunk).where(Chunk.section_id == kp.section_id).limit(3)))
                if chunks:
                    snippet = (chunks[0].text or "")[:500]
            except Exception:
                pass
            norm = _norm(kp.name)
            # Exact norm hit → check if already canonical
            exact = db.scalar(select(Concept).where(Concept.canonical_name_norm == norm))
            if exact is not None:
                # Add mention if not exists
                exists = db.scalar(select(ConceptMention).where(ConceptMention.concept_id==exact.id, ConceptMention.book_id==kp.book_id, ConceptMention.section_id==kp.section_id))
                if exists is None:
                    if not dry_run:
                        db.add(ConceptMention(concept_id=exact.id, book_id=kp.book_id, section_id=kp.section_id, section_title_snapshot=section.title if section else kp.name, snippet=snippet or kp.description[:500]))
                        # alias if wording differs but norm same -> already same norm, skip alias
                    created_mentions += 1
                deduped += 1
                continue

            # Alias hit
            alias_hit = db.scalar(select(ConceptAlias).where(ConceptAlias.alias_norm == norm).limit(1))
            if alias_hit is not None:
                exists = db.scalar(select(ConceptMention).where(ConceptMention.concept_id==alias_hit.concept_id, ConceptMention.book_id==kp.book_id, ConceptMention.section_id==kp.section_id))
                if exists is None and not dry_run:
                    db.add(ConceptMention(concept_id=alias_hit.concept_id, book_id=kp.book_id, section_id=kp.section_id, section_title_snapshot=section.title if section else kp.name, snippet=snippet or kp.description[:500]))
                if not dry_run:
                    db.flush()
                created_mentions += 1
                deduped += 1
                continue

            # Embedding recall vs existing canonicals
            candidate = None
            best_sim = 0.0
            best_cand = None
            if canonicals and canonical_embs:
                try:
                    prop_text = f"[{book.title if book else '?'} | {section.title if section else '?'}] {kp.name}: {kp.description} | {snippet[:300]}"
                    prop_emb = embedding_client.embed_texts([prop_text])[0]
                    for c, emb in zip(canonicals, canonical_embs):
                        sim = _cosine(prop_emb, emb)
                        if sim >= 0.82 and sim > best_sim:
                            best_sim = sim
                            best_cand = c
                except Exception as e:
                    logger.warning("embed recall failed for %s: %s", kp.name, e)

            if best_cand is not None and best_sim >= 0.82:
                # LLM confirm duplicate vs context diff
                try:
                    cand_mention = db.scalar(select(ConceptMention).where(ConceptMention.concept_id==best_cand.id).limit(1))
                    cand_snip = cand_mention.snippet if cand_mention and cand_mention.snippet else best_cand.canonical_description[:400]
                    aliases = ", ".join(a.alias_term for a in db.scalars(select(ConceptAlias).where(ConceptAlias.concept_id==best_cand.id).limit(5))) or "—"
                    prompt = _prompt_text("concept_resolve.txt", {
                        "existing_id": str(best_cand.id),
                        "existing_name": best_cand.canonical_name,
                        "existing_desc": best_cand.canonical_description,
                        "existing_book_title": book.title if book else "?",
                        "existing_section_title": section.title if section else "?",
                        "existing_snippet": cand_snip[:400],
                        "existing_aliases": aliases,
                        "proposed_name": kp.name,
                        "proposed_desc": kp.description,
                        "proposed_difficulty": str(kp.difficulty),
                        "proposed_book_title": book.title if book else "?",
                        "proposed_section_title": section.title if section else "?",
                        "proposed_snippet": snippet[:400] or kp.description[:400],
                        "similarity": f"{best_sim:.3f}",
                    })
                    raw = llm_client.complete([{"role":"system","content":prompt},{"role":"user","content":"Decide now. Return JSON only."}])
                    res = _extract_json(raw)
                    decision = res.get("decision","unrelated")
                except Exception as e:
                    logger.warning("LLM confirm failed for %s — %s: %s", kp.name, best_cand.canonical_name, e)
                    decision = "duplicate_same_context" if best_sim >= 0.92 else "unrelated"

                if decision == "duplicate_same_context":
                    if not dry_run:
                        exists = db.scalar(select(ConceptMention).where(ConceptMention.concept_id==best_cand.id, ConceptMention.book_id==kp.book_id, ConceptMention.section_id==kp.section_id))
                        if exists is None:
                            db.add(ConceptMention(concept_id=best_cand.id, book_id=kp.book_id, section_id=kp.section_id, section_title_snapshot=section.title if section else kp.name, snippet=snippet or kp.description[:500]))
                        if norm != best_cand.canonical_name_norm:
                            alias_exists = db.scalar(select(ConceptAlias).where(ConceptAlias.concept_id==best_cand.id, ConceptAlias.alias_norm==norm))
                            if alias_exists is None:
                                db.add(ConceptAlias(concept_id=best_cand.id, alias_term=kp.name.strip(), alias_norm=norm, source_book_id=kp.book_id))
                        db.flush()
                    created_mentions += 1
                    deduped += 1
                    continue
                # If same_term_different_context or distinct_related — we will create new canonical below and also create an edge
                create_edge = decision in ("same_term_different_context","distinct_related")
                edge_info = res if create_edge else None
            else:
                create_edge = False
                edge_info = None
                best_cand = None

            # Create new canonical
            if dry_run:
                created_concepts += 1
                continue
            concept = Concept(canonical_name=kp.name.strip(), canonical_name_norm=norm, canonical_description=kp.description.strip(), difficulty=kp.difficulty)
            db.add(concept)
            db.flush()
            db.add(ConceptMention(concept_id=concept.id, book_id=kp.book_id, section_id=kp.section_id, section_title_snapshot=section.title if section else kp.name, snippet=snippet or kp.description[:500]))
            db.add(ConceptAlias(concept_id=concept.id, alias_term=kp.name.strip(), alias_norm=norm, source_book_id=kp.book_id))
            # embed for future recall
            try:
                txt = f"{concept.canonical_name}: {concept.canonical_description}"
                emb = embedding_client.embed_texts([txt])[0]
                canonicals.append(concept)
                canonical_embs.append(emb)
            except Exception:
                canonicals.append(concept)
                canonical_embs.append([])

            if create_edge and best_cand and edge_info:
                rel = str(edge_info.get("relationship") or "related").strip()
                if rel not in ("prerequisite","builds_on","related","contrasts_with","analogous"): rel="related"
                try:
                    strength = float(edge_info.get("strength") or best_sim)
                except: strength = best_sim
                expl_long = str(edge_info.get("explanation_long") or "").strip()[:2000]
                expl_short = str(edge_info.get("explanation_short") or "").strip()[:500]
                # Avoid duplicate edge
                from sqlalchemy import or_
                exists_rel = db.scalar(select(ConceptRelation).where(or_(
                    (ConceptRelation.source_concept_id==best_cand.id) & (ConceptRelation.target_concept_id==concept.id),
                    (ConceptRelation.source_concept_id==concept.id) & (ConceptRelation.target_concept_id==best_cand.id),
                )))
                if exists_rel is None:
                    db.add(ConceptRelation(
                        source_concept_id=best_cand.id,
                        target_concept_id=concept.id,
                        relationship_type=rel,
                        strength=max(0.0,min(1.0,strength)),
                        explanation_long=expl_long,
                        explanation_short=expl_short,
                        evidence_json=json.dumps({"migrated_from_kp":kp.id,"similarity":best_sim}),
                    ))
            created_concepts += 1
            created_mentions += 1
            if not dry_run:
                db.flush()

        # Migrate legacy ConceptEdge → ConceptRelation where both ends now have canonicals (if no relation exists yet)
        if not dry_run:
            from backend.app.models import ConceptEdge
            edges = list(db.scalars(select(ConceptEdge)))
            edge_migrated = 0
            for e in edges:
                src_kp = db.get(KnowledgePoint, e.source_point_id)
                tgt_kp = db.get(KnowledgePoint, e.target_point_id)
                if not src_kp or not tgt_kp:
                    continue
                src_c = db.scalar(select(Concept).where(Concept.canonical_name_norm==_norm(src_kp.name)).limit(1))
                tgt_c = db.scalar(select(Concept).where(Concept.canonical_name_norm==_norm(tgt_kp.name)).limit(1))
                if not src_c or not tgt_c or src_c.id==tgt_c.id:
                    continue
                exists = db.scalar(select(ConceptRelation).where(
                    ((ConceptRelation.source_concept_id==src_c.id) & (ConceptRelation.target_concept_id==tgt_c.id)) |
                    ((ConceptRelation.source_concept_id==tgt_c.id) & (ConceptRelation.target_concept_id==src_c.id))
                ))
                if exists: continue
                rel = e.relationship_type if e.relationship_type in ("prerequisite","builds_on","related","contrasts_with") else "related"
                db.add(ConceptRelation(
                    source_concept_id=src_c.id,
                    target_concept_id=tgt_c.id,
                    relationship_type=rel,
                    strength=e.strength,
                    explanation_long=e.explanation or "",
                    explanation_short=(e.explanation or "")[:300],
                    evidence_json=json.dumps({"migrated_edge_id":e.id}),
                ))
                edge_migrated += 1
            logger.info("Migrated %d legacy ConceptEdges → ConceptRelations", edge_migrated)
            db.commit()
        else:
            logger.info("[dry-run] would create %d concepts, %d mentions, dedup %d", created_concepts, created_mentions, deduped)
            db.rollback()

        logger.info("Done: %d canonical concepts, %d mentions, %d deduped from %d KPs", created_concepts, created_mentions, deduped, len(kps))
        return {"created_concepts":created_concepts,"created_mentions":created_mentions,"deduped":deduped,"total_kps":len(kps)}

if __name__=="__main__":
    ap=argparse.ArgumentParser()
    ap.add_argument("--dry-run",action="store_true")
    ap.add_argument("--force",action="store_true")
    args=ap.parse_args()
    res=migrate(dry_run=args.dry_run, force=args.force)
    print(json.dumps(res, indent=2))
