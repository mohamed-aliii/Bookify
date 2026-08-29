from dataclasses import dataclass

from .config import PROMPTS_DIR, settings
from .embeddings import embedding_client
from .schemas import Citation
from .vectorstore import RetrievedChunk, get_vector_store


@dataclass
class RetrievalResult:
    context: str
    citations: list[Citation]
    best_distance: float | None = None


def retrieve_context(question: str, book_id: int) -> RetrievalResult:
    query_embedding = embedding_client.embed_query(question)
    store = get_vector_store()
    hits: list[RetrievedChunk] = store.query(query_embedding, book_id, settings.ingestion.top_k)
    if not hits:
        return RetrievalResult(context="", citations=[], best_distance=None)
    best_distance = min(hit.distance for hit in hits)

    parts: list[str] = []
    seen_pages: set[int] = set()
    citations: list[Citation] = []
    for i, hit in enumerate(hits, start=1):
        label = f"[Excerpt {i} | Section: {hit.section_title} | pages {hit.page_start}-{hit.page_end}]"
        parts.append(f"{label}\n{hit.text}")
        if hit.page_start not in seen_pages:
            seen_pages.add(hit.page_start)
            citations.append(
                Citation(
                    page=hit.page_start,
                    section_title=hit.section_title,
                    snippet=hit.text[:180].replace("\n", " "),
                )
            )

    code_hits = store.query_code(query_embedding, book_id, 3)
    for j, hit in enumerate(code_hits, start=1):
        parts.append(f"[Code snippet {j} | Section: {hit.section_title} | pages {hit.page_start}-{hit.page_end}]\n{hit.text}")

    return RetrievalResult(
        context="\n\n".join(parts),
        citations=citations,
        best_distance=best_distance,
    )


def augment_with_web(result: RetrievalResult, question: str) -> RetrievalResult:
    from .websearch import search_web

    web_hits = search_web(question)
    if not web_hits:
        return result

    parts = [result.context] if result.context else []
    for i, hit in enumerate(web_hits, start=1):
        content = hit.content or hit.snippet
        parts.append(f"[Web result {i} | Source: {hit.title} | URL: {hit.url} | Relevance: {hit.score:.1f}]\n{content}")
        result.citations.append(Citation(page=None, section_title=hit.title, snippet=hit.snippet[:180], url=hit.url))
    return RetrievalResult(
        context="\n\n".join(parts),
        citations=result.citations,
        best_distance=result.best_distance,
    )


def build_chat_messages(history: list[dict], question: str, context: str, notes_block: str = "") -> list[dict]:
    system_prompt = (PROMPTS_DIR / "chat_system.txt").read_text(encoding="utf-8")
    if notes_block:
        system_prompt += "\n\n" + notes_block
    messages: list[dict] = [{"role": "system", "content": system_prompt}]
    messages.extend(history)
    user_content = (
        f"Book excerpts retrieved for this question:\n\n{context}\n\nReader's question: {question}"
        if context
        else question
    )
    messages.append({"role": "user", "content": user_content})
    return messages


def reader_notes_block(notes) -> str:
    """Format the reader's own notes for the system prompt."""
    lines: list[str] = []
    total = 0
    for i, note in enumerate(notes, start=1):
        loc = []
        if note.section is not None and note.section.title:
            loc.append(f"Section: {note.section.title}")
        if note.page is not None:
            loc.append(f"p.{note.page}")
        suffix = f" ({', '.join(loc)})" if loc else ""
        entry = f"{i}. “{note.content}”{suffix}"
        total += len(entry)
        if total > 1600 and lines:
            break
        lines.append(entry)
    if not lines:
        return ""
    header = (
        "The reader has also saved personal notes while studying this book. "
        "If a note is relevant to the question, weave it in naturally and refer to it as “your note”"
        " (e.g. “as you noted, …”). Never present the reader's notes as book content.\n\nReader's notes:\n"
    )
    return header + "\n".join(lines)
