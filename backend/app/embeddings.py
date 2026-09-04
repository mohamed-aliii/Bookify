import logging
from collections.abc import Iterator

from .config import settings
from .openrouter_rotation import get_keys_in_rotation_order, is_rate_limit_error

logger = logging.getLogger(__name__)


class EmbeddingClient:
    def __init__(self) -> None:
        self._local_model = None
        self._chroma_ef = None

    def embed_texts(self, texts: list[str]) -> list[list[float]]:
        cleaned = [t if t.strip() else " " for t in texts]
        provider = settings.embeddings.provider
        if provider == "sentence_transformers":
            return self._embed_local(cleaned)
        if provider == "chroma_default":
            return self._embed_chroma(cleaned)
        return self._embed_api(cleaned)

    def embed_query(self, text: str) -> list[float]:
        return self.embed_texts([text])[0]

    def embed_batches(self, texts: list[str]) -> Iterator[tuple[int, list[list[float]]]]:
        size = max(settings.embeddings.batch_size, 1)
        for start in range(0, len(texts), size):
            batch = texts[start : start + size]
            yield start, self.embed_texts(batch)

    def _embed_api(self, texts: list[str]) -> list[list[float]]:
        import litellm

        keys = get_keys_in_rotation_order()
        # If no rotation keys, try once with default env
        if not keys:
            response = litellm.embedding(model=settings.embeddings.model, input=texts, timeout=60)
            return [item["embedding"] for item in response.data]

        last_exc: Exception | None = None
        for attempt, key in enumerate(keys):
            try:
                response = litellm.embedding(model=settings.embeddings.model, input=texts, timeout=60, api_key=key)
                return [item["embedding"] for item in response.data]
            except Exception as exc:
                last_exc = exc
                if is_rate_limit_error(exc) and attempt < len(keys) - 1:
                    logger.warning("Embedding rate-limited on key %d/%d — rotating", attempt + 1, len(keys))
                    continue
                raise
        if last_exc:
            raise last_exc
        return []

    def _embed_local(self, texts: list[str]) -> list[list[float]]:
        if self._local_model is None:
            from sentence_transformers import SentenceTransformer

            self._local_model = SentenceTransformer(settings.embeddings.local_model)
        return self._local_model.encode(texts, normalize_embeddings=True).tolist()

    def _embed_chroma(self, texts: list[str]) -> list[list[float]]:
        if self._chroma_ef is None:
            from chromadb.utils.embedding_functions import ONNXMiniLM_L6_V2

            self._chroma_ef = ONNXMiniLM_L6_V2()
        vectors = self._chroma_ef(texts)
        return [
            v.tolist() if hasattr(v, "tolist") else [float(x) for x in v] for v in vectors
        ]


embedding_client = EmbeddingClient()
