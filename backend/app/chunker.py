import re
from bisect import bisect_right
from collections import Counter
from dataclasses import dataclass

from .config import settings
from .parser import PageBlock, ParsedBook

MAX_DERIVED_SUBS_PER_CHAPTER = 40


@dataclass
class SectionDraft:
    title: str
    level: int
    page_start: int


@dataclass
class ChunkDraft:
    text: str
    section_index: int
    section_title: str
    page_start: int
    page_end: int
    ord: int
    is_code: bool = False


def _normalize_title(value: str) -> str:
    return re.sub(r"[^a-z0-9]+", " ", value.lower()).strip()


def _is_front_matter_title(title: str, blacklist: tuple[str, ...]) -> bool:
    norm = _normalize_title(title)
    if not norm:
        return True
    for candidate in blacklist:
        c = _normalize_title(candidate)
        if norm == c or c in norm:
            return True
    return False


def detect_content_start_index(sections: list[SectionDraft]) -> int:
    """Return the index of the first real content section (after front matter)."""
    blacklist = getattr(settings.ingestion, "front_matter_blacklist", ())
    for idx, section in enumerate(sections):
        if not _is_front_matter_title(section.title, blacklist):
            return idx
    return 0


def _body_font_size(parsed: ParsedBook) -> float:
    sizes = Counter(round(b.size, 1) for b in parsed.blocks if b.kind == "body")
    if not sizes:
        return 11.0
    return sizes.most_common(1)[0][0]


