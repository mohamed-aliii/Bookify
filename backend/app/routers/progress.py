import json
import logging

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from ..config import PROMPTS_DIR
from ..database import get_db
from ..llm import llm_client
from ..models import (
    Book,
    Flashcard,
    KnowledgePoint,
    Note,
    QuizAttempt,
    QuizError,
    ReadingProgress,
    Section,
    UserKnowledgePoint,
    utcnow_naive,
)
from ..schemas import (
    BookDashboard,
    ChapterProgress,
    QuizErrorOut,
    ReadingProgressOut,
    ReadingSummary,
    RecallCheckRequest,
    RecallCheckResult,
)

logger = logging.getLogger(__name__)
router = APIRouter(tags=["progress"])


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


def _chapter_progress_for_section(
    db: Session, book_id: int, section: Section, read_ids: set[int]
) -> ChapterProgress:
    children = list(db.scalars(select(Section).where(Section.parent_id == section.id)))
    children_read = sum(1 for c in children if c.id in read_ids)

    all_child_ids = [c.id for c in children] + [section.id]
    card_rows = db.execute(
        select(
            func.count(),
            func.sum(Flashcard.interval_days >= 3),
        ).where(Flashcard.section_id.in_(all_child_ids))
    ).one()
    cards_total = int(card_rows[0] or 0)
    cards_mastered = int(card_rows[1] or 0)

    last_quiz = db.scalar(
        select(QuizAttempt)
        .where(QuizAttempt.section_id == section.id)
        .order_by(QuizAttempt.id.desc())
    )
    quiz_score = None
    if last_quiz and last_quiz.total > 0:
        quiz_score = round(last_quiz.score / last_quiz.total * 100)

    kps = list(db.scalars(select(KnowledgePoint).where(KnowledgePoint.section_id.in_(all_child_ids))))
    mastery = None
    if kps:
        total_mastery = 0.0
        count = 0
        for kp in kps:
            ukp = db.scalar(select(UserKnowledgePoint).where(UserKnowledgePoint.knowledge_point_id == kp.id))
            if ukp is not None:
                total_mastery += ukp.mastery
                count += 1
        if count > 0:
            mastery = round(total_mastery / count, 3)

    return ChapterProgress(
        section_id=section.id,
        title=section.title,
        level=section.level,
        read=section.id in read_ids,
        children_read=children_read,
        total_children=len(children),
        cards_mastered=cards_mastered,
        cards_total=cards_total,
        quiz_score=quiz_score,
        mastery=mastery,
    )


@router.get("/books/{book_id}/reading-progress", response_model=list[ReadingProgressOut])
def get_reading_progress(book_id: int, db: Session = Depends(get_db)):
    _load_book(db, book_id)
    sections = list(db.scalars(select(Section).where(Section.book_id == book_id)))
    section_ids = [s.id for s in sections]
    rows = list(db.scalars(select(ReadingProgress).where(ReadingProgress.section_id.in_(section_ids))))
    return rows


@router.post("/books/{book_id}/sections/{section_id}/read")
def toggle_read(book_id: int, section_id: int, db: Session = Depends(get_db)):
    _load_book(db, book_id)
    section = db.get(Section, section_id)
    if section is None or section.book_id != book_id:
        raise HTTPException(status_code=404, detail="Section not found")

    existing = db.scalar(select(ReadingProgress).where(ReadingProgress.section_id == section_id))
    if existing:
        db.delete(existing)
        db.commit()
        return {"read": False}

    db.add(ReadingProgress(section_id=section_id))
    db.commit()

    try:
        from ..xp_engine import award_xp
        award_xp(db, "section_read")
    except Exception:
        pass

    return {"read": True}


@router.get("/books/{book_id}/reading-summary", response_model=ReadingSummary)
def reading_summary(book_id: int, db: Session = Depends(get_db)):
    _load_book(db, book_id)
    sections = list(db.scalars(select(Section).where(Section.book_id == book_id).order_by(Section.ord)))
    read_ids = {
        rp.section_id
        for rp in db.scalars(
            select(ReadingProgress).where(ReadingProgress.section_id.in_([s.id for s in sections]))
        )
    }
    chapters = [s for s in sections if s.level == 1]
    chapter_progress = [_chapter_progress_for_section(db, book_id, ch, read_ids) for ch in chapters]

    total = len(sections)
    read_count = len(read_ids)
    return ReadingSummary(
        sections_read=read_count,
        total_sections=total,
        read_percent=round(read_count / total * 100, 1) if total > 0 else 0,
        chapter_progress=chapter_progress,
    )


