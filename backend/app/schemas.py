import datetime
from typing import Literal

from pydantic import BaseModel, ConfigDict, field_validator


class BookOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    title: str
    filename: str
    num_pages: int
    status: str
    error: str | None
    content_start_section_id: int | None = None
    content_start_page: int | None = None


class SectionOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    title: str
    level: int
    page_start: int
    page_end: int


class ChatSessionOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    book_id: int
    title: str


class Citation(BaseModel):
    page: int | None = None
    section_title: str
    snippet: str
    url: str | None = None


class MessageOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    role: str
    content: str
    action: str | None = None
    citations: list[Citation] | None = None
    created_at: datetime.datetime | None = None


class SectionChatRequest(BaseModel):
    text: str
    action: str
    page: int | None = None
    question: str | None = None


class SectionChatOut(BaseModel):
    session_id: int
    messages: list[MessageOut]


class FlashcardOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    section_id: int
    front: str
    back: str
    ord: int
    ease: float = 2.5
    interval_days: int = 0
    due_at: datetime.datetime | None = None
    reps: int = 0
    lapses: int = 0


class ReviewRequest(BaseModel):
    rating: Literal["again", "hard", "good", "easy"]


class QuizAttemptOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    section_id: int | None = None
    score: int
    total: int
    created_at: datetime.datetime


class SectionProgress(BaseModel):
    section_id: int
    cards_total: int
    cards_due: int
    cards_mastered: int
    last_quiz: QuizAttemptOut | None = None


class BookProgress(BaseModel):
    cards_total: int
    cards_due: int
    cards_mastered: int
    sections: list[SectionProgress]
    attempts: list[QuizAttemptOut]


class NoteCreate(BaseModel):
    content: str
    section_id: int | None = None
    page: int | None = None
    quote: str | None = None


class NoteUpdate(BaseModel):
    content: str | None = None
    section_id: int | None = None
    page: int | None = None
    quote: str | None = None


class NoteOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    section_id: int | None = None
    page: int | None = None
    quote: str | None = None
    content: str
    created_at: datetime.datetime
    updated_at: datetime.datetime


class VocabWordCreate(BaseModel):
    term: str
    translation: str
    note: str | None = None
    context: str | None = None
    section_id: int | None = None
    page: int | None = None


class VocabWordOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    book_id: int
    section_id: int | None = None
    term: str
    translation: str
    note: str | None = None
    context: str | None = None
    page: int | None = None
    created_at: datetime.datetime


class TranslateRequest(BaseModel):
    text: str
    page: int | None = None


class TranslateWord(BaseModel):
    term: str
    translation: str
    note: str | None = None


class TranslateResult(BaseModel):
    words: list[TranslateWord]
    context: str | None = None


class DashboardBook(BaseModel):
    id: int
    title: str
    status: str
    num_pages: int
    sections_count: int
    sections_read: int = 0
    cards_total: int
    cards_due: int
    cards_mastered: int
    notes_count: int
    last_quiz: QuizAttemptOut | None = None
    last_activity: datetime.datetime | None = None


class DashboardOut(BaseModel):
    cards_total: int
    cards_due: int
    cards_mastered: int
    books: list[DashboardBook]


class SearchHit(BaseModel):
    book_id: int
    book_title: str
    section_id: int | None = None
    section_title: str
    page_start: int
    page_end: int
    snippet: str
    distance: float


class QuizQuestion(BaseModel):
    id: str
    question: str
    options: list[str]


class QuizOut(BaseModel):
    quiz_id: str
    questions: list[QuizQuestion]


class QuizGradeRequest(BaseModel):
    question_id: str
    selected: int


class QuizGradeResult(BaseModel):
    correct: bool
    answer_index: int
    explanation: str


class KnowledgePointOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    book_id: int
    section_id: int
    name: str
    description: str
    difficulty: float


class UserKnowledgePointOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    knowledge_point_id: int
    mastery: float
    quiz_correct: int
    quiz_total: int
    socratic_reveals: int
    socratic_total: int
    practice_score_sum: float
    practice_count: int
    last_practiced: datetime.datetime | None


class WeakAreaOut(BaseModel):
    knowledge_point: KnowledgePointOut
    user_kp: UserKnowledgePointOut | None
    section_title: str
    recommendation: str


class StudyActivityOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    activity_type: str
    knowledge_point_id: int | None
    result: str
    duration_seconds: int
    created_at: datetime.datetime


class StudySessionOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    book_id: int
    started_at: datetime.datetime
    completed_at: datetime.datetime | None
    xp_earned: int
    activities_count: int


class StudySessionPlanOut(BaseModel):
    session: StudySessionOut
    activities: list[StudyActivityOut]
    total_activities: int
    current_index: int


class StudySessionNextRequest(BaseModel):
    activity_id: int
    result: str = "pending"
    duration_seconds: int = 0
    knowledge_point_id: int | None = None


class ConceptGraphNode(BaseModel):
    id: int
    name: str
    description: str
    difficulty: float
    mastery: float | None
    section_id: int
    section_title: str