def _derive_subtitles(parsed: ParsedBook, chapters: list[SectionDraft], max_level: int | None = None) -> dict[int, list[SectionDraft]]:
    """Find real section subtitles typographically for flat-TOC books.

    Picks the dominant heading font tier (1.5x-2.4x body size), keeps clean
    single-line titles, drops recurring decorative labels, and groups results
    under their chapter.
    """
    effective_max = max_level if max_level is not None else settings.ingestion.max_toc_level
    body = _body_font_size(parsed)
    tier_sizes = Counter(
        round(b.size, 1)
        for b in parsed.blocks
        if b.kind == "heading" and body * 1.5 <= b.size <= body * 2.4
    )
    if not tier_sizes:
        return {}
    sub_size = tier_sizes.most_common(1)[0][0]

    candidates: list[PageBlock] = []
    for b in parsed.blocks:
        if b.kind != "heading" or abs(round(b.size, 1) - sub_size) > 0.3:
            continue
        title = b.text.strip()
        if "\n" in b.text or not 3 <= len(title) <= 60 or not any(c.isalpha() for c in title):
            continue
        candidates.append(b)

    chapter_count = max(len(chapters), 1)
    title_counts = Counter(b.text.strip().lower() for b in candidates)
    recurring = {t for t, n in title_counts.items() if n > max(6, chapter_count // 2)}

    starts_only = [c.page_start for c in chapters]
    titles_by_page: dict[int, set[str]] = {}
    for c in chapters:
        titles_by_page.setdefault(c.page_start, set()).add(c.title.strip().lower())

    subs_by_chapter: dict[int, list[SectionDraft]] = {}
    for b in candidates:
        title_lower = b.text.strip().lower()
        if title_lower in recurring:
            continue
        known = titles_by_page.get(b.page, set())
        if any(title_lower == t or title_lower in t or t in title_lower for t in known):
            continue
        idx = bisect_right(starts_only, b.page) - 1
        if idx < 0:
            continue
        chapter = chapters[idx]
        bucket = subs_by_chapter.setdefault(chapter.page_start, [])
        if len(bucket) >= MAX_DERIVED_SUBS_PER_CHAPTER:
            continue
        if bucket and (
            b.page < bucket[-1].page_start
            or (b.page == bucket[-1].page_start and bucket[-1].title.lower() == title_lower)
        ):
            continue
        level = min(chapter.level + 1, effective_max)
        bucket.append(SectionDraft(title=b.text.strip(), level=level, page_start=b.page))
    return subs_by_chapter


def build_sections(parsed: ParsedBook, max_level: int | None = None) -> list[SectionDraft]:
    toc = parsed.toc
    if toc:
        limit = max_level if max_level is not None else settings.ingestion.max_toc_level
        drafts: list[SectionDraft] = []
        for lvl, title, page in toc:
            if lvl < 1 or lvl > limit:
                continue
            clean = str(title).strip()
            if not 2 < len(clean) < 200:
                continue
            page = max(int(page), 1)
            if drafts and page < drafts[-1].page_start:
                continue
            if (
                drafts
                and drafts[-1].level == lvl
                and drafts[-1].page_start == page
                and drafts[-1].title.lower() == clean.lower()
            ):
                continue
            drafts.append(SectionDraft(title=clean, level=lvl, page_start=page))
        if drafts:
            if drafts[0].page_start > 1:
                drafts.insert(0, SectionDraft(title="Front matter", level=drafts[0].level, page_start=1))
            if limit > 1 and len({d.level for d in drafts}) == 1:
                subs = _derive_subtitles(parsed, drafts, max_level=limit)
                enriched: list[SectionDraft] = []
                for draft in drafts:
                    enriched.append(draft)
                    enriched.extend(subs.get(draft.page_start, []))
                return enriched
            return drafts

    drafts: list[SectionDraft] = []
    for block in parsed.blocks:
        if block.kind != "heading":
            continue
        title = block.text.split("\n")[0].strip()
        if drafts and block.page == drafts[-1].page_start and drafts[-1].title == title:
            continue
        drafts.append(SectionDraft(title=title, level=1, page_start=block.page))
    if not drafts:
        drafts = [SectionDraft(title=parsed.title, level=1, page_start=1)]
    return drafts


def assign_blocks(blocks: list[PageBlock], sections: list[SectionDraft]) -> list[list[PageBlock]]:
    starts = [s.page_start for s in sections]
    grouped: list[list[PageBlock]] = [[] for _ in sections]
    for block in blocks:
        idx = bisect_right(starts, block.page) - 1
        grouped[max(idx, 0)].append(block)
    return grouped


def _split_long(text: str, limit: int, overlap: int) -> list[str]:
    parts: list[str] = []
    start = 0
    n = len(text)
    while start < n:
        end = min(start + limit, n)
        if end < n:
            cut = text.rfind("\n", start + limit // 2, end)
            if cut == -1:
                cut = text.rfind(". ", start + limit // 2, end)
            if cut != -1:
                end = cut + 1
        piece = text[start:end].strip()
        if piece:
            parts.append(piece)
        if end >= n:
            break
        start = max(end - overlap, start + 1)
    return parts


def pack_section_chunks(
    section_index: int,
    section_title: str,
    blocks: list[PageBlock],
    chunk_chars: int,
    overlap: int,
) -> list[ChunkDraft]:
    units: list[tuple[str, int, bool]] = []
    for block in blocks:
        is_code = block.kind == "code"
        if len(block.text) > chunk_chars:
            for piece in _split_long(block.text, chunk_chars, overlap):
                units.append((piece, block.page, is_code))
        else:
            units.append((block.text, block.page, is_code))

    drafts: list[ChunkDraft] = []
    current: list[str] = []
    current_code: list[bool] = []
    cur_len = 0
    pages: list[int] = []

    def flush() -> None:
        nonlocal current, current_code, cur_len, pages
        if not current:
            return
        text = "\n\n".join(current).strip()
        if text:
            drafts.append(
                ChunkDraft(
                    text=text,
                    section_index=section_index,
                    section_title=section_title,
                    page_start=min(pages),
                    page_end=max(pages),
                    ord=len(drafts),
                    is_code=any(current_code),
                )
            )
        current, current_code, cur_len, pages = [], [], 0, []

    tail_cache = ""
    for text, page, is_code in units:
        if cur_len and cur_len + len(text) + 2 > chunk_chars:
            flush()
            if overlap > 0 and tail_cache:
                head = tail_cache[-overlap:]
                current.append(head)
                current_code.append(False)
                cur_len = len(head)
                pages.append(page)
        current.append(text)
        current_code.append(is_code)
        cur_len += len(text) + 2
        pages.append(page)
        tail_cache = "\n\n".join(current)
    flush()
    return drafts


def make_chunks(parsed: ParsedBook, content_start_page: int | None = None, max_level: int | None = None) -> tuple[list[SectionDraft], list[ChunkDraft], int]:
    cfg = settings.ingestion
    sections = build_sections(parsed, max_level=max_level)
    content_start_index = detect_content_start_index(sections)
    if content_start_page is not None:
        override_idx = next((i for i, s in enumerate(sections) if s.page_start == content_start_page), content_start_index)
        content_start_index = override_idx
    grouped = assign_blocks(parsed.blocks, sections)
    all_drafts: list[ChunkDraft] = []
    ord_counter = 0
    for idx, (section, blocks) in enumerate(zip(sections, grouped)):
        if idx < content_start_index:
            continue
        drafts = pack_section_chunks(idx, section.title, blocks, cfg.chunk_chars, cfg.chunk_overlap)
        for draft in drafts:
            draft.ord = ord_counter
            ord_counter += 1
        all_drafts.extend(drafts)
    return sections, all_drafts, content_start_index
