// sql.js wrapper: schema migrations, settings table, history table, and a
// debounced autosave hook. Pass `onFlush(bytes)` to wire it to disk; without
// one, the DB stays in memory (mobile Safari path).

import initSqlJs from "sql.js";
import WASM_B64 from "./wasm-binary.js";

let SQL = null;

function base64ToBytes(b64) {
  const bin = atob(b64);
  const arr = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
  return arr;
}

export async function loadSqlJs() {
  if (SQL) return SQL;
  SQL = await initSqlJs({ wasmBinary: base64ToBytes(WASM_B64) });
  return SQL;
}

const SCHEMA_V1 = `
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER NOT NULL,
  prompt_en TEXT NOT NULL,
  reference_jp TEXT NOT NULL,
  target_grammar_id TEXT,
  target_grammar_label TEXT,
  notes TEXT,
  user_answer TEXT NOT NULL,
  verdict TEXT NOT NULL,
  judges_json TEXT NOT NULL
);
PRAGMA user_version = 1;
`;

// v2: persist approved-but-unanswered drills so resuming a session doesn't
// re-spend tokens regenerating what was already in the user's queue.
const SCHEMA_V2 = `
CREATE TABLE IF NOT EXISTS pending_drills (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER NOT NULL,
  drill_json TEXT NOT NULL
);
PRAGMA user_version = 2;
`;

const DEFAULT_SETTINGS = {
  model: "gpt-5.4",
  service_tier: "flex",
  temperature: "1",
  grammar_sample_size: "2",
  vocab_sample_size: "10",
  queue_target: "5",
  instructions: "",
  auto_generate: "0",
};

export class DrillDb {
  constructor(db) {
    this.db = db;
    this.dirty = false;
    this.flushTimer = null;
    this.onFlush = null;       // async (Uint8Array) => void
    this.flushDelayMs = 5000;
    this.flushing = null;
  }

  static async open(bytes) {
    const sql = await loadSqlJs();
    const db = (bytes && bytes.length)
      ? new sql.Database(bytes)
      : new sql.Database();
    const out = new DrillDb(db);
    out._migrate();
    return out;
  }

  _migrate() {
    const v = this.userVersion();
    if (v < 1) {
      this.db.exec(SCHEMA_V1);
      this._seedDefaults();
      this.dirty = true;
    }
    if (v < 2) {
      this.db.exec(SCHEMA_V2);
      this.dirty = true;
    }
    // Backfill any setting that didn't exist when this DB was created.
    // Idempotent; runs on every open. New default keys added later (e.g.,
    // auto_generate) reach older DBs through this loop.
    for (const [k, dv] of Object.entries(DEFAULT_SETTINGS)) {
      if (!this._hasSetting(k)) this.setSetting(k, dv);
    }
  }

  _hasSetting(key) {
    const stmt = this.db.prepare("SELECT 1 FROM settings WHERE key = ?");
    try {
      stmt.bind([key]);
      return stmt.step();
    } finally {
      stmt.free();
    }
  }

  userVersion() {
    const r = this.db.exec("PRAGMA user_version");
    return r[0] ? r[0].values[0][0] : 0;
  }

  _seedDefaults() {
    const stmt = this.db.prepare("INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)");
    try {
      for (const [k, v] of Object.entries(DEFAULT_SETTINGS)) {
        stmt.run([k, v]);
      }
    } finally {
      stmt.free();
    }
  }

  getSetting(key, fallback) {
    const stmt = this.db.prepare("SELECT value FROM settings WHERE key = ?");
    try {
      stmt.bind([key]);
      if (stmt.step()) {
        return stmt.get()[0];
      }
      return fallback == null ? "" : fallback;
    } finally {
      stmt.free();
    }
  }

  setSetting(key, value) {
    const stmt = this.db.prepare(
      "INSERT INTO settings (key, value) VALUES (?, ?) " +
      "ON CONFLICT(key) DO UPDATE SET value = excluded.value"
    );
    try { stmt.run([key, String(value)]); } finally { stmt.free(); }
    this.markDirty();
  }

