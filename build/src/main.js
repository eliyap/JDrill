// Entry point. Wires the file picker, tab switching, drill-stack rendering,
// and the OpenAI cycle.
//
// State machine (post-boot):
//   - file-section visible until the user opens / creates / uploads a .sqlite
//   - then tabs (Revision | Settings) appear; default tab is Revision
//
// Auto-gen toggle defaults OFF for cost control. With it off, the user must
// click "Generate next" once per drill they want. With it on, the runtime
// maintains queue_target ready cards via background refill.

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

let storage = null;          // FileStorage | null (null in in-memory fallback)
let db = null;
let inflight = 0;
const cards = [];

// -- Boot ---------------------------------------------------------------------

async function boot() {
  show("file-section", true);
  show("tabs", false);
  show("tab-revision", false);
  show("tab-settings", false);
  show("stats-section", false);

  const VOCAB = JSON.parse($("vocab").textContent || "[]");
  const GRAMMAR = JSON.parse($("grammar").textContent || "[]");
  configureOpenAI({
    vocab: VOCAB,
    grammar: GRAMMAR,
    getSettingFn: (key, def) => db ? db.getSetting(key, def) : def,
  });

  wireFileSection();
  wireTabs();
  wireControls();
  wireSettings();
  wireUnloadFlush();

  const forceMem = new URLSearchParams(location.search).get("mem") === "1";
  if (forceMem || !fsaaSupported()) {
    renderFsaaFallback();
    return;
  }

  storage = await FileStorage.restore();
  await renderFileSection();
}

// -- Tab switching ------------------------------------------------------------

function wireTabs() {
  document.querySelectorAll('[role="tab"]').forEach((btn) => {
    btn.addEventListener("click", () => switchTab(btn.dataset.tabTarget));
  });
}

function switchTab(target) {
  document.querySelectorAll('[role="tab"]').forEach((b) => {
    b.setAttribute("aria-selected", b.dataset.tabTarget === target ? "true" : "false");
  });
  document.querySelectorAll('[data-tab]').forEach((s) => {
    if (s.dataset.tab === target) s.removeAttribute("hidden");
    else s.setAttribute("hidden", "");
  });
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
  if (download) download.addEventListener("click", downloadDb);

  // Settings-tab equivalents that act on the live (post-boot) state.
  $("settings-forget-btn").addEventListener("click", async () => {
    if (!storage) return;
    await storage.forget();
    location.reload();
  });
  $("settings-download-btn").addEventListener("click", downloadDb);
}

