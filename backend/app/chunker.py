import json
import logging
import re
from bisect import bisect_right
from collections import Counter
from dataclasses import dataclass

logger = logging.getLogger(__name__)

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


def normalize_slide_title(title: str) -> str:
    t = (title or "").strip()
    # Remove citations like (Oord et al., 2016) or [Author, 2020]
    t = re.sub(r"\s*[\(\[][A-Z][a-zA-Z\s\.,&]+(19|20)\d{2}[a-z]?[\)\]]", "", t)
    # Remove continuation suffixes like (cont.), (continued), (2), - Part 2, etc.
    t = re.sub(r"\s*[\(\[](cont|cont\'d|continued|part\s*\d+|\d+/\d+|\d+)[\.\)\]]*", "", t, flags=re.IGNORECASE)
    t = re.sub(r"\s*-\s*part\s*\d+", "", t, flags=re.IGNORECASE)
    t = re.sub(r"\s*:\s*continued", "", t, flags=re.IGNORECASE)
    # Remove trailing punctuation
    t = re.sub(r"[\s:,\-]+$", "", t)
    return re.sub(r"\s+", " ", t).strip().lower()


def is_same_slide_topic(title_a: str, title_b: str) -> bool:
    norm_a = normalize_slide_title(title_a)
    norm_b = normalize_slide_title(title_b)
    if not norm_a or not norm_b:
        return False
    # Exact normalized match
    if norm_a == norm_b:
        return True
    # One is prefix of the other (e.g. "Pixel RNN" vs "Pixel RNN (Oord et al., 2016)")
    if (len(norm_a) >= 5 and norm_b.startswith(norm_a)) or (len(norm_b) >= 5 and norm_a.startswith(norm_b)):
        return True
    return False


def _parse_llm_outline_json(raw: str, num_pages: int) -> list[SectionDraft] | None:
    try:
        text = raw.strip()
        match = re.search(r"\[\s*\{.*?\}\s*\]", text, re.DOTALL)
        if match:
            text = match.group(0)
        else:
            if text.startswith("```"):
                text = re.sub(r"^```[a-zA-Z]*\s*", "", text)
                text = re.sub(r"\s*```$", "", text).strip()
        data = json.loads(text)
        if not isinstance(data, list) or len(data) < 2:
            return None

        drafts: list[SectionDraft] = []
        last_page = 0
        for item in data:
            if not isinstance(item, dict):
                continue
            title = str(item.get("title") or "").strip()
            pno = item.get("page_start")
            try:
                pno = int(pno)
            except (TypeError, ValueError):
                continue
            if not title or pno <= last_page or pno > num_pages:
                continue
            drafts.append(SectionDraft(title=title[:200], level=1, page_start=pno))
            last_page = pno

        if not drafts:
            return None

        if drafts[0].page_start != 1:
            drafts[0].page_start = 1

        if len(drafts) >= 2:
            return drafts
    except Exception as e:
        logger.warning("Failed to parse LLM outline response: %s", e)
    return None


def _build_sections_via_llm(
    candidates: list[tuple[int, str]],
    num_pages: int,
    doc_title: str | None = None,
) -> list[SectionDraft] | None:
    """Use LLM to intelligently synthesize 4 to 8 conceptual modules when slide titling is overly used."""
    if len(candidates) < 8:
        return None

    try:
        from .llm import llm_client

        lines = []
        seen_pages = set()
        for pno, title in candidates:
            if pno in seen_pages:
                continue
            seen_pages.add(pno)
            lines.append(f"Slide {pno}: {title[:80]}")
            if len(lines) >= 120:
                break

        slide_text = "\n".join(lines)
        topic_hint = f"Topic/Title: {doc_title}\n" if doc_title else ""
        prompt = (
            f"You are an expert academic curriculum designer.\n"
            f"{topic_hint}"
            f"Below is the list of slides and slide titles from a lecture presentation.\n"
            f"Titling on individual slides is overly used (nearly every slide has a title).\n"
            f"Your task is to group this lecture into a clean, logical outline of 4 to 8 main coherent conceptual modules/sections.\n"
            f"Each section must specify the section title and the slide number where that section starts.\n"
            f"The first section must start at slide 1.\n"
            f"Every page_start must be an integer from the slides below, in strictly increasing order.\n\n"
            f"Slides:\n{slide_text}\n\n"
            f"Respond ONLY with a JSON array: [{{\"title\": \"...\", \"page_start\": 1}}, ...]\n"
            f"No markdown formatting, no explanations."
        )

        resp = llm_client.complete([{"role": "user", "content": prompt}], temperature=0.1)
        if not resp or not resp.strip():
            return None

        return _parse_llm_outline_json(resp, num_pages)
    except Exception as e:
        logger.warning("LLM section generation failed: %s", e)
        return None


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
    candidates: list[tuple[int, str]] = []
    for block in parsed.blocks:
        if block.kind != "heading":
            continue
        title = " ".join(block.text.splitlines()).strip()
        title = re.sub(r"\s+", " ", title)
        if len(title) <= 2 or re.match(r"^\d+\s*/\s*\d+$", title):
            continue
        candidates.append((block.page, title))

    # When slide titling is overly used across pages, attempt intelligent LLM outline synthesis
    if len(candidates) >= 10:
        llm_sections = _build_sections_via_llm(candidates, parsed.num_pages, parsed.title)
        if llm_sections:
            logger.info("Generated %d intelligent lecture sections via LLM for '%s'", len(llm_sections), parsed.title)
            return llm_sections

    # Detect recurring running headers/footers using cluster occurrences (non-consecutive runs)
    clusters: list[str] = []
    for _, title in candidates:
        norm = normalize_slide_title(title)
        if not clusters or clusters[-1] != norm:
            clusters.append(norm)
    cluster_counts = Counter(clusters)
    page_count = max(parsed.num_pages, 1)
    recurring = {t for t, n in cluster_counts.items() if n > 3 and (n > page_count * 0.12 or n > 6)}

    for pno, title in candidates:
        norm = normalize_slide_title(title)
        if norm in recurring:
            continue
        if drafts:
            # Check if this slide continues the previous section
            if is_same_slide_topic(drafts[-1].title, title):
                continue
            # Avoid duplicate section on exact same page
            if pno == drafts[-1].page_start:
                continue
        drafts.append(SectionDraft(title=title, level=1, page_start=pno))

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
