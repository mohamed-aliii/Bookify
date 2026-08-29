import datetime as dt
import json
import logging
import uuid

from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import StreamingResponse
from pydantic import BaseModel
from sqlalchemy import delete, func, select
from sqlalchemy.orm import Session

from ..config import PROMPTS_DIR
from ..database import get_db
from ..llm import llm_client
from ..models import Book, Chunk, Flashcard, QuizAttempt, Section, SectionSummary, utcnow_naive
from ..schemas import (
    BookProgress,
    FlashcardOut,
    QuizAttemptOut,
    QuizGradeRequest,
    QuizGradeResult,
    QuizOut,
    QuizQuestion,
    ReviewRequest,
    SectionProgress,
)

logger = logging.getLogger(__name__)
router = APIRouter(tags=["study"])

MAX_CONTEXT_CHUNKS_SUMMARY = 30
MAX_CONTEXT_CHUNKS_CARDS = 24
MAX_CONTEXT_CHUNKS_QUIZ_SECTION = 30
MAX_CONTEXT_CHUNKS_QUIZ_BOOK = 40

CHARS_PER_SUMMARY_WORD = 160
CHARS_PER_FLASHCARD = 4000
CHARS_PER_QUESTION = 7000

_quizzes: dict[str, dict] = {}


class SummaryRequest(BaseModel):
    force: bool = False


class FlashcardsRequest(BaseModel):
    count: int | None = None


class QuizRequest(BaseModel):
    section_id: int | None = None
    num_questions: int | None = None


def _clamp(value: int, low: int, high: int) -> int:
    return max(low, min(value, high))


def _auto_summary_words(total_chars: int) -> int:
    return _clamp(round(total_chars / CHARS_PER_SUMMARY_WORD), 70, 420)


def _auto_flashcards(total_chars: int) -> int:
    return _clamp(round(total_chars / CHARS_PER_FLASHCARD), 4, 24)


def _auto_questions(total_chars: int) -> int:
    return _clamp(round(total_chars / CHARS_PER_QUESTION), 3, 15)


def _total_chars(chunks: list[Chunk]) -> int:
    return sum(len(c.text) for c in chunks)


def _spread(items: list[Chunk], limit: int) -> list[Chunk]:
    """Evenly sample up to `limit` chunks across the whole ordered list."""
    if len(items) <= limit:
        return items
    step = len(items) / limit
    return [items[int(i * step)] for i in range(limit)]


def _sse(payload: dict) -> str:
    return f"data: {json.dumps(payload)}\n\n"


def _load_book_section(db: Session, book_id: int, section_id: int) -> Section:
    section = db.get(Section, section_id)
    if section is None or section.book_id != book_id:
        raise HTTPException(status_code=404, detail="Section not found")
    return section


def _load_book(db: Session, book_id: int) -> Book:
    book = db.get(Book, book_id)
    if book is None:
        raise HTTPException(status_code=404, detail="Book not found")
    return book


def _descendant_section_ids(db: Session, book_id: int, section_id: int) -> list[int]:
    rows = db.execute(select(Section.id, Section.parent_id).where(Section.book_id == book_id)).all()
    children: dict[int | None, list[int]] = {}
    for sid, pid in rows:
        children.setdefault(pid, []).append(sid)
    collected: list[int] = []
    queue = [section_id]
    while queue:
        current = queue.pop()
        collected.append(current)
        queue.extend(children.get(current, []))
    return collected


def _section_all_chunks(db: Session, book_id: int, section_id: int) -> list[Chunk]:
    ids = _descendant_section_ids(db, book_id, section_id)
    return list(db.scalars(select(Chunk).where(Chunk.section_id.in_(ids)).order_by(Chunk.ord)))


def _excerpts_text(chunks: list[Chunk]) -> str:
    return "\n\n".join(
        f"[Excerpt {i} | {c.section_title} | pages {c.page_start}-{c.page_end}]\n{c.text}"
        for i, c in enumerate(chunks, start=1)
    )


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


