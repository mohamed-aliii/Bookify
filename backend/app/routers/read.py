import json
import logging
from pathlib import Path

from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import StreamingResponse
from pydantic import BaseModel
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from ..config import PROMPTS_DIR
from ..database import get_db
from ..llm import llm_client
from ..models import Book, ChatSession, Chunk, Flashcard, Message, Note, Notebook, NotebookCell, Section
from ..schemas import MessageOut, SectionChatOut, SectionChatRequest

logger = logging.getLogger(__name__)
router = APIRouter(tags=["read"])

MAX_STREAM_ATTEMPTS = 3
RETRY_BASE_DELAY_SECONDS = 5


class ReadAskRequest(BaseModel):
    action: str
    text: str
    page: int | None = None
    section_id: int | None = None
    question: str | None = None


ACTION_PROMPTS = {
    "simplify": "read_simplify.txt",
    "explain": "read_explain.txt",
    "examples": "read_examples.txt",
    "code": "read_code_cell.txt",
    "flashcard": "read_flashcard.txt",
    "note": "read_note.txt",
    "translate": "read_translate.txt",
}


def _sse(payload: dict) -> str:
    return f"data: {json.dumps(payload)}\n\n"


def _prompt_text(name: str, subs: dict[str, object] | None = None) -> str:
    text = (PROMPTS_DIR / name).read_text(encoding="utf-8")
    for key, value in (subs or {}).items():
        text = text.replace("{%s}" % key, str(value))
    return text


def _find_context_chunks(db: Session, book_id: int, page: int | None, section_id: int | None) -> list[str]:
    chunks: list[Chunk] = []
    if section_id is not None:
        chunks = list(
            db.scalars(
                select(Chunk)
                .where(Chunk.book_id == book_id, Chunk.section_id == section_id)
                .order_by(Chunk.ord)
                .limit(8)
            )
        )
    elif page is not None:
        chunks = list(
            db.scalars(
                select(Chunk)
                .where(Chunk.book_id == book_id, Chunk.page_start <= page, Chunk.page_end >= page)
                .order_by(Chunk.ord)
                .limit(5)
            )
        )
    if not chunks:
        chunks = list(
            db.scalars(
                select(Chunk).where(Chunk.book_id == book_id).order_by(Chunk.ord).limit(8)
            )
        )
    return [c.text for c in chunks]


def _event_stream(book_id: int, body: ReadAskRequest):
    db = get_db().__next__()  # type: ignore
    try:
        book = db.get(Book, book_id)
        if book is None:
            yield _sse({"type": "error", "message": "Book not found"})
            return

        context_chunks = _find_context_chunks(db, book_id, body.page, body.section_id)
        context_text = "\n\n---\n\n".join(context_chunks) if context_chunks else ""

        action = body.action
        if action in ACTION_PROMPTS:
            prompt_file = ACTION_PROMPTS[action]
            system_msg = _prompt_text(prompt_file, {"selected_text": body.text})
        elif action == "ask" and body.question:
            system_msg = (
                "You are a helpful tutor. The student selected this passage from a technical book "
                "and has a question about it.\n\n"
                f"Selected passage:\n\"{body.text}\"\n\n"
                f"Surrounding context:\n{context_text}\n\n"
                f"Answer the student's question concisely and accurately. "
                "If the passage doesn't contain enough info, say so. "
                "Respond in the same language as the selected text."
            )
        else:
            yield _sse({"type": "error", "message": f"Unknown action: {action}"})
            return

        user_msg = f"Selected text:\n\"{body.text}\""
        if body.question:
            user_msg += f"\n\nStudent's question: {body.question}"
        if context_text:
            user_msg += f"\n\nAdditional context from surrounding pages:\n{context_text[:2000]}"

        messages = [
            {"role": "system", "content": system_msg},
            {"role": "user", "content": user_msg},
        ]

        try:
            for attempt in range(MAX_STREAM_ATTEMPTS):
                try:
                    for kind, value in llm_client.stream(messages):
                        yield _sse({"type": kind, "value": value})
                    break
                except Exception as exc:
                    if attempt < MAX_STREAM_ATTEMPTS - 1:
                        import time
                        time.sleep(RETRY_BASE_DELAY_SECONDS * (attempt + 1))
                    else:
                        raise

        except Exception as exc:
            logger.exception("Read/ask LLM stream failed")
            yield _sse({"type": "error", "message": f"Model call failed: {exc}"})
            return

        yield _sse({"type": "done"})
    except Exception:
        logger.exception("Read/ask stream failed")
        yield _sse({"type": "error", "message": "Unexpected server error"})
    finally:
        db.close()


