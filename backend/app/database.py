from sqlalchemy import create_engine, event
from sqlalchemy.orm import DeclarativeBase, sessionmaker

from .config import ensure_dirs, settings

ensure_dirs()

engine = create_engine(
    f"sqlite:///{settings.data.db_path.as_posix()}",
    connect_args={"check_same_thread": False},
)


@event.listens_for(engine, "connect")
def _set_sqlite_pragma(dbapi_connection, connection_record):
    cursor = dbapi_connection.cursor()
    cursor.execute("PRAGMA journal_mode=WAL")
    cursor.execute("PRAGMA busy_timeout=60000")
    cursor.execute("PRAGMA foreign_keys=ON")
    cursor.close()


SessionLocal = sessionmaker(bind=engine, autoflush=False, expire_on_commit=False)


class Base(DeclarativeBase):
    pass


def _backup_db() -> None:
    import shutil
    import sqlite3
    import time

    db_path = settings.data.db_path
    if not db_path.exists():
        return
    backup_dir = db_path.parent
    backups = sorted(backup_dir.glob(f"{db_path.name}.bak-*"))
    while len(backups) >= 5:
        backups.pop(0).unlink(missing_ok=True)
    stamp = time.strftime("%Y%m%d-%H%M%S")
    target = backup_dir / f"{db_path.name}.bak-{stamp}"
    src = sqlite3.connect(str(db_path))
    dst = sqlite3.connect(str(target))
    try:
        src.backup(dst)
    finally:
        dst.close()
        src.close()


