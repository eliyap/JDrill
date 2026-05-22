# JDrill — N4 grammar drill app

Live: **https://eliyap.github.io/JDrill/**

Single-page English→Japanese N4 grammar drill app. The HTML page owns the UI;
a sibling `.sqlite` file in iCloud Drive owns the data. Open the page on any
Chrome instance (Mac / iPad / iPhone) signed into the same iCloud account and
you study off the same history.

`v1/` is the previous DOM-as-database implementation, kept for reference.

## Architecture

```
   GH Pages (static)              iCloud Drive (data)
   ──────────────────             ────────────────────
   index.html                  n4-drill.sqlite
     - sql.js + .wasm (inlined)   - settings (key/value)
     - vocab + grammar (inlined)  - history (one row per
     - app code                     completed drill)
            │                              ▲
            │  File System Access API      │
            └──────────────────────────────┘
                     read on open
                     write on flush (5s debounce)
```

- **App code** ships as one ~1 MB `index.html`. sql.js's WASM is inlined as
  base64 so the page has zero external resources except calls to
  `api.openai.com`.
- **Data** lives in the `.sqlite` file the user picks on first launch. The
  `FileSystemFileHandle` is cached in IndexedDB so subsequent launches only
  need one click to re-grant permission.
- **iCloud Drive** handles cross-device sync; last-writer-wins is acceptable
  for a single-user app.
- **Mobile Safari fallback**: no File System Access API. The page detects this
  and exposes Upload / Download buttons instead; data stays in memory until
  the user manually downloads.

## What's in the SQLite file

```sql
PRAGMA user_version = 1;

CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
-- seeded defaults: model, service_tier, temperature,
-- grammar_sample_size, vocab_sample_size, queue_target, instructions

CREATE TABLE history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER NOT NULL,             -- unix ms
  prompt_en TEXT NOT NULL,
  reference_jp TEXT NOT NULL,
  target_grammar_id TEXT,
  target_grammar_label TEXT,
  notes TEXT,
  user_answer TEXT NOT NULL,
  verdict TEXT NOT NULL,           -- "pass" | "fail"
  judges_json TEXT NOT NULL        -- JSON array of {verdict, reason} ×3
);
```

Vocab and grammar are **not** in the SQLite. They're inlined in the HTML as
the prompt-cache prefix — see "Prompt caching" below.

## Build

The Mochi export is a build-time input. The deck grows over time; re-run the
build whenever you want the page to know about new cards.

```sh
cd build
python3 build.py                       # uses /var/tmp/export.mochi
python3 build.py --mochi /path/to.zip  # override
python3 build.py --skip-convert        # reuse last vocab.json/grammar.json
```

The build:
1. Runs `convert.py` to pull the **Vocab** and **Grammar Practice** decks from
   the Mochi `.mochi` zip into compact `vocab.json` / `grammar.json`.
2. Runs `npx esbuild` to bundle `src/main.js` (which imports sql.js + its
   `.wasm` as base64) into a single IIFE.
3. Stamps the bundle, vocab JSON, and grammar JSON into `src/template.html`.
4. Writes `index.html` at the repo root.

Output: ~1 MB self-contained HTML.

## Source layout

```
build/
  package.json         # sql.js + esbuild dev-deps
  convert.py           # Mochi → vocab.json/grammar.json
  build.py             # convert → bundle → stamp template → write index.html
  src/
    template.html      # outer page shell + UI sections + {{markers}}
    main.js            # boot, file-picker UI, drill cycle, history rendering
    db.js              # sql.js init, schema migrations, settings/history, autosave
    storage.js         # FileSystemFileHandle + IndexedDB persistence
    openai.js          # SYSTEM_PROMPT, schemas, callOpenAI, generate/approve/grade
    wasm-binary.js     # imports sql-wasm.wasm as base64 (esbuild loader)
  dist/                # esbuild output (gitignored)
  node_modules/        # (gitignored)
  vocab.json           # build artifact (gitignored)
  grammar.json         # build artifact (gitignored)
index.html          # final shipped artifact
```

## Drill lifecycle

1. **Generation** — GPT-5 sees a sampled subset of grammar candidates
   (`grammar_sample_size`, default 2) and vocab candidates
   (`vocab_sample_size`, default 10), picks one grammar focus, and emits
   `{ prompt_en, reference_jp, target_grammar_id, target_grammar_label, notes }`.
2. **Approval** — 3 parallel GPT-5 calls, distinct seeds, non-zero
   temperature, judge whether the reference correctly demonstrates the
   chosen grammar. Unanimous yes admits the drill to the visible stack.
3. **Stack** — approved drills appear as <article> cards in a chronological
   list. `queue_target` (default 5) fresh+grading cards are maintained at
   any time; the background loop generates more as the user works through
   them.
4. **Answer** — user types Japanese into any fresh card; Cmd/Ctrl+Enter or
   the Grade button submits. The card transitions to `grading` and the
   user immediately moves on to the next card. Multiple cards can be
   grading concurrently.
5. **Grading** — 3 parallel GPT-5 calls judge semantic + grammatical
   equivalence to the reference. Unanimous yes = pass.
6. **Record** — `INSERT INTO history` → `markDirty()` → 5-second debounced
   autosave writes the DB bytes back to the file via File System Access API.
7. **Reveal** — the card transitions to `graded-pass` or `graded-fail`
   in place, showing verdict, reference, judge reasoning, and target
   grammar pill. The card stays in the stack as a record of this session.

## Prompt strategy

The system message is **task rules only** (~1 KB). The full vocab and
grammar decks are *not* shipped in the system prompt — the runtime samples
a small subset per call and embeds it directly in the user message.

Why not a fat cached prefix? The generator rule already forbids the model
from picking outside the offered candidates, so the rest of the deck adds
nothing to output quality. It used to be there as a cache anchor (~30K
tokens, dropping to 1/10th price after the first call), but OpenAI's cache
TTL is short — every cold start paid the full uncached price for content
the model couldn't even use. Trimming dropped per-call payload ~30x.

Per drill cycle (1 generate + 3 approve + 3 grade = 7 calls):
- **nano**: well under a cent
- **mini**: a few cents
- **full (gpt-5.4)**: ~$0.05-0.10 depending on output length

## Privacy / security

- The API key is stored in the `settings` table of your `.sqlite` file. It
  persists across launches so you don't have to retype it. This trades
  the "never on disk" purity for usability; treat the `.sqlite` like any
  other file containing a credential. Clearing the API-key field in the UI
  removes it from the DB.
- The `.sqlite` file also contains drill history (prompts you saw, your
  answers, judge reasoning).
- All API calls go to `api.openai.com` over HTTPS. No analytics, no CDNs,
  no fonts, no telemetry.

## URL parameters

- `?mem=1` — force the in-memory fallback even on browsers with FSAA. Use it
  for a private session that won't touch your saved file.

## Known limits

- Vocab deck currently has only 4 entries. Drills will feel repetitive until
  the deck is grown. Either expand the source Mochi deck and re-run the
  build, or edit `convert.py` to additionally pull other decks (`N4`,
  `Bonus`, etc.).
- `service_tier: "flex"` can cost ~90 seconds per call. Keep
  `queue_target` ≥ 3 so prefetch hides latency during study.
- Conflict resolution is last-writer-wins. Studying simultaneously on two
  devices may lose history.
