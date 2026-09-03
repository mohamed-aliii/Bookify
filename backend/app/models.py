import datetime as dt

from sqlalchemy import Boolean, DateTime, Float, ForeignKey, Integer, String, Text, UniqueConstraint, func
from sqlalchemy.orm import Mapped, mapped_column, relationship

from .database import Base


def utcnow_naive() -> dt.datetime:
    return dt.datetime.now(dt.timezone.utc).replace(tzinfo=None)


class Book(Base):
    __tablename__ = "books"

    id: Mapped[int] = mapped_column(primary_key=True)
    title: Mapped[str] = mapped_column(String(400))
    filename: Mapped[str] = mapped_column(String(400))
    path: Mapped[str] = mapped_column(String(600))
    cover_path: Mapped[str | None] = mapped_column(String(600), nullable=True)
    num_pages: Mapped[int] = mapped_column(Integer, default=0)
    status: Mapped[str] = mapped_column(String(20), default="pending")
    error: Mapped[str | None] = mapped_column(Text, nullable=True)
    content_start_section_id: Mapped[int | None] = mapped_column(ForeignKey("sections.id"), nullable=True)
    content_start_page: Mapped[int | None] = mapped_column(Integer, nullable=True)
    content_start_confirmed: Mapped[bool] = mapped_column(Boolean, default=False)
    ingestion_max_level: Mapped[int] = mapped_column(Integer, default=3)
    content_type: Mapped[str] = mapped_column(String(20), default="book")
    created_at: Mapped[dt.datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())

    sections: Mapped[list["Section"]] = relationship(
        back_populates="book", cascade="all, delete-orphan", order_by="Section.ord",
        foreign_keys="Section.book_id",
    )
    chunks: Mapped[list["Chunk"]] = relationship(back_populates="book", cascade="all, delete-orphan")
    sessions: Mapped[list["ChatSession"]] = relationship(back_populates="book", cascade="all, delete-orphan")
    notebook: Mapped[list["Notebook"]] = relationship(back_populates="book", cascade="all, delete-orphan")


class ReadingProgress(Base):
    __tablename__ = "reading_progress"

    id: Mapped[int] = mapped_column(primary_key=True)
    section_id: Mapped[int] = mapped_column(ForeignKey("sections.id"), unique=True)
    completed_at: Mapped[dt.datetime] = mapped_column(DateTime, default=utcnow_naive)
    time_spent_seconds: Mapped[int] = mapped_column(Integer, default=0)


class Section(Base):
    __tablename__ = "sections"

    id: Mapped[int] = mapped_column(primary_key=True)
    book_id: Mapped[int] = mapped_column(ForeignKey("books.id"))
    parent_id: Mapped[int | None] = mapped_column(ForeignKey("sections.id"), nullable=True)
    title: Mapped[str] = mapped_column(String(400))
    level: Mapped[int] = mapped_column(Integer, default=1)
    page_start: Mapped[int] = mapped_column(Integer)
    page_end: Mapped[int] = mapped_column(Integer, default=0)
    ord: Mapped[int] = mapped_column(Integer, default=0)

    book: Mapped[Book] = relationship(back_populates="sections", foreign_keys="Section.book_id")


class Chunk(Base):
    __tablename__ = "chunks"

    id: Mapped[int] = mapped_column(primary_key=True)
    book_id: Mapped[int] = mapped_column(ForeignKey("books.id"))
    section_id: Mapped[int | None] = mapped_column(ForeignKey("sections.id"), nullable=True)
    section_title: Mapped[str] = mapped_column(String(400))
    text: Mapped[str] = mapped_column(Text)
    page_start: Mapped[int] = mapped_column(Integer)
    page_end: Mapped[int] = mapped_column(Integer)
    ord: Mapped[int] = mapped_column(Integer, default=0)
    is_code: Mapped[bool] = mapped_column(Boolean, default=False)

    book: Mapped[Book] = relationship(back_populates="chunks")


class ChatSession(Base):
    __tablename__ = "chat_sessions"

    id: Mapped[int] = mapped_column(primary_key=True)
    book_id: Mapped[int] = mapped_column(ForeignKey("books.id"))
    section_id: Mapped[int | None] = mapped_column(ForeignKey("sections.id"), nullable=True)
    title: Mapped[str] = mapped_column(String(300), default="New chat")
    created_at: Mapped[dt.datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())

    book: Mapped[Book] = relationship(back_populates="sessions")
    messages: Mapped[list["Message"]] = relationship(
        back_populates="session", cascade="all, delete-orphan", order_by="Message.id"
    )