@router.post("/books/{book_id}/sections/{section_id}/summary")
def summarize_section(section_id: int, book_id: int, body: SummaryRequest, db: Session = Depends(get_db)):
    _load_book(db, book_id)
    section = _load_book_section(db, book_id, section_id)

    def _cached_stream(content: str):
        yield _sse({"type": "content", "value": content})
        yield _sse({"type": "done"})

    cached = db.scalar(select(SectionSummary).where(SectionSummary.section_id == section.id))
    if cached is not None and not body.force:
        content = cached.content
        return StreamingResponse(_cached_stream(content), media_type="text/event-stream")

    chunks = _section_all_chunks(db, book_id, section.id)
    if not chunks:
        raise HTTPException(status_code=400, detail="Section has no indexed text")
    max_words = _auto_summary_words(_total_chars(chunks))
    excerpts = _excerpts_text(_spread(chunks, MAX_CONTEXT_CHUNKS_SUMMARY))
    messages = [
        {"role": "system", "content": _prompt_text("summary.txt", {"max_words": max_words})},
        {"role": "user", "content": f"Excerpts from “{section.title}”:\n\n{excerpts}\n\nWrite the summary now."},
    ]

    def _generate():
        collected: list[str] = []
        try:
            for kind, value in llm_client.stream(messages):
                if kind == "content":
                    collected.append(value)
                yield _sse({"type": kind, "value": value})
        except Exception as exc:
            logger.exception("Summary stream failed")
            yield _sse({"type": "error", "message": f"Model call failed: {exc}"})
            return
        if collected:
            db.add(SectionSummary(book_id=book_id, section_id=section.id, content="".join(collected)))
            db.commit()
        yield _sse({"type": "done"})

    return StreamingResponse(_generate(), media_type="text/event-stream")


@router.get("/books/{book_id}/flashcards", response_model=list[FlashcardOut])
def list_flashcards(book_id: int, db: Session = Depends(get_db)):
    _load_book(db, book_id)
    return list(db.scalars(select(Flashcard).where(Flashcard.book_id == book_id).order_by(Flashcard.section_id, Flashcard.ord)))


@router.post("/books/{book_id}/sections/{section_id}/flashcards", response_model=list[FlashcardOut])
def generate_flashcards(section_id: int, book_id: int, body: FlashcardsRequest, db: Session = Depends(get_db)):
    _load_book(db, book_id)
    section = _load_book_section(db, book_id, section_id)

    all_chunks = _section_all_chunks(db, book_id, section.id)
    if not all_chunks:
        raise HTTPException(status_code=400, detail="Section has no indexed text")
    count = _auto_flashcards(_total_chars(all_chunks)) if body.count is None else _clamp(body.count, 3, 24)
    chunks = _spread(all_chunks, MAX_CONTEXT_CHUNKS_CARDS)

    messages = [
        {"role": "system", "content": _prompt_text("flashcards.txt", {"count": count})},
        {"role": "user", "content": f"Excerpts from “{section.title}”:\n\n{_excerpts_text(chunks)}\n\nWrite the flashcards now."},
    ]
    try:
        items = _extract_json_array(llm_client.complete(messages))
    except Exception as exc:
        logger.exception("Flashcard generation failed")
        raise HTTPException(status_code=502, detail=f"Generation failed: {exc}") from exc

    cards = [
        (str(item["front"]).strip(), str(item["back"]).strip())
        for item in items
        if str(item.get("front", "")).strip() and str(item.get("back", "")).strip()
    ]
    if not cards:
        raise HTTPException(status_code=502, detail="Model returned no usable flashcards")

    db.execute(delete(Flashcard).where(Flashcard.section_id == section.id))
    rows = [Flashcard(book_id=book_id, section_id=section.id, front=f, back=b, ord=i) for i, (f, b) in enumerate(cards)]
    db.add_all(rows)
    db.commit()
    for row in rows:
        db.refresh(row)
    return rows


class SingleFlashcardRequest(BaseModel):
    front: str
    back: str


@router.post("/books/{book_id}/sections/{section_id}/flashcards/single", response_model=FlashcardOut, status_code=201)
def add_single_flashcard(book_id: int, section_id: int, body: SingleFlashcardRequest, db: Session = Depends(get_db)):
    _load_book(db, book_id)
    section = _load_book_section(db, book_id, section_id)
    front = body.front.strip()
    back = body.back.strip()
    if not front or not back:
        raise HTTPException(status_code=422, detail="Front and back cannot be empty")
    max_ord = db.scalar(select(func.coalesce(func.max(Flashcard.ord), -1)).where(Flashcard.section_id == section_id))
    card = Flashcard(book_id=book_id, section_id=section_id, front=front, back=back, ord=max_ord + 1)
    db.add(card)
    db.commit()
    db.refresh(card)
    try:
        from ..xp_engine import award_xp
        award_xp(db, "flashcards_generated")
    except Exception:
        pass
    return card


