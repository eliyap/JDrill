#!/usr/bin/env python3
"""Build the inlined n4-drill.html.

Pipeline:
  1. Run convert.py to derive vocab.json/grammar.json from the Mochi export.
     The Mochi file is a build-time input; default /var/tmp/export.mochi,
     overridable with --mochi.
  2. Bundle src/main.js into a single IIFE via `npx esbuild`, with sql.js's
     .wasm inlined as a base64 string (loader:.wasm=base64).
  3. Stamp the bundle into src/template.html at the /*__BUNDLE__*/ marker.
  4. Write the final HTML to ../n4-drill.html (one directory above build/).
"""

from __future__ import annotations
import argparse
import shutil
import subprocess
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent
SRC = HERE / "src"
TEMPLATE = SRC / "template.html"
ENTRY = SRC / "main.js"
OUT_BUNDLE = HERE / "dist" / "bundle.js"
OUT_HTML = ROOT / "index.html"
BUNDLE_MARKER = "/*__BUNDLE__*/"
VOCAB_MARKER = "{{VOCAB_JSON}}"
GRAMMAR_MARKER = "{{GRAMMAR_JSON}}"
VOCAB_JSON_PATH = HERE / "vocab.json"
GRAMMAR_JSON_PATH = HERE / "grammar.json"


def run(cmd: list[str], cwd: Path | None = None) -> None:
    print("$", " ".join(cmd))
    subprocess.run(cmd, cwd=cwd, check=True)


def ensure_npm_install() -> None:
    if not (HERE / "node_modules" / "sql.js").exists():
        run(["npm", "install"], cwd=HERE)


def bundle_js() -> str:
    OUT_BUNDLE.parent.mkdir(parents=True, exist_ok=True)
    run([
        "npx", "--yes", "esbuild",
        str(ENTRY),
        "--bundle",
        "--format=iife",
        "--platform=browser",
        "--target=es2022",
        "--loader:.wasm=base64",
        "--minify",
        f"--outfile={OUT_BUNDLE}",
    ], cwd=HERE)
    return OUT_BUNDLE.read_text(encoding="utf-8")


def stamp(template: str, bundle: str, vocab: str, grammar: str) -> str:
    for marker in (BUNDLE_MARKER, VOCAB_MARKER, GRAMMAR_MARKER):
        if marker not in template:
            sys.exit(f"template missing {marker!r}")
    out = template.replace(VOCAB_MARKER, vocab)
    out = out.replace(GRAMMAR_MARKER, grammar)
    # Bundle last — it's the big string and we don't want $-escape weirdness.
    out = out.replace(BUNDLE_MARKER, bundle)
    return out


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--mochi", default="/var/tmp/export.mochi",
                    help="Path to Mochi export .zip (default: %(default)s)")
    ap.add_argument("--skip-convert", action="store_true",
                    help="Skip running convert.py (use existing vocab.json/grammar.json)")
    args = ap.parse_args()

    if not args.skip_convert:
        convert_py = HERE / "convert.py"
        if convert_py.exists():
            run([sys.executable, str(convert_py), "--mochi", args.mochi], cwd=HERE)
        else:
            print(f"note: {convert_py} not yet present — skipping vocab/grammar derivation")

    ensure_npm_install()
    bundle = bundle_js()
    template = TEMPLATE.read_text(encoding="utf-8")
    vocab = VOCAB_JSON_PATH.read_text(encoding="utf-8") if VOCAB_JSON_PATH.exists() else "[]"
    grammar = GRAMMAR_JSON_PATH.read_text(encoding="utf-8") if GRAMMAR_JSON_PATH.exists() else "[]"
    html = stamp(template, bundle, vocab, grammar)
    OUT_HTML.write_text(html, encoding="utf-8")
    size_kb = OUT_HTML.stat().st_size / 1024
    print(f"\nwrote {OUT_HTML} ({size_kb:.1f} KB)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
