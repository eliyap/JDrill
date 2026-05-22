// Entry point. Wires the file picker, sql.js, OpenAI calls, and the drill
// cycle. Boot order:
//   1. Parse inline VOCAB/GRAMMAR JSON. Configure openai prompts.
//   2. Try to restore the FileSystemFileHandle from IndexedDB.
//   3. Render the appropriate first screen (pick file / reconnect / key entry).
//   4. After the user enters a key, start the prefetch queue and render drills.

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
const queue = [];
let inflight = 0;
let currentDrill = null;

// -- Boot ---------------------------------------------------------------------

async function boot() {
  // Reset all UI sections — only #file-section is visible to start. This is
  // belt-and-braces; we own the page now (no MiniClay) but a stale tab cached
  // before a code update could otherwise look broken.
  show("file-section", true);
  show("key-section", false);
  show("settings-section", false);
  show("drill-card", false);
  show("reveal-panel", false);
  show("stats-section", false);

  // Parse inline corpus.
  const VOCAB = JSON.parse($("vocab").textContent || "[]");
  const GRAMMAR = JSON.parse($("grammar").textContent || "[]");
  configureOpenAI({
    vocab: VOCAB,
    grammar: GRAMMAR,
    getSettingFn: (key, def) => db ? db.getSetting(key, def) : def,
  });

  wireFileSection();
  wireKeySection();
  wireSettingsSection();
  wireDrillSection();
  wireRevealSection();
  wireUnloadFlush();

  // `?mem=1` forces the in-memory fallback even on browsers with FSAA. Useful
  // for testing on Chrome without binding a real iCloud file, and as a
  // "private session" mode that won't touch your stored handle.
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
      // Write an initial empty file so the handle is valid + persisted.
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
      if (!ok) {
        setStatus("Permission denied.");
        return;
      }
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
  if (newMem) {
    newMem.addEventListener("click", async () => {
      await openInMemoryDb(null);
    });
  }
  const download = $("file-download-btn");
  if (download) {
    download.addEventListener("click", () => {
      if (!db) return;
      const bytes = db.exportBytes();
      const blob = new Blob([bytes], { type: "application/vnd.sqlite3" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = "n4-drill.sqlite";
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    });
  }
}

async function renderFileSection() {
  // Decide which controls to show. Mobile Safari path is handled separately
  // via renderFsaaFallback().
  show("file-fsaa-pick", false);
  show("file-fsaa-reconnect", false);
  show("file-fallback", false);

  if (storage.hasHandle) {
    const granted = await storage.hasPermission("readwrite");
    if (granted) {
      // Already permitted; load straight away.
      await loadFromHandle();
      return;
    }
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
    if (bytes.length === 0) {
      // Treat zero-byte (just-created) as fresh.
      fresh = true;
    }
  }
  db = await DrillDb.open(fresh ? null : bytes);
  db.onFlush = async (out) => { await storage.write(out); };
  // Force an immediate flush after seeding/migration so the file on disk is
  // never zero-byte after a successful "Create new".
  if (db.dirty) await db.flush();
  setStatus("Database loaded (" + (storage.name || "in memory") + ").");
  enterAppMode();
}

async function openInMemoryDb(bytes) {
  setStatus("Loading database (in-memory)…");
  db = await DrillDb.open(bytes);
  // onFlush stays null — autosave disabled. User must use "Download .sqlite".
  show("file-download-btn", true);
  setStatus("In-memory database ready. Use Download to save.");
  enterAppMode();
}

// -- Enter app mode -----------------------------------------------------------

function enterAppMode() {
  show("file-section", false);
  show("key-section", !hasApiKey());
  show("settings-section", hasApiKey());
  show("drill-card", hasApiKey());
  show("stats-section", true);

  // Expose for devtools poking. Not load-bearing; safe to call anything here.
  window.__app = { db, storage, queue, get currentDrill() { return currentDrill; } };

  // Hydrate the instructions textarea from settings.
  $("instructions").value = db.getSetting("instructions", "");

  refreshStats();
  if (hasApiKey()) {
    renderCurrentDrill();
    refillQueue();
  }
}

// -- Key entry ----------------------------------------------------------------

function wireKeySection() {
  $("key-submit").addEventListener("click", onSubmitKey);
  $("api-key").addEventListener("keydown", (e) => {
    if (e.key === "Enter") onSubmitKey();
  });
}

function onSubmitKey() {
  const v = $("api-key").value.trim();
  if (!v) { alert("Paste an API key first."); return; }
  setApiKey(v);
  $("api-key").value = "";
  show("key-section", false);
  show("settings-section", true);
  show("drill-card", true);
  show("stats-section", true);
  const s = openAiStats();
  setStatus(`Ready. Vocab: ${s.vocab} · Grammar: ${s.grammar} (${s.grammarTotal - s.grammar} unverified excluded). Generating first drill…`);
  renderCurrentDrill();
  refillQueue();
}

// -- Settings -----------------------------------------------------------------

function wireSettingsSection() {
  $("instructions").addEventListener("blur", function () {
    db.setSetting("instructions", this.value);
  });
}

// -- Drill cycle --------------------------------------------------------------

function wireDrillSection() {
  $("grade-btn").addEventListener("click", onGrade);
  $("skip-btn").addEventListener("click", onSkip);
  $("user-answer").addEventListener("keydown", (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key === "Enter") onGrade();
  });
}

function wireRevealSection() {
  $("next-btn").addEventListener("click", onNext);
}

function updateQueueStatus() {
  const el = $("queue-status");
  if (!el) return;
  el.textContent = "Queue: " + queue.length + (inflight ? " (+" + inflight + " in flight)" : "");
}

function revealVisible() {
  const el = $("reveal-panel");
  return el && !el.hasAttribute("hidden");
}

function refillQueue() {
  if (!hasApiKey()) return;
  const target = Math.max(1, parseInt(db.getSetting("queue_target", "5"), 10));
  while (queue.length + inflight < target) {
    inflight++;
    generateAndApprove()
      .then((drill) => {
        if (drill) {
          queue.push(drill);
          if (currentDrill === null && !revealVisible()) {
            renderCurrentDrill();
          }
        }
      })
      .catch((err) => {
        if (!err.skip) console.error("prefetch error:", err);
      })
      .finally(() => {
        inflight--;
        updateQueueStatus();
        const t2 = Math.max(1, parseInt(db.getSetting("queue_target", "5"), 10));
        if (hasApiKey() && queue.length + inflight < t2) {
          setTimeout(refillQueue, 50);
        }
      });
  }
  updateQueueStatus();
}

async function generateAndApprove() {
  const drill = await generateDrill();
  const { passed, verdicts } = await approveDrill(drill);
  if (!passed) return null;
  drill._approval = verdicts;
  return drill;
}

function renderCurrentDrill() {
  if (!currentDrill) {
    if (queue.length === 0) {
      $("prompt-en").textContent = "Generating…";
      $("user-answer").value = "";
      $("user-answer").disabled = true;
      $("grade-btn").disabled = true;
      return;
    }
    currentDrill = queue.shift();
    refillQueue();
  }
  $("prompt-en").textContent = currentDrill.prompt_en;
  $("user-answer").value = "";
  $("user-answer").disabled = false;
  $("grade-btn").disabled = false;
  $("skip-btn").disabled = false;
  $("user-answer").focus();
  show("reveal-panel", false);
  show("drill-card", true);
}

async function onGrade() {
  if (!currentDrill) return;
  const answer = $("user-answer").value.trim();
  if (!answer) {
    alert("Type an answer first.");
    return;
  }
  $("grade-btn").disabled = true;
  $("skip-btn").disabled = true;
  $("user-answer").disabled = true;
  setStatus("Grading…");
  try {
    const { passed, verdicts } = await gradeAnswer(currentDrill, answer);
    persistHistory(currentDrill, answer, passed, verdicts);
    showReveal(currentDrill, passed, verdicts);
    refreshStats();
    setStatus("Saved.");
  } catch (e) {
    setStatus("Grading failed: " + e.message);
    $("grade-btn").disabled = false;
    $("skip-btn").disabled = false;
    $("user-answer").disabled = false;
  }
}

function showReveal(drill, passed, verdicts) {
  $("verdict-label").innerHTML = passed
    ? '<span class="verdict-pass">✓ Pass</span>'
    : '<span class="verdict-fail">✗ Miss</span>';
  $("target-grammar-pill").textContent = drill.target_grammar_label || "";
  $("reference-jp").textContent = drill.reference_jp;
  $("drill-notes").textContent = drill.notes || "";
  const judgesEl = $("judges");
  judgesEl.innerHTML = "";
  verdicts.forEach((v, i) => {
    const row = document.createElement("div");
    row.className = "j";
    row.innerHTML = '<span class="pill ' + (v.verdict === "yes" ? "pass" : "fail") + '">judge ' + (i + 1) + ' · ' + v.verdict + '</span> ' + escapeText(v.reason);
    judgesEl.appendChild(row);
  });
  show("reveal-panel", true);
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

function onNext() {
  currentDrill = null;
  renderCurrentDrill();
}

function onSkip() {
  currentDrill = null;
  renderCurrentDrill();
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
    const p = document.createElement("div"); p.className = "prompt"; p.textContent = "EN: " + row.prompt_en; el.appendChild(p);
    const r = document.createElement("div"); r.className = "reference"; r.textContent = "REF: " + row.reference_jp; el.appendChild(r);
    const u = document.createElement("div"); u.className = "user-answer"; u.textContent = "YOU: " + row.user_answer; el.appendChild(u);
    let judges = [];
    try { judges = JSON.parse(row.judges_json || "[]"); } catch (_) {}
    judges.forEach((j, i) => {
      const d = document.createElement("div");
      d.className = "j";
      d.textContent = "judge " + (i + 1) + ": " + j.verdict + " — " + j.reason;
      el.appendChild(d);
    });
    view.appendChild(el);
  }
}

// -- Flush on unload ----------------------------------------------------------

function wireUnloadFlush() {
  // Best-effort: synchronously flush via the SAA writable in a beforeunload.
  // We can't block tab close on async work, but if the user just navigates
  // away while the 5s timer is pending, this catches the unsaved write.
  window.addEventListener("beforeunload", () => {
    if (db && db.dirty && db.onFlush) {
      try { db.flush(); } catch (_) {}
    }
  });
  // visibilitychange catches mobile-style tab suspensions earlier.
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
