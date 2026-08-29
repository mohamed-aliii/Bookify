import logging
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from .config import ensure_dirs
from .database import init_db
from .kernel_manager import kernel_manager
from .routers import books, chat, conceptmap, crossbook, export, gamification, intelligence, learning, notes, notebook, playground, progress, read, search, session, settings, study, tts, vocab

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")


@asynccontextmanager
async def lifespan(app: FastAPI):
    ensure_dirs()
    init_db()
    yield
    kernel_manager.shutdown()


app = FastAPI(title="Bookify", version="0.1.0", lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:5173", "http://127.0.0.1:5173"],
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
app.include_router(progress.router, prefix="/api")
app.include_router(read.router, prefix="/api")
app.include_router(vocab.router, prefix="/api")


@app.get("/health")
def health():
    return {"status": "ok"}
