#!/usr/bin/env python3
"""Read a Mochi export (.mochi is a zip containing data.json), pull the
Grammar Practice deck and the Vocab deck, normalise their contents, and emit
two compact JSON blobs ready to be inlined into n4-drill.html as the stable
prompt-cache prefix.

The Mochi file is a build-time input — the source deck grows and changes over
time, so we re-derive vocab.json/grammar.json on every build. Default path is
/var/tmp/export.mochi, overridable via --mochi.

Outputs (next to this script):
  vocab.json
  grammar.json
"""
import argparse
import json
import re
import zipfile
import hashlib
from pathlib import Path

HERE = Path(__file__).resolve().parent

FURIGANA_RE = re.compile(r"([一-鿿々]+?)\(([぀-ゟ]+)\)")
LINK_RE = re.compile(r"\[\[([^\]|]+)(?:\|[^\]]+)?\]\]")
MARKDOWN_LINK_RE = re.compile(r"\[([^\]]+)\]\([^)]+\)")
CLOZE_RE = re.compile(r"\{\{([^}]*)\}\}")
HIGHLIGHT_RE = re.compile(r"==([^=]+)==")
BOLD_RE = re.compile(r"\*\*([^*]+)\*\*")

# Tag-only line must START with an ASCII letter so we don't misread Japanese
# headings (e.g. `# する`) as tags.
TAG_ONLY_LINE_RE = re.compile(r"^\s*#[A-Za-z][\w-]*\s*$")
H1_RE = re.compile(r"^#(?!#)\s*(.+?)\s*$")


def short_id(s: str) -> str:
    return hashlib.sha256(s.encode("utf-8")).hexdigest()[:8]


def split_card(content: str):
    parts = re.split(r"^---\s*$", content, maxsplit=1, flags=re.MULTILINE)
    if len(parts) == 2:
        return parts[0].strip("\n"), parts[1].strip("\n")
    return content.strip("\n"), ""


def strip_furigana(s: str) -> str:
    return FURIGANA_RE.sub(r"\1", s)


def clean_markdown(s: str) -> str:
    s = MARKDOWN_LINK_RE.sub(r"\1", s)
    s = LINK_RE.sub(r"\1", s)
    s = HIGHLIGHT_RE.sub(r"\1", s)
    s = BOLD_RE.sub(r"\1", s)
    s = CLOZE_RE.sub(r"\1", s)
    return s


def _split_lines(text):
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

    back_lines = []
    for line in back_clean.splitlines():
        if re.fullmatch(r"\s*#[\w-]+\s*", line):
            continue
        back_lines.append(line)
    back_clean = "\n".join(back_lines).strip()

    parts = re.split(r"\n\s*\n", back_clean, maxsplit=1)
    answer = parts[0].strip()
    notes = parts[1].strip() if len(parts) == 2 else ""

    prompt = front_clean
    tags = sorted(card.get("~:tags", {}).get("~#set", []))
    entry = {
        "id": short_id(prompt + "|" + answer),
        "prompt_en": prompt,
        "answer_jp": answer,
    }
    if notes:
        notes = re.sub(r"\s+", " ", notes).strip()
        if len(notes) > 200:
            notes = notes[:197] + "..."
        entry["notes"] = notes
    if tags:
        entry["tags"] = tags
    return entry


def find_deck(decks, name):
    """Several decks may share names ('Vocab' appears twice — one populated,
    one empty). Pick the populated one."""
    best = None
    for d in decks:
        if d.get("~:name") != name:
            continue
        n = len(d.get("~:cards", {}).get("~#list", []))
        if best is None or n > len(best.get("~:cards", {}).get("~#list", [])):
            best = d
    return best


def dedup(items):
    seen = set()
    out = []
    for it in items:
        if it["id"] in seen:
            continue
        seen.add(it["id"])
        out.append(it)
    return out


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--mochi", default="/var/tmp/export.mochi",
                    help="Path to Mochi export (default: %(default)s)")
    ap.add_argument("--out-dir", default=str(HERE),
                    help="Where to write vocab.json/grammar.json (default: alongside this script)")
    args = ap.parse_args()

    export = Path(args.mochi)
    out_dir = Path(args.out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)

    with zipfile.ZipFile(export) as z:
        with z.open("data.json") as f:
            data = json.load(f)
    decks = data["~:decks"]

    grammar_deck = find_deck(decks, "Grammar Practice")
    vocab_deck = find_deck(decks, "Vocab")
    if not grammar_deck:
        raise SystemExit(f"No 'Grammar Practice' deck found in {export}")
    if not vocab_deck:
        raise SystemExit(f"No 'Vocab' deck found in {export}")

    print(f"Grammar Practice: {len(grammar_deck['~:cards']['~#list'])} cards")
    print(f"Vocab:            {len(vocab_deck['~:cards']['~#list'])} cards")

    grammar_entries = [e for c in grammar_deck["~:cards"]["~#list"]
                       if (e := parse_grammar_card(c)) is not None]
    vocab_entries = [e for c in vocab_deck["~:cards"]["~#list"]
                     if (e := parse_vocab_card(c)) is not None]

    grammar_entries = dedup(grammar_entries)
    vocab_entries = dedup(vocab_entries)

    print(f"Parsed: {len(grammar_entries)} grammar entries, {len(vocab_entries)} vocab entries")

    (out_dir / "grammar.json").write_text(
        json.dumps(grammar_entries, ensure_ascii=False, separators=(",", ":"))
    )
    (out_dir / "vocab.json").write_text(
        json.dumps(vocab_entries, ensure_ascii=False, separators=(",", ":"))
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