@router.post("/books/{book_id}/sections/{section_id}/recall", response_model=RecallCheckResult)
def check_recall(book_id: int, section_id: int, body: RecallCheckRequest, db: Session = Depends(get_db)):
    _load_book(db, book_id)
    section = db.get(Section, section_id)
    if section is None or section.book_id != book_id:
        raise HTTPException(status_code=404, detail="Section not found")

    kps = list(db.scalars(select(KnowledgePoint).where(KnowledgePoint.section_id == section_id)))
    kp_text = "\n".join(f"- {kp.name}: {kp.description}" for kp in kps) if kps else "(no knowledge points extracted yet)"

    messages = [
        {"role": "system", "content": _prompt_text("recall_check.txt", {"section_title": section.title, "knowledge_points": kp_text})},
        {"role": "user", "content": f"Student's recall:\n{body.recall_text}\n\nEvaluate now."},
    ]
    try:
        raw = llm_client.complete(messages)
        cleaned = raw.strip()
        if cleaned.startswith("```"):
            cleaned = "\n".join(cleaned.splitlines()[1:-1]).strip()
        start, end = cleaned.find("{"), cleaned.rfind("}")
        if start == -1 or end <= start:
            raise ValueError("No JSON object in response")
        data = json.loads(cleaned[start : end + 1])
        return RecallCheckResult(
            score=int(data.get("score", 50)),
            accurate_points=[str(p) for p in data.get("accurate_points", [])],
            missed_points=[str(p) for p in data.get("missed_points", [])],
            misconceptions=[str(p) for p in data.get("misconceptions", [])],
            encouragement=str(data.get("encouragement", "Keep going!")),
        )
    except Exception as exc:
        logger.exception("Recall check failed")
        raise HTTPException(status_code=502, detail=f"Recall check failed: {exc}") from exc


@router.get("/books/{book_id}/book-dashboard", response_model=BookDashboard)
def book_dashboard(book_id: int, db: Session = Depends(get_db)):
    _load_book(db, book_id)
    sections = list(db.scalars(select(Section).where(Section.book_id == book_id).order_by(Section.ord)))
    read_ids = {
        rp.section_id
        for rp in db.scalars(
            select(ReadingProgress).where(ReadingProgress.section_id.in_([s.id for s in sections]))
        )
    }
    chapters = [s for s in sections if s.level == 1]
    chapter_progress = [_chapter_progress_for_section(db, book_id, ch, read_ids) for ch in chapters]

    total_sections = len(sections)
    sections_read = len(read_ids)
    read_percent = round(sections_read / total_sections * 100, 1) if total_sections > 0 else 0

    card_row = db.execute(
        select(
            func.count(),
            func.sum(Flashcard.due_at <= utcnow_naive()),
            func.sum(Flashcard.interval_days >= 3),
        ).where(Flashcard.book_id == book_id)
    ).one()
    cards_total = int(card_row[0] or 0)
    cards_due = int(card_row[1] or 0)
    cards_mastered = int(card_row[2] or 0)

    attempts = list(
        db.scalars(select(QuizAttempt).where(QuizAttempt.book_id == book_id).order_by(QuizAttempt.id.desc()))
    )
    total_quizzes = len(attempts)
    quiz_avg_score = None
    if attempts:
        scores = [a.score / a.total * 100 for a in attempts if a.total > 0]
        if scores:
            quiz_avg_score = round(sum(scores) / len(scores), 1)

    kps = list(db.scalars(select(KnowledgePoint).where(KnowledgePoint.book_id == book_id)))
    kp_mastery_avg = None
    if kps:
        total_m = 0.0
        cnt = 0
        for kp in kps:
            ukp = db.scalar(select(UserKnowledgePoint).where(UserKnowledgePoint.knowledge_point_id == kp.id))
            if ukp is not None:
                total_m += ukp.mastery
                cnt += 1
        if cnt > 0:
            kp_mastery_avg = round(total_m / cnt, 3)

    next_steps: list[str] = []
    if cards_due > 0:
        next_steps.append(f"{cards_due} flashcard{'s' if cards_due != 1 else ''} due for review")
    weak_chapters = [cp for cp in chapter_progress if cp.mastery is not None and cp.mastery < 0.5 and cp.read]
    for wc in weak_chapters[:2]:
        next_steps.append(f"Review {wc.title} — mastery at {round(wc.mastery * 100)}%")
    unread = [cp for cp in chapter_progress if not cp.read]
    if unread and not next_steps:
        next_steps.append(f"Start reading {unread[0].title}")
    if not next_steps:
        next_steps.append("All caught up — great work!")

    recent_activity: list[dict] = []
    for a in attempts[:5]:
        sec = db.get(Section, a.section_id) if a.section_id else None
        recent_activity.append({
            "type": "quiz",
            "section": sec.title[:40] if sec else "Whole book",
            "score": f"{a.score}/{a.total}",
            "at": a.created_at.isoformat() if a.created_at else "",
        })
    notes = list(db.scalars(select(Note).where(Note.book_id == book_id).order_by(Note.id.desc()).limit(3)))
    for n in notes:
        sec = db.get(Section, n.section_id) if n.section_id else None
        recent_activity.append({
            "type": "note",
            "section": sec.title[:40] if sec else "General",
            "preview": n.content[:60],
            "at": n.created_at.isoformat() if n.created_at else "",
        })

    return BookDashboard(
        sections_read=sections_read,
        total_sections=total_sections,
        read_percent=read_percent,
        cards_total=cards_total,
        cards_mastered=cards_mastered,
        cards_due=cards_due,
        quiz_avg_score=quiz_avg_score,
        total_quizzes=total_quizzes,
        kp_mastery_avg=kp_mastery_avg,
        chapter_progress=chapter_progress,
        next_steps=next_steps,
        recent_activity=recent_activity[:10],
    )


@router.get("/books/{book_id}/errors", response_model=list[QuizErrorOut])
def list_errors(book_id: int, limit: int = 30, db: Session = Depends(get_db)):
    _load_book(db, book_id)
    return list(
        db.scalars(
            select(QuizError).where(QuizError.book_id == book_id).order_by(QuizError.id.desc()).limit(limit)
        )
    )