@router.post("/books/{book_id}/read/ask")
def read_ask(book_id: int, body: ReadAskRequest, db: Session = Depends(get_db)):
    book = db.get(Book, book_id)
    if book is None:
        raise HTTPException(status_code=404, detail="Book not found")
    return StreamingResponse(
        _event_stream(book_id, body),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


def _get_or_create_section_chat(db: Session, book_id: int, section_id: int) -> ChatSession:
    section = db.get(Section, section_id)
    title = f"Section {section_id}"
    if section and section.title:
        title = section.title[:300]

    existing = db.scalars(
        select(ChatSession).where(
            ChatSession.book_id == book_id,
            ChatSession.section_id == section_id,
        )
    ).first()
    if existing:
        if existing.title != title:
            existing.title = title
            db.commit()
        return existing

    session = ChatSession(book_id=book_id, section_id=section_id, title=title)
    db.add(session)
    db.commit()
    db.refresh(session)
    return session


def _extract_python_code(response: str) -> str:
    text = response.strip()
    if "```" in text:
        parts = text.split("```")
        for i, part in enumerate(parts):
            if i % 2 == 1:
                code = part.strip()
                if code.startswith("python"):
                    code = code[len("python"):].lstrip("\n")
                if code:
                    return code
    return text


def _push_code_to_notebook(db: Session, book_id: int, section_id: int | None, code: str) -> NotebookCell | None:
    code = code.strip()
    if not code:
        return None
    notebook = db.scalar(select(Notebook).where(Notebook.book_id == book_id, Notebook.section_id == section_id))
    if notebook is None:
        title = "Notebook"
        if section_id is not None:
            section = db.get(Section, section_id)
            if section is not None:
                title = section.title[:397]
        notebook = Notebook(book_id=book_id, section_id=section_id, title=title)
        db.add(notebook)
        db.flush()
    max_ord = db.scalar(
        select(func.coalesce(func.max(NotebookCell.ord), -1)).where(NotebookCell.notebook_id == notebook.id)
    )
    cell = NotebookCell(notebook_id=notebook.id, ord=max_ord + 1, source=code, status="idle")
    db.add(cell)
    db.commit()
    db.refresh(cell)
    return cell


def _message_to_out(m: Message) -> dict:
    out = {
        "id": m.id,
        "role": m.role,
        "content": m.content,
        "action": m.action,
        "created_at": m.created_at.isoformat() if m.created_at else None,
    }
    return out


CHAT_HISTORY_LIMIT = 30


@router.get("/books/{book_id}/sections/{section_id}/chat", response_model=SectionChatOut)
def get_section_chat(book_id: int, section_id: int, db: Session = Depends(get_db)):
    if db.get(Book, book_id) is None:
        raise HTTPException(status_code=404, detail="Book not found")
    if db.get(Section, section_id) is None:
        raise HTTPException(status_code=404, detail="Section not found")
    session = _get_or_create_section_chat(db, book_id, section_id)
    messages = db.scalars(
        select(Message).where(Message.session_id == session.id).order_by(Message.id)
    ).all()
    return SectionChatOut(
        session_id=session.id,
        messages=[MessageOut.model_validate(_message_to_out(m)) for m in messages],
    )


def _section_chat_stream(book_id: int, section_id: int, body: SectionChatRequest):
    db = get_db().__next__()  # type: ignore
    try:
        book = db.get(Book, book_id)
        if book is None:
            yield _sse({"type": "error", "message": "Book not found"})
            return

        session = _get_or_create_section_chat(db, book_id, section_id)

        user_content = body.text
        if body.action == "ask" and body.question:
            user_content = f"{body.question}\n\nSelected text:\n\"{body.text}\""
        elif body.action != "ask":
            user_content = f"[{body.action}] {body.text}"

        db.add(Message(session_id=session.id, role="user", content=user_content, action=body.action))
        db.commit()

        history_rows = list(
            db.scalars(
                select(Message)
                .where(Message.session_id == session.id)
                .order_by(Message.id.desc())
                .limit(CHAT_HISTORY_LIMIT)
            )
        )
        history = [{"role": r.role, "content": r.content} for r in reversed(history_rows)]

        context_chunks = _find_context_chunks(db, book_id, body.page, None)
        context_text = "\n\n---\n\n".join(context_chunks) if context_chunks else ""

        if body.action in ACTION_PROMPTS:
            prompt_file = ACTION_PROMPTS[body.action]
            system_msg = _prompt_text(prompt_file, {"selected_text": body.text})
        elif body.action == "ask" and body.question:
            system_msg = (
                "You are a helpful tutor. The student is reading a technical book and has selected a passage.\n"
                "Answer the student's question concisely and accurately. "
                "Respond in the same language as the selected text."
            )
        else:
            yield _sse({"type": "error", "message": f"Unknown action: {body.action}"})
            return

        if context_text:
            system_msg += f"\n\nAdditional context from surrounding pages:\n{context_text[:3000]}"

        llm_messages = [{"role": "system", "content": system_msg}] + history

        full_response = ""
        suppress_content = body.action == "code"
        try:
            for attempt in range(MAX_STREAM_ATTEMPTS):
                try:
                    for kind, value in llm_client.stream(llm_messages):
                        if kind == "content":
                            full_response += value
                            if suppress_content:
                                continue
                        yield _sse({"type": kind, "value": value})
                    break
                except Exception as exc:
                    if attempt < MAX_STREAM_ATTEMPTS - 1:
                        import time
                        time.sleep(RETRY_BASE_DELAY_SECONDS * (attempt + 1))
                    else:
                        raise
        except Exception as exc:
            logger.exception("Section chat LLM stream failed")
            yield _sse({"type": "error", "message": f"Model call failed: {exc}"})
            return

        persisted_content = full_response
        if body.action == "code":
            persisted_content = "Added a Python code cell to your notebook."
        db.add(Message(session_id=session.id, role="assistant", content=persisted_content))
        db.commit()

        if body.action == "note" and full_response.strip():
            note = Note(
                book_id=book_id,
                section_id=section_id,
                page=body.page,
                quote=body.text,
                content=full_response.strip(),
            )
            db.add(note)
            db.commit()
            db.refresh(note)
            yield _sse({"type": "saved_note", "id": note.id})

        elif body.action == "flashcard" and full_response.strip():
            front, back = body.text, full_response.strip()
            try:
                parsed = json.loads(full_response)
                if isinstance(parsed, dict):
                    front = str(parsed.get("front") or front).strip()
                    back = str(parsed.get("back") or full_response).strip()
            except Exception:
                pass
            if front and back:
                max_ord = db.scalar(
                    select(func.coalesce(func.max(Flashcard.ord), -1)).where(Flashcard.section_id == section_id)
                )
                card = Flashcard(
                    book_id=book_id, section_id=section_id, front=front, back=back, ord=max_ord + 1
                )
                db.add(card)
                db.commit()
                db.refresh(card)
                try:
                    from ..xp_engine import award_xp
                    award_xp(db, "flashcards_generated")
                except Exception:
                    pass
                yield _sse({"type": "saved_flashcard", "id": card.id})

        elif body.action == "code" and full_response.strip():
            code = _extract_python_code(full_response)
            cell = _push_code_to_notebook(db, book_id, section_id, code)
            if cell is not None:
                yield _sse({"type": "notebook_created", "notebook_id": cell.notebook_id, "cell_id": cell.id})

        yield _sse({"type": "done"})
    except Exception:
        logger.exception("Section chat stream failed")
        yield _sse({"type": "error", "message": "Unexpected server error"})
    finally:
        db.close()


@router.post("/books/{book_id}/sections/{section_id}/chat")
def post_section_chat(
    book_id: int, section_id: int, body: SectionChatRequest, db: Session = Depends(get_db)
):
    if db.get(Book, book_id) is None:
        raise HTTPException(status_code=404, detail="Book not found")
    if db.get(Section, section_id) is None:
        raise HTTPException(status_code=404, detail="Section not found")
    return StreamingResponse(
        _section_chat_stream(book_id, section_id, body),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )
