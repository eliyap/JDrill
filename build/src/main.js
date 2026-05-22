// Entry point. Wires the file picker, sql.js, OpenAI calls, and the drill
// stack. The drill UI is a chronological list of <article class="card">
// elements, each owning its own state machine (fresh → grading → graded).
// Multiple cards can be grading in parallel; the user is never blocked.

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

// -- DOM helpers --------------------------------------------------------------

const $ = (id) => document.getElementById(id);

function show(id, on) {
  const el = $(id);
  if (!el) return;
  if (on) el.removeAttribute("hidden");
  else el.setAttribute("hidden", "");
}

function setStatus(text) {
  const el = $("status-line");
  if (el) el.textContent = text;
}

function escapeText(s) {
  return String(s == null ? "" : s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

// -- Module state -------------------------------------------------------------

let storage = null;          // FileStorage
let db = null;               // DrillDb
let inflight = 0;            // generate+approve calls running
const cards = [];            // ordered array of Card instances

// -- Boot ---------------------------------------------------------------------

async function boot() {
  show("file-section", true);
  show("settings-section", false);
  show("drill-area", false);
  show("stats-section", false);

  const VOCAB = JSON.parse($("vocab").textContent || "[]");
  const GRAMMAR = JSON.parse($("grammar").textContent || "[]");
  configureOpenAI({
    vocab: VOCAB,
    grammar: GRAMMAR,
    getSettingFn: (key, def) => db ? db.getSetting(key, def) : def,
  });

  wireFileSection();
  wireSettingsSection();
  wireUnloadFlush();

  const forceMem = new URLSearchParams(location.search).get("mem") === "1";
  if (forceMem || !fsaaSupported()) {
    renderFsaaFallback();
    return;
  }

  storage = await FileStorage.restore();
  await renderFileSection();
}

// -- File section -------------------------------------------------------------

function wireFileSection() {
  $("file-open-btn").addEventListener("click", async () => {
    try {
      await storage.pickOpen();
      await loadFromHandle();
    } catch (e) {
      if (e && e.name === "AbortError") return;
      setStatus("Open failed: " + (e && e.message ? e.message : String(e)));
    }
  });
  $("file-create-btn").addEventListener("click", async () => {
    try {
      await storage.pickCreate();
      await storage.write(new Uint8Array(0));
      await loadFromHandle({ fresh: true });
    } catch (e) {
      if (e && e.name === "AbortError") return;
      setStatus("Create failed: " + (e && e.message ? e.message : String(e)));
    }
  });
  $("file-reconnect-btn").addEventListener("click", async () => {
    try {
      const ok = await storage.requestPermission("readwrite");
      if (!ok) { setStatus("Permission denied."); return; }
      await loadFromHandle();
    } catch (e) {
      setStatus("Reconnect failed: " + (e && e.message ? e.message : String(e)));
    }
  });
  $("file-forget-btn").addEventListener("click", async () => {
    await storage.forget();
    await renderFileSection();
  });
  const upload = $("file-upload");
  if (upload) {
    upload.addEventListener("change", async (e) => {
      const f = e.target.files && e.target.files[0];
      if (!f) return;
      const bytes = new Uint8Array(await f.arrayBuffer());
      await openInMemoryDb(bytes);
    });
  }
  const newMem = $("file-new-mem-btn");
  if (newMem) newMem.addEventListener("click", async () => { await openInMemoryDb(null); });
  const download = $("file-download-btn");
  if (download) {
    download.addEventListener("click", () => {
      if (!db) return;
      const bytes = db.exportBytes();
      const blob = new Blob([bytes], { type: "application/vnd.sqlite3" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url; a.download = "n4-drill.sqlite";
      document.body.appendChild(a); a.click(); document.body.removeChild(a);
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    });
  }
}

async function renderFileSection() {
  show("file-fsaa-pick", false);
  show("file-fsaa-reconnect", false);
  show("file-fallback", false);

  if (storage.hasHandle) {
    const granted = await storage.hasPermission("readwrite");
    if (granted) { await loadFromHandle(); return; }
    $("file-reconnect-name").textContent = storage.name || "";
    show("file-fsaa-reconnect", true);
    setStatus("Reconnect to your .sqlite file to continue.");
  } else {
    show("file-fsaa-pick", true);
    setStatus("Pick or create a .sqlite file. It lives in your iCloud Drive and travels across devices.");
  }
}

function renderFsaaFallback() {
  show("file-fsaa-pick", false);
  show("file-fsaa-reconnect", false);
  show("file-fallback", true);
  setStatus("This browser can't autosave to a file. Upload an existing .sqlite or start fresh; download to save manually.");
}

async function loadFromHandle({ fresh = false } = {}) {
  setStatus("Loading database…");
  let bytes = null;
  if (!fresh) {
    bytes = await storage.read();
    if (bytes.length === 0) fresh = true;
  }
  db = await DrillDb.open(fresh ? null : bytes);
  db.onFlush = async (out) => { await storage.write(out); };
  if (db.dirty) await db.flush();
  setStatus("Database loaded (" + (storage.name || "in memory") + ").");
  enterAppMode();
}

async function openInMemoryDb(bytes) {
  setStatus("Loading database (in-memory)…");
  db = await DrillDb.open(bytes);
  show("file-download-btn", true);
  setStatus("In-memory database ready. Use Download to save.");
  enterAppMode();
}

// -- Enter app mode -----------------------------------------------------------

function enterAppMode() {
  show("file-section", false);
  show("settings-section", true);
  show("drill-area", true);
  show("stats-section", true);

  $("api-key").value = db.getSetting("api_key", "");
  $("instructions").value = db.getSetting("instructions", "");

  // If a key is already saved, prime the OpenAI module and start drilling.
  const savedKey = db.getSetting("api_key", "");
  if (savedKey) {
    setApiKey(savedKey);
    onKeyAvailable();
  } else {
    setStatus("Enter your OpenAI API key in the settings field to start drilling.");
    $("empty-hint").textContent = "Enter your API key above to begin.";
    show("empty-hint", true);
  }

  window.__app = {
    db,
    storage,
    get cards() { return cards.slice(); },
    get inflight() { return inflight; },
  };

  refreshStats();
}

// -- Settings -----------------------------------------------------------------

function wireSettingsSection() {
  $("instructions").addEventListener("blur", function () {
    if (db) db.setSetting("instructions", this.value);
  });

  const keyEl = $("api-key");
  keyEl.addEventListener("blur", function () {
    if (!db) return;
    const v = (this.value || "").trim();
    const was = db.getSetting("api_key", "");
    if (v === was) return;
    db.setSetting("api_key", v);
    if (v) {
      setApiKey(v);
      onKeyAvailable();
    } else {
      setApiKey(null);
      setStatus("API key cleared. Add a key to resume drilling.");
    }
  });
  keyEl.addEventListener("keydown", function (e) {
    if (e.key === "Enter") this.blur();
  });

  $("api-key-show").addEventListener("click", function () {
    const el = $("api-key");
    if (el.type === "password") { el.type = "text"; this.textContent = "Hide"; }
    else { el.type = "password"; this.textContent = "Show"; }
  });
}

function onKeyAvailable() {
  const s = openAiStats();
  setStatus(`Ready. Vocab: ${s.vocab} · Grammar: ${s.grammar} (${s.grammarTotal - s.grammar} unverified excluded).`);
  refillQueue();
  updateEmptyHint();
}

// -- Drill stack --------------------------------------------------------------

class Card {
  constructor(drill) {
    this.drill = drill;
    this.state = "fresh";  // fresh | grading | graded
    this.answer = "";
    this.verdicts = null;
    this.passed = null;
    this.el = this._build();
  }

  _build() {
    const el = document.createElement("article");
    el.className = "card";
    el.dataset.state = "fresh";

    const stateRow = document.createElement("div");
    stateRow.className = "card-state-row";
    const statePill = document.createElement("span");
    statePill.className = "pill fresh";
    statePill.textContent = "fresh";
    stateRow.appendChild(statePill);
    el.appendChild(stateRow);

    const prompt = document.createElement("div");
    prompt.className = "card-prompt";
    prompt.textContent = this.drill.prompt_en;
    el.appendChild(prompt);

    const answer = document.createElement("textarea");
    answer.lang = "ja";
    answer.placeholder = "日本語で…";
    answer.autocomplete = "off";
    answer.spellcheck = false;
    el.appendChild(answer);

    const actions = document.createElement("div");
    actions.className = "card-actions";
    const grade = document.createElement("button");
    grade.className = "primary";
    grade.textContent = "Grade";
    const skip = document.createElement("button");
    skip.textContent = "Skip";
    actions.appendChild(grade);
    actions.appendChild(skip);
    el.appendChild(actions);

    const reveal = document.createElement("div");
    reveal.className = "card-reveal";
    reveal.hidden = true;
    el.appendChild(reveal);

    this._statePill = statePill;
    this._answerEl = answer;
    this._gradeBtn = grade;
    this._skipBtn = skip;
    this._revealEl = reveal;

    grade.addEventListener("click", () => this.startGrade());
    skip.addEventListener("click", () => this.skip());
    answer.addEventListener("keydown", (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "Enter") this.startGrade();
    });

    return el;
  }

  _renderJudgePanel() {
    // Replace the actions row with three pending judge pills. They'll be
    // mutated in place as judge promises resolve.
    const actions = this.el.querySelector(".card-actions");
    if (!actions) return;
    actions.innerHTML = "";
    actions.className = "card-judges-mini";
    for (let i = 0; i < 3; i++) {
      const pill = document.createElement("span");
      pill.className = "judge-pill pending";
      pill.dataset.judge = String(i);
      pill.textContent = `judge ${i + 1}`;
      actions.appendChild(pill);
    }
    this._judgesEl = actions;
  }

  _updateJudgeIndicator(i, verdict, err) {
    if (!this._judgesEl) return;
    const pill = this._judgesEl.querySelector(`[data-judge="${i}"]`);
    if (!pill) return;
    pill.classList.remove("pending");
    if (verdict && verdict.verdict === "yes") {
      pill.classList.add("pass");
      pill.textContent = `judge ${i + 1} ✓`;
    } else {
      pill.classList.add("fail");
      pill.textContent = `judge ${i + 1} ✗`;
    }
  }

  _setState(state) {
    this.state = state;
    this.el.dataset.state = state;
    if (state === "fresh") {
      this._statePill.className = "pill fresh";
      this._statePill.textContent = "fresh";
    } else if (state === "grading") {
      this._statePill.className = "pill grading";
      this._statePill.textContent = "grading…";
    } else if (state === "graded-pass" || (state === "graded" && this.passed)) {
      this._statePill.className = "pill pass";
      this._statePill.textContent = "✓ pass";
      this.el.dataset.state = "graded-pass";
    } else if (state === "graded-fail" || (state === "graded" && !this.passed)) {
      this._statePill.className = "pill fail";
      this._statePill.textContent = "✗ miss";
      this.el.dataset.state = "graded-fail";
    }
  }

  async startGrade() {
    if (this.state !== "fresh") return;
    const v = (this._answerEl.value || "").trim();
    if (!v) { this._answerEl.focus(); return; }
    this.answer = v;
    this._answerEl.disabled = true;
    this._gradeBtn.disabled = true;
    this._skipBtn.disabled = true;
    this._setState("grading");
    this._renderJudgePanel();
    updateQueueStatus();
    refillQueue();

    try {
      const onJudge = (i, v, err) => this._updateJudgeIndicator(i, v, err);
      const { passed, verdicts } = await gradeAnswer(this.drill, this.answer, onJudge);
      this.passed = passed;
      this.verdicts = verdicts;
      persistHistory(this.drill, this.answer, passed, verdicts);
      this._renderReveal();
      this._setState(passed ? "graded-pass" : "graded-fail");
      this._gradeBtn.remove();
      this._skipBtn.remove();
      refreshStats();
      updateQueueStatus();
    } catch (e) {
      // Allow retry: drop back to fresh state.
      this._setState("fresh");
      this._answerEl.disabled = false;
      this._gradeBtn.disabled = false;
      this._skipBtn.disabled = false;
      const err = document.createElement("div");
      err.className = "muted";
      err.style.color = "var(--fail)";
      err.textContent = "Grading failed: " + (e && e.message ? e.message : String(e));
      this.el.appendChild(err);
    }
  }

  skip() {
    if (this.state !== "fresh") return;
    // Remove from stack; refill will replace it.
    const idx = cards.indexOf(this);
    if (idx >= 0) cards.splice(idx, 1);
    this.el.remove();
    refillQueue();
    updateQueueStatus();
    updateEmptyHint();
  }

  _renderReveal() {
    const drill = this.drill;
    const reveal = this._revealEl;
    reveal.hidden = false;
    reveal.innerHTML = "";

    const pillRow = document.createElement("div");
    pillRow.className = "row";
    const tg = document.createElement("span");
    tg.className = "pill";
    tg.textContent = drill.target_grammar_label || "";
    pillRow.appendChild(tg);
    reveal.appendChild(pillRow);

    const ref = document.createElement("div");
    ref.className = "ref-jp";
    ref.textContent = drill.reference_jp;
    reveal.appendChild(ref);

    if (drill.notes) {
      const n = document.createElement("div");
      n.className = "muted";
      n.textContent = drill.notes;
      reveal.appendChild(n);
    }

    const judges = document.createElement("div");
    judges.className = "judges";
    this.verdicts.forEach((v, i) => {
      const row = document.createElement("div");
      row.className = "j";
      row.innerHTML = '<span class="pill ' + (v.verdict === "yes" ? "pass" : "fail") + '">judge ' + (i + 1) + ' · ' + v.verdict + '</span> ' + escapeText(v.reason);
      judges.appendChild(row);
    });
    reveal.appendChild(judges);
  }
}

function freshOrGradingCount() {
  return cards.reduce((n, c) => n + ((c.state === "fresh" || c.state === "grading") ? 1 : 0), 0);
}

function updateQueueStatus() {
  const el = $("queue-status");
  if (!el) return;
  const fresh = cards.reduce((n, c) => n + (c.state === "fresh" ? 1 : 0), 0);
  const grading = cards.reduce((n, c) => n + (c.state === "grading" ? 1 : 0), 0);
  // Generations in flight are shown visually as ghost cards, not text.
  el.textContent = fresh + " ready" + (grading ? " · " + grading + " grading" : "");
}

function updateEmptyHint() {
  const hint = $("empty-hint");
  if (!hint) return;
  if (!hasApiKey()) {
    hint.hidden = false;
    hint.textContent = "Enter your API key above to begin.";
    return;
  }
  // Ghosts are visible whenever generations are in flight, so the hint is
  // only useful in the brief window before the first ghost is appended.
  hint.hidden = true;
}

function createGhost() {
  // Apple-widget shimmer skeleton. Inserted as a real <article> at the
  // bottom of the stack while generation+approval runs; replaced in-place
  // with a Card on success, removed on failure.
  const el = document.createElement("article");
  el.className = "card ghost";
  el.innerHTML = `
    <div class="card-state-row">
      <span class="pill grading">generating…</span>
    </div>
    <div class="ghost-skel ghost-line"></div>
    <div class="ghost-skel ghost-block"></div>
    <div class="ghost-skel ghost-line short"></div>
  `;
  $("cards-stack").appendChild(el);
  return el;
}

function replaceGhostWithCard(ghost, drill) {
  const card = new Card(drill);
  cards.push(card);
  ghost.replaceWith(card.el);
  updateQueueStatus();
  updateEmptyHint();
  if (document.activeElement === document.body) {
    const firstFresh = cards.find(c => c.state === "fresh");
    if (firstFresh) firstFresh._answerEl.focus();
  }
}

function refillQueue() {
  if (!hasApiKey() || !db) return;
  const target = Math.max(1, parseInt(db.getSetting("queue_target", "5"), 10));
  while (freshOrGradingCount() + inflight < target) {
    inflight++;
    const ghost = createGhost();
    updateQueueStatus();
    updateEmptyHint();
    generateAndApprove()
      .then((drill) => {
        if (drill) replaceGhostWithCard(ghost, drill);
        else ghost.remove();
      })
      .catch((err) => {
        if (!err.skip) console.error("[prefetch]", err);
        ghost.remove();
      })
      .finally(() => {
        inflight--;
        updateQueueStatus();
        updateEmptyHint();
        const t2 = Math.max(1, parseInt(db.getSetting("queue_target", "5"), 10));
        if (hasApiKey() && freshOrGradingCount() + inflight < t2) {
          setTimeout(refillQueue, 50);
        }
      });
  }
}

async function generateAndApprove() {
  const drill = await generateDrill();
  const { passed, verdicts } = await approveDrill(drill);
  if (!passed) return null;  // [approval] log emitted inside approveDrill
  drill._approval = verdicts;
  return drill;
}

function persistHistory(drill, userAnswer, passed, verdicts) {
  db.insertHistory({
    ts: Date.now(),
    prompt_en: drill.prompt_en,
    reference_jp: drill.reference_jp,
    target_grammar_id: drill.target_grammar_id,
    target_grammar_label: drill.target_grammar_label,
    notes: drill.notes,
    user_answer: userAnswer,
    verdict: passed ? "pass" : "fail",
    judges_json: JSON.stringify(verdicts),
  });
}

// -- Stats / history ----------------------------------------------------------

function refreshStats() {
  if (!db) return;
  const counts = db.historyCounts();
  const total = counts.pass + counts.fail;
  $("stats-summary").textContent =
    "History · " + total + " drill" + (total === 1 ? "" : "s") +
    (total ? " · " + counts.pass + " pass / " + counts.fail + " miss" : "");
  const view = $("history-view");
  view.innerHTML = "";
  for (const row of db.listHistory(50)) {
    const el = document.createElement("div");
    el.className = "drill-entry";
    const meta = document.createElement("div");
    meta.className = "meta";
    const dt = new Date(row.ts);
    meta.textContent = (row.verdict === "pass" ? "✓ " : "✗ ") + (row.target_grammar_label || "") + " · " + dt.toLocaleString();
    el.appendChild(meta);
    const p = document.createElement("div"); p.textContent = "EN: " + row.prompt_en; el.appendChild(p);
    const r = document.createElement("div"); r.textContent = "REF: " + row.reference_jp; el.appendChild(r);
    const u = document.createElement("div"); u.textContent = "YOU: " + row.user_answer; el.appendChild(u);
    view.appendChild(el);
  }
}

// -- Flush on unload ----------------------------------------------------------

function wireUnloadFlush() {
  window.addEventListener("beforeunload", () => {
    if (db && db.dirty && db.onFlush) { try { db.flush(); } catch (_) {} }
  });
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden" && db && db.dirty && db.onFlush) {
      db.flush().catch(() => {});
    }
  });
}

// -- Run ----------------------------------------------------------------------

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", () => { boot().catch(reportFatal); });
} else {
  boot().catch(reportFatal);
}

function reportFatal(err) {
  console.error("fatal boot error:", err);
  setStatus("Fatal: " + (err && err.stack ? err.stack : String(err)));
}
