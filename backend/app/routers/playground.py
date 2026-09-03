import json
import logging
import random
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
    book = _load_book(db, book_id)
    # Guard concurrent reindex – code extraction needs stable sections
    if book.status == "pending":
        raise HTTPException(status_code=409, detail="Book is being indexed – try again after it finishes")

    if not force:
        existing = db.scalar(select(CodeBlock).where(CodeBlock.book_id == book_id).limit(1))
        if existing is not None:
            return {"ok": True, "message": "Code blocks already exist"}
    else:
        old_blocks = list(db.scalars(select(CodeBlock).where(CodeBlock.book_id == book_id)))
        for block in old_blocks:
            db.delete(block)
        db.flush()

    # Ensure we see committed sections even if caller reused a stale session
    try:
        db.expire_all()
    except Exception:
        pass
    total_created = 0
    created_blocks: list[CodeBlock] = []
    sections = list(db.scalars(
        select(Section).where(Section.book_id == book_id).order_by(Section.id)
    ))
    # Validate sections still exist and belong to this book (protects against stale FK)
    valid_ids = {s.id for s in sections}
    if not sections:
        db.commit()
        return {"ok": True, "created": 0}

    rate_limited = False
    rate_limited_section: str | None = None
    retry_after_ms: int | None = None

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

        raw: str | None = None
        items: list[dict] | None = None
        last_exc: Exception | None = None
        for attempt in range(5):
            try:
                raw = llm_client.complete(messages)
                items = _extract_json_array(raw)
                last_exc = None
                break
            except Exception as exc:
                last_exc = exc
                msg = str(exc)
                is_rate_limit = (
                    "Rate limit" in msg
                    or "rate_limit" in msg.lower()
                    or "429" in msg
                    or exc.__class__.__name__ == "RateLimitError"
                )
                if not is_rate_limit:
                    logger.warning("Code extraction failed for section %s: %s", section.title, exc)
                    break
                # Rate limit – retry with exponential backoff
                if attempt < 4:
                    # Try to respect Retry-After / X-RateLimit-Reset if present in exception
                    wait = (2 ** attempt) + random.uniform(0, 1)
                    # Extract headers if available on exception
                    headers = getattr(exc, "headers", None) or getattr(getattr(exc, "response", None), "headers", None) or {}
                    # Handle both dict and case-insensitive
                    retry_after = headers.get("Retry-After") or headers.get("retry-after") or headers.get("X-RateLimit-Reset") or headers.get("x-ratelimit-reset")
                    if retry_after:
                        try:
                            # X-RateLimit-Reset is epoch ms in log, Retry-After is seconds
                            ra = float(str(retry_after))
                            # If large (ms epoch), convert to seconds until reset
                            if ra > 1e12:  # ms epoch
                                ra = (ra - (time.time() * 1000)) / 1000
                            wait = max(wait, float(ra))
                            wait = min(wait, 32)
                        except Exception:
                            pass
                    logger.info("Code extraction rate limited for section %s (attempt %d/5), retrying in %.1fs: %s", section.title, attempt + 1, wait, exc)
                    time.sleep(min(wait, 32))
                    continue
                else:
                    # 5th attempt still rate limited – stop entire extraction and report
                    logger.warning("Code extraction rate limited after 5 retries for section %s, stopping: %s", section.title, exc)
                    rate_limited = True
                    rate_limited_section = section.title
                    # Try to get retry_after for frontend
                    headers = getattr(exc, "headers", None) or getattr(getattr(exc, "response", None), "headers", None) or {}
                    ra = headers.get("Retry-After") or headers.get("retry-after") or headers.get("X-RateLimit-Reset") or headers.get("x-ratelimit-reset")
                    if ra:
                        try:
                            raf = float(str(ra))
                            if raf > 1e12:
                                retry_after_ms = int(raf)
                            else:
                                retry_after_ms = int(time.time() * 1000 + raf * 1000)
                        except Exception:
                            retry_after_ms = None
                    break
        if rate_limited:
            # Stop processing further sections – report partial success
            break
        if last_exc is not None and items is None:
            # Non-rate-limit failure already logged, skip this section
            continue
        # At this point raw/items should be set
        if items is None:
            continue

        for i, item in enumerate(items):
            lang = str(item.get("language", "python")).strip().lower()
            code = str(item.get("code", "")).strip()
            desc = str(item.get("description", "")).strip()

            if not code or not desc:
                continue
            if lang not in ("python", "javascript", "sql", "bash", "java", "c", "go", "pseudo"):
                lang = "python"
            # Validate section still exists and is valid for this book (protect stale FK after reindex)
            if section.id not in valid_ids:
                logger.warning("Skipping code block for stale section %s (book %s)", section.id, book_id)
                continue
            created_blocks.append(CodeBlock(
                book_id=book_id,
                section_id=section.id,
                language=lang,
                code=code,
                description=desc,
                ord=i,
            ))
            total_created += 1

    # Final validation: drop any blocks whose section_id somehow became invalid between loop and commit
    if created_blocks:
        # Re-compute valid ids in case sections changed during LLM calls
        try:
            db.flush()
            fresh_ids = {s.id for s in db.scalars(select(Section).where(Section.book_id == book_id))}
            before = len(created_blocks)
            created_blocks = [b for b in created_blocks if b.section_id in fresh_ids]
            if len(created_blocks) < before:
                logger.warning("Filtered %d stale code blocks for book %s", before - len(created_blocks), book_id)
        except Exception:
            pass
    db.add_all(created_blocks)
    try:
        db.commit()
    except Exception as exc:
        # Handle FK race: if another reindex deleted sections between validation and commit, retry without stale blocks
        if "FOREIGN KEY" in str(exc):
            logger.warning("FK failed on code_blocks for book %s, retrying with fresh sections: %s", book_id, exc)
            db.rollback()
            # Re-fetch valid ids and filter again
            fresh_ids = {s.id for s in db.scalars(select(Section).where(Section.book_id == book_id))}
            filtered = [b for b in created_blocks if b.section_id in fresh_ids]
            if filtered:
                db.add_all(filtered)
                db.commit()
                total_created = len(filtered)
            else:
                total_created = 0
                db.commit()
        else:
            raise

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

    if rate_limited:
        return {
            "ok": True,
            "created": total_created,
            "rate_limited": True,
            "failed_section": rate_limited_section,
            "retry_after_ms": retry_after_ms,
            "total_sections": len(sections),
        }
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
