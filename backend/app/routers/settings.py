import os
import tomllib
from pathlib import Path

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from ..config import ROOT_DIR, settings

router = APIRouter(prefix="/settings", tags=["settings"])

CONFIG_PATH = ROOT_DIR / "config.toml"
ENV_PATH = ROOT_DIR / ".env"


def _mask_key(key: str) -> str:
    if not key or len(key) < 8:
        return ""
    return key[:4] + "…" + key[-4:]


def _read_config() -> dict:
    if not CONFIG_PATH.exists():
        return {}
    with CONFIG_PATH.open("rb") as fh:
        return tomllib.load(fh)


def _read_env() -> dict[str, str]:
    env: dict[str, str] = {}
    if not ENV_PATH.exists():
        return env
    for line in ENV_PATH.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        if "=" in line:
            k, v = line.split("=", 1)
            env[k.strip()] = v.strip()
    return env


def _write_env(env: dict[str, str]) -> None:
    lines = [f"{k}={v}" for k, v in env.items()]
    ENV_PATH.write_text("\n".join(lines) + "\n", encoding="utf-8")


def _write_config(raw: dict) -> None:
    lines: list[str] = []

    def _dump(d: dict, prefix: str = "") -> None:
        for k, v in d.items():
            if isinstance(v, dict):
                lines.append(f"\n[{prefix}{k}]" if not prefix else f"\n[{prefix}.{k}]")
                _dump(v, f"{prefix}{k}." if prefix else f"{k}.")
            elif isinstance(v, bool):
                lines.append(f"{k} = {'true' if v else 'false'}")
            elif isinstance(v, str):
                lines.append(f'{k} = "{v}"')
            elif isinstance(v, (int, float)):
                lines.append(f"{k} = {v}")
            elif v is None:
                lines.append(f'{k} = ""')

    first = True
    for section_key, section_val in raw.items():
        if not isinstance(section_val, dict):
            continue
        if not first:
            lines.append("")
        first = False
        lines.append(f"[{section_key}]")
        for k, v in section_val.items():
            if isinstance(v, bool):
                lines.append(f"{k} = {'true' if v else 'false'}")
            elif isinstance(v, str):
                lines.append(f'{k} = "{v}"')
            elif isinstance(v, (int, float)):
                lines.append(f"{k} = {v}")

    CONFIG_PATH.write_text("\n".join(lines) + "\n", encoding="utf-8")


class SettingsOut(BaseModel):
    llm_model: str
    llm_temperature: float | None
    llm_max_history: int
    reasoning_enabled: bool
    embedding_provider: str
    embedding_model: str
    chunk_chars: int
    chunk_overlap: int
    top_k: int
    min_heading_ratio: float
    max_toc_level: int
    web_fallback_distance: float
    web_search_provider: str
    tavily_api_key_masked: str
    tavily_search_depth: str
    web_max_results: int
    web_query_expansion: bool
    web_relevance_filter: bool
    openrouter_api_key_masked: str


class SettingsUpdate(BaseModel):
    llm_model: str | None = None
    llm_temperature: float | None = None
    llm_max_history: int | None = None
    reasoning_enabled: bool | None = None
    embedding_provider: str | None = None
    embedding_model: str | None = None
    chunk_chars: int | None = None
    chunk_overlap: int | None = None
    top_k: int | None = None
    min_heading_ratio: float | None = None
    max_toc_level: int | None = None
    web_fallback_distance: float | None = None
    web_search_provider: str | None = None
    tavily_api_key: str | None = None
    tavily_search_depth: str | None = None
    web_max_results: int | None = None
    web_query_expansion: bool | None = None
    web_relevance_filter: bool | None = None
    openrouter_api_key: str | None = None


