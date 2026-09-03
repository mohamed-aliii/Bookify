import logging
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from .config import ensure_dirs
from .database import init_db
from .kernel_manager import kernel_manager
from .routers import books, chat, conceptmap, courses, crossbook, export, gamification, intelligence, learning, notes, notebook, playground, progress, read, search, session, settings, study, tts, vocab

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")


@asynccontextmanager
async def lifespan(app: FastAPI):
    ensure_dirs()
    init_db()
    # Auto-upgrade existing books to L2+L3 (user requested) – reindex those that have no L3 yet
    try:
        import threading

        from sqlalchemy import select

        from .database import SessionLocal
        from .models import Book, Section

        def _auto_upgrade() -> None:
            try:
                from .ingest import ingest_book
                from .routers.books import reindex_book
                from fastapi import BackgroundTasks

                with SessionLocal() as db:
                    from .models import CourseBook
                    candidates = list(db.scalars(select(Book).where(Book.ingestion_max_level == 3, Book.status == "ready")))
                    # Exclude books that belong to a course (courses use L1+L2 only)
                    course_book_ids = set(db.scalars(select(CourseBook.book_id)).all())
                    to_reindex: list[int] = []
                    for b in candidates:
                        if b.id in course_book_ids:
                            continue
                        has_l3 = db.scalar(select(Section).where(Section.book_id == b.id, Section.level == 3).limit(1))
                        if has_l3 is None:
                            has_l2 = db.scalar(select(Section).where(Section.book_id == b.id, Section.level == 2).limit(1))
                            if has_l2 is not None:
                                to_reindex.append(b.id)
                    if not to_reindex:
                        return
                    logging.info("Auto-upgrading %d book(s) to L2+L3: %s", len(to_reindex), to_reindex)
                    for bid in to_reindex:
                        try:
                            # Use a fresh DB session per book to avoid cross-contamination
                            with SessionLocal() as rdb:
                                bt = BackgroundTasks()
                                # reindex_book will stash, delete, set pending and schedule ingest via bt
                                # We call it directly; then run the background tasks synchronously
                                try:
                                    reindex_book(bid, bt, rdb)
                                except Exception as e:
                                    logging.warning("Auto-reindex failed for book %s: %s", bid, e)
                                    continue
                                # Run the scheduled ingest tasks sequentially (BackgroundTasks holds them)
                                for task in getattr(bt, "tasks", []):
                                    try:
                                        # task is Starlette BackgroundTask with func/args/kwargs
                                        func = getattr(task, "func", None)
                                        args = getattr(task, "args", ())
                                        kwargs = getattr(task, "kwargs", {})
                                        if func:
                                            func(*args, **kwargs)
                                        else:
                                            # Fallback: BackgroundTasks is just a list of callables in some Starlette versions
                                            task()
                                    except Exception as e:
                                        logging.warning("Auto-ingest failed for book %s: %s", bid, e)
                        except Exception as e:
                            logging.warning("Auto-upgrade loop error for %s: %s", bid, e)
            except Exception as e:
                logging.warning("Auto-upgrade check failed: %s", e)

        threading.Thread(target=_auto_upgrade, daemon=True).start()
    except Exception as e:
        logging.warning("Failed to start auto-upgrade thread: %s", e)
    yield
    kernel_manager.shutdown()


app = FastAPI(title="Bookify", version="0.1.0", lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        "http://localhost:5173",
        "http://127.0.0.1:5173",
        "http://localhost:5174",
        "http://127.0.0.1:5174",
    ],
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(books.router, prefix="/api")
app.include_router(chat.router, prefix="/api")
app.include_router(study.router, prefix="/api")
app.include_router(notes.router, prefix="/api")
app.include_router(search.router, prefix="/api")
app.include_router(export.router, prefix="/api")
app.include_router(settings.router, prefix="/api")
app.include_router(learning.router, prefix="/api")
app.include_router(intelligence.router, prefix="/api")
app.include_router(session.router, prefix="/api")
app.include_router(tts.router, prefix="/api")
app.include_router(conceptmap.router, prefix="/api")
app.include_router(playground.router, prefix="/api")
app.include_router(notebook.router, prefix="")
app.include_router(gamification.router, prefix="/api")
app.include_router(crossbook.router, prefix="/api")
app.include_router(courses.router, prefix="/api")
app.include_router(progress.router, prefix="/api")
app.include_router(read.router, prefix="/api")
app.include_router(vocab.router, prefix="/api")


@app.get("/health")
def health():
    return {"status": "ok"}
