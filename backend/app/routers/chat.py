import json
import logging
import time

import litellm
from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import StreamingResponse
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.orm import Session

from ..config import settings
from ..database import SessionLocal, get_db
from ..llm import llm_client
from ..models import Book, ChatSession, Message, Note
from ..rag import augment_with_web, build_chat_messages, reader_notes_block, retrieve_context
from ..schemas import ChatSessionOut, Citation, MessageOut

logger = logging.getLogger(__name__)
router = APIRouter(tags=["chat"])

HISTORY_LIMIT = settings.llm.max_history_messages
MAX_STREAM_ATTEMPTS = 3
RETRY_BASE_DELAY_SECONDS = 5


class SendMessageRequest(BaseModel):
    content: str


def _to_message_out(m: Message) -> MessageOut:
    citations = None
    if m.citations_json:
        try:
            citations = [Citation(**item) for item in json.loads(m.citations_json)]
        except ValueError:
            citations = None
    return MessageOut(id=m.id, role=m.role, content=m.content, citations=citations)


@router.post("/books/{book_id}/sessions", response_model=ChatSessionOut)
def create_session(book_id: int, db: Session = Depends(get_db)):
    if db.get(Book, book_id) is None:
        raise HTTPException(status_code=404, detail="Book not found")
    session = ChatSession(book_id=book_id)
    db.add(session)
    db.commit()
    db.refresh(session)
    return session


@router.get("/books/{book_id}/sessions", response_model=list[ChatSessionOut])
def list_sessions(book_id: int, db: Session = Depends(get_db)):
    return list(
        db.scalars(select(ChatSession).where(ChatSession.book_id == book_id).order_by(ChatSession.id.desc()))
    )


@router.delete("/sessions/{session_id}")
def delete_session(session_id: int, db: Session = Depends(get_db)):
    session = db.get(ChatSession, session_id)
    if session is None:
        raise HTTPException(status_code=404, detail="Session not found")
    db.delete(session)
    db.commit()
    return {"ok": True}


@router.get("/sessions/{session_id}/messages", response_model=list[MessageOut])
def list_messages(session_id: int, db: Session = Depends(get_db)):
    if db.get(ChatSession, session_id) is None:
        raise HTTPException(status_code=404, detail="Session not found")
    rows = db.scalars(select(Message).where(Message.session_id == session_id).order_by(Message.id))
    return [_to_message_out(m) for m in rows]


def _sse(payload: dict) -> str:
    return f"data: {json.dumps(payload)}\n\n"


def _event_stream(session_id: int, book_id: int, question: str):
    db = SessionLocal()
    try:
        history_rows = list(
            db.scalars(
                select(Message)
                .where(Message.session_id == session_id)
                .order_by(Message.id.desc())
                .limit(HISTORY_LIMIT)
            )
        )
        history = [{"role": r.role, "content": r.content} for r in reversed(history_rows)]

        db.add(Message(session_id=session_id, role="user", content=question))
        db.commit()

        result = retrieve_context(question, book_id)
        if result.best_distance is None or result.best_distance > settings.chat.web_fallback_distance:
            yield _sse({"type": "status", "value": "Not in the book — searching the web…"})

            if settings.web_search.query_expansion:
                yield _sse({"type": "status", "value": "Decomposing query for better results…"})

            if settings.web_search.relevance_filter:
                yield _sse({"type": "status", "value": "Scoring result relevance…"})

            result = augment_with_web(result, question)

        yield _sse({"type": "citations", "citations": [c.model_dump() for c in result.citations]})

        notes = list(
            db.scalars(select(Note).where(Note.book_id == book_id).order_by(Note.updated_at.desc()).limit(15))
        )
        notes_block = reader_notes_block(notes) if notes else ""
        messages = build_chat_messages(history, question, result.context, notes_block=notes_block)

        collected: list[str] = []
        try:
            for attempt in range(MAX_STREAM_ATTEMPTS):
                try:
                    for kind, value in llm_client.stream(messages):
                        if kind == "content":
                            collected.append(value)
                        yield _sse({"type": kind, "value": value})
                    break
                except litellm.RateLimitError:
                    attempts_left = MAX_STREAM_ATTEMPTS - 1 - attempt
                    if attempts_left > 0 and not collected:
                        delay = RETRY_BASE_DELAY_SECONDS * (attempt + 1)
                        logger.warning("Upstream rate limited; retrying in %ss (%d attempts left)", delay, attempts_left)
                        time.sleep(delay)
                    else:
                        raise
        except Exception as exc:
            logger.exception("LLM stream failed")
            yield _sse({"type": "error", "message": f"Model call failed: {exc}"})
            return

        if collected:
            db.add(
                Message(
                    session_id=session_id,
                    role="assistant",
                    content="".join(collected),
                    citations_json=json.dumps([c.model_dump() for c in result.citations]),
                )
            )
            db.commit()
        yield _sse({"type": "done"})
    except Exception:
        logger.exception("Chat stream failed")
        yield _sse({"type": "error", "message": "Unexpected server error"})
    finally:
        db.close()


@router.post("/sessions/{session_id}/title", response_model=ChatSessionOut)
def generate_title(session_id: int, db: Session = Depends(get_db)):
    """Name an untitled session from its first exchange."""
    session = db.get(ChatSession, session_id)
    if session is None:
        raise HTTPException(status_code=404, detail="Session not found")
    if session.title != "New chat":
        return session

    first_user = db.scalar(
        select(Message).where(Message.session_id == session_id, Message.role == "user").order_by(Message.id)
    )
    if first_user is None:
        return session
    first_bot = db.scalar(
        select(Message).where(Message.session_id == session_id, Message.role == "assistant").order_by(Message.id)
    )

    title_prompt = [
        {
            "role": "system",
            "content": "You name chat sessions. Reply with ONLY a 3-6 word title. No quotes, no period, no preamble.",
        },
        {
            "role": "user",
            "content": (
                f"Question: {first_user.content[:500]}\n\n"
                f"Answer excerpt: {(first_bot.content[:400] if first_bot else '(no answer yet)')}"
            ),
        },
    ]
    try:
        raw = llm_client.complete(title_prompt).strip().strip('"').strip("'")
    except Exception:
        logger.exception("Title generation failed")
        return session
    title = " ".join(raw.split())[:60]
    if not title:
        return session
    session.title = title
    db.commit()
    db.refresh(session)
    return session


@router.post("/sessions/{session_id}/messages")
def send_message(session_id: int, body: SendMessageRequest, db: Session = Depends(get_db)):
    session = db.get(ChatSession, session_id)
    if session is None:
        raise HTTPException(status_code=404, detail="Session not found")
    question = body.content.strip()
    if not question:
        raise HTTPException(status_code=400, detail="Empty message")
    return StreamingResponse(
        _event_stream(session.id, session.book_id, question),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )
