#!/usr/bin/env python3
"""Stamp the inline VOCAB / GRAMMAR JSON into the template to produce
n4-drill.html. Re-run after editing the template or after re-running convert.py."""
from pathlib import Path

HERE = Path(__file__).parent
template = (HERE / "n4-drill.template.html").read_text()
vocab = (HERE / "vocab.json").read_text().strip()
grammar = (HERE / "grammar.json").read_text().strip()

out = template.replace("{{VOCAB_JSON}}", vocab).replace("{{GRAMMAR_JSON}}", grammar)
dest = HERE.parent / "n4-drill.html"
dest.write_text(out)
print("wrote", dest, "—", len(out), "bytes")