class Message(Base):
    __tablename__ = "messages"

    id: Mapped[int] = mapped_column(primary_key=True)
    session_id: Mapped[int] = mapped_column(ForeignKey("chat_sessions.id"))
    role: Mapped[str] = mapped_column(String(20))
    content: Mapped[str] = mapped_column(Text)
    action: Mapped[str | None] = mapped_column(String(30), nullable=True)
    citations_json: Mapped[str | None] = mapped_column(Text, nullable=True)
    created_at: Mapped[dt.datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())

    session: Mapped[ChatSession] = relationship(back_populates="messages")


class SectionSummary(Base):
    __tablename__ = "section_summaries"

    id: Mapped[int] = mapped_column(primary_key=True)
    book_id: Mapped[int] = mapped_column(ForeignKey("books.id"))
    section_id: Mapped[int] = mapped_column(ForeignKey("sections.id"), unique=True)
    content: Mapped[str] = mapped_column(Text)
    created_at: Mapped[dt.datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())


class Flashcard(Base):
    __tablename__ = "flashcards"

    id: Mapped[int] = mapped_column(primary_key=True)
    book_id: Mapped[int] = mapped_column(ForeignKey("books.id"))
    section_id: Mapped[int] = mapped_column(ForeignKey("sections.id"))
    front: Mapped[str] = mapped_column(Text)
    back: Mapped[str] = mapped_column(Text)
    ord: Mapped[int] = mapped_column(Integer, default=0)
    ease: Mapped[float] = mapped_column(Float, default=2.5)
    interval_days: Mapped[int] = mapped_column(Integer, default=0)
    due_at: Mapped[dt.datetime] = mapped_column(DateTime, default=utcnow_naive)
    reps: Mapped[int] = mapped_column(Integer, default=0)
    lapses: Mapped[int] = mapped_column(Integer, default=0)
    created_at: Mapped[dt.datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())


class QuizAttempt(Base):
    __tablename__ = "quiz_attempts"

    id: Mapped[int] = mapped_column(primary_key=True)
    book_id: Mapped[int] = mapped_column(ForeignKey("books.id"))
    section_id: Mapped[int | None] = mapped_column(ForeignKey("sections.id"), nullable=True)
    score: Mapped[int] = mapped_column(Integer)
    total: Mapped[int] = mapped_column(Integer)
    created_at: Mapped[dt.datetime] = mapped_column(DateTime, default=utcnow_naive)


class QuizError(Base):
    __tablename__ = "quiz_errors"

    id: Mapped[int] = mapped_column(primary_key=True)
    book_id: Mapped[int] = mapped_column(ForeignKey("books.id"))
    section_id: Mapped[int | None] = mapped_column(ForeignKey("sections.id"), nullable=True)
    question: Mapped[str] = mapped_column(Text)
    user_answer: Mapped[str] = mapped_column(Text)
    correct_answer: Mapped[str] = mapped_column(Text)
    explanation: Mapped[str] = mapped_column(Text, default="")
    created_at: Mapped[dt.datetime] = mapped_column(DateTime, default=utcnow_naive)


class Note(Base):
    __tablename__ = "notes"

    id: Mapped[int] = mapped_column(primary_key=True)
    book_id: Mapped[int] = mapped_column(ForeignKey("books.id"))
    section_id: Mapped[int | None] = mapped_column(ForeignKey("sections.id"), nullable=True)
    page: Mapped[int | None] = mapped_column(Integer, nullable=True)
    quote: Mapped[str | None] = mapped_column(Text, nullable=True)
    content: Mapped[str] = mapped_column(Text)
    created_at: Mapped[dt.datetime] = mapped_column(DateTime, default=utcnow_naive)
    updated_at: Mapped[dt.datetime] = mapped_column(DateTime, default=utcnow_naive, onupdate=utcnow_naive)

    section: Mapped[Section | None] = relationship()


