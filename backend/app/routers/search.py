from collections import defaultdict

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from ..database import get_db
from ..embeddings import embedding_client
from ..llm import llm_client
from ..models import Book, Section
from ..schemas import SearchHit
from ..vectorstore import RetrievedChunk, get_vector_store

router = APIRouter(prefix="/search", tags=["search"])

RRF_K = 60
TITLE_BOOST_WEIGHT = 0.04
ORIG_QUERY_WEIGHT = 3.0


def _resolve_section_id(db: Session, book_id: int, title: str, page_start: int) -> int | None:
    row = db.execute(
        select(Section.id)
        .where(Section.book_id == book_id, Section.title.in_([title, title[:300]]))
        .order_by(func.abs(Section.page_start - page_start))
        .limit(1)
    ).scalar()
    return row


def _tokenize(text: str) -> set[str]:
    return {w for w in "".join(c.lower() if c.isalnum() else " " for c in text).split() if len(w) > 2}


def _expand_query(query: str) -> list[str]:
    """LLM rewrites the query into textbook-flavoured phrasings."""
    try:
        raw = llm_client.complete(
            [
                {
                    "role": "system",
                    "content": (
                        "You rewrite search queries for searching the text of technical books. "
                        "Reply with EXACTLY two alternative phrasings of the query on separate lines. "
                        "No numbering, quotes, or explanations."
                    ),
                },
                {"role": "user", "content": query},
            ]
        )
    except Exception:
        return []
    variants: list[str] = []
    for line in raw.splitlines():
        clean = line.strip().strip("-•").strip()
        if 2 <= len(clean) <= 140:
            variants.append(clean)
    return variants[:2]


def _fuse_and_rank(
    db: Session,
    query: str,
    per_variant_hits: list[list[RetrievedChunk]],
    limit: int,
) -> list[SearchHit]:
    # reciprocal rank fusion at chunk level with asymmetric query weighting
    chunk_scores: dict[tuple, float] = defaultdict(float)
    chunk_best: dict[tuple, RetrievedChunk] = {}
    for variant_idx, hits in enumerate(per_variant_hits):
        weight = ORIG_QUERY_WEIGHT if variant_idx == 0 else 1.0
        for rank, hit in enumerate(hits, start=1):
            key = (hit.book_id, hit.section_title[:300], hit.page_start)
            chunk_scores[key] += weight / (RRF_K + rank)
            current = chunk_best.get(key)
            if current is None or hit.distance < current.distance:
                chunk_best[key] = hit

    # aggregate to section level so multi-page sections appear once
    section_scores: dict[tuple, float] = defaultdict(float)
    section_rep: dict[tuple, tuple] = {}
    section_meta: dict[tuple, tuple] = {}
    section_id_cache: dict[tuple, int | None] = {}

    for key, score in chunk_scores.items():
        hit = chunk_best[key]
        sid_key = (key[0], key[1])
        if sid_key not in section_id_cache:
            section_id_cache[sid_key] = _resolve_section_id(db, key[0], key[1], hit.page_start)
        sid = section_id_cache[sid_key]
        agg_key = (key[0], ("sid", sid) if sid is not None else ("raw", key[1], key[2]))
        section_scores[agg_key] += score
        rep_key = section_rep.get(agg_key)
        if rep_key is None or hit.distance < chunk_best[rep_key].distance:
            section_rep[agg_key] = key
        section_meta[agg_key] = (sid, key[1])

    query_terms = _tokenize(query)
    ranked: list[tuple[float, float, tuple]] = []
    for agg_key, score in section_scores.items():
        _, title = section_meta[agg_key]
        title_terms = _tokenize(title)
        overlap = len(query_terms & title_terms) / max(len(query_terms), 1)
        rep_key = section_rep[agg_key]
        best_dist = chunk_best[rep_key].distance
        ranked.append((score + TITLE_BOOST_WEIGHT * overlap, best_dist, agg_key))
    ranked.sort(key=lambda item: (item[0], -item[1]), reverse=True)

    results: list[SearchHit] = []
    for fused_score, _best_dist, agg_key in ranked[:limit]:
        rep_key = section_rep[agg_key]
        hit = chunk_best[rep_key]
        book = db.get(Book, hit.book_id)
        if book is None or book.status != "ready":
            continue
        sid = section_meta[agg_key][0]
        results.append(
            SearchHit(
                book_id=book.id,
                book_title=book.title,
                section_id=sid,
                section_title=hit.section_title,
                page_start=hit.page_start,
                page_end=hit.page_end,
                snippet=hit.text[:260].replace("\n", " ").strip(),
                distance=round(hit.distance, 4),
            )
        )
    return results


@router.get("", response_model=list[SearchHit])
def search_library(
    q: str = Query(min_length=1),
    k: int = Query(default=12, ge=1, le=30),
    mode: str = Query(default="enhanced", pattern="^(basic|enhanced)$"),
    db: Session = Depends(get_db),
):
    """Semantic search across every indexed book in the library."""
    query = q.strip()
    if not query:
        raise HTTPException(status_code=422, detail="Empty query")

    store = get_vector_store()
    if mode == "basic":
        embedding = embedding_client.embed_query(query)
        hits = store.query_all(embedding, k)
        results: list[SearchHit] = []
        for hit in hits:
            book = db.get(Book, hit.book_id)
            if book is None or book.status != "ready":
                continue
            results.append(
                SearchHit(
                    book_id=book.id,
                    book_title=book.title,
                    section_id=_resolve_section_id(db, book.id, hit.section_title, hit.page_start),
                    section_title=hit.section_title,
                    page_start=hit.page_start,
                    page_end=hit.page_end,
                    snippet=hit.text[:260].replace("\n", " ").strip(),
                    distance=round(hit.distance, 4),
                )
            )
        return results

    variants = [query] + _expand_query(query)
    per_variant_hits = [store.query_all(embedding_client.embed_query(v), 30) for v in variants]
    return _fuse_and_rank(db, query, per_variant_hits, k)