class QuizAttemptCreate(BaseModel):
    section_id: int | None = None
    score: int
    total: int
    knowledge_point_results: list[dict] | None = None


MASTERED_INTERVAL_DAYS = 3


def _apply_review(card: Flashcard, rating: str) -> None:
    """Simplified SM-2 scheduling."""
    now = utcnow_naive()
    if rating == "again":
        card.reps = 0
        card.lapses += 1
        card.ease = max(1.3, card.ease - 0.2)
        card.interval_days = 0
        card.due_at = now + dt.timedelta(minutes=10)
    elif rating == "hard":
        card.interval_days = max(1, int(card.interval_days * 1.2))
        card.ease = max(1.3, card.ease - 0.15)
        card.reps += 1
        card.due_at = now + dt.timedelta(days=card.interval_days)
    elif rating == "good":
        if card.reps == 0:
            card.interval_days = 1
        elif card.reps == 1:
            card.interval_days = 3
        else:
            card.interval_days = max(card.interval_days + 1, int(card.interval_days * card.ease))
        card.reps += 1
        card.due_at = now + dt.timedelta(days=card.interval_days)
    else:  # easy
        if card.reps == 0:
            card.interval_days = 4
        else:
            card.interval_days = max(card.interval_days + 2, int((card.interval_days or 1) * card.ease * 1.3))
        card.reps += 1
        card.ease += 0.15
        card.due_at = now + dt.timedelta(days=card.interval_days)


@router.get("/books/{book_id}/review", response_model=list[FlashcardOut])
def review_queue(book_id: int, limit: int = 30, db: Session = Depends(get_db)):
    _load_book(db, book_id)
    return list(
        db.scalars(
            select(Flashcard)
            .where(Flashcard.book_id == book_id, Flashcard.due_at <= utcnow_naive())
            .order_by(Flashcard.due_at)
            .limit(_clamp(limit, 1, 100))
        )
    )


@router.post("/books/{book_id}/flashcards/{card_id}/review", response_model=FlashcardOut)
def review_card(book_id: int, card_id: int, body: ReviewRequest, db: Session = Depends(get_db)):
    _load_book(db, book_id)
    card = db.get(Flashcard, card_id)
    if card is None or card.book_id != book_id:
        raise HTTPException(status_code=404, detail="Flashcard not found")
    _apply_review(card, body.rating)
    db.commit()
    db.refresh(card)
    try:
        from ..xp_engine import award_xp
        award_xp(db, "flashcard_perfect" if body.rating == "easy" else "flashcard_review")
    except Exception:
        pass
    return card


@router.post("/books/{book_id}/quiz-attempts", response_model=QuizAttemptOut)
def record_quiz_attempt(book_id: int, body: QuizAttemptCreate, db: Session = Depends(get_db)):
    _load_book(db, book_id)
    if body.section_id is not None:
        _load_book_section(db, book_id, body.section_id)
    if not 0 <= body.score <= body.total:
        raise HTTPException(status_code=422, detail="Invalid score")
    attempt = QuizAttempt(book_id=book_id, section_id=body.section_id, score=body.score, total=body.total)
    db.add(attempt)

    if body.knowledge_point_results:
        from .intelligence import update_mastery
        for kpr in body.knowledge_point_results:
            kp_id = kpr.get("knowledge_point_id")
            correct = kpr.get("correct", 0)
            total = kpr.get("total", 1)
            if kp_id and total > 0:
                update_mastery(db, kp_id, quiz_correct=correct, quiz_total=total)

    db.commit()
    db.refresh(attempt)
    try:
        from ..xp_engine import award_xp
        is_perfect = body.score == body.total and body.total > 0
        award_xp(db, "quiz_perfect" if is_perfect else "quiz_attempt")
    except Exception:
        pass
    return attempt