class VocabWord(Base):
    __tablename__ = "vocab_words"

    id: Mapped[int] = mapped_column(primary_key=True)
    book_id: Mapped[int] = mapped_column(ForeignKey("books.id"))
    section_id: Mapped[int | None] = mapped_column(ForeignKey("sections.id"), nullable=True)
    term: Mapped[str] = mapped_column(String(300))
    translation: Mapped[str] = mapped_column(Text)
    note: Mapped[str | None] = mapped_column(Text, nullable=True)
    context: Mapped[str | None] = mapped_column(Text, nullable=True)
    page: Mapped[int | None] = mapped_column(Integer, nullable=True)
    created_at: Mapped[dt.datetime] = mapped_column(DateTime, default=utcnow_naive)

    book: Mapped[Book] = relationship()
    section: Mapped[Section | None] = relationship()


class KnowledgePoint(Base):
    __tablename__ = "knowledge_points"

    id: Mapped[int] = mapped_column(primary_key=True)
    book_id: Mapped[int] = mapped_column(ForeignKey("books.id"))
    section_id: Mapped[int] = mapped_column(ForeignKey("sections.id"))
    name: Mapped[str] = mapped_column(String(300))
    description: Mapped[str] = mapped_column(Text)
    difficulty: Mapped[float] = mapped_column(Float, default=0.5)
    created_at: Mapped[dt.datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())

    book: Mapped[Book] = relationship()
    section: Mapped[Section] = relationship()


