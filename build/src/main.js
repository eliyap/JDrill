// Preact + htm rewrite of the UI. The whole app is a single <App /> component
// rendered into #root. State lives in hooks; async business logic (file I/O,
// OpenAI calls) is run in event handlers and effects, and surfaces back to
// the tree via dispatch / setState.
//
// db.js, storage.js, openai.js remain plain modules — the UI just calls them.

import { html, render } from "htm/preact";
import { useEffect, useReducer, useRef, useState } from "preact/hooks";

import { DrillDb } from "./db.js";
import { FileStorage, isSupported as fsaaSupported } from "./storage.js";
import {
  configure as configureOpenAI,
  setApiKey,
  hasApiKey,
  generateDrill,
  approveDrill,
  gradeAnswer,
  stats as openAiStats,
} from "./openai.js";
import { shouldRefill, freshOrGradingCount, buildRubyAnnotator, renderRuby, cardsReducer } from "./runtime.js";

const VOCAB = JSON.parse(document.getElementById("vocab").textContent || "[]");
const GRAMMAR = JSON.parse(document.getElementById("grammar").textContent || "[]");

// One-shot lookup table for furigana rendering. Built at module load
// because vocab is immutable for the session.
const RUBY = buildRubyAnnotator(VOCAB);

let _nextCardId = 1;
const cardId = () => "c" + (_nextCardId++);

// -- App ----------------------------------------------------------------------

function App() {
  const [phase, setPhase] = useState("boot");   // boot | file-pick | reconnect | fallback | ready
  const [status, setStatus] = useState("Loading…");
  const storageRef = useRef(null);
  const dbRef = useRef(null);
  const [settings, setSettings] = useState({});
  const [tab, setTab] = useState("revision");
  const [cards, dispatch] = useReducer(cardsReducer, []);
  const [inflight, setInflight] = useState(0);
  const [counts, setCounts] = useState({ pass: 0, fail: 0 });

  // Refs to read latest values inside async callbacks without stale closures.
  const cardsRef = useRef(cards);  useEffect(() => { cardsRef.current = cards; }, [cards]);
  const inflightRef = useRef(0);   useEffect(() => { inflightRef.current = inflight; }, [inflight]);
  const settingsRef = useRef(settings); useEffect(() => { settingsRef.current = settings; }, [settings]);

  configureOpenAI({
    vocab: VOCAB,
    grammar: GRAMMAR,
    getSettingFn: (key, def) => settingsRef.current[key] ?? def,
  });

  // -- Boot effect --
  useEffect(() => {
    (async () => {
      const forceMem = new URLSearchParams(location.search).get("mem") === "1";
      if (forceMem || !fsaaSupported()) { setPhase("fallback"); setStatus("This browser can't autosave to a file. Upload an existing .sqlite or start fresh; download to save manually."); return; }
      storageRef.current = await FileStorage.restore();
      if (storageRef.current.hasHandle) {
        if (await storageRef.current.hasPermission("readwrite")) await loadDb(false);
        else { setPhase("reconnect"); setStatus("Reconnect to your .sqlite file to continue."); }
      } else {
        setPhase("file-pick");
        setStatus("Pick or create a .sqlite file. It lives in your iCloud Drive and travels across devices.");
      }
    })().catch(reportFatal);
  }, []);

  // -- DB lifecycle --
  function hydrateFromDb(db) {
    setSettings(db.allSettings());
    setCounts(db.historyCounts());
    // Restore any drills the user generated but didn't answer last session.
    // Without this, reopening the file burns N generate+approve cycles
    // refilling a queue we already paid for.
    for (const p of db.listPending()) {
      dispatch({ type: "add", card: {
        id: cardId(), drill: p.drill, pendingId: p.id,
        state: "fresh", answer: "",
        judgeProgress: [null, null, null],
        verdicts: null, passed: null,
      }});
    }
    const k = db.getSetting("api_key", "");
    if (k) setApiKey(k);
    return Boolean(k);
  }

  async function loadDb(fresh) {
    setStatus("Loading database…");
    const s = storageRef.current;
    let bytes = null;
    if (s && !fresh) {
      bytes = await s.read();
      if (bytes.length === 0) fresh = true;
    }
    const db = await DrillDb.open(fresh ? null : bytes);
    if (s) db.onFlush = async (out) => { await s.write(out); };
    if (db.dirty) await db.flush();
    dbRef.current = db;
    const hasKey = hydrateFromDb(db);
    setPhase("ready");
    setStatus(hasKey
      ? buildReadyStatus()
      : (s ? `Database loaded (${s.name || "in memory"}).` : "In-memory database ready. Use Download to save."));
  }

  // Refill effect: maintain queue_target fresh+grading cards while auto-gen is
  // on. Logic lives in runtime.shouldRefill so it can be unit-tested without
  // touching the React reconciler. Depend on `cards` (the array reference) —
  // the reducer regenerates it on every state action, including grading→graded
  // transitions that free up slots. `cards.length` alone misses those.
  useEffect(() => {
    if (phase !== "ready") return;
    if (shouldRefill({
      cards,
      inflight,
      autoGenerate: settings.auto_generate === "1",
      queueTarget: parseInt(settings.queue_target || "5", 10),
      hasKey: hasApiKey(),
    })) kickOffOne();
  }, [phase, settings.auto_generate, settings.queue_target, cards, inflight]);

  // -- Imperative actions --
  async function kickOffOne() {
    if (!hasApiKey() || !dbRef.current) return;
    setInflight(n => n + 1);
    try {
      const drill = await generateDrill();
      const { passed } = await approveDrill(drill);
      if (passed) {
        // Persist the approved drill before showing it. If the user closes
        // the tab before answering, the next launch picks it up via
        // listPending instead of paying for another generation.
        const pendingId = dbRef.current?.insertPending(drill);
        dispatch({ type: "add", card: {
          id: cardId(), drill, pendingId,
          state: "fresh", answer: "",
          judgeProgress: [null, null, null],
          verdicts: null, passed: null,
        }});
      }
    } catch (err) {
      if (!err.skip) console.error("[prefetch]", err);
    } finally {
      setInflight(n => n - 1);
    }
  }

  async function startGrade(id, answer) {
    const card = cardsRef.current.find(c => c.id === id);
    if (!card || card.state !== "fresh" || !answer.trim()) return;
    dispatch({ type: "update", id, patch: {
      state: "grading", answer: answer.trim(), judgeProgress: [null, null, null],
    }});

    try {
      // Per-judge verdict objects flow in via callback; Reveal renders the
      // rationale as soon as a row settles, and a shimmer skeleton while pending.
      const onJudge = (i, v) => {
        dispatch({ type: "update", id, patch: {
          judgeProgress: cardsRef.current.find(c => c.id === id).judgeProgress.map(
            (jp, idx) => idx === i ? v : jp
          ),
        }});
      };
      const { passed, verdicts } = await gradeAnswer(card.drill, answer.trim(), onJudge);
      dbRef.current.insertHistory({
        ts: Date.now(),
        prompt_en: card.drill.prompt_en,
        reference_jp: card.drill.reference_jp,
        target_grammar_id: card.drill.target_grammar_id,
        target_grammar_label: card.drill.target_grammar_label,
        notes: card.drill.notes,
        user_answer: answer.trim(),
        verdict: passed ? "pass" : "fail",
        judges_json: JSON.stringify(verdicts),
      });
      dbRef.current.deletePending(card.pendingId);
      dispatch({ type: "update", id, patch: {
        state: passed ? "graded-pass" : "graded-fail",
        verdicts, passed,
      }});
      setCounts(dbRef.current.historyCounts());
    } catch (e) {
      dispatch({ type: "update", id, patch: {
        state: "fresh", judgeProgress: [null, null, null],
        gradingError: e && e.message ? e.message : String(e),
      }});
    }
  }

  function skipCard(id) {
    // Trash icon-btn — discard without recording history. (Earlier UX
    // had a separate "I have no idea" reveal button that recorded a fail;
    // now the peel sticker covers the visual reveal and the trash discards.
    // Users who peeked can still type the answer and submit if they want.)
    const card = cardsRef.current.find(c => c.id === id);
    if (card?.pendingId) dbRef.current?.deletePending(card.pendingId);
    dispatch({ type: "remove", id });
  }

  function updateSetting(key, value) {
    if (dbRef.current) dbRef.current.setSetting(key, value);
    setSettings(s => ({ ...s, [key]: value }));
    if (key === "api_key") {
      if (value) {
        setApiKey(value);
        setStatus(buildReadyStatus());
      } else {
        setApiKey(null);
        setStatus("API key cleared. Add a key to resume drilling.");
      }
    }
  }

  function buildReadyStatus() {
    const s = openAiStats();
    return `Ready. Vocab: ${s.vocab} · Grammar: ${s.grammar} (${s.grammarTotal - s.grammar} unverified excluded).`;
  }

  // -- File-section actions --
  async function fileOpen() {
    try { await storageRef.current.pickOpen(); await loadDb(false); }
    catch (e) { if (e?.name !== "AbortError") setStatus("Open failed: " + (e?.message || e)); }
  }
  async function fileCreate() {
    try {
      await storageRef.current.pickCreate();
      await storageRef.current.write(new Uint8Array(0));
      await loadDb(true);
    } catch (e) { if (e?.name !== "AbortError") setStatus("Create failed: " + (e?.message || e)); }
  }
  async function fileReconnect() {
    const ok = await storageRef.current.requestPermission("readwrite");
    if (!ok) { setStatus("Permission denied."); return; }
    await loadDb(false);
  }
  async function fileForget() {
    await storageRef.current.forget();
    setPhase("file-pick");
    setStatus("Pick or create a .sqlite file.");
  }
  async function uploadInMemory(file) {
    const bytes = new Uint8Array(await file.arrayBuffer());
    storageRef.current = null;
    const db = await DrillDb.open(bytes);
    if (db.dirty) await db.flush();
    dbRef.current = db;
    const hasKey = hydrateFromDb(db);
    setPhase("ready");
    setStatus(hasKey ? buildReadyStatus() : "In-memory database ready. Use Download to save.");
  }
  async function startInMemory() {
    storageRef.current = null;
    const db = await DrillDb.open(null);
    if (db.dirty) await db.flush();
    dbRef.current = db;
    hydrateFromDb(db);
    setPhase("ready");
    setStatus("In-memory database ready. Use Download to save.");
  }
  function downloadDb() {
    const db = dbRef.current; if (!db) return;
    const blob = new Blob([db.exportBytes()], { type: "application/vnd.sqlite3" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = "n4-drill.sqlite";
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  // -- Flush on unload --
  useEffect(() => {
    const beforeunload = () => { if (dbRef.current?.dirty && dbRef.current.onFlush) try { dbRef.current.flush(); } catch (_) {} };
    const visibilitychange = () => {
      if (document.visibilityState === "hidden" && dbRef.current?.dirty && dbRef.current.onFlush) {
        dbRef.current.flush().catch(() => {});
      }
    };
    window.addEventListener("beforeunload", beforeunload);
    document.addEventListener("visibilitychange", visibilitychange);
    return () => {
      window.removeEventListener("beforeunload", beforeunload);
      document.removeEventListener("visibilitychange", visibilitychange);
    };
  }, []);

  // Test surface (used by rodney smoke tests).
  if (typeof window !== "undefined") {
    window.__app = {
      get db() { return dbRef.current; },
      get storage() { return storageRef.current; },
      get cards() { return cardsRef.current; },
      get inflight() { return inflightRef.current; },
      get phase() { return phase; },
      get settings() { return settings; },
    };
  }

  // -- Render --
  return html`
    <div class="status-line">${status}</div>
    ${phase === "file-pick" && html`<${FilePickSection} onOpen=${fileOpen} onCreate=${fileCreate} />`}
    ${phase === "reconnect" && html`<${ReconnectSection} name=${storageRef.current?.name} onReconnect=${fileReconnect} onForget=${fileForget} />`}
    ${phase === "fallback" && html`<${FallbackSection} onUpload=${uploadInMemory} onNewMem=${startInMemory} />`}
    ${phase === "ready" && html`
      <${Tabs} active=${tab} onSwitch=${setTab} />
      ${tab === "revision" && html`<${RevisionTab}
        settings=${settings}
        onSetting=${updateSetting}
        onGenerate=${kickOffOne}
        cards=${cards}
        inflight=${inflight}
        onGrade=${startGrade}
        onSkip=${skipCard}
      />`}
      ${tab === "settings" && html`<${SettingsTab}
        settings=${settings}
        onSetting=${updateSetting}
        storage=${storageRef.current}
        onForget=${async () => { if (storageRef.current) { await storageRef.current.forget(); location.reload(); } }}
        onDownload=${downloadDb}
      />`}
      <${Stats} counts=${counts} db=${dbRef.current} />
    `}
  `;
}

// -- File-section components -------------------------------------------------

function FilePickSection({ onOpen, onCreate }) {
  return html`
    <section>
      <p><strong>Choose where drill history is stored.</strong> The .sqlite file lives in your iCloud Drive; the app keeps the file in sync as you study.</p>
      <div class="row">
        <button class="primary" onClick=${onOpen}>Open existing .sqlite…</button>
        <button onClick=${onCreate}>Create new .sqlite…</button>
      </div>
      <p class="muted">First-time setup: pick a folder in iCloud Drive and choose a filename. After that, this browser remembers it.</p>
    </section>
  `;
}

function ReconnectSection({ name, onReconnect, onForget }) {
  return html`
    <section>
      <p><strong>Reconnect to your file.</strong></p>
      <p>Last used: <code>${name || ""}</code></p>
      <div class="row">
        <button class="primary" onClick=${onReconnect}>Reconnect</button>
        <button onClick=${onForget}>Forget &amp; pick another…</button>
      </div>
      <p class="muted">Chrome requires a click after each launch to re-grant write permission to the file.</p>
    </section>
  `;
}

function FallbackSection({ onUpload, onNewMem }) {
  return html`
    <section>
      <p><strong>This browser can't autosave to a file.</strong> Use the upload/download path instead.</p>
      <div style="margin: 8px 0;">
        <label class="muted">Open existing .sqlite:</label>
        <input id="file-upload" type="file" accept=".sqlite,.sqlite3,.db,application/vnd.sqlite3"
          onChange=${(e) => { const f = e.target.files?.[0]; if (f) onUpload(f); }} />
      </div>
      <div class="row">
        <button onClick=${onNewMem}>Start fresh (in memory)</button>
      </div>
      <p class="muted">Drill history lives in this tab only. Use Download in Settings to save before closing.</p>
    </section>
  `;
}

// -- Tabs --------------------------------------------------------------------

function Tabs({ active, onSwitch }) {
  const tab = (name, label) => html`
    <button role="tab" aria-selected=${active === name} data-tab-target=${name}
      onClick=${() => onSwitch(name)}>${label}</button>
  `;
  return html`<div class="tabs" id="tabs" role="tablist">${tab("revision", "Revision")}${tab("settings", "Settings")}</div>`;
}

// -- Revision tab + cards ----------------------------------------------------

function RevisionTab({ settings, onSetting, onGenerate, cards, inflight, onGrade, onSkip }) {
  const autoOn = settings.auto_generate === "1";
  const showKeyHint = !hasApiKey();

  return html`
    <section>
      <div class="control-row">
        <span class="label">Tier</span>
        <div class="segmented" id="tier-seg">
          <label><input type="radio" name="tier" value="flex" checked=${settings.service_tier === "flex"} onChange=${() => onSetting("service_tier", "flex")} />Flex</label>
          <label><input type="radio" name="tier" value="default" checked=${settings.service_tier === "default"} onChange=${() => onSetting("service_tier", "default")} />Fast</label>
        </div>
      </div>
      <div class="control-row">
        <span class="label">Model</span>
        <div class="segmented" id="model-seg">
          <label><input type="radio" name="model" value="gpt-5.4-nano" checked=${settings.model === "gpt-5.4-nano"} onChange=${() => onSetting("model", "gpt-5.4-nano")} />Nano</label>
          <label><input type="radio" name="model" value="gpt-5.4-mini" checked=${settings.model === "gpt-5.4-mini"} onChange=${() => onSetting("model", "gpt-5.4-mini")} />Mini</label>
          <label><input type="radio" name="model" value="gpt-5.4" checked=${settings.model === "gpt-5.4"} onChange=${() => onSetting("model", "gpt-5.4")} />Full</label>
        </div>
      </div>
      ${showKeyHint && html`<div id="empty-hint" class="muted">Add your API key in Settings to begin.</div>`}
    </section>

    <div id="cards-stack">
      ${cards.map(c => html`<${Card} key=${c.id} card=${c} onGrade=${onGrade} onSkip=${onSkip} />`)}
      ${Array.from({ length: inflight }, (_, i) => html`<${Ghost} key=${"ghost-" + i} />`)}
    </div>

    <div class="controls-strip">
      <button class="icon-btn accent generate-btn" id="generate-one-btn"
        aria-label="Generate next" title="Generate next" onClick=${onGenerate}>
        <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
          <path d="M8 3v10M3 8h10"/>
        </svg>
      </button>
      <div class="auto-gen">
        <span class="label glyph" title="Auto-generate the next card after grading">∞</span>
        <label class="toggle">
          <input type="checkbox" id="auto-gen-toggle" checked=${autoOn}
            onChange=${(e) => onSetting("auto_generate", e.target.checked ? "1" : "0")} />
          <span class="slider"></span>
        </label>
      </div>
    </div>
  `;
}

function TrashIconBtn({ onClick }) {
  return html`
    <button class="icon-btn danger" aria-label="Discard card" title="Discard" onClick=${onClick}>
      <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
        <path d="M2.5 4h11M6.5 4V2.5h3V4M4 4l.7 9.2a1 1 0 0 0 1 .8h4.6a1 1 0 0 0 1-.8L12 4M6.5 7v4M9.5 7v4"/>
      </svg>
    </button>
  `;
}

function SubmitIconBtn({ onClick }) {
  return html`
    <button class="icon-btn accent" aria-label="Grade" title="Grade (↵ or ⌘↵)" onClick=${onClick}>
      <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
        <path d="M13 3v4a2 2 0 0 1-2 2H3M6 6 3 9l3 3"/>
      </svg>
    </button>
  `;
}

function Card({ card, onGrade, onSkip }) {
  // Uncontrolled while fresh — avoids re-rendering on every keystroke and
  // lets event handlers read e.target.value synchronously. When the card
  // transitions out of `fresh`, we re-render with a controlled value (the
  // submitted answer) and disable the input.
  const textRef = useRef(null);
  const ds = card.state;
  const fresh = ds === "fresh";
  const submit = () => onGrade(card.id, textRef.current?.value || "");
  // Cmd/Ctrl + Enter submits. Bare Enter does nothing — IMEs need Enter to
  // commit kana → kanji conversion and a plain-Enter submit would race the
  // composition end.
  const onKeyDown = (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key === "Enter") submit();
  };

  return html`
    <article class="card" data-state=${ds}>
      <div class="card-prompt">
        <span class="card-prompt-text">${card.drill.prompt_en}</span>
        ${fresh && html`<${TrashIconBtn} onClick=${() => onSkip(card.id)} />`}
      </div>

      <div class="model-answer">
        <div class="ref-jp"><${RubyText} text=${card.drill.reference_jp} /></div>
        ${fresh && html`
          <span class="peel" onClick=${(e) => e.currentTarget.classList.toggle("peeled")}></span>
          <span class="peel-fold"></span>
        `}
      </div>

      ${fresh
        ? html`
            <div class="answer-row">
              <input ref=${textRef} class="answer-input" lang="ja" type="text"
                placeholder="日本語で…" autocomplete="off" spellcheck=${false}
                onKeyDown=${onKeyDown} />
              <${SubmitIconBtn} onClick=${submit} />
            </div>`
        : html`<input class="answer-input" lang="ja" type="text" disabled value=${card.answer || ""} />`
      }

      ${card.gradingError && html`<div class="muted" style="color: var(--fail);">Grading failed: ${card.gradingError}</div>`}
      ${(ds === "grading" || ds === "graded-pass" || ds === "graded-fail") && html`<${Reveal} card=${card} />`}
    </article>
  `;
}

function Reveal({ card }) {
  // Render the final verdicts when available, falling back to the per-judge
  // progress (which contains verdict objects as each judge settles). This
  // lets rationales appear progressively during grading.
  const rows = card.verdicts || card.judgeProgress || [null, null, null];
  return html`
    <div class="card-reveal">
      <div class="row">
        <span class="pill">${card.drill.target_grammar_label || ""}</span>
      </div>
      ${card.drill.notes && html`<div class="muted">${card.drill.notes}</div>`}
      <div class="judges">
        ${rows.map((v, i) => {
          if (!v) {
            const shortCls = i % 2 === 1 ? " short" : "";
            return html`
              <div class="j reveal-judge pending" key=${i}>
                <span class="verdict-mark" aria-label="grading"></span>
                <span class=${"ghost-skel ghost-line" + shortCls}></span>
              </div>
            `;
          }
          const pass = v.verdict === "yes";
          return html`
            <div class="j reveal-judge" key=${i}>
              <span class=${"verdict-mark " + (pass ? "pass" : "fail")} aria-label=${pass ? "pass" : "fail"}>${pass ? "✓" : "✕"}</span>
              <span>${v.reason}</span>
            </div>
          `;
        })}
      </div>
    </div>
  `;
}

/**
 * Render a Japanese string with furigana annotations on any vocab word
 * the user has studied. Words without ruby data render as plain text.
 */
function RubyText({ text }) {
  const tokens = renderRuby(text || "", RUBY.map, RUBY.keys);
  return html`<span>${tokens.map((tok, i) => {
    if (tok.kind === "plain") return tok.text;
    return html`<span key=${i}>${tok.segments.map(([t, r], j) =>
      r
        ? html`<ruby key=${j}>${t}<rt>${r}</rt></ruby>`
        : t
    )}</span>`;
  })}</span>`;
}

function Ghost() {
  return html`
    <article class="card ghost" data-state="fresh">
      <div class="ghost-skel ghost-line"></div>
      <div class="ghost-skel ghost-line short"></div>
      <div class="ghost-skel ghost-block"></div>
    </article>
  `;
}

// -- Settings tab ------------------------------------------------------------

function SettingsTab({ settings, onSetting, storage, onForget, onDownload }) {
  const [showKey, setShowKey] = useState(false);
  const blurInt = (key, lo, hi, defVal) => (e) => {
    const v = Math.max(lo, Math.min(hi, parseInt(e.target.value, 10) || defVal));
    e.target.value = String(v);
    onSetting(key, String(v));
  };
  const blurFloat = (key, lo, hi, defVal) => (e) => {
    let v = parseFloat(e.target.value);
    if (!isFinite(v)) v = defVal;
    v = Math.max(lo, Math.min(hi, v));
    e.target.value = String(v);
    onSetting(key, String(v));
  };

  return html`
    <div id="tab-settings" data-tab="settings">
      <section>
        <h2>Steering instructions</h2>
        <p class="muted" style="margin: 0 0 6px;">Free-text guidance prepended to every generation request.</p>
        <textarea id="instructions" rows="3" placeholder="e.g. focus on ば conditionals; include cooking vocab"
          value=${settings.instructions || ""}
          onBlur=${(e) => onSetting("instructions", e.target.value)} />
      </section>

      <section>
        <h2>Sampling</h2>
        <p class="muted" style="margin: 0 0 8px;">How the runtime chooses what to put in front of the model on each generation call.</p>
        <div class="control-row">
          <span class="label">Grammar / call</span>
          <input id="grammar-sample-size" type="number" min="1" max="10" step="1"
            value=${settings.grammar_sample_size || "2"}
            onChange=${blurInt("grammar_sample_size", 1, 10, 2)} />
          <span class="muted">candidates offered (lower = focused, higher = wider).</span>
        </div>
        <div class="control-row">
          <span class="label">Vocab / call</span>
          <input id="vocab-sample-size" type="number" min="1" max="30" step="1"
            value=${settings.vocab_sample_size || "10"}
            onChange=${blurInt("vocab_sample_size", 1, 30, 10)} />
          <span class="muted">candidates offered.</span>
        </div>
        <div class="control-row">
          <span class="label">Temperature</span>
          <input id="temperature" type="number" min="0" max="2" step="0.05"
            value=${settings.temperature || "1"}
            onChange=${blurFloat("temperature", 0, 2, 1)} />
          <span class="muted">0 = deterministic, 1 = default, 2 = max randomness.</span>
        </div>
      </section>

      <section>
        <h2>Queue depth</h2>
        <div class="row">
          <span class="muted">When auto-generate is on, keep</span>
          <input id="queue-target" type="number" min="1" max="20" step="1"
            value=${settings.queue_target || "5"}
            onChange=${blurInt("queue_target", 1, 20, 5)} />
          <span class="muted">cards ready.</span>
        </div>
      </section>

      <section>
        <h2>File</h2>
        <p class="muted" style="margin: 0 0 6px;">Currently: <code>${storage?.name || "in-memory session"}</code></p>
        <div class="row">
          ${storage && html`<button id="settings-forget-btn" onClick=${onForget}>Forget &amp; pick another…</button>`}
          ${!storage && html`<button id="settings-download-btn" onClick=${onDownload}>Download .sqlite</button>`}
        </div>
      </section>

      <section>
        <h2>OpenAI API key</h2>
        <p class="muted" style="margin: 0 0 6px;">Stored in your .sqlite file. Clearing this field removes it.</p>
        <div class="row">
          <input id="api-key" type=${showKey ? "text" : "password"} autocomplete="off" spellcheck=${false} placeholder="sk-…" style="flex:1; min-width: 220px;"
            value=${settings.api_key || ""}
            onBlur=${(e) => onSetting("api_key", (e.target.value || "").trim())}
            onKeyDown=${(e) => { if (e.key === "Enter") e.target.blur(); }} />
          <button id="api-key-show" type="button" onClick=${() => setShowKey(s => !s)}>${showKey ? "Hide" : "Show"}</button>
        </div>
      </section>
    </div>
  `;
}

// -- Stats -------------------------------------------------------------------

function Stats({ counts, db }) {
  const total = counts.pass + counts.fail;
  if (!db) return null;
  const summary = "History · " + total + " drill" + (total === 1 ? "" : "s") +
    (total ? " · " + counts.pass + " pass / " + counts.fail + " miss" : "");
  const rows = db.listHistory(50);
  return html`
    <section id="stats-section">
      <details>
        <summary><span id="stats-summary">${summary}</span></summary>
        <div id="history-view">
          ${rows.map(r => html`
            <div class="drill-entry">
              <div class="meta">${r.verdict === "pass" ? "✓ " : "✗ "}${r.target_grammar_label || ""} · ${new Date(r.ts).toLocaleString()}</div>
              <div>EN: ${r.prompt_en}</div>
              <div>REF: <${RubyText} text=${r.reference_jp} /></div>
              <div>YOU: ${r.user_answer}</div>
            </div>
          `)}
        </div>
      </details>
    </section>
  `;
}

// -- Mount -------------------------------------------------------------------

function reportFatal(err) {
  console.error("fatal boot error:", err);
  const root = document.getElementById("root");
  if (root) root.textContent = "Fatal: " + (err && err.stack ? err.stack : String(err));
}

render(html`<${App} />`, document.getElementById("root"));