class ConceptGraphEdge(BaseModel):
    id: int
    source: int
    target: int
    relationship_type: str
    strength: float


class ConceptGraphOut(BaseModel):
    nodes: list[ConceptGraphNode]
    edges: list[ConceptGraphEdge]


class ConceptEdgeOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    source_point_id: int
    target_point_id: int
    relationship_type: str
    strength: float


class CodeBlockOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    book_id: int
    section_id: int
    language: str
    code: str
    description: str
    ord: int


class CodeRunRequest(BaseModel):
    code: str
    language: str = "python"


class CodeRunResult(BaseModel):
    stdout: str
    stderr: str
    success: bool
    execution_ms: int = 0


class NotebookCellCreate(BaseModel):
    source: str = ""
    description: str | None = None
    cell_type: str = "code"
    after_cell_id: int | None = None


class NotebookCellUpdate(BaseModel):
    source: str | None = None
    cell_type: str | None = None


class NotebookCellOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    notebook_id: int
    ord: int
    cell_type: str = "code"
    source: str
    output: str | None = None
    error: str | None = None
    status: str
    execution_count: int = 0
    elapsed_ms: int = 0
    last_executed_at: datetime.datetime | None = None
    images: list[dict] = []
    variables: list[dict] = []
    created_at: datetime.datetime | None = None

    @field_validator("images", "variables", mode="before")
    @classmethod
    def _parse_json_column(cls, v):
        import json
        if v is None:
            return []
        if isinstance(v, str):
            try:
                parsed = json.loads(v)
            except Exception:
                return []
            return parsed if isinstance(parsed, list) else []
        return v


class NotebookOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    book_id: int
    title: str
    cells: list[NotebookCellOut] = []


class UserProfileOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    display_name: str
    total_xp: int
    level: int
    current_streak: int
    longest_streak: int
    daily_xp_goal: int
    last_study_date: str | None


class UserProfileUpdate(BaseModel):
    display_name: str | None = None
    daily_xp_goal: int | None = None


class DailyProgressOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    date: str
    xp_earned: int
    flashcards_reviewed: int
    quizzes_taken: int
    quizzes_perfect: int
    notes_created: int
    sections_read: int
    study_minutes: int
    goal_met: bool


class AchievementDefOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    key: str
    name: str
    description: str
    icon: str
    category: str
    xp_reward: int
    earned: bool
    earned_at: datetime.datetime | None = None


class GamificationStatsOut(BaseModel):
    total_xp: int
    level: int
    xp_to_next_level: int
    current_streak: int
    longest_streak: int
    books_explored: int
    total_cards_reviewed: int
    total_quizzes: int
    perfect_quizzes: int
    total_notes: int
    achievements_earned: int
    achievements_total: int
    daily_goal_progress: float


class CrossBookLinkOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    source_kp_id: int
    target_kp_id: int
    similarity: float
    relationship_label: str
    explanation: str
    source_book_title: str | None = None
    target_book_title: str | None = None
    source_kp_name: str | None = None
    target_kp_name: str | None = None


class ConceptClusterOut(BaseModel):
    id: int
    name: str
    description: str
    member_count: int
    books_involved: list[str]


class ConceptClusterMemberOut(BaseModel):
    knowledge_point_id: int
    kp_name: str
    book_id: int
    book_title: str
    section_title: str
    mastery: float | None


class UnifiedGraphOut(BaseModel):
    nodes: list[ConceptGraphNode]
    intra_edges: list[ConceptGraphEdge]
    inter_edges: list[CrossBookLinkOut]


class RelatedSectionOut(BaseModel):
    book_id: int
    book_title: str
    section_id: int
    section_title: str
    page_start: int
    page_end: int
    similarity_score: float
    shared_clusters: list[str]
    explanation: str


class ReadingProgressOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    section_id: int
    completed_at: datetime.datetime
    time_spent_seconds: int


class ChapterProgress(BaseModel):
    section_id: int
    title: str
    level: int
    read: bool
    children_read: int
    total_children: int
    cards_mastered: int
    cards_total: int
    quiz_score: int | None = None
    mastery: float | None = None


class ReadingSummary(BaseModel):
    sections_read: int
    total_sections: int
    read_percent: float
    chapter_progress: list[ChapterProgress]


class BookDashboard(BaseModel):
    sections_read: int
    total_sections: int
    read_percent: float
    cards_total: int
    cards_mastered: int
    cards_due: int
    quiz_avg_score: float | None = None
    total_quizzes: int
    kp_mastery_avg: float | None = None
    chapter_progress: list[ChapterProgress]
    next_steps: list[str]
    recent_activity: list[dict]


class RecallCheckRequest(BaseModel):
    recall_text: str


class RecallCheckResult(BaseModel):
    score: int
    accurate_points: list[str]
    missed_points: list[str]
    misconceptions: list[str]
    encouragement: str


class QuizErrorOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: int
    book_id: int
    section_id: int | None = None
    question: str
    user_answer: str
    correct_answer: str
    explanation: str
    created_at: datetime.datetime