@router.get("/books/{book_id}/progress", response_model=BookProgress)
def book_progress(book_id: int, db: Session = Depends(get_db)):
    _load_book(db, book_id)
    now = utcnow_naive()

    rows = db.execute(
        select(Flashcard.section_id, func.count(), func.sum(Flashcard.due_at <= now), func.sum(Flashcard.interval_days >= MASTERED_INTERVAL_DAYS))
        .where(Flashcard.book_id == book_id)
        .group_by(Flashcard.section_id)
    ).all()

    attempts = list(
        db.scalars(select(QuizAttempt).where(QuizAttempt.book_id == book_id).order_by(QuizAttempt.id.desc()).limit(50))
    )
    last_quiz_by_section: dict[int, QuizAttempt] = {}
    for attempt in reversed(attempts):
        if attempt.section_id is not None:
            last_quiz_by_section.setdefault(attempt.section_id, attempt)

    progress = [
        SectionProgress(
            section_id=sid,
            cards_total=total,
            cards_due=int(due or 0),
            cards_mastered=int(mastered or 0),
            last_quiz=QuizAttemptOut.model_validate(last_quiz_by_section[sid]) if sid in last_quiz_by_section else None,
        )
        for sid, total, due, mastered in rows
    ]
    return BookProgress(
        cards_total=sum(p.cards_total for p in progress),
        cards_due=sum(p.cards_due for p in progress),
        cards_mastered=sum(p.cards_mastered for p in progress),
        sections=progress,
        attempts=[QuizAttemptOut.model_validate(a) for a in attempts[:20]],
    )


@router.post("/books/{book_id}/quiz", response_model=QuizOut)
def generate_quiz(book_id: int, body: QuizRequest, db: Session = Depends(get_db)):
    _load_book(db, book_id)

    if body.section_id is not None:
        section = _load_book_section(db, book_id, body.section_id)
        all_chunks = _section_all_chunks(db, book_id, section.id)
        chunks = _spread(all_chunks, MAX_CONTEXT_CHUNKS_QUIZ_SECTION)
        scope = section.title
    else:
        all_chunks = list(db.scalars(select(Chunk).where(Chunk.book_id == book_id).order_by(Chunk.ord)))
        chunks = _spread(all_chunks, MAX_CONTEXT_CHUNKS_QUIZ_BOOK)
        scope = "the whole book"
    if not chunks:
        raise HTTPException(status_code=400, detail="No indexed text for this scope")

    num = _auto_questions(_total_chars(all_chunks)) if body.num_questions is None else _clamp(body.num_questions, 3, 15)

    messages = [
        {"role": "system", "content": _prompt_text("quiz.txt", {"count": num})},
        {"role": "user", "content": f"Excerpts from {scope}:\n\n{_excerpts_text(chunks)}\n\nWrite the quiz now."},
    ]
    try:
        items = _extract_json_array(llm_client.complete(messages))
    except Exception as exc:
        logger.exception("Quiz generation failed")
        raise HTTPException(status_code=502, detail=f"Generation failed: {exc}") from exc

    questions = []
    for item in items:
        options = [str(opt).strip() for opt in item.get("options", []) if str(opt).strip()]
        answer_index = item.get("answer_index")
        question_text = str(item.get("question", "")).strip()
        if not question_text or len(options) < 2 or not isinstance(answer_index, int) or not 0 <= answer_index < len(options):
            continue
        qid = uuid.uuid4().hex[:12]
        questions.append(
            {
                "id": qid,
                "question": question_text,
                "options": options,
                "answer_index": min(answer_index, len(options) - 1),
                "explanation": str(item.get("explanation", "")).strip(),
            }
        )
    if not questions:
        raise HTTPException(status_code=502, detail="Model returned no usable questions")

    quiz_id = uuid.uuid4().hex[:12]
    _quizzes[quiz_id] = {"questions": questions, "book_id": book_id, "section_id": body.section_id}
    while len(_quizzes) > 50:
        _quizzes.pop(next(iter(_quizzes)))

    return QuizOut(
        quiz_id=quiz_id,
        questions=[QuizQuestion(id=q["id"], question=q["question"], options=q["options"]) for q in questions],
    )


@router.post("/quiz/{quiz_id}/grade", response_model=QuizGradeResult)
def grade_answer(quiz_id: str, body: QuizGradeRequest, db: Session = Depends(get_db)):
    quiz = _quizzes.get(quiz_id)
    if quiz is None:
        raise HTTPException(status_code=404, detail="Quiz not found (expired — generate a new one)")
    question = next((q for q in quiz["questions"] if q["id"] == body.question_id), None)
    if question is None:
        raise HTTPException(status_code=404, detail="Question not found")
    correct = body.selected == question["answer_index"]
    if not correct:
        from ..models import QuizError
        db.add(QuizError(
            book_id=quiz.get("book_id", 0),
            section_id=quiz.get("section_id"),
            question=question["question"],
            user_answer=question["options"][body.selected] if body.selected < len(question["options"]) else "",
            correct_answer=question["options"][question["answer_index"]],
            explanation=question["explanation"],
        ))
        db.commit()
    return QuizGradeResult(
        correct=correct,
        answer_index=question["answer_index"],
        explanation=question["explanation"],
    )


