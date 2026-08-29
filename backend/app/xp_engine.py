from __future__ import annotations

import datetime as dt
from typing import TYPE_CHECKING

from sqlalchemy import select

if TYPE_CHECKING:
    from sqlalchemy.orm import Session

from .models import (
    AchievementDefinition,
    DailyProgress,
    Flashcard,
    StudyStreakLog,
    UserAchievement,
    UserProfile,
)

XP_TABLE = {
    "flashcard_review": 5,
    "flashcard_perfect": 10,
    "quiz_attempt": 20,
    "quiz_perfect": 50,
    "note_created": 10,
    "socratic_complete": 25,
    "practice_complete": 20,
    "teachback_complete": 30,
    "understand_complete": 15,
    "study_session_complete": 15,
    "daily_goal_met": 40,
    "section_read": 15,
    "cross_book_discovery": 25,
}

ACHIEVEMENT_CATALOG: list[dict] = [
    {"key": "first_quiz_ace", "name": "First Quiz Ace", "description": "Score 100% on a quiz", "icon": "🏆", "category": "quiz", "xp_reward": 50, "threshold": 1},
    {"key": "quiz_master_10", "name": "Quiz Veteran", "description": "Score 100% on 10 quizzes", "icon": "🎓", "category": "quiz", "xp_reward": 200, "threshold": 10},
    {"key": "streak_3", "name": "Getting Started", "description": "Study 3 days in a row", "icon": "🔥", "category": "streak", "xp_reward": 30, "threshold": 3},
    {"key": "streak_7", "name": "Week Warrior", "description": "Study 7 days in a row", "icon": "🔥", "category": "streak", "xp_reward": 100, "threshold": 7},
    {"key": "streak_30", "name": "Monthly Master", "description": "Study 30 days in a row", "icon": "🔥", "category": "streak", "xp_reward": 500, "threshold": 30},
    {"key": "streak_100", "name": "Century Scholar", "description": "Study 100 days in a row", "icon": "💎", "category": "streak", "xp_reward": 2000, "threshold": 100},
    {"key": "books_2", "name": "Bookworm", "description": "Explore 2 books", "icon": "📚", "category": "exploration", "xp_reward": 50, "threshold": 2},
    {"key": "books_5", "name": "Polyglot Reader", "description": "Explore 5 books", "icon": "📚", "category": "exploration", "xp_reward": 200, "threshold": 5},
    {"key": "books_10", "name": "Library Legend", "description": "Explore 10 books", "icon": "📚", "category": "exploration", "xp_reward": 500, "threshold": 10},
    {"key": "cards_50", "name": "Flashcard Frenzy", "description": "Review 50 flashcards", "icon": "🃏", "category": "mastery", "xp_reward": 30, "threshold": 50},
    {"key": "cards_500", "name": "Card Shark", "description": "Review 500 flashcards", "icon": "🃏", "category": "mastery", "xp_reward": 200, "threshold": 500},
    {"key": "mastery_first", "name": "First Mastery", "description": "Master your first concept", "icon": "⭐", "category": "mastery", "xp_reward": 50, "threshold": 1},
    {"key": "mastery_10", "name": "Knowledge Navigator", "description": "Master 10 concepts", "icon": "⭐", "category": "mastery", "xp_reward": 300, "threshold": 10},
    {"key": "notes_25", "name": "Annotator", "description": "Create 25 notes", "icon": "📝", "category": "exploration", "xp_reward": 50, "threshold": 25},
    {"key": "level_5", "name": "Rising Star", "description": "Reach level 5", "icon": "⭐", "category": "streak", "xp_reward": 100, "threshold": 5},
    {"key": "level_10", "name": "Scholar", "description": "Reach level 10", "icon": "🎓", "category": "streak", "xp_reward": 300, "threshold": 10},
]


def xp_for_level(level: int) -> int:
    return 100 * level * (level + 1) // 2


def level_for_xp(total_xp: int) -> int:
    level = 1
    while xp_for_level(level + 1) <= total_xp:
        level += 1
    return level


def xp_to_next_level(total_xp: int) -> int:
    current_level = level_for_xp(total_xp)
    return xp_for_level(current_level + 1) - total_xp


def today_str() -> str:
    return dt.date.today().isoformat()


def _ensure_profile(db: Session) -> UserProfile:
    profile = db.scalar(select(UserProfile).limit(1))
    if profile is None:
        profile = UserProfile(display_name="Reader")
        db.add(profile)
        db.flush()
    return profile


def _ensure_daily_progress(db: Session, date: str) -> DailyProgress:
    progress = db.scalar(select(DailyProgress).where(DailyProgress.date == date))
    if progress is None:
        progress = DailyProgress(date=date)
        db.add(progress)
        db.flush()
    return progress


