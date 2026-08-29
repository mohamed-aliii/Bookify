import datetime as dt
import logging

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.orm import Session

from ..database import get_db
from ..models import (
    Book,
    Flashcard,
    KnowledgePoint,
    StudyActivity,
    StudySession,
    UserKnowledgePoint,
    utcnow_naive,
)
from ..schemas import (
    StudyActivityOut,
    StudySessionNextRequest,
    StudySessionOut,
    StudySessionPlanOut,
)

logger = logging.getLogger(__name__)
router = APIRouter(tags=["session"])

FLASHCARDS_PER_SESSION = 5
QUIZ_PER_SESSION = 2
PRACTICE_PER_SESSION = 1
TOTAL_ACTIVITIES = FLASHCARDS_PER_SESSION + QUIZ_PER_SESSION + PRACTICE_PER_SESSION

ACTIVITY_XP = {
    "flashcard": 2,
    "quiz_correct": 5,
    "quiz_incorrect": 1,
    "practice": 10,
}


def _load_book(db: Session, book_id: int) -> Book:
    book = db.get(Book, book_id)
    if book is None:
        raise HTTPException(status_code=404, detail="Book not found")
    return book


def _load_session(db: Session, session_id: int) -> StudySession:
    session = db.get(StudySession, session_id)
    if session is None:
        raise HTTPException(status_code=404, detail="Study session not found")
    return session


def _due_flashcards(db: Session, book_id: int, limit: int) -> list[Flashcard]:
    return list(
        db.scalars(
            select(Flashcard)
            .where(Flashcard.book_id == book_id, Flashcard.due_at <= utcnow_naive())
            .order_by(Flashcard.due_at)
            .limit(limit)
        )
    )


def _weak_kp_ids(db: Session, book_id: int) -> list[int]:
    kps = list(db.scalars(select(KnowledgePoint).where(KnowledgePoint.book_id == book_id)))
    weak = []
    for kp in kps:
        ukp = db.scalar(select(UserKnowledgePoint).where(UserKnowledgePoint.knowledge_point_id == kp.id))
        if ukp is None or ukp.mastery < 0.6:
            weak.append(kp.id)
    return weak


def _build_session_plan(db: Session, book_id: int, session: StudySession) -> list[StudyActivity]:
    activities: list[StudyActivity] = []
    weak_ids = _weak_kp_ids(db, book_id)

    due_cards = _due_flashcards(db, book_id, FLASHCARDS_PER_SESSION)
    for card in due_cards:
        kp_id = _find_kp_for_section(db, book_id, card.section_id, weak_ids)
        activities.append(StudyActivity(
            session_id=session.id,
            activity_type="flashcard",
            knowledge_point_id=kp_id,
        ))

    kps_for_quiz = [kid for kid in weak_ids[:QUIZ_PER_SESSION]]
    for kp_id in kps_for_quiz:
        activities.append(StudyActivity(
            session_id=session.id,
            activity_type="quiz",
            knowledge_point_id=kp_id,
        ))
    if len(kps_for_quiz) < QUIZ_PER_SESSION:
        remaining = QUIZ_PER_SESSION - len(kps_for_quiz)
        all_kps = list(db.scalars(select(KnowledgePoint).where(KnowledgePoint.book_id == book_id).order_by(KnowledgePoint.id)))
        used = set(kps_for_quiz)
        for kp in all_kps:
            if kp.id not in used and remaining > 0:
                activities.append(StudyActivity(
                    session_id=session.id,
                    activity_type="quiz",
                    knowledge_point_id=kp.id,
                ))
                used.add(kp.id)
                remaining -= 1
                if remaining == 0:
                    break

    kps_for_practice = [kid for kid in weak_ids[PRACTICE_PER_SESSION:0:-1]]
    if kps_for_practice:
        activities.append(StudyActivity(
            session_id=session.id,
            activity_type="practice",
            knowledge_point_id=kps_for_practice[0],
        ))
    else:
        all_kps = list(db.scalars(select(KnowledgePoint).where(KnowledgePoint.book_id == book_id).order_by(KnowledgePoint.id)))
        if all_kps:
            activities.append(StudyActivity(
                session_id=session.id,
                activity_type="practice",
                knowledge_point_id=all_kps[0].id,
            ))

    db.add_all(activities)
    db.commit()
    return activities


def _find_kp_for_section(db: Session, book_id: int, section_id: int, weak_ids: list[int]) -> int | None:
    for kid in weak_ids:
        kp = db.get(KnowledgePoint, kid)
        if kp and kp.section_id == section_id:
            return kid
    kp = db.scalar(
        select(KnowledgePoint).where(KnowledgePoint.book_id == book_id, KnowledgePoint.section_id == section_id).limit(1)
    )
    return kp.id if kp else None


