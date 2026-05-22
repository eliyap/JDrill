// File System Access API + IndexedDB persistence of the file handle.
//
// Lifecycle:
//   - On first launch, the user picks an existing .sqlite file or saves a new
//     one. The FileSystemFileHandle goes into IndexedDB so we don't have to
//     prompt again next time.
//   - On relaunch, we read the handle back from IDB, but Chrome requires a
//     fresh user gesture to re-grant write permission. We surface a
//     "Reconnect" button for that.
//   - Mobile Safari has no FSAA; callers should check `isSupported()` and fall
//     back to the upload/download path.

const DB_NAME = "n4-drill-storage";
const STORE = "handles";
const KEY = "current";

export function isSupported() {
  return typeof window !== "undefined" && typeof window.showOpenFilePicker === "function";
}

function openIdb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      req.result.createObjectStore(STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function idbGet(key) {
  const idb = await openIdb();
  return new Promise((resolve, reject) => {
    const tx = idb.transaction(STORE, "readonly");
    const req = tx.objectStore(STORE).get(key);
    req.onsuccess = () => resolve(req.result || null);
    req.onerror = () => reject(req.error);
  });
}

async function idbSet(key, value) {
  const idb = await openIdb();
  return new Promise((resolve, reject) => {
    const tx = idb.transaction(STORE, "readwrite");
    tx.objectStore(STORE).put(value, key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

async function idbDelete(key) {
  const idb = await openIdb();
  return new Promise((resolve, reject) => {
    const tx = idb.transaction(STORE, "readwrite");
    tx.objectStore(STORE).delete(key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

export class FileStorage {
  constructor(handle) {
    this.handle = handle || null;
  }

  static async restore() {
    const handle = await idbGet(KEY).catch(() => null);
    return new FileStorage(handle);
  }

  get name() { return this.handle ? this.handle.name : null; }
  get hasHandle() { return !!this.handle; }

  async hasPermission(mode = "readwrite") {
    if (!this.handle) return false;
    const opts = { mode };
    const status = await this.handle.queryPermission(opts);
    return status === "granted";
  }

  async requestPermission(mode = "readwrite") {
    if (!this.handle) return false;
    const opts = { mode };
    if ((await this.handle.queryPermission(opts)) === "granted") return true;
    const status = await this.handle.requestPermission(opts);
    return status === "granted";
  }

  async pickOpen() {
    const [handle] = await window.showOpenFilePicker({
      types: [{
        description: "SQLite database",
        accept: { "application/vnd.sqlite3": [".sqlite", ".sqlite3", ".db"] },
      }],
      multiple: false,
      excludeAcceptAllOption: false,
    });
    this.handle = handle;
    await idbSet(KEY, handle);
  }

  async pickCreate(suggestedName = "n4-drill.sqlite") {
    const handle = await window.showSaveFilePicker({
      suggestedName,
      types: [{
        description: "SQLite database",
        accept: { "application/vnd.sqlite3": [".sqlite"] },
      }],
    });
    this.handle = handle;
    await idbSet(KEY, handle);
  }

  async forget() {
    this.handle = null;
    await idbDelete(KEY);
  }

  async read() {
    if (!this.handle) throw new Error("no handle");
    const file = await this.handle.getFile();
    const buf = await file.arrayBuffer();
    return new Uint8Array(buf);
  }

  async write(bytes) {
    if (!this.handle) throw new Error("no handle");
    const w = await this.handle.createWritable();
    try {
      await w.write(bytes);
    } finally {
      await w.close();
    }
  }
}
