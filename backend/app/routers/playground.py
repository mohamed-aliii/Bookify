import json
import logging
import subprocess
import tempfile
import time

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.orm import Session

from ..config import PROMPTS_DIR
from ..database import get_db
from ..embeddings import embedding_client
from ..llm import llm_client
from ..models import Book, Chunk, CodeBlock, Section
from ..schemas import CodeBlockOut, CodeRunRequest, CodeRunResult
from ..vectorstore import get_vector_store

logger = logging.getLogger(__name__)
router = APIRouter(tags=["playground"])

SAFE_PATTERNS = ["import os", "import subprocess", "import shutil", "os.system", "eval(", "exec("]


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
    if not isinstance(items, list):
        raise ValueError("Unexpected JSON structure")
    return items


@router.get("/books/{book_id}/code-blocks", response_model=list[CodeBlockOut])
def list_code_blocks(book_id: int, db: Session = Depends(get_db)):
    _load_book(db, book_id)
    return list(db.scalars(
        select(CodeBlock).where(CodeBlock.book_id == book_id).order_by(CodeBlock.id)
    ))


@router.post("/books/{book_id}/code-blocks/extract")
def extract_code_blocks(book_id: int, force: bool = False, db: Session = Depends(get_db)):
    _load_book(db, book_id)

    if not force:
        existing = db.scalar(select(CodeBlock).where(CodeBlock.book_id == book_id).limit(1))
        if existing is not None:
            return {"ok": True, "message": "Code blocks already exist"}
    else:
        old_blocks = list(db.scalars(select(CodeBlock).where(CodeBlock.book_id == book_id)))
        for block in old_blocks:
            db.delete(block)
        db.flush()

    total_created = 0
    created_blocks: list[CodeBlock] = []
    sections = list(db.scalars(
        select(Section).where(Section.book_id == book_id).order_by(Section.id)
    ))

    for section in sections:
        code_chunks = list(db.scalars(
            select(Chunk)
            .where(Chunk.book_id == book_id, Chunk.section_id == section.id, Chunk.is_code == True)
            .order_by(Chunk.ord)
        ))
        if not code_chunks:
            continue

        combined = "\n\n---\n\n".join(
            f"[Excerpt {i}]\n{c.text}" for i, c in enumerate(code_chunks, start=1)
        )

        messages = [
            {"role": "system", "content": _prompt_text("code_blocks.txt", {
                "section_title": section.title,
                "count": "3-5",
            })},
            {"role": "user", "content": f"Extract code examples from this section:\n\n{combined}"},
        ]

        try:
            raw = llm_client.complete(messages)
            items = _extract_json_array(raw)
        except Exception as exc:
            logger.warning("Code extraction failed for section %s: %s", section.title, exc)
            continue

        for i, item in enumerate(items):
            lang = str(item.get("language", "python")).strip().lower()
            code = str(item.get("code", "")).strip()
            desc = str(item.get("description", "")).strip()

            if not code or not desc:
                continue
            if lang not in ("python", "javascript", "sql", "bash", "java", "c", "go", "pseudo"):
                lang = "python"

            created_blocks.append(CodeBlock(
                book_id=book_id,
                section_id=section.id,
                language=lang,
                code=code,
                description=desc,
                ord=i,
            ))
            total_created += 1

    db.add_all(created_blocks)
    db.commit()

    store = get_vector_store()
    store.delete_book_code(book_id)
    if created_blocks:
        section_by_id = {s.id: s for s in sections}
        texts = [f"{b.language}\n{b.code}\n\n{b.description}" for b in created_blocks]
        metas = [
            {
                "book_id": book_id,
                "section_id": b.section_id,
                "section_title": (section_by_id.get(b.section_id).title if section_by_id.get(b.section_id) else ""),
                "page_start": (section_by_id.get(b.section_id).page_start if section_by_id.get(b.section_id) else 0),
                "page_end": (section_by_id.get(b.section_id).page_end if section_by_id.get(b.section_id) else 0),
            }
            for b in created_blocks
        ]
        for start, batch_embeddings in embedding_client.embed_batches(texts):
            store.add_code(
                texts[start : start + len(batch_embeddings)],
                batch_embeddings,
                metas[start : start + len(batch_embeddings)],
            )

    return {"ok": True, "created": total_created}


@router.post("/playground/run", response_model=CodeRunResult)
def run_code(body: CodeRunRequest):
    if body.language != "python":
        raise HTTPException(status_code=400, detail=f"Server execution only supports Python. Use browser Pyodide for {body.language}.")

    code = body.code
    for pattern in SAFE_PATTERNS:
        if pattern in code:
            raise HTTPException(status_code=400, detail=f"Code contains restricted pattern: {pattern}")

    start_time = time.monotonic()
    try:
        with tempfile.NamedTemporaryFile(mode="w", suffix=".py", delete=False, encoding="utf-8") as f:
            f.write(code)
            f.flush()
            result = subprocess.run(
                ["python", f.name],
                capture_output=True,
                text=True,
                timeout=5,
            )
        elapsed_ms = int((time.monotonic() - start_time) * 1000)
        return CodeRunResult(
            stdout=result.stdout,
            stderr=result.stderr,
            success=result.returncode == 0,
            execution_ms=elapsed_ms,
        )
    except subprocess.TimeoutExpired:
        return CodeRunResult(stdout="", stderr="Execution timed out (5s limit)", success=False)
    except Exception as exc:
        return CodeRunResult(stdout="", stderr=str(exc), success=False)
