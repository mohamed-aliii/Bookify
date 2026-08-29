import json
import logging
import time
from typing import Literal

import litellm
from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import StreamingResponse
from pydantic import BaseModel
from sqlalchemy.orm import Session

from ..config import PROMPTS_DIR, settings
from ..database import get_db
from ..embeddings import embedding_client
from ..llm import llm_client
from ..models import Book, Section
from ..schemas import Citation
from ..vectorstore import get_vector_store

logger = logging.getLogger(__name__)
router = APIRouter(tags=["learning"])

MAX_STREAM_ATTEMPTS = 3
RETRY_BASE_DELAY_SECONDS = 5


def _sse(payload: dict) -> str:
    return f"data: {json.dumps(payload)}\n\n"


def _retrieve_section_context(db: Session, book_id: int, section_id: int) -> str:
    section = db.get(Section, section_id)
    if section is None:
        raise HTTPException(status_code=404, detail="Section not found")
    query_embedding = embedding_client.embed_query(section.title)
    store = get_vector_store()
    hits = store.query(query_embedding, book_id, settings.ingestion.top_k)
    parts: list[str] = []
    for i, hit in enumerate(hits, start=1):
        parts.append(f"[Excerpt {i} | Section: {hit.section_title} | pages {hit.page_start}-{hit.page_end}]\n{hit.text}")
    return "\n\n".join(parts)


def _build_messages(system_prompt: str, context: str, history: list[dict], user_message: str) -> list[dict]:
    messages: list[dict] = [{"role": "system", "content": system_prompt}]
    if context:
        messages.append({"role": "system", "content": f"Book excerpts for this section:\n\n{context}"})
    messages.extend(history)
    messages.append({"role": "user", "content": user_message})
    return messages


def _stream_llm(messages: list[dict]):
    collected: list[str] = []
    try:
        for attempt in range(MAX_STREAM_ATTEMPTS):
            try:
                for kind, value in llm_client.stream(messages):
                    if kind == "content":
                        collected.append(value)
                    yield _sse({"type": kind, "value": value})
                return
            except litellm.RateLimitError:
                attempts_left = MAX_STREAM_ATTEMPTS - 1 - attempt
                if attempts_left > 0 and not collected:
                    delay = RETRY_BASE_DELAY_SECONDS * (attempt + 1)
                    time.sleep(delay)
                else:
                    raise
    except Exception as exc:
        logger.exception("LLM stream failed")
        yield _sse({"type": "error", "message": f"Model call failed: {exc}"})


# ── Socratic Mode ──────────────────────────────────────────────


class SocraticRequest(BaseModel):
    section_id: int
    message: str
    history: list[dict] = []
    reveal_level: int = 0


class PracticeRequest(BaseModel):
    section_id: int
    problem_type: Literal["auto", "code", "math", "design", "debug", "conceptual"] = "auto"
    answer: str | None = None
    problem_id: str | None = None
    hints_revealed: int = 0


