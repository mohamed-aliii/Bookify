from pathlib import Path

import pymupdf as fitz

from app.chunker import make_chunks
from app.parser import parse_pdf
from app.config import settings


def _sample_pdf(tmp_path: Path, with_toc: bool) -> Path:
    path = tmp_path / ("sample_toc.pdf" if with_toc else "sample_notoc.pdf")
    doc = fitz.open()
    page = doc.new_page()
    page.insert_text((72, 90), "Chapter One: Vectors", fontsize=22, fontname="helv")
    body = ("Vectors describe magnitude and direction. " * 30).strip()
    page.insert_text((72, 130), body, fontsize=11, fontname="helv")
    page.insert_text((72, 420), "import numpy as np", fontsize=11, fontname="cour")
    page.insert_text((72, 440), "v = np.array([1, 2, 3])", fontsize=11, fontname="cour")
    page_two = doc.new_page()
    page_two.insert_text((72, 90), "Chapter Two: Matrices", fontsize=22, fontname="helv")
    page_two.insert_text((72, 130), "Matrices transform vector spaces.", fontsize=11, fontname="helv")
    if with_toc:
        doc.set_toc([[1, "Chapter One: Vectors", 1], [1, "Chapter Two: Matrices", 2]])
    doc.save(str(path))
    doc.close()
    return path


def test_parse_detects_structure(tmp_path):
    parsed = parse_pdf(_sample_pdf(tmp_path, with_toc=True))
    assert parsed.num_pages == 2
    assert parsed.toc[0][1] == "Chapter One: Vectors"
    kinds = {b.kind for b in parsed.blocks}
    assert "heading" in kinds
    assert "code" in kinds
    assert any("magnitude" in b.text for b in parsed.blocks)


def test_chunks_respect_sections_and_keep_code(tmp_path):
    parsed = parse_pdf(_sample_pdf(tmp_path, with_toc=True))
    sections, chunks = make_chunks(parsed)
    assert [s.title for s in sections] == ["Chapter One: Vectors", "Chapter Two: Matrices"]
    assert chunks
    assert all(c.page_start >= 1 for c in chunks)
    assert any("np.array" in c.text for c in chunks)
    limit = settings.ingestion.chunk_chars + settings.ingestion.chunk_overlap
    assert all(len(c.text) <= limit + 50 for c in chunks)


def test_fallback_headings_without_toc(tmp_path):
    path = _sample_pdf(tmp_path, with_toc=False)
    parsed = parse_pdf(path)
    assert parsed.toc == []
    sections, chunks = make_chunks(parsed)
    assert sections[0].title == "Chapter One: Vectors"
    assert any(c.section_title == "Chapter Two: Matrices" for c in chunks)