def init_db() -> None:
    from sqlalchemy import text

    from . import models

    Base.metadata.create_all(engine)

    with engine.begin() as conn:
        columns = {row[1] for row in conn.execute(text("PRAGMA table_info(sections)"))}
        if "parent_id" not in columns:
            conn.execute(text("ALTER TABLE sections ADD COLUMN parent_id INTEGER REFERENCES sections(id)"))

        fcolumns = {row[1] for row in conn.execute(text("PRAGMA table_info(flashcards)"))}
        if "ease" not in fcolumns:
            conn.execute(text("ALTER TABLE flashcards ADD COLUMN ease FLOAT NOT NULL DEFAULT 2.5"))
            conn.execute(text("ALTER TABLE flashcards ADD COLUMN interval_days INTEGER NOT NULL DEFAULT 0"))
            conn.execute(text("ALTER TABLE flashcards ADD COLUMN due_at DATETIME"))
            conn.execute(text("UPDATE flashcards SET due_at = CURRENT_TIMESTAMP WHERE due_at IS NULL"))
            conn.execute(text("ALTER TABLE flashcards ADD COLUMN reps INTEGER NOT NULL DEFAULT 0"))
            conn.execute(text("ALTER TABLE flashcards ADD COLUMN lapses INTEGER NOT NULL DEFAULT 0"))

        scolumns = {row[1] for row in conn.execute(text("PRAGMA table_info(chat_sessions)"))}
        if "section_id" not in scolumns:
            conn.execute(text("ALTER TABLE chat_sessions ADD COLUMN section_id INTEGER REFERENCES sections(id)"))

        mcolumns = {row[1] for row in conn.execute(text("PRAGMA table_info(messages)"))}
        if "action" not in mcolumns:
            conn.execute(text("ALTER TABLE messages ADD COLUMN action VARCHAR(30)"))

        bcolumns = {row[1] for row in conn.execute(text("PRAGMA table_info(books)"))}
        if "cover_path" not in bcolumns:
            conn.execute(text("ALTER TABLE books ADD COLUMN cover_path VARCHAR(600)"))
        if "content_start_section_id" not in bcolumns:
            conn.execute(text("ALTER TABLE books ADD COLUMN content_start_section_id INTEGER REFERENCES sections(id)"))
        if "content_start_page" not in bcolumns:
            conn.execute(text("ALTER TABLE books ADD COLUMN content_start_page INTEGER"))
        if "content_start_confirmed" not in bcolumns:
            conn.execute(text("ALTER TABLE books ADD COLUMN content_start_confirmed BOOLEAN NOT NULL DEFAULT 0"))
            # Backfill existing ready books as confirmed so they don't block.
            conn.execute(text("UPDATE books SET content_start_confirmed = 1 WHERE status = 'ready'"))
        if "ingestion_max_level" not in bcolumns:
            conn.execute(text("ALTER TABLE books ADD COLUMN ingestion_max_level INTEGER NOT NULL DEFAULT 3"))
        else:
            # Auto-upgrade existing L2 books to L2+L3 on next restart (user request)
            # Only upgrade books that are ready and were at default 2
            conn.execute(text("UPDATE books SET ingestion_max_level=3 WHERE ingestion_max_level=2"))
        if "content_type" not in bcolumns:
            conn.execute(text("ALTER TABLE books ADD COLUMN content_type VARCHAR(20) NOT NULL DEFAULT 'book'"))
            conn.execute(text("UPDATE books SET content_type='book' WHERE content_type IS NULL OR content_type=''"))

        ncolumns = {row[1] for row in conn.execute(text("PRAGMA table_info(notebook_cells)"))}
        if "cell_type" not in ncolumns:
            conn.execute(text("ALTER TABLE notebook_cells ADD COLUMN cell_type VARCHAR(10) NOT NULL DEFAULT 'code'"))
            conn.execute(text("ALTER TABLE notebook_cells ADD COLUMN execution_count INTEGER NOT NULL DEFAULT 0"))
            conn.execute(text("ALTER TABLE notebook_cells ADD COLUMN elapsed_ms INTEGER NOT NULL DEFAULT 0"))
            conn.execute(text("ALTER TABLE notebook_cells ADD COLUMN last_executed_at DATETIME"))
            conn.execute(text("ALTER TABLE notebook_cells ADD COLUMN images TEXT"))
            conn.execute(text("ALTER TABLE notebook_cells ADD COLUMN variables TEXT"))

        nbcolumns = {row[1] for row in conn.execute(text("PRAGMA table_info(notebooks)"))}
        if "section_id" not in nbcolumns:
            conn.execute(text("ALTER TABLE notebooks ADD COLUMN section_id INTEGER REFERENCES sections(id)"))

        ccolumns = {row[1] for row in conn.execute(text("PRAGMA table_info(chunks)"))}
        if "is_code" not in ccolumns:
            conn.execute(text("ALTER TABLE chunks ADD COLUMN is_code BOOLEAN NOT NULL DEFAULT 0"))

        ec_columns = {row[1] for row in conn.execute(text("PRAGMA table_info(concept_edges)"))}
        if "explanation" not in ec_columns:
            conn.execute(text("ALTER TABLE concept_edges ADD COLUMN explanation TEXT NOT NULL DEFAULT ''"))

    _drop_notebooks_book_id_unique()

    _backup_db()


def _drop_notebooks_book_id_unique() -> None:
    """SQLite can't ALTER a UNIQUE constraint, so rebuild `notebooks` to allow
    more than one notebook per book (section notebooks share book_id)."""
    import sqlite3

    db_path = settings.data.db_path
    if not db_path.exists():
        return
    conn = sqlite3.connect(str(db_path))
    try:
        conn.execute("PRAGMA foreign_keys=OFF")
        indexes = conn.execute("PRAGMA index_list('notebooks')").fetchall()
        has_book_id_unique = any(r[2] for r in indexes)
        if not has_book_id_unique:
            return
        conn.execute("BEGIN")
        conn.execute(
            """
            CREATE TABLE notebooks_new (
                id INTEGER NOT NULL PRIMARY KEY,
                book_id INTEGER NOT NULL REFERENCES books(id),
                section_id INTEGER REFERENCES sections(id),
                title VARCHAR(400) NOT NULL,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP NOT NULL
            )
            """
        )
        conn.execute(
            "INSERT INTO notebooks_new (id, book_id, section_id, title, created_at) "
            "SELECT id, book_id, section_id, title, created_at FROM notebooks"
        )
        conn.execute("DROP TABLE notebooks")
        conn.execute("ALTER TABLE notebooks_new RENAME TO notebooks")
        conn.execute("COMMIT")
        conn.execute("PRAGMA foreign_keys=ON")
    finally:
        conn.close()


def get_db():
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()