class UserKnowledgePoint(Base):
    __tablename__ = "user_knowledge_points"

    id: Mapped[int] = mapped_column(primary_key=True)
    knowledge_point_id: Mapped[int] = mapped_column(ForeignKey("knowledge_points.id"), unique=True)
    mastery: Mapped[float] = mapped_column(Float, default=0.0)
    quiz_correct: Mapped[int] = mapped_column(Integer, default=0)
    quiz_total: Mapped[int] = mapped_column(Integer, default=0)
    socratic_reveals: Mapped[int] = mapped_column(Integer, default=0)
    socratic_total: Mapped[int] = mapped_column(Integer, default=0)
    practice_score_sum: Mapped[float] = mapped_column(Float, default=0.0)
    practice_count: Mapped[int] = mapped_column(Integer, default=0)
    last_practiced: Mapped[dt.datetime | None] = mapped_column(DateTime, nullable=True)
    created_at: Mapped[dt.datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    updated_at: Mapped[dt.datetime] = mapped_column(DateTime(timezone=True), server_default=func.now(), onupdate=func.now())

    knowledge_point: Mapped[KnowledgePoint] = relationship()


class StudySession(Base):
    __tablename__ = "study_sessions"

    id: Mapped[int] = mapped_column(primary_key=True)
    book_id: Mapped[int] = mapped_column(ForeignKey("books.id"))
    started_at: Mapped[dt.datetime] = mapped_column(DateTime, default=utcnow_naive)
    completed_at: Mapped[dt.datetime | None] = mapped_column(DateTime, nullable=True)
    xp_earned: Mapped[int] = mapped_column(Integer, default=0)
    activities_count: Mapped[int] = mapped_column(Integer, default=0)

    book: Mapped[Book] = relationship()
    activities: Mapped[list["StudyActivity"]] = relationship(back_populates="session", cascade="all, delete-orphan")


class StudyActivity(Base):
    __tablename__ = "study_activities"

    id: Mapped[int] = mapped_column(primary_key=True)
    session_id: Mapped[int] = mapped_column(ForeignKey("study_sessions.id"))
    activity_type: Mapped[str] = mapped_column(String(30))
    knowledge_point_id: Mapped[int | None] = mapped_column(ForeignKey("knowledge_points.id"), nullable=True)
    result: Mapped[str] = mapped_column(String(20), default="pending")
    duration_seconds: Mapped[int] = mapped_column(Integer, default=0)
    created_at: Mapped[dt.datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())

    session: Mapped[StudySession] = relationship(back_populates="activities")
    knowledge_point: Mapped[KnowledgePoint | None] = relationship()


class ConceptEdge(Base):
    __tablename__ = "concept_edges"

    id: Mapped[int] = mapped_column(primary_key=True)
    source_point_id: Mapped[int] = mapped_column(ForeignKey("knowledge_points.id"))
    target_point_id: Mapped[int] = mapped_column(ForeignKey("knowledge_points.id"))
    relationship_type: Mapped[str] = mapped_column(String(50))
    strength: Mapped[float] = mapped_column(Float, default=0.5)
    explanation: Mapped[str] = mapped_column(Text, default="")
    created_at: Mapped[dt.datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())

    source: Mapped[KnowledgePoint] = relationship(foreign_keys="ConceptEdge.source_point_id")
    target: Mapped[KnowledgePoint] = relationship(foreign_keys="ConceptEdge.target_point_id")


class CodeBlock(Base):
    __tablename__ = "code_blocks"

    id: Mapped[int] = mapped_column(primary_key=True)
    book_id: Mapped[int] = mapped_column(ForeignKey("books.id"))
    section_id: Mapped[int] = mapped_column(ForeignKey("sections.id"))
    language: Mapped[str] = mapped_column(String(30), default="python")
    code: Mapped[str] = mapped_column(Text)
    description: Mapped[str] = mapped_column(Text)
    ord: Mapped[int] = mapped_column(Integer, default=0)
    created_at: Mapped[dt.datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())

    book: Mapped[Book] = relationship()
    section: Mapped[Section] = relationship()


class Notebook(Base):
    __tablename__ = "notebooks"

    id: Mapped[int] = mapped_column(primary_key=True)
    book_id: Mapped[int] = mapped_column(ForeignKey("books.id"))
    section_id: Mapped[int | None] = mapped_column(ForeignKey("sections.id"), nullable=True)
    title: Mapped[str] = mapped_column(String(400), default="Notebook")
    created_at: Mapped[dt.datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())

    book: Mapped[Book] = relationship()
    section: Mapped["Section | None"] = relationship()
    cells: Mapped[list["NotebookCell"]] = relationship(
        back_populates="notebook", cascade="all, delete-orphan", order_by="NotebookCell.ord"
    )


class NotebookCell(Base):
    __tablename__ = "notebook_cells"

    id: Mapped[int] = mapped_column(primary_key=True)
    notebook_id: Mapped[int] = mapped_column(ForeignKey("notebooks.id"))
    ord: Mapped[int] = mapped_column(Integer, default=0)
    cell_type: Mapped[str] = mapped_column(String(10), default="code")
    source: Mapped[str] = mapped_column(Text, default="")
    output: Mapped[str | None] = mapped_column(Text, nullable=True)
    error: Mapped[str | None] = mapped_column(Text, nullable=True)
    status: Mapped[str] = mapped_column(String(20), default="idle")
    execution_count: Mapped[int] = mapped_column(Integer, default=0)
    elapsed_ms: Mapped[int] = mapped_column(Integer, default=0)
    last_executed_at: Mapped[dt.datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    images: Mapped[str | None] = mapped_column(Text, nullable=True)
    variables: Mapped[str | None] = mapped_column(Text, nullable=True)
    created_at: Mapped[dt.datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())

    notebook: Mapped[Notebook] = relationship(back_populates="cells")


class UserProfile(Base):
    __tablename__ = "user_profiles"

    id: Mapped[int] = mapped_column(primary_key=True)
    display_name: Mapped[str] = mapped_column(String(100), default="Reader")
    total_xp: Mapped[int] = mapped_column(Integer, default=0)
    level: Mapped[int] = mapped_column(Integer, default=1)
    current_streak: Mapped[int] = mapped_column(Integer, default=0)
    longest_streak: Mapped[int] = mapped_column(Integer, default=0)
    last_study_date: Mapped[str | None] = mapped_column(String(10), nullable=True)
    daily_xp_goal: Mapped[int] = mapped_column(Integer, default=50)
    created_at: Mapped[dt.datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    updated_at: Mapped[dt.datetime] = mapped_column(DateTime(timezone=True), server_default=func.now(), onupdate=func.now())


class DailyProgress(Base):
    __tablename__ = "daily_progress"

    id: Mapped[int] = mapped_column(primary_key=True)
    date: Mapped[str] = mapped_column(String(10), unique=True)
    xp_earned: Mapped[int] = mapped_column(Integer, default=0)
    flashcards_reviewed: Mapped[int] = mapped_column(Integer, default=0)
    quizzes_taken: Mapped[int] = mapped_column(Integer, default=0)
    quizzes_perfect: Mapped[int] = mapped_column(Integer, default=0)
    notes_created: Mapped[int] = mapped_column(Integer, default=0)
    sections_read: Mapped[int] = mapped_column(Integer, default=0)
    study_minutes: Mapped[int] = mapped_column(Integer, default=0)
    goal_met: Mapped[bool] = mapped_column(Boolean, default=False)
    created_at: Mapped[dt.datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())


class AchievementDefinition(Base):
    __tablename__ = "achievement_definitions"

    id: Mapped[int] = mapped_column(primary_key=True)
    key: Mapped[str] = mapped_column(String(50), unique=True)
    name: Mapped[str] = mapped_column(String(100))
    description: Mapped[str] = mapped_column(String(300))
    icon: Mapped[str] = mapped_column(String(10))
    category: Mapped[str] = mapped_column(String(30))
    xp_reward: Mapped[int] = mapped_column(Integer, default=0)
    threshold: Mapped[int] = mapped_column(Integer, default=1)


class UserAchievement(Base):
    __tablename__ = "user_achievements"

    id: Mapped[int] = mapped_column(primary_key=True)
    achievement_key: Mapped[str] = mapped_column(ForeignKey("achievement_definitions.key"), unique=True)
    earned_at: Mapped[dt.datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    notified: Mapped[bool] = mapped_column(Boolean, default=False)

    definition: Mapped[AchievementDefinition] = relationship()


class StudyStreakLog(Base):
    __tablename__ = "study_streak_log"

    id: Mapped[int] = mapped_column(primary_key=True)
    date: Mapped[str] = mapped_column(String(10), index=True)
    activities_count: Mapped[int] = mapped_column(Integer, default=0)
    xp_earned: Mapped[int] = mapped_column(Integer, default=0)


class CrossBookLink(Base):
    __tablename__ = "cross_book_links"

    id: Mapped[int] = mapped_column(primary_key=True)
    source_kp_id: Mapped[int] = mapped_column(ForeignKey("knowledge_points.id"))
    target_kp_id: Mapped[int] = mapped_column(ForeignKey("knowledge_points.id"))
    similarity: Mapped[float] = mapped_column(Float)
    relationship_label: Mapped[str] = mapped_column(String(50))
    explanation: Mapped[str] = mapped_column(Text)
    created_at: Mapped[dt.datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())

    source_kp: Mapped[KnowledgePoint] = relationship(foreign_keys="CrossBookLink.source_kp_id")
    target_kp: Mapped[KnowledgePoint] = relationship(foreign_keys="CrossBookLink.target_kp_id")


class ConceptCluster(Base):
    __tablename__ = "concept_clusters"

    id: Mapped[int] = mapped_column(primary_key=True)
    name: Mapped[str] = mapped_column(String(300))
    description: Mapped[str] = mapped_column(Text)
    created_at: Mapped[dt.datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())

    members: Mapped[list["ConceptClusterMember"]] = relationship(back_populates="cluster", cascade="all, delete-orphan")


class ConceptClusterMember(Base):
    __tablename__ = "concept_cluster_members"

    id: Mapped[int] = mapped_column(primary_key=True)
    cluster_id: Mapped[int] = mapped_column(ForeignKey("concept_clusters.id"))
    knowledge_point_id: Mapped[int] = mapped_column(ForeignKey("knowledge_points.id"))
    book_id: Mapped[int] = mapped_column(ForeignKey("books.id"))

    cluster: Mapped[ConceptCluster] = relationship(back_populates="members")
    knowledge_point: Mapped[KnowledgePoint] = relationship()
    book: Mapped[Book] = relationship()


class Course(Base):
    __tablename__ = "courses"

    id: Mapped[int] = mapped_column(primary_key=True)
    title: Mapped[str] = mapped_column(String(400))
    description: Mapped[str] = mapped_column(Text, default="")
    cover_path: Mapped[str | None] = mapped_column(String(600), nullable=True)
    created_at: Mapped[dt.datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    updated_at: Mapped[dt.datetime] = mapped_column(DateTime(timezone=True), server_default=func.now(), onupdate=func.now())

    books: Mapped[list["CourseBook"]] = relationship(
        back_populates="course", cascade="all, delete-orphan", order_by="CourseBook.ord"
    )


class CourseBook(Base):
    __tablename__ = "course_books"

    id: Mapped[int] = mapped_column(primary_key=True)
    course_id: Mapped[int] = mapped_column(ForeignKey("courses.id", ondelete="CASCADE"))
    book_id: Mapped[int] = mapped_column(ForeignKey("books.id", ondelete="CASCADE"))
    ord: Mapped[int] = mapped_column(Integer, default=0)
    added_at: Mapped[dt.datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())

    __table_args__ = (UniqueConstraint("course_id", "book_id", name="uq_course_book"),)

    course: Mapped[Course] = relationship(back_populates="books")
    book: Mapped[Book] = relationship()


# ---------------------------------------------------------------------------
# Clean canonical Knowledge Graph — global dedup across Library & Courses
# One Concept per meaning-in-context; recurrence = ConceptMention
# ---------------------------------------------------------------------------


class Concept(Base):
    """Canonical concept — one row per meaning-in-context, never duplicated."""

    __tablename__ = "concepts"

    id: Mapped[int] = mapped_column(primary_key=True)
    canonical_name: Mapped[str] = mapped_column(String(300))
    canonical_name_norm: Mapped[str] = mapped_column(String(300), index=True)
    canonical_description: Mapped[str] = mapped_column(Text)
    difficulty: Mapped[float] = mapped_column(Float, default=0.5)
    created_at: Mapped[dt.datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    updated_at: Mapped[dt.datetime] = mapped_column(DateTime(timezone=True), server_default=func.now(), onupdate=func.now())

    # No UniqueConstraint on norm — same term with different context yields separate rows (e.g., "normalization" DB vs ML)

    mentions: Mapped[list["ConceptMention"]] = relationship(back_populates="concept", cascade="all, delete-orphan")
    aliases: Mapped[list["ConceptAlias"]] = relationship(back_populates="concept", cascade="all, delete-orphan")


class ConceptMention(Base):
    """Provenance — one row per occurrence of a Concept in a specific book/section."""

    __tablename__ = "concept_mentions"

    id: Mapped[int] = mapped_column(primary_key=True)
    concept_id: Mapped[int] = mapped_column(ForeignKey("concepts.id", ondelete="CASCADE"), index=True)
    book_id: Mapped[int] = mapped_column(ForeignKey("books.id", ondelete="CASCADE"), index=True)
    section_id: Mapped[int] = mapped_column(ForeignKey("sections.id", ondelete="CASCADE"), index=True)
    # denormalized for fast filtering / display without joins
    section_title_snapshot: Mapped[str] = mapped_column(String(400), default="")
    snippet: Mapped[str | None] = mapped_column(Text, nullable=True)
    created_at: Mapped[dt.datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())

    __table_args__ = (UniqueConstraint("concept_id", "book_id", "section_id", name="uq_concept_mention"),)

    concept: Mapped[Concept] = relationship(back_populates="mentions")
    book: Mapped[Book] = relationship()
    section: Mapped[Section] = relationship()


class ConceptAlias(Base):
    """Synonym / surface-form alias for a canonical concept."""

    __tablename__ = "concept_aliases"

    id: Mapped[int] = mapped_column(primary_key=True)
    concept_id: Mapped[int] = mapped_column(ForeignKey("concepts.id", ondelete="CASCADE"), index=True)
    alias_term: Mapped[str] = mapped_column(String(300))
    alias_norm: Mapped[str] = mapped_column(String(300), index=True)
    source_book_id: Mapped[int | None] = mapped_column(ForeignKey("books.id", ondelete="SET NULL"), nullable=True)
    created_at: Mapped[dt.datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())

    __table_args__ = (UniqueConstraint("concept_id", "alias_norm", name="uq_concept_alias_norm"),)

    concept: Mapped[Concept] = relationship(back_populates="aliases")


class ConceptRelation(Base):
    """Typed edge between canonical concepts — the only edge table (intra + inter unified)."""

    __tablename__ = "concept_relations"

    id: Mapped[int] = mapped_column(primary_key=True)
    source_concept_id: Mapped[int] = mapped_column(ForeignKey("concepts.id", ondelete="CASCADE"), index=True)
    target_concept_id: Mapped[int] = mapped_column(ForeignKey("concepts.id", ondelete="CASCADE"), index=True)
    relationship_type: Mapped[str] = mapped_column(String(30))  # prerequisite|builds_on|related|contrasts_with|analogous
    strength: Mapped[float] = mapped_column(Float, default=0.5)
    explanation_long: Mapped[str] = mapped_column(Text, default="")
    explanation_short: Mapped[str] = mapped_column(String(500), default="")
    evidence_json: Mapped[str | None] = mapped_column(Text, nullable=True)
    created_at: Mapped[dt.datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())

    __table_args__ = (UniqueConstraint("source_concept_id", "target_concept_id", name="uq_concept_relation"),)

    source: Mapped[Concept] = relationship(foreign_keys="ConceptRelation.source_concept_id")
    target: Mapped[Concept] = relationship(foreign_keys="ConceptRelation.target_concept_id")
