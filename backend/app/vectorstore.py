import logging

import chromadb
from chromadb.config import Settings as ChromaSettings
from dataclasses import dataclass

from .config import ensure_dirs, settings

logger = logging.getLogger(__name__)


@dataclass
class RetrievedChunk:
    text: str
    book_id: int
    section_title: str
    page_start: int
    page_end: int
    distance: float


class VectorStore:
    def __init__(self) -> None:
        ensure_dirs()
        client = chromadb.PersistentClient(
            path=str(settings.data.chroma_dir),
            settings=ChromaSettings(anonymized_telemetry=False),
        )
        self.collection = client.get_or_create_collection("book_chunks", metadata={"hnsw:space": "cosine"})
        self.code_collection = client.get_or_create_collection("code_blocks", metadata={"hnsw:space": "cosine"})

    def add(self, texts: list[str], embeddings: list[list[float]], metadatas: list[dict]) -> None:
        if not texts:
            return
        import uuid

        ids = [uuid.uuid4().hex for _ in texts]
        self.collection.upsert(ids=ids, documents=texts, embeddings=embeddings, metadatas=metadatas)

    def delete_book(self, book_id: int) -> None:
        try:
            self.collection.delete(where={"book_id": book_id})
        except Exception:
            logger.warning("Vector cleanup failed for book %d", book_id)

    def add_code(self, texts: list[str], embeddings: list[list[float]], metadatas: list[dict]) -> None:
        if not texts:
            return
        import uuid

        ids = [uuid.uuid4().hex for _ in texts]
        self.code_collection.upsert(ids=ids, documents=texts, embeddings=embeddings, metadatas=metadatas)

    def delete_book_code(self, book_id: int) -> None:
        try:
            self.code_collection.delete(where={"book_id": book_id})
        except Exception:
            logger.warning("Code vector cleanup failed for book %d", book_id)

    def query_code(self, embedding: list[float], book_id: int, k: int) -> list[RetrievedChunk]:
        return self._parse(
            self.code_collection.query(
                query_embeddings=[embedding],
                n_results=k,
                where={"book_id": book_id},
                include=["documents", "metadatas", "distances"],
            )
        )

    def query(self, embedding: list[float], book_id: int, k: int) -> list[RetrievedChunk]:
        return self._parse(
            self.collection.query(
                query_embeddings=[embedding],
                n_results=k,
                where={"book_id": book_id},
                include=["documents", "metadatas", "distances"],
            )
        )

    def query_all(self, embedding: list[float], k: int) -> list[RetrievedChunk]:
        """Similarity search across every indexed book."""
        return self._parse(
            self.collection.query(
                query_embeddings=[embedding],
                n_results=k,
                include=["documents", "metadatas", "distances"],
            )
        )

    @staticmethod
    def _parse(result: dict) -> list[RetrievedChunk]:
        docs = (result.get("documents") or [[]])[0]
        metas = (result.get("metadatas") or [[]])[0]
        dists = (result.get("distances") or [[]])[0]
        chunks: list[RetrievedChunk] = []
        for doc, meta, dist in zip(docs, metas, dists):
            chunks.append(
                RetrievedChunk(
                    text=doc,
                    book_id=int(meta["book_id"]),
                    section_title=str(meta.get("section_title", "")),
                    page_start=int(meta.get("page_start", 0)),
                    page_end=int(meta.get("page_end", 0)),
                    distance=float(dist),
                )
            )
        return chunks


_store: VectorStore | None = None


def get_vector_store() -> VectorStore:
    global _store
    if _store is None:
        _store = VectorStore()
    return _store
