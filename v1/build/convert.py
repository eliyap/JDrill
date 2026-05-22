#!/usr/bin/env python3
"""Read /var/tmp/export.mochi (a zip with data.json), pull the Grammar Practice
deck and the Vocab deck, normalise their contents, and emit two compact JSON
blobs ready to drop into <script type="application/json"> tags inside
n4-drill.html.

Output:
  /private/var/tmp/n4-prep/build/vocab.json
  /private/var/tmp/n4-prep/build/grammar.json
"""
import json
import re
import zipfile
import hashlib
from pathlib import Path

EXPORT = Path("/var/tmp/export.mochi")
OUT_DIR = Path("/private/var/tmp/n4-prep/build")
OUT_DIR.mkdir(parents=True, exist_ok=True)

FURIGANA_RE = re.compile(r"([一-鿿々]+?)\(([぀-ゟ]+)\)")
TAG_LINE_RE = re.compile(r"(?:^|\s)#([\w-]+)")
LINK_RE = re.compile(r"\[\[([^\]|]+)(?:\|[^\]]+)?\]\]")
MARKDOWN_LINK_RE = re.compile(r"\[([^\]]+)\]\([^)]+\)")
CLOZE_RE = re.compile(r"\{\{([^}]*)\}\}")
HIGHLIGHT_RE = re.compile(r"==([^=]+)==")
BOLD_RE = re.compile(r"\*\*([^*]+)\*\*")


def short_id(s: str) -> str:
    return hashlib.sha256(s.encode("utf-8")).hexdigest()[:8]


def split_card(content: str):
    """Split a Mochi card body on the front/back separator."""
    # Mochi exports use a line containing only '---' as the separator.
    parts = re.split(r"^---\s*$", content, maxsplit=1, flags=re.MULTILINE)
    if len(parts) == 2:
        return parts[0].strip("\n"), parts[1].strip("\n")
    return content.strip("\n"), ""


def strip_furigana(s: str) -> str:
    """都(つ)合(ごう) -> 都合"""
    return FURIGANA_RE.sub(r"\1", s)


def extract_reading(s: str) -> str:
    """都(つ)合(ごう) -> つごう"""
    return "".join(m.group(2) for m in FURIGANA_RE.finditer(s))


def clean_markdown(s: str) -> str:
    s = MARKDOWN_LINK_RE.sub(r"\1", s)
    s = LINK_RE.sub(r"\1", s)
    s = HIGHLIGHT_RE.sub(r"\1", s)
    s = BOLD_RE.sub(r"\1", s)
    s = CLOZE_RE.sub(r"\1", s)
    return s


def strip_heading(s: str) -> str:
    return re.sub(r"^#+\s*", "", s).strip()


TAG_ONLY_LINE_RE = re.compile(r"^\s*#[A-Za-z][\w-]*\s*$")
# A "##"-or-deeper heading is treated as a sub-heading (notes), not the main title.
H1_RE = re.compile(r"^#(?!#)\s*(.+?)\s*$")


def _split_lines(text):
    """Yield (kind, body) where kind is 'h1', 'tag', or 'text'."""
    for line in text.splitlines():
        if not line.strip():
            continue
        if TAG_ONLY_LINE_RE.match(line):
            yield "tag", line.strip()[1:]
            continue
        m = H1_RE.match(line)
        if m:
            yield "h1", m.group(1).strip()
            continue
        yield "text", line.strip()


def parse_vocab_card(card: dict):
    front, back = split_card(card.get("~:content", ""))
    if not front.strip() or not back.strip():
        return None
    front_clean = clean_markdown(front)
    back_clean = clean_markdown(back)

    en = None
    notes_front = []
    for kind, body in _split_lines(front_clean):
        if kind == "tag":
            continue
        if kind == "h1" and en is None:
            en = body
        else:
            notes_front.append(body)

    jp_raw = None
    notes_back = []
    for kind, body in _split_lines(back_clean):
        if kind == "tag":
            continue
        if kind == "h1" and jp_raw is None:
            jp_raw = body
        else:
            notes_back.append(body)

    if not en or not jp_raw:
        return None

    jp_term = strip_furigana(jp_raw).strip()
    pos = sorted(card.get("~:tags", {}).get("~#set", []))

    entry = {
        "id": short_id(jp_term + "|" + en),
        "jp": jp_term,
        "en": en,
    }
    if pos:
        entry["pos"] = pos
    notes = " ".join(s.strip() for s in (notes_front + notes_back) if s.strip())
    notes = re.sub(r"\s+", " ", notes).strip()
    if notes:
        entry["notes"] = notes
    return entry


