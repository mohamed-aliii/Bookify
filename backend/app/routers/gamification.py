import datetime as dt
import logging

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.orm import Session

from ..database import get_db
from ..models import (
    AchievementDefinition,
    Book,
    DailyProgress,
    Flashcard,
    Note,
    QuizAttempt,
    UserAchievement,
    UserProfile,
    UserKnowledgePoint,
)
from ..schemas import (
    AchievementDefOut,
    DailyProgressOut,
    GamificationStatsOut,
    UserProfileOut,
    UserProfileUpdate,
)
from ..xp_engine import award_xp, get_profile, get_today_progress, seed_achievements, xp_to_next_level

logger = logging.getLogger(__name__)
router = APIRouter(tags=["gamification"])


@router.on_event("startup")
def _seed():
    pass


def _ensure_profile(db: Session) -> UserProfile:
    profile = db.scalar(select(UserProfile).limit(1))
    if profile is None:
        profile = UserProfile(display_name="Reader")
        db.add(profile)
        db.commit()
        db.refresh(profile)
    return profile


@router.get("/gamification/profile", response_model=UserProfileOut)
def get_gamification_profile(db: Session = Depends(get_db)):
    seed_achievements(db)
    return _ensure_profile(db)


@router.patch("/gamification/profile", response_model=UserProfileOut)
def update_gamification_profile(body: UserProfileUpdate, db: Session = Depends(get_db)):
    profile = _ensure_profile(db)
    if body.display_name is not None:
        profile.display_name = body.display_name
    if body.daily_xp_goal is not None:
        profile.daily_xp_goal = max(10, body.daily_xp_goal)
    db.commit()
    db.refresh(profile)
    return profile


@router.get("/gamification/progress/today", response_model=DailyProgressOut)
def get_today(db: Session = Depends(get_db)):
    return get_today_progress(db)


@router.get("/gamification/progress/history", response_model=list[DailyProgressOut])
def get_progress_history(days: int = 365, db: Session = Depends(get_db)):
    cutoff = (dt.date.today() - dt.timedelta(days=days)).isoformat()
    return list(db.scalars(
        select(DailyProgress).where(DailyProgress.date >= cutoff).order_by(DailyProgress.date)
    ))


@router.get("/gamification/achievements", response_model=list[AchievementDefOut])
def get_achievements(db: Session = Depends(get_db)):
    seed_achievements(db)
    earned_map = {
        ua.achievement_key: ua.earned_at
        for ua in db.scalars(select(UserAchievement))
    }
    defs = list(db.scalars(select(AchievementDefinition)))
    return [
        AchievementDefOut(
            key=d.key,
            name=d.name,
            description=d.description,
            icon=d.icon,
            category=d.category,
            xp_reward=d.xp_reward,
            earned=d.key in earned_map,
            earned_at=earned_map.get(d.key),
        )
        for d in defs
    ]


@router.get("/gamification/achievements/recent", response_model=list[AchievementDefOut])
def get_recent_achievements(db: Session = Depends(get_db)):
    unseen = list(db.scalars(
        select(UserAchievement).where(UserAchievement.notified == False)
    ))
    if not unseen:
        return []
    result = []
    for ua in unseen:
        defn = db.get(AchievementDefinition, ua.achievement_key)
        if defn:
            result.append(AchievementDefOut(
                key=defn.key,
                name=defn.name,
                description=defn.description,
                icon=defn.icon,
                category=defn.category,
                xp_reward=defn.xp_reward,
                earned=True,
                earned_at=ua.earned_at,
            ))
    return result


@router.post("/gamification/achievements/{key}/acknowledge")
def acknowledge_achievement(key: str, db: Session = Depends(get_db)):
    ua = db.scalar(select(UserAchievement).where(UserAchievement.achievement_key == key))
    if ua is None:
        raise HTTPException(status_code=404, detail="Achievement not found")
    ua.notified = True
    db.commit()
    return {"ok": True}


@router.get("/gamification/stats", response_model=GamificationStatsOut)
def get_stats(db: Session = Depends(get_db)):
    profile = _ensure_profile(db)
    progress = get_today_progress(db)

    total_books = len(list(db.scalars(select(Book.id))))
    total_notes = len(list(db.scalars(select(Note))))
    all_quizzes = list(db.scalars(select(QuizAttempt)))
    perfect_quizzes = len([q for q in all_quizzes if q.score == q.total])
    total_achievements = len(list(db.scalars(select(AchievementDefinition))))
    earned_achievements = len(list(db.scalars(select(UserAchievement))))

    return GamificationStatsOut(
        total_xp=profile.total_xp,
        level=profile.level,
        xp_to_next_level=xp_to_next_level(profile.total_xp),
        current_streak=profile.current_streak,
        longest_streak=profile.longest_streak,
        books_explored=total_books,
        total_cards_reviewed=sum(f.reps for f in db.scalars(select(Flashcard))),
        total_quizzes=len(all_quizzes),
        perfect_quizzes=perfect_quizzes,
        total_notes=total_notes,
        achievements_earned=earned_achievements,
        achievements_total=total_achievements,
        daily_goal_progress=min(1.0, progress.xp_earned / max(1, profile.daily_xp_goal)),
    )