@router.post("/books/{book_id}/study-sessions/start", response_model=StudySessionPlanOut)
def start_study_session(book_id: int, db: Session = Depends(get_db)):
    _load_book(db, book_id)

    session = StudySession(book_id=book_id, started_at=utcnow_naive())
    db.add(session)
    db.flush()

    activities = _build_session_plan(db, book_id, session)
    db.commit()
    db.refresh(session)

    return StudySessionPlanOut(
        session=StudySessionOut.model_validate(session),
        activities=[StudyActivityOut.model_validate(a) for a in activities],
        total_activities=len(activities),
        current_index=0,
    )


@router.get("/books/{book_id}/study-sessions/{session_id}", response_model=StudySessionPlanOut)
def get_study_session(book_id: int, session_id: int, db: Session = Depends(get_db)):
    _load_book(db, book_id)
    session = _load_session(db, session_id)
    if session.book_id != book_id:
        raise HTTPException(status_code=404, detail="Session not found for this book")

    activities = list(db.scalars(select(StudyActivity).where(StudyActivity.session_id == session.id).order_by(StudyActivity.id)))
    completed = sum(1 for a in activities if a.result != "pending")
    current = next((i for i, a in enumerate(activities) if a.result == "pending"), len(activities))

    return StudySessionPlanOut(
        session=StudySessionOut.model_validate(session),
        activities=[StudyActivityOut.model_validate(a) for a in activities],
        total_activities=len(activities),
        current_index=current,
    )


@router.post("/books/{book_id}/study-sessions/{session_id}/next")
def advance_session(book_id: int, session_id: int, body: StudySessionNextRequest, db: Session = Depends(get_db)):
    _load_book(db, book_id)
    session = _load_session(db, session_id)
    if session.book_id != book_id:
        raise HTTPException(status_code=404, detail="Session not found for this book")

    activity = db.get(StudyActivity, body.activity_id)
    if activity is None or activity.session_id != session.id:
        raise HTTPException(status_code=404, detail="Activity not found in this session")

    activity.result = body.result
    activity.duration_seconds = body.duration_seconds
    if body.knowledge_point_id:
        activity.knowledge_point_id = body.knowledge_point_id

    if activity.knowledge_point_id and body.result in ("correct", "incorrect", "partial"):
        from .intelligence import update_mastery
        kp_id = activity.knowledge_point_id
        if activity.activity_type == "quiz":
            update_mastery(db, kp_id, quiz_correct=1 if body.result == "correct" else 0, quiz_total=1)
        elif activity.activity_type in ("practice", "teachback", "socratic"):
            score = 1.0 if body.result == "correct" else (0.5 if body.result == "partial" else 0.0)
            update_mastery(db, kp_id, practice_score=score)

    xp = 0
    if activity.activity_type == "flashcard":
        xp = ACTIVITY_XP["flashcard"]
    elif activity.activity_type == "quiz":
        xp = ACTIVITY_XP["quiz_correct"] if body.result == "correct" else ACTIVITY_XP["quiz_incorrect"]
    elif activity.activity_type == "practice":
        xp = ACTIVITY_XP["practice"]

    session.xp_earned += xp
    session.activities_count += 1
    db.commit()

    activities = list(db.scalars(select(StudyActivity).where(StudyActivity.session_id == session.id).order_by(StudyActivity.id)))
    completed = sum(1 for a in activities if a.result != "pending")
    current = next((i for i, a in enumerate(activities) if a.result == "pending"), len(activities))

    return {
        "xp_earned": xp,
        "total_xp": session.xp_earned,
        "completed": completed,
        "total": len(activities),
        "current_index": current,
        "all_done": current >= len(activities),
    }


@router.post("/books/{book_id}/study-sessions/{session_id}/complete")
def complete_session(book_id: int, session_id: int, db: Session = Depends(get_db)):
    _load_book(db, book_id)
    session = _load_session(db, session_id)
    if session.book_id != book_id:
        raise HTTPException(status_code=404, detail="Session not found for this book")

    session.completed_at = utcnow_naive()
    db.commit()

    activities = list(db.scalars(select(StudyActivity).where(StudyActivity.session_id == session.id).order_by(StudyActivity.id)))
    correct_count = sum(1 for a in activities if a.result == "correct")
    total = len(activities)

    return {
        "session_id": session.id,
        "xp_earned": session.xp_earned,
        "activities_completed": total,
        "correct_count": correct_count,
        "duration_seconds": int((session.completed_at - session.started_at).total_seconds()) if session.completed_at else 0,
    }
