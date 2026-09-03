import re

from dataclasses import dataclass
from pathlib import Path

import pymupdf as fitz

CODE_FONT_HINTS = ("mono", "courier", "consolas", "menlo", "cmtt", "dejavusansmono")
HEADING_MAX_CHARS = 200


@dataclass
class PageBlock:
    page: int
    text: str
    kind: str
    size: float


@dataclass
class ParsedBook:
    title: str
    num_pages: int
    toc: list[tuple[int, str, int]]
    blocks: list[PageBlock]


def _clean_candidate(value: str) -> str:
    value = value.strip().strip("{}[]()\"'").strip()
    value = re.sub(r"[_\-.]+", " ", value)
    return re.sub(r"\s+", " ", value).strip()


def is_hashlike_title(value: str | None) -> bool:
    compact = re.sub(r"[{}\-\s]", "", value or "")
    return len(compact) >= 24 and re.fullmatch(r"[0-9a-fA-F]+", compact) is not None


def _usable_title(value: str) -> bool:
    return 3 < len(value) < 150


def _is_code_font(fonts: set[str]) -> bool:
    joined = " ".join(fonts).lower()
    return any(hint in joined for hint in CODE_FONT_HINTS)


def extract_blocks_and_body_size(
    doc,
    min_heading_ratio: float = 1.15,
) -> tuple[list[PageBlock], float]:
    raw_blocks: list[tuple[int, str, set[str], list[float]]] = []
    font_weights: dict[float, float] = {}
    flags = fitz.TEXTFLAGS_TEXT

    for pno, page in enumerate(doc, start=1):
        d = page.get_text("dict", flags=flags)
        for block in d.get("blocks", []):
            if block.get("type") != 0:
                continue
            text_lines: list[str] = []
            fonts: set[str] = set()
            sizes: list[float] = []
            for line in block.get("lines", []):
                line_text = "".join(span.get("text", "") for span in line.get("spans", [])).strip()
                if not line_text:
                    continue
                text_lines.append(line_text)
                for span in line.get("spans", []):
                    fonts.add(span.get("font", ""))
                    sz = round(span.get("size", 11.0), 1)
                    sizes.append(sz)
                    font_weights[sz] = font_weights.get(sz, 0.0) + max(len(span.get("text", "").strip()), 1)
            text = "\n".join(text_lines).strip()
            if not text:
                continue
            if len(text) <= 5 and text.replace(".", "").isdigit():
                continue
            raw_blocks.append((pno, text, fonts, sizes))

    body_size = max(font_weights.items(), key=lambda kv: kv[1])[0] if font_weights else 11.0

    blocks_out: list[PageBlock] = []
    for pno, text, fonts, sizes in raw_blocks:
        dom_size = max(set(sizes), key=sizes.count) if sizes else body_size
        if _is_code_font(fonts):
            kind = "code"
        elif dom_size >= body_size * min_heading_ratio and len(text) <= HEADING_MAX_CHARS:
            kind = "heading"
        else:
            kind = "body"
        blocks_out.append(PageBlock(page=pno, text=text, kind=kind, size=dom_size))
    return blocks_out, body_size


def _dominant_font_size(doc) -> float:
    _, body_size = extract_blocks_and_body_size(doc)
    return body_size


def extract_blocks(doc, body_size: float, min_heading_ratio: float) -> list[PageBlock]:
    blocks, _ = extract_blocks_and_body_size(doc, min_heading_ratio)
    return blocks


def parse_pdf(
    path: Path | str,
    min_heading_ratio: float = 1.15,
    fallback_title: str | None = None,
) -> ParsedBook:
    doc = fitz.open(path)
    try:
        num_pages = doc.page_count
        toc = [(int(lvl), str(title).strip(), int(page)) for lvl, title, page in doc.get_toc(simple=True)]
        toc = [entry for entry in toc if entry[2] >= 1]

        candidates: list[str] = []
        meta_clean = _clean_candidate(str((doc.metadata or {}).get("title") or ""))
        if _usable_title(meta_clean) and not is_hashlike_title(meta_clean):
            candidates.append(meta_clean)
        if fallback_title:
            fb_clean = _clean_candidate(str(fallback_title))
            if _usable_title(fb_clean) and not is_hashlike_title(fb_clean):
                candidates.append(fb_clean)
        for lvl, t, _page in toc:
            if int(lvl) == 1:
                t_clean = _clean_candidate(t)
                if _usable_title(t_clean) and not is_hashlike_title(t_clean):
                    candidates.append(t_clean)
                break
        stem_clean = _clean_candidate(Path(path).stem)
        if _usable_title(stem_clean) and not is_hashlike_title(stem_clean):
            candidates.append(stem_clean)

        blocks, _ = extract_blocks_and_body_size(doc, min_heading_ratio)
        return ParsedBook(title=candidates[0] if candidates else "Untitled book", num_pages=num_pages, toc=toc, blocks=blocks)
    finally:
        doc.close()