@router.get("", response_model=SettingsOut)
def get_settings():
    raw = _read_config()
    env = _read_env()
    llm = raw.get("llm", {})
    emb = raw.get("embeddings", {})
    ing = raw.get("ingestion", {})
    chat = raw.get("chat", {})
    ws = raw.get("web_search", {})

    extra_body = llm.get("extra_body", {})
    reasoning = extra_body.get("reasoning", {}) if isinstance(extra_body, dict) else {}

    tavily_key = ws.get("tavily_api_key", "") or env.get("TAVILY_API_KEY", "")
    or_key = env.get("OPENROUTER_API_KEY", "")

    return SettingsOut(
        llm_model=llm.get("model", settings.llm.model),
        llm_temperature=llm.get("temperature", settings.llm.temperature),
        llm_max_history=llm.get("max_history_messages", settings.llm.max_history_messages),
        reasoning_enabled=bool(reasoning.get("enabled", False)),
        embedding_provider=emb.get("provider", settings.embeddings.provider),
        embedding_model=emb.get("model", settings.embeddings.model),
        chunk_chars=ing.get("chunk_chars", settings.ingestion.chunk_chars),
        chunk_overlap=ing.get("chunk_overlap", settings.ingestion.chunk_overlap),
        top_k=ing.get("top_k", settings.ingestion.top_k),
        min_heading_ratio=ing.get("min_heading_ratio", settings.ingestion.min_heading_ratio),
        max_toc_level=ing.get("max_toc_level", settings.ingestion.max_toc_level),
        web_fallback_distance=chat.get("web_fallback_distance", settings.chat.web_fallback_distance),
        web_search_provider=ws.get("provider", "tavily"),
        tavily_api_key_masked=_mask_key(tavily_key),
        tavily_search_depth=ws.get("search_depth", "basic"),
        web_max_results=ws.get("max_results", 5),
        web_query_expansion=ws.get("query_expansion", True),
        web_relevance_filter=ws.get("relevance_filter", True),
        openrouter_api_key_masked=_mask_key(or_key),
    )


@router.put("", response_model=SettingsOut)
def update_settings(body: SettingsUpdate):
    raw = _read_config()
    env = _read_env()

    llm = raw.setdefault("llm", {})
    emb = raw.setdefault("embeddings", {})
    ing = raw.setdefault("ingestion", {})
    chat = raw.setdefault("chat", {})
    ws = raw.setdefault("web_search", {})

    if body.llm_model is not None:
        llm["model"] = body.llm_model
    if body.llm_temperature is not None:
        llm["temperature"] = body.llm_temperature
    if body.llm_max_history is not None:
        llm["max_history_messages"] = body.llm_max_history
    if body.reasoning_enabled is not None:
        extra_body = llm.setdefault("extra_body", {})
        extra_body["reasoning"] = {"enabled": body.reasoning_enabled}

    if body.embedding_provider is not None:
        emb["provider"] = body.embedding_provider
    if body.embedding_model is not None:
        emb["model"] = body.embedding_model

    if body.chunk_chars is not None:
        ing["chunk_chars"] = body.chunk_chars
    if body.chunk_overlap is not None:
        ing["chunk_overlap"] = body.chunk_overlap
    if body.top_k is not None:
        ing["top_k"] = body.top_k
    if body.min_heading_ratio is not None:
        ing["min_heading_ratio"] = body.min_heading_ratio
    if body.max_toc_level is not None:
        ing["max_toc_level"] = body.max_toc_level

    if body.web_fallback_distance is not None:
        chat["web_fallback_distance"] = body.web_fallback_distance
    if body.web_search_provider is not None:
        ws["provider"] = body.web_search_provider
    if body.tavily_api_key is not None:
        ws["tavily_api_key"] = body.tavily_api_key
    if body.tavily_search_depth is not None:
        ws["search_depth"] = body.tavily_search_depth
    if body.web_max_results is not None:
        ws["max_results"] = body.web_max_results
    if body.web_query_expansion is not None:
        ws["query_expansion"] = body.web_query_expansion
    if body.web_relevance_filter is not None:
        ws["relevance_filter"] = body.web_relevance_filter

    if body.openrouter_api_key is not None:
        env["OPENROUTER_API_KEY"] = body.openrouter_api_key

    _write_config(raw)
    _write_env(env)

    # Reload settings in-memory
    from ..config import load_settings
    import app.config as config_mod
    config_mod.settings = load_settings()

    return get_settings()
