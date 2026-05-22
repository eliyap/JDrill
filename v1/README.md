# n4-drill

Single-file English→Japanese N4 grammar drill app. Open `n4-drill.html` in
the MiniClay launcher (on Chrome/Mac/iPadOS) for autosave + iCloud sync,
or open it directly in any browser for an in-memory session.

## Files

- `n4-drill.html` — the shipped artifact. Self-contained, ~48 KB. Inline
  vocab + grammar JSON, inline CSS and runtime, no external resources
  except calls to `api.openai.com`.
- `build/` — sources used to rebuild `n4-drill.html`:
  - `convert.py` — reads `/var/tmp/export.mochi`, pulls the **Vocab** and
    **Grammar Practice** decks, writes `vocab.json` and `grammar.json`.
  - `n4-drill.template.html` — the HTML with `{{VOCAB_JSON}}` and
    `{{GRAMMAR_JSON}}` placeholders.
  - `build.py` — stamps the JSON into the template; writes
    `../n4-drill.html`.
  - `vocab.json`, `grammar.json` — last-built JSON blobs.

## Rebuilding after a Mochi update

```
cd build && python3 convert.py && python3 build.py
```

## Runtime parameters

All knobs are `data-*` attributes on the `#settings` div. Editable in any
text editor without touching the script:

| attribute | default | purpose |
| --- | --- | --- |
| `data-model` | `gpt-5` | OpenAI chat completions model |
| `data-service-tier` | `flex` | `flex` (cheap, slow) or `default` |
| `data-temperature` | `1` | sampling temperature |
| `data-grammar-sample-size` | `2` | grammar candidates offered per generate call |
| `data-vocab-sample-size` | `10` | vocab candidates offered per generate call |
| `data-queue-target` | `5` | prefetch queue depth |
| `data-instructions` | empty | free-text steering, persisted across launches |

## What gets persisted vs. lost

| state | persisted via | lost on... |
| --- | --- | --- |
| `#history` (completed drills) | MiniClay autosave (Chrome only) | mobile Safari close |
| `data-instructions` | MiniClay autosave | mobile Safari close |
| API key | nowhere | tab close (by design) |
| Prefetch queue | nowhere | tab close (refilled on next launch) |

## How persistence is partitioned

Only `#history` (drill entries) and `#settings` (data-attrs) are intentionally
persistent. The rest of the DOM is **ephemeral UI state** and is re-derived in
`boot()` on every launch — section visibility, status line, current prompt,
queue counts, and reveal-panel content are all reset. This matters because
MiniClay autosaves the entire serialized document; without this reset, closing
the tab mid-drill would persist `#key-entry hidden=""`, leaving no way to enter
an API key on next open.

## Known limits

- Vocab is currently 4 entries (the source "Vocab" Mochi deck is small).
  Drills will feel very repetitive until the deck is grown. Either expand
  the Vocab deck and re-run the build, or edit `convert.py` to pull
  additional decks (e.g., `N4`, `Bonus`, `Chapter X`).
- The grammar bank is 138 example pairs (17 marked `unverified` are
  excluded from sampling at runtime — the runtime filter is in
  `n4-drill.html`'s init script).
- `service_tier: "flex"` can cost ~90 seconds per call. Keep
  `data-queue-target` at ≥3 so prefetch hides the latency during study.

## Cost notes

Per completed drill: 1 generator call + 3 approval calls + 3 grading
calls = 7 GPT-5 calls. The system message (~22 KB containing the full
vocab + grammar + instructions) is byte-identical across all calls and
is automatically prompt-cached by OpenAI on prefixes ≥1024 tokens. After
the first call in a session, subsequent calls hit the cache for the
prefix and pay only for the short variable tail + output.