def parse_grammar_card(card: dict):
    front, back = split_card(card.get("~:content", ""))
    if not front.strip() or not back.strip():
        return None
    front_clean = clean_markdown(front).strip()
    back_clean = clean_markdown(back).strip()

    # Strip inline #tag-only lines from the back (e.g., "#unverified" footer)
    back_lines = []
    for line in back_clean.splitlines():
        if re.fullmatch(r"\s*#[\w-]+\s*", line):
            continue
        back_lines.append(line)
    back_clean = "\n".join(back_lines).strip()

    # Sometimes the back has main answer on first line and notes after a blank line
    parts = re.split(r"\n\s*\n", back_clean, maxsplit=1)
    answer = parts[0].strip()
    notes = parts[1].strip() if len(parts) == 2 else ""

    # English prompt may have leading "(Formal)" parenthetical we want to keep
    prompt = front_clean

    tags = sorted(card.get("~:tags", {}).get("~#set", []))
    entry = {
        "id": short_id(prompt + "|" + answer),
        "prompt_en": prompt,
        "answer_jp": answer,
    }
    if notes:
        # Trim to one line of guidance
        notes = re.sub(r"\s+", " ", notes).strip()
        if len(notes) > 200:
            notes = notes[:197] + "..."
        entry["notes"] = notes
    if tags:
        entry["tags"] = tags
    return entry


def find_deck(decks, name):
    """Return the largest deck with the given name, since several decks share
    names ('Vocab' appears twice — one populated, one empty)."""
    best = None
    for d in decks:
        if d.get("~:name") != name:
            continue
        n = len(d.get("~:cards", {}).get("~#list", []))
        if best is None or n > len(best.get("~:cards", {}).get("~#list", [])):
            best = d
    return best


def main():
    with zipfile.ZipFile(EXPORT) as z:
        with z.open("data.json") as f:
            data = json.load(f)
    decks = data["~:decks"]

    grammar_deck = find_deck(decks, "Grammar Practice")
    vocab_deck = find_deck(decks, "Vocab")
    print(f"Grammar Practice: {len(grammar_deck['~:cards']['~#list'])} cards")
    print(f"Vocab:            {len(vocab_deck['~:cards']['~#list'])} cards")

    grammar_entries = []
    for c in grammar_deck["~:cards"]["~#list"]:
        e = parse_grammar_card(c)
        if e is not None:
            grammar_entries.append(e)

    vocab_entries = []
    for c in vocab_deck["~:cards"]["~#list"]:
        e = parse_vocab_card(c)
        if e is not None:
            vocab_entries.append(e)

    # Dedup by id, keep first occurrence
    def dedup(items):
        seen = set()
        out = []
        for it in items:
            if it["id"] in seen:
                continue
            seen.add(it["id"])
            out.append(it)
        return out

    grammar_entries = dedup(grammar_entries)
    vocab_entries = dedup(vocab_entries)

    print(f"Parsed: {len(grammar_entries)} grammar entries, {len(vocab_entries)} vocab entries")

    (OUT_DIR / "grammar.json").write_text(
        json.dumps(grammar_entries, ensure_ascii=False, separators=(",", ":"))
    )
    (OUT_DIR / "vocab.json").write_text(
        json.dumps(vocab_entries, ensure_ascii=False, separators=(",", ":"))
    )

    print("Sample grammar:")
    for e in grammar_entries[:3]:
        print(" ", json.dumps(e, ensure_ascii=False))
    print("Sample vocab:")
    for e in vocab_entries[:3]:
        print(" ", json.dumps(e, ensure_ascii=False))


if __name__ == "__main__":
    main()