  allSettings() {
    const res = this.db.exec("SELECT key, value FROM settings");
    const out = {};
    if (res[0]) {
      for (const [k, v] of res[0].values) out[k] = v;
    }
    return out;
  }

  insertHistory(row) {
    const stmt = this.db.prepare(
      "INSERT INTO history (ts, prompt_en, reference_jp, target_grammar_id, target_grammar_label, notes, user_answer, verdict, judges_json) " +
      "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)"
    );
    try {
      stmt.run([
        row.ts,
        row.prompt_en,
        row.reference_jp,
        row.target_grammar_id || null,
        row.target_grammar_label || null,
        row.notes || null,
        row.user_answer,
        row.verdict,
        row.judges_json,
      ]);
    } finally {
      stmt.free();
    }
    this.markDirty();
  }

  listHistory(limit = 50) {
    const stmt = this.db.prepare(
      "SELECT id, ts, prompt_en, reference_jp, target_grammar_id, target_grammar_label, notes, user_answer, verdict, judges_json " +
      "FROM history ORDER BY id DESC LIMIT ?"
    );
    const out = [];
    try {
      stmt.bind([limit]);
      while (stmt.step()) {
        const r = stmt.getAsObject();
        out.push(r);
      }
    } finally {
      stmt.free();
    }
    return out;
  }

  // -- Pending drills (approved, awaiting user answer) -----------------------

  insertPending(drill) {
    const stmt = this.db.prepare(
      "INSERT INTO pending_drills (ts, drill_json) VALUES (?, ?)"
    );
    try { stmt.run([Date.now(), JSON.stringify(drill)]); }
    finally { stmt.free(); }
    const r = this.db.exec("SELECT last_insert_rowid()");
    const id = r[0] ? r[0].values[0][0] : null;
    this.markDirty();
    return id;
  }

  listPending() {
    const stmt = this.db.prepare(
      "SELECT id, ts, drill_json FROM pending_drills ORDER BY id ASC"
    );
    const out = [];
    try {
      while (stmt.step()) {
        const r = stmt.getAsObject();
        try {
          out.push({ id: r.id, ts: r.ts, drill: JSON.parse(r.drill_json) });
        } catch (_) { /* skip malformed */ }
      }
    } finally { stmt.free(); }
    return out;
  }

  deletePending(id) {
    if (id == null) return;
    const stmt = this.db.prepare("DELETE FROM pending_drills WHERE id = ?");
    try { stmt.run([id]); } finally { stmt.free(); }
    this.markDirty();
  }

  historyCounts() {
    const r = this.db.exec("SELECT verdict, COUNT(*) FROM history GROUP BY verdict");
    const out = { pass: 0, fail: 0 };
    if (r[0]) {
      for (const [v, n] of r[0].values) {
        if (v === "pass") out.pass = n;
        else out.fail = n;
      }
    }
    return out;
  }

  // -- Autosave ---------------------------------------------------------------

  markDirty() {
    this.dirty = true;
    if (!this.onFlush) return;
    if (this.flushTimer) clearTimeout(this.flushTimer);
    this.flushTimer = setTimeout(() => { this.flush(); }, this.flushDelayMs);
  }

  async flush() {
    if (this.flushTimer) { clearTimeout(this.flushTimer); this.flushTimer = null; }
    if (!this.dirty || !this.onFlush) return;
    // Serialize concurrent flushes — never overlap writes.
    if (this.flushing) await this.flushing;
    this.flushing = (async () => {
      const bytes = this.db.export();
      this.dirty = false;
      try {
        await this.onFlush(bytes);
      } catch (e) {
        // If the write failed, leave dirty=true so the next markDirty retries.
        this.dirty = true;
        throw e;
      }
    })();
    try { await this.flushing; } finally { this.flushing = null; }
  }

  exportBytes() {
    return this.db.export();
  }
}