@router.post("/books/{book_id}/socratic")
def socratic_stream(book_id: int, body: SocraticRequest, db: Session = Depends(get_db)):
    if db.get(Book, book_id) is None:
        raise HTTPException(status_code=404, detail="Book not found")
    context = _retrieve_section_context(db, book_id, body.section_id)
    system_prompt = (PROMPTS_DIR / "socratic.txt").read_text(encoding="utf-8")
    system_prompt += f"\n\nStudent's reveal level: {body.reveal_level} (0=strict, 1=hint mode, 2=reveal after 1 wrong)"
    messages = _build_messages(system_prompt, context, body.history, body.message)

    def generate():
        yield from _stream_llm(messages)
        yield _sse({"type": "done"})

    return StreamingResponse(generate(), media_type="text/event-stream", headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"})


# ── Teach-Back Mode (Conversational Q&A) ───────────────────────


class TeachBackStartRequest(BaseModel):
    section_id: int


class TeachBackChatRequest(BaseModel):
    section_id: int
    conversation: list[dict]
    question_text: str | None = None


@router.post("/books/{book_id}/teachback/questions")
def teachback_questions(book_id: int, body: TeachBackStartRequest, db: Session = Depends(get_db)):
    if db.get(Book, book_id) is None:
        raise HTTPException(status_code=404, detail="Book not found")
    context = _retrieve_section_context(db, book_id, body.section_id)
    system_prompt = (PROMPTS_DIR / "teachback_questions.txt").read_text(encoding="utf-8")
    user_msg = "Generate deep understanding questions for this section."
    messages = _build_messages(system_prompt, context, [], user_msg)

    raw = llm_client.complete(messages)
    raw = raw.strip().removeprefix("```json").removeprefix("```").removesuffix("```").strip()
    try:
        data = json.loads(raw)
    except json.JSONDecodeError:
        lines = [l.strip() for l in raw.split("\n") if l.strip()]
        data = {"questions": [{"id": f"q{i}", "text": line, "difficulty": "medium", "tests": ""} for i, line in enumerate(lines)]}
    return data


@router.post("/books/{book_id}/teachback/chat")
def teachback_chat(book_id: int, body: TeachBackChatRequest, db: Session = Depends(get_db)):
    if db.get(Book, book_id) is None:
        raise HTTPException(status_code=404, detail="Book not found")
    context = _retrieve_section_context(db, book_id, body.section_id)
    system_prompt = (PROMPTS_DIR / "teachback_chat.txt").read_text(encoding="utf-8")
    messages = [{"role": "system", "content": system_prompt}]
    if context:
        messages.append({"role": "system", "content": f"Book excerpts for this section:\n\n{context}"})
    messages.extend(body.conversation)

    def generate():
        yield _sse({"type": "status", "value": "Thinking…"})
        yield from _stream_llm(messages)
        yield _sse({"type": "done"})

    return StreamingResponse(generate(), media_type="text/event-stream", headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"})


# ── Practice Problems ──────────────────────────────────────────


class PracticeGenerateRequest(BaseModel):
    section_id: int
    problem_type: Literal["auto", "code", "math", "design", "debug", "conceptual"] = "auto"


class PracticeGradeRequest(BaseModel):
    section_id: int
    problem_id: str
    answer: str


@router.post("/books/{book_id}/practice/generate")
def practice_generate(book_id: int, body: PracticeGenerateRequest, db: Session = Depends(get_db)):
    if db.get(Book, book_id) is None:
        raise HTTPException(status_code=404, detail="Book not found")
    context = _retrieve_section_context(db, book_id, body.section_id)
    system_prompt = (PROMPTS_DIR / "practice.txt").read_text(encoding="utf-8")
    type_hint = "" if body.problem_type == "auto" else f"\n\nGenerate a {body.problem_type} type problem."
    user_msg = f"Generate one practice problem for this section.{type_hint}"
    messages = _build_messages(system_prompt, context, [], user_msg)

    raw = llm_client.complete(messages)
    raw = raw.strip().removeprefix("```json").removeprefix("```").removesuffix("```").strip()
    try:
        problem = json.loads(raw)
    except json.JSONDecodeError:
        problem = {"problem_type": "conceptual", "difficulty": "medium", "question": raw, "hints": [], "solution": ""}
    import hashlib
    problem_id = hashlib.md5(json.dumps(problem).encode()).hexdigest()[:12]
    return {"problem_id": problem_id, **problem}


@router.post("/books/{book_id}/practice/grade")
def practice_grade(book_id: int, body: PracticeGradeRequest, db: Session = Depends(get_db)):
    if db.get(Book, book_id) is None:
        raise HTTPException(status_code=404, detail="Book not found")
    context = _retrieve_section_context(db, book_id, body.section_id)
    system_prompt = (
        "You are grading a student's answer to a practice problem. "
        "Give concise, specific feedback. Score correctness 0.0-1.0. "
        "Explain what's right and what's wrong. If partially correct, explain what's missing."
    )
    user_msg = f"Student's answer:\n\"\"\"\n{body.answer}\n\"\"\"\n\nProvide feedback and a correctness score (0-1)."
    messages = _build_messages(system_prompt, context, [], user_msg)

    def generate():
        yield _sse({"type": "status", "value": "Evaluating your answer…"})
        yield from _stream_llm(messages)
        yield _sse({"type": "done"})

    return StreamingResponse(generate(), media_type="text/event-stream", headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"})


# ── Understanding Check ────────────────────────────────────────


class UnderstandRequest(BaseModel):
    section_id: int
    answers: list[str] | None = None


@router.post("/books/{book_id}/understand")
def understand_check(book_id: int, body: UnderstandRequest, db: Session = Depends(get_db)):
    if db.get(Book, book_id) is None:
        raise HTTPException(status_code=404, detail="Book not found")
    context = _retrieve_section_context(db, book_id, body.section_id)
    system_prompt = (PROMPTS_DIR / "understanding_check.txt").read_text(encoding="utf-8")

    if body.answers is None:
        user_msg = "Generate the pre-assessment questions for this section."
        messages = _build_messages(system_prompt, context, [], user_msg)
        raw = llm_client.complete(messages)
        raw = raw.strip().removeprefix("```json").removeprefix("```").removesuffix("```").strip()
        try:
            data = json.loads(raw)
        except json.JSONDecodeError:
            data = {"questions": [raw]}
        return data
    else:
        answers_text = "\n".join(f"Q{i+1}: {a}" for i, a in enumerate(body.answers))
        user_msg = f"The student answered the pre-assessment:\n\n{answers_text}\n\nAnalyze their answers."
        messages = _build_messages(system_prompt, context, [], user_msg)

        def generate():
            yield _sse({"type": "status", "value": "Analyzing your understanding…"})
            yield from _stream_llm(messages)
            yield _sse({"type": "done"})

        return StreamingResponse(generate(), media_type="text/event-stream", headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"})