function downloadDb() {
  if (!db) return;
  const bytes = db.exportBytes();
  const blob = new Blob([bytes], { type: "application/vnd.sqlite3" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = "n4-drill.sqlite";
  document.body.appendChild(a); a.click(); document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
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
  show("settings-download-btn", true);
  setStatus("In-memory database ready. Use Download to save.");
  enterAppMode();
}

// -- Enter app mode -----------------------------------------------------------

function enterAppMode() {
  show("file-section", false);
  show("tabs", true);
  show("stats-section", true);
  switchTab("revision");

  hydrateControlsFromDb();

  // File-controls section in Settings tab.
  if (storage && storage.name) {
    $("current-file-name").textContent = storage.name;
    show("file-controls-section", true);
    show("settings-forget-btn", true);
    show("settings-download-btn", false);
  } else {
    show("file-controls-section", true);
    $("current-file-name").textContent = "in-memory session";
    show("settings-forget-btn", false);
    show("settings-download-btn", true);
  }

  const savedKey = db.getSetting("api_key", "");
  if (savedKey) {
    setApiKey(savedKey);
    onKeyAvailable();
  } else {
    setStatus("Add your OpenAI API key in Settings to begin.");
  }

  window.__app = {
    db,
    storage,
    get cards() { return cards.slice(); },
    get inflight() { return inflight; },
  };

  refreshStats();
  updateEmptyHint();
  updateQueueStatus();
}

function onKeyAvailable() {
  const s = openAiStats();
  setStatus(`Ready. Vocab: ${s.vocab} · Grammar: ${s.grammar} (${s.grammarTotal - s.grammar} unverified excluded).`);
  refillQueue();
  updateEmptyHint();
}

// -- Controls (Revision tab) --------------------------------------------------

function hydrateControlsFromDb() {
  // Tier
  const tier = db.getSetting("service_tier", "flex");
  const tierRadio = document.querySelector(`#tier-seg input[value="${tier}"]`);
  if (tierRadio) tierRadio.checked = true;

  // Model
  const model = db.getSetting("model", "gpt-5.4");
  let modelRadio = document.querySelector(`#model-seg input[value="${model}"]`);
  if (!modelRadio) {
    // Unrecognized model (e.g., user typed gpt-5.5 manually); default the
    // selector to Full so the user sees something selected and can pick.
    modelRadio = document.querySelector('#model-seg input[value="gpt-5.4"]');
  }
  if (modelRadio) modelRadio.checked = true;

  // Auto-gen
  const auto = db.getSetting("auto_generate", "0") === "1";
  $("auto-gen-toggle").checked = auto;

  // Queue target
  $("queue-target").value = db.getSetting("queue_target", "5");

  // Sampling
  $("grammar-sample-size").value = db.getSetting("grammar_sample_size", "2");
  $("vocab-sample-size").value = db.getSetting("vocab_sample_size", "10");
  $("temperature").value = db.getSetting("temperature", "1");

  // Instructions
  $("instructions").value = db.getSetting("instructions", "");

  // API key
  $("api-key").value = db.getSetting("api_key", "");
}

function wireControls() {
  document.querySelectorAll('#tier-seg input').forEach((r) => {
    r.addEventListener("change", () => {
      if (r.checked && db) db.setSetting("service_tier", r.value);
    });
  });
  document.querySelectorAll('#model-seg input').forEach((r) => {
    r.addEventListener("change", () => {
      if (r.checked && db) db.setSetting("model", r.value);
    });
  });
  $("auto-gen-toggle").addEventListener("change", function () {
    if (!db) return;
    db.setSetting("auto_generate", this.checked ? "1" : "0");
    if (this.checked && hasApiKey()) refillQueue();
    updateEmptyHint();
  });
  $("generate-one-btn").addEventListener("click", () => {
    if (!hasApiKey()) {
      setStatus("Add your API key in Settings first.");
      return;
    }
    kickOffOneGeneration();
  });
}

// -- Settings tab handlers ----------------------------------------------------

function wireSettings() {
  $("instructions").addEventListener("blur", function () {
    if (db) db.setSetting("instructions", this.value);
  });
  $("queue-target").addEventListener("change", function () {
    if (!db) return;
    const v = Math.max(1, Math.min(20, parseInt(this.value, 10) || 5));
    this.value = String(v);
    db.setSetting("queue_target", String(v));
    if (hasApiKey()) refillQueue();
  });

  function wireIntInput(id, key, defVal, lo, hi) {
    $(id).addEventListener("change", function () {
      if (!db) return;
      const v = Math.max(lo, Math.min(hi, parseInt(this.value, 10) || defVal));
      this.value = String(v);
      db.setSetting(key, String(v));
    });
  }
  function wireFloatInput(id, key, defVal, lo, hi) {
    $(id).addEventListener("change", function () {
      if (!db) return;
      let v = parseFloat(this.value);
      if (!isFinite(v)) v = defVal;
      v = Math.max(lo, Math.min(hi, v));
      this.value = String(v);
      db.setSetting(key, String(v));
    });
  }
  wireIntInput("grammar-sample-size", "grammar_sample_size", 2, 1, 10);
  wireIntInput("vocab-sample-size", "vocab_sample_size", 10, 1, 30);
  wireFloatInput("temperature", "temperature", 1, 0, 2);

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
      updateEmptyHint();
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

// -- Drill stack --------------------------------------------------------------

class Card {
  constructor(drill) {
    this.drill = drill;
    this.state = "fresh";
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

  _setState(state) {
    this.state = state;
    if (state === "fresh") {
      this.el.dataset.state = "fresh";
      this._statePill.className = "pill fresh"; this._statePill.textContent = "fresh";
    } else if (state === "grading") {
      this.el.dataset.state = "grading";
      this._statePill.className = "pill grading"; this._statePill.textContent = "grading…";
    } else if (state === "graded-pass") {
      this.el.dataset.state = "graded-pass";
      this._statePill.className = "pill pass"; this._statePill.textContent = "✓ pass";
    } else if (state === "graded-fail") {
      this.el.dataset.state = "graded-fail";
      this._statePill.className = "pill fail"; this._statePill.textContent = "✗ miss";
    }
  }

  _renderJudgePanel() {
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
      pill.classList.add("pass"); pill.textContent = `judge ${i + 1} ✓`;
    } else {
      pill.classList.add("fail"); pill.textContent = `judge ${i + 1} ✗`;
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
      refreshStats();
      updateQueueStatus();
    } catch (e) {
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
    const idx = cards.indexOf(this);
    if (idx >= 0) cards.splice(idx, 1);
    this.el.remove();
    if (db && db.getSetting("auto_generate", "0") === "1") refillQueue();
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
  el.textContent = fresh + " ready" + (grading ? " · " + grading + " grading" : "");
}

function updateEmptyHint() {
  const hint = $("empty-hint");
  if (!hint) return;
  if (!hasApiKey()) {
    hint.hidden = false;
    hint.textContent = "Add your API key in Settings to begin.";
    return;
  }
  const autoOn = db && db.getSetting("auto_generate", "0") === "1";
  const hasCards = cards.length > 0 || inflight > 0;
  if (!hasCards && !autoOn) {
    hint.hidden = false;
    hint.textContent = "Press “Generate next” to create a drill. Toggle Auto-gen on if you'd rather have a steady queue.";
    return;
  }
  hint.hidden = true;
}

function createGhost() {
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

function kickOffOneGeneration() {
  if (!hasApiKey() || !db) return;
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
      if (db.getSetting("auto_generate", "0") === "1") {
        const t = Math.max(1, parseInt(db.getSetting("queue_target", "5"), 10));
        if (hasApiKey() && freshOrGradingCount() + inflight < t) {
          setTimeout(refillQueue, 50);
        }
      }
    });
}

function refillQueue() {
  if (!hasApiKey() || !db) return;
  if (db.getSetting("auto_generate", "0") !== "1") return;
  const target = Math.max(1, parseInt(db.getSetting("queue_target", "5"), 10));
  while (freshOrGradingCount() + inflight < target) {
    kickOffOneGeneration();
  }
}

async function generateAndApprove() {
  const drill = await generateDrill();
  const { passed } = await approveDrill(drill);
  if (!passed) return null;
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
