import json
import logging
import os
from abc import ABC, abstractmethod
from dataclasses import dataclass

from .config import PROMPTS_DIR, settings

logger = logging.getLogger(__name__)


@dataclass
class WebResult:
    title: str
    url: str
    snippet: str
    content: str = ""
    score: float = 0.0


class WebSearchProvider(ABC):
    @abstractmethod
    def search(self, query: str, max_results: int) -> list[WebResult]:
        ...


class TavilySearch(WebSearchProvider):
    def search(self, query: str, max_results: int) -> list[WebResult]:
        api_key = settings.web_search.tavily_api_key or os.environ.get("TAVILY_API_KEY", "")
        if not api_key:
            logger.warning("Tavily API key not configured — falling back")
            return []
        try:
            from tavily import TavilyClient

            client = TavilyClient(api_key=api_key)
            response = client.search(
                query,
                max_results=max_results,
                search_depth=settings.web_search.search_depth,
                include_raw_content=False,
            )
            results: list[WebResult] = []
            for item in response.get("results", []):
                results.append(
                    WebResult(
                        title=str(item.get("title", ""))[:200],
                        url=str(item.get("url", "")),
                        snippet=str(item.get("content", ""))[:600],
                        content=str(item.get("content", ""))[:2000],
                        score=float(item.get("score", 0)),
                    )
                )
            return results
        except Exception as exc:
            logger.warning("Tavily search failed for %r: %s", query, exc)
            return []


class DuckDuckGoSearch(WebSearchProvider):
    def search(self, query: str, max_results: int) -> list[WebResult]:
        try:
            from ddgs import DDGS

            with DDGS() as ddgs:
                raw = list(ddgs.text(query, max_results=max_results))
            return [
                WebResult(
                    title=str(item.get("title", ""))[:200],
                    url=str(item.get("href", "")),
                    snippet=str(item.get("body", ""))[:600],
                )
                for item in raw
                if item.get("href") and item.get("body")
            ]
        except Exception as exc:
            logger.warning("DuckDuckGo search failed for %r: %s", query, exc)
            return []


_PROVIDERS: dict[str, type[WebSearchProvider]] = {
    "tavily": TavilySearch,
    "duckduckgo": DuckDuckGoSearch,
}


def _get_provider() -> WebSearchProvider:
    name = settings.web_search.provider.lower()
    cls = _PROVIDERS.get(name)
    if cls is None:
        logger.warning("Unknown web search provider %r, falling back to DuckDuckGo", name)
        return DuckDuckGoSearch()
    return cls()


def _llm_complete(prompt: str) -> str:
    from .llm import llm_client
    return llm_client.complete(
        [{"role": "user", "content": prompt}]
    )


def decompose_query(query: str) -> list[str]:
    prompt = (PROMPTS_DIR / "query_decompose.txt").read_text(encoding="utf-8") + f"\n\nQuestion: {query}"
    try:
        raw = _llm_complete(prompt)
    except Exception as exc:
        logger.warning("Query decomposition failed: %s", exc)
        return []
    variants: list[str] = []
    for line in raw.splitlines():
        clean = line.strip().strip("-•").strip()
        if 2 <= len(clean) <= 140:
            variants.append(clean)
    return variants[:3]


def score_relevance(query: str, result: WebResult) -> float:
    prompt = (PROMPTS_DIR / "relevance_score.txt").read_text(encoding="utf-8")
    prompt += f"\n\nQuestion: {query}\n\nSearch result title: {result.title}\nSearch result snippet: {result.snippet[:400]}"
    try:
        raw = _llm_complete(prompt)
        data = json.loads(raw.strip().removeprefix("```json").removeprefix("```").removesuffix("```").strip())
        return float(data.get("relevance", 0.5))
    except Exception:
        return 0.5


def search_web(query: str, max_results: int | None = None) -> list[WebResult]:
    provider = _get_provider()
    k = max_results or settings.web_search.max_results

    seen_urls: set[str] = set()
    all_hits: list[WebResult] = []

    for q in [query] + (decompose_query(query) if settings.web_search.query_expansion else []):
        hits = provider.search(q, k)
        for h in hits:
            if h.url and h.url not in seen_urls:
                seen_urls.add(h.url)
                all_hits.append(h)
        if len(all_hits) >= k * 2:
            break

    if settings.web_search.relevance_filter and all_hits:
        scored: list[WebResult] = []
        for h in all_hits[:k * 2]:
            h.score = score_relevance(query, h)
            if h.score >= 0.3:
                scored.append(h)
        scored.sort(key=lambda x: x.score, reverse=True)
        all_hits = scored

    return all_hits[:k]
