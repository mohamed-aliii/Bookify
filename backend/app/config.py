import os
import tomllib
from dataclasses import dataclass
from pathlib import Path

from dotenv import load_dotenv

ROOT_DIR = Path(__file__).resolve().parents[2]
BACKEND_DIR = ROOT_DIR / "backend"
PROMPTS_DIR = BACKEND_DIR / "prompts"

load_dotenv(ROOT_DIR / ".env", override=True)


@dataclass
class LLMConfig:
    model: str = "openai/gpt-4o-mini"
    api_key_env: str = "OPENROUTER_API_KEY"
    temperature: float | None = None
    max_history_messages: int = 10
    extra_body: dict | None = None


@dataclass
class EmbeddingsConfig:
    provider: str = "litellm"
    model: str = "openai/text-embedding-3-small"
    local_model: str = "all-MiniLM-L6-v2"
    batch_size: int = 32


@dataclass
class IngestionConfig:
    chunk_chars: int = 1400
    chunk_overlap: int = 200
    top_k: int = 6
    min_heading_ratio: float = 1.15
    max_toc_level: int = 2
    front_matter_blacklist: tuple[str, ...] = (
        "front matter", "title page", "half title", "copyright", "table of contents",
        "contents", "dedication", "epigraph", "disclaimer", "preface", "foreword",
        "introduction", "about the author", "about this book", "acknowledgments",
        "acknowledgement", "prologue", "list of figures", "list of tables",
        "list of illustrations", "publisher", "notation", "glossary",
    )


@dataclass
class ChatConfig:
    web_fallback_distance: float = 0.6
    web_max_results: int = 4


@dataclass
class WebSearchConfig:
    provider: str = "tavily"
    tavily_api_key: str = ""
    search_depth: str = "basic"
    max_results: int = 5
    query_expansion: bool = True
    relevance_filter: bool = True


@dataclass
class DataConfig:
    db_path: Path
    chroma_dir: Path
    uploads_dir: Path


@dataclass
class Settings:
    llm: LLMConfig
    embeddings: EmbeddingsConfig
    ingestion: IngestionConfig
    chat: ChatConfig
    web_search: WebSearchConfig
    data: DataConfig


def _abs_path(value: str | Path) -> Path:
    path = Path(value)
    return path if path.is_absolute() else ROOT_DIR / path


def _read_config(path: Path) -> dict:
    if not path.exists():
        return {}
    with path.open("rb") as fh:
        return tomllib.load(fh)


def load_settings(path: Path | None = None) -> Settings:
    raw = _read_config(path or ROOT_DIR / "config.toml")
    data_root = ROOT_DIR / "data"
    data_raw = raw.get("data", {})
    data_cfg = DataConfig(
        db_path=_abs_path(data_raw.get("db_path", data_root / "bookify.db")),
        chroma_dir=_abs_path(data_raw.get("chroma_dir", data_root / "chroma")),
        uploads_dir=_abs_path(data_raw.get("uploads_dir", data_root / "uploads")),
    )
    ws_raw = raw.get("web_search", {})
    ws_cfg = WebSearchConfig(
        provider=ws_raw.get("provider", "tavily"),
        tavily_api_key=ws_raw.get("tavily_api_key", ""),
        search_depth=ws_raw.get("search_depth", "basic"),
        max_results=ws_raw.get("max_results", 5),
        query_expansion=ws_raw.get("query_expansion", True),
        relevance_filter=ws_raw.get("relevance_filter", True),
    )
    # Tavily API key: config.toml > .env > empty
    if not ws_cfg.tavily_api_key:
        ws_cfg.tavily_api_key = os.environ.get("TAVILY_API_KEY", "")
    return Settings(
        llm=LLMConfig(**{k: v for k, v in raw.get("llm", {}).items() if k in LLMConfig.__annotations__}),
        embeddings=EmbeddingsConfig(**{k: v for k, v in raw.get("embeddings", {}).items() if k in EmbeddingsConfig.__annotations__}),
        ingestion=IngestionConfig(**{k: v for k, v in raw.get("ingestion", {}).items() if k in IngestionConfig.__annotations__}),
        chat=ChatConfig(**{k: v for k, v in raw.get("chat", {}).items() if k in ChatConfig.__annotations__}),
        web_search=ws_cfg,
        data=data_cfg,
    )


settings = load_settings()


def ensure_dirs() -> None:
    settings.data.db_path.parent.mkdir(parents=True, exist_ok=True)
    settings.data.chroma_dir.mkdir(parents=True, exist_ok=True)
    settings.data.uploads_dir.mkdir(parents=True, exist_ok=True)
    PROMPTS_DIR.mkdir(parents=True, exist_ok=True)