def _update_streak(profile: UserProfile, today: str) -> None:
    if profile.last_study_date == today:
        return
    if profile.last_study_date:
        last = dt.date.fromisoformat(profile.last_study_date)
        diff = (dt.date.today() - last).days
        if diff == 1:
            profile.current_streak += 1
        elif diff > 1:
            profile.current_streak = 1
    else:
        profile.current_streak = 1
    if profile.current_streak > profile.longest_streak:
        profile.longest_streak = profile.current_streak
    profile.last_study_date = today


def _check_achievements(db: Session, profile: UserProfile) -> list[str]:
    earned_keys = {
        ua.achievement_key
        for ua in db.scalars(select(UserAchievement))
    }
    new_achievements: list[str] = []
    from .models import Book, KnowledgePoint, Note, QuizAttempt, UserKnowledgePoint, Flashcard

    total_books = db.scalar(select(Book.id).limit(1).correlate(select()) or select(1)) or 0
    total_books = len(list(db.scalars(select(Book.id))))

    for defn in db.scalars(select(AchievementDefinition)):
        if defn.key in earned_keys:
            continue
        met = False
        if defn.category == "streak" and defn.key.startswith("streak_"):
            met = profile.current_streak >= defn.threshold
        elif defn.key.startswith("books_"):
            met = total_books >= defn.threshold
        elif defn.key.startswith("level_"):
            met = profile.level >= defn.threshold
        elif defn.key == "first_quiz_ace" or defn.key == "quiz_master_10":
            count = 0
            for q in db.scalars(select(QuizAttempt)):
                if q.score == q.total:
                    count += 1
            met = count >= defn.threshold
        elif defn.key.startswith("cards_"):
            total_reviews = sum(f.reps for f in db.scalars(select(Flashcard)))
            met = total_reviews >= defn.threshold
        elif defn.key.startswith("mastery_"):
            count = len([u for u in db.scalars(select(UserKnowledgePoint)) if u.mastery >= 0.8])
            met = count >= defn.threshold
        elif defn.key == "notes_25":
            count = len(list(db.scalars(select(Note))))
            met = count >= defn.threshold

        if met:
            db.add(UserAchievement(achievement_key=defn.key))
            profile.total_xp += defn.xp_reward
            new_achievements.append(defn.key)

    return new_achievements


def award_xp(
    db: Session,
    activity_type: str,
    *,
    xp_override: int | None = None,
) -> dict:
    profile = _ensure_profile(db)
    today = today_str()
    progress = _ensure_daily_progress(db, today)

    base_xp = xp_override if xp_override is not None else XP_TABLE.get(activity_type, 0)
    profile.total_xp += base_xp
    profile.level = level_for_xp(profile.total_xp)
    progress.xp_earned += base_xp

    if activity_type == "flashcard_review" or activity_type == "flashcard_perfect":
        progress.flashcards_reviewed += 1
    elif activity_type.startswith("quiz_"):
        progress.quizzes_taken += 1
        if activity_type == "quiz_perfect":
            progress.quizzes_perfect += 1
    elif activity_type == "note_created":
        progress.notes_created += 1
    elif activity_type == "study_session_complete":
        progress.study_minutes += 1

    _update_streak(profile, today)

    streak_log = db.scalar(select(StudyStreakLog).where(StudyStreakLog.date == today))
    if streak_log is None:
        streak_log = StudyStreakLog(date=today)
        db.add(streak_log)
    streak_log.activities_count += 1
    streak_log.xp_earned += base_xp

    if progress.xp_earned >= profile.daily_xp_goal and not progress.goal_met:
        progress.goal_met = True
        bonus = XP_TABLE["daily_goal_met"]
        profile.total_xp += bonus
        progress.xp_earned += bonus

    new_achievements = _check_achievements(db, profile)
    db.commit()

    return {
        "xp_awarded": base_xp,
        "total_xp": profile.total_xp,
        "level": profile.level,
        "streak": profile.current_streak,
        "daily_xp": progress.xp_earned,
        "daily_goal": profile.daily_xp_goal,
        "goal_met": progress.goal_met,
        "new_achievements": new_achievements,
    }


def get_profile(db: Session) -> UserProfile:
    return _ensure_profile(db)


def get_today_progress(db: Session) -> DailyProgress:
    return _ensure_daily_progress(db, today_str())


def seed_achievements(db: Session) -> None:
    existing = {d.key for d in db.scalars(select(AchievementDefinition))}
    for item in ACHIEVEMENT_CATALOG:
        if item["key"] not in existing:
            db.add(AchievementDefinition(**item))
    db.commit()
