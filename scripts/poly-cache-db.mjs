const DB_NAME = "boundless-light-poly-cache";
const DB_VERSION = 1;
const STORE_NAME = "levels";
const MAX_LEVEL_RECORDS = 64;

let _dbPromise = null;
let _openDb = null;

function getIndexedDB() {
  try {
    return typeof globalThis !== "undefined" ? (globalThis.indexedDB ?? null) : null;
  } catch {
    return null;
  }
}

export function makePolyCacheRecordKey(worldId, sceneId, levelId) {
  return `${worldId || "world"}::${sceneId || ""}::${levelId || ""}`;
}

export function isPolyCacheDBSupported() {
  return Boolean(getIndexedDB());
}

export function resetPolyCacheDBConnection() {
  if (_openDb) {
    try { _openDb.close(); } catch {}
    _openDb = null;
  }
  _dbPromise = null;
}

function handleDbTxError(err) {
  const name = err?.name || "";
  if (name === "InvalidStateError" || name === "NotFoundError" || name === "AbortError") {
    resetPolyCacheDBConnection();
  }
}

function openPolyCacheDB() {
  const idb = getIndexedDB();
  if (!idb) return Promise.resolve(null);
  if (_dbPromise) return _dbPromise;

  const p = new Promise((resolve) => {
    let settled = false;
    const finish = (val) => {
      if (settled) return false;
      settled = true;
      resolve(val);
      return true;
    };
    try {
      const req = idb.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        try {
          const db = req.result;
          if (!db.objectStoreNames.contains(STORE_NAME)) {
            const store = db.createObjectStore(STORE_NAME, { keyPath: "key" });
            store.createIndex("updatedAt", "updatedAt", { unique: false });
          }
        } catch {
          try { req.transaction?.abort(); } catch {}
        }
      };
      req.onsuccess = () => {
        const db = req.result;
        if (_dbPromise !== p) {
          try { db.close(); } catch {}
          finish(null);
          return;
        }
        if (!finish(db)) {
          try { db.close(); } catch {}
          return;
        }
        _openDb = db;
        const drop = () => {
          if (_openDb === db) _openDb = null;
          if (_dbPromise === p) _dbPromise = null;
        };
        db.onversionchange = () => {
          try { db.close(); } catch {}
          drop();
        };
        db.onclose = drop;
        db.onabort = drop;
      };
      req.onerror = (ev) => {
        try { ev?.preventDefault?.(); } catch {}
        if (_dbPromise === p) _dbPromise = null;
        finish(null);
      };
      req.onblocked = () => {
        if (_dbPromise === p) _dbPromise = null;
        finish(null);
      };
    } catch {
      if (_dbPromise === p) _dbPromise = null;
      finish(null);
    }
  });
  _dbPromise = p;
  return p;
}

/**
 * Load cached light shadow polygons for the given levels from IndexedDB.
 * Returns a Map<lightId, { sig: string, offsets: Float32Array | null, hasNearbyWall: boolean }>.
 */
export async function loadLevelPolysFromDB(worldId, sceneId, levelIds) {
  const out = new Map();
  if (!sceneId || !Array.isArray(levelIds) || !levelIds.length) return out;
  const db = await openPolyCacheDB();
  if (!db) return out;

  return new Promise((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      resolve(out);
    };
    try {
      const tx = db.transaction(STORE_NAME, "readonly");
      const store = tx.objectStore(STORE_NAME);
      let pending = levelIds.length;
      const doneOne = () => {
        if (--pending <= 0) finish();
      };
      for (const levelId of levelIds) {
        const key = makePolyCacheRecordKey(worldId, sceneId, levelId);
        const req = store.get(key);
        req.onsuccess = () => {
          try {
            const rec = req.result;
            if (rec && Array.isArray(rec.entries)) {
              for (const row of rec.entries) {
                if (!Array.isArray(row) || row.length < 4) continue;
                const [lightId, sig, rawOffsets, hasNearbyWall] = row;
                if (typeof lightId !== "string" || typeof sig !== "string") continue;
                let offsets = null;
                if (rawOffsets instanceof Float32Array) {
                  offsets = rawOffsets;
                } else if (ArrayBuffer.isView(rawOffsets)) {
                  const len = Math.floor(rawOffsets.byteLength / 4);
                  if (len > 0) {
                    if ((rawOffsets.byteOffset & 3) === 0) {
                      offsets = new Float32Array(rawOffsets.buffer, rawOffsets.byteOffset, len);
                    } else {
                      const copy = rawOffsets.buffer.slice(rawOffsets.byteOffset, rawOffsets.byteOffset + len * 4);
                      offsets = new Float32Array(copy);
                    }
                  }
                } else if (Array.isArray(rawOffsets)) {
                  offsets = Float32Array.from(rawOffsets);
                }
                out.set(lightId, { sig, offsets, hasNearbyWall: Boolean(hasNearbyWall) });
              }
            }
          } catch {}
          finally {
            doneOne();
          }
        };
        req.onerror = (ev) => {
          try { ev?.preventDefault?.(); } catch {}
          doneOne();
        };
      }
      tx.oncomplete = finish;
      tx.onerror = (ev) => { try { ev?.preventDefault?.(); } catch {} finish(); };
      tx.onabort = finish;
    } catch (err) {
      handleDbTxError(err);
      finish();
    }
  });
}

/**
 * Persist computed light shadow polygons per level to IndexedDB and prune old records beyond MAX_LEVEL_RECORDS.
 * `entriesByLevel` is Map<levelId, Array<[lightId, sig, Float32Array | null, boolean]>>.
 */
export async function saveLevelPolysToDB(worldId, sceneId, entriesByLevel, { maxRecords = MAX_LEVEL_RECORDS } = {}) {
  if (!sceneId || !(entriesByLevel instanceof Map) || !entriesByLevel.size) return false;
  const db = await openPolyCacheDB();
  if (!db) return false;

  const now = Date.now();
  let quotaHit = false;
  const saved = await new Promise((resolve) => {
    try {
      const tx = db.transaction(STORE_NAME, "readwrite");
      const store = tx.objectStore(STORE_NAME);
      for (const [levelId, entries] of entriesByLevel) {
        if (!levelId || !Array.isArray(entries) || !entries.length) continue;
        store.put({
          key: makePolyCacheRecordKey(worldId, sceneId, levelId),
          worldId: worldId || "world",
          sceneId,
          levelId,
          updatedAt: now,
          entries
        });
      }
      tx.oncomplete = () => resolve(true);
      tx.onerror = (ev) => {
        try { ev?.preventDefault?.(); } catch {}
        const err = tx.error;
        if (err?.name === "QuotaExceededError") quotaHit = true;
        else handleDbTxError(err);
        resolve(false);
      };
      tx.onabort = () => {
        const err = tx.error;
        if (err?.name === "QuotaExceededError") quotaHit = true;
        else handleDbTxError(err);
        resolve(false);
      };
    } catch (err) {
      if (err?.name === "QuotaExceededError") quotaHit = true;
      else handleDbTxError(err);
      resolve(false);
    }
  });

  if (quotaHit && maxRecords > 0) {
    const freshDb = await openPolyCacheDB();
    if (freshDb) await _pruneOldRecords(freshDb, Math.max(4, Math.floor(maxRecords / 2)));
  } else if (saved && maxRecords > 0) {
    const freshDb = await openPolyCacheDB();
    if (freshDb) await _pruneOldRecords(freshDb, maxRecords);
  }
  return saved;
}

function _pruneOldRecords(db, maxRecords) {
  return new Promise((resolve) => {
    try {
      const tx = db.transaction(STORE_NAME, "readwrite");
      const store = tx.objectStore(STORE_NAME);
      const countReq = store.count();
      countReq.onsuccess = () => {
        try {
          const excess = (countReq.result || 0) - maxRecords;
          if (excess <= 0) return;
          const idx = store.index("updatedAt");
          let deleted = 0;
          const cursorReq = idx.openCursor();
          cursorReq.onsuccess = () => {
            try {
              const cursor = cursorReq.result;
              if (!cursor || deleted >= excess) return;
              cursor.delete();
              deleted++;
              cursor.continue();
            } catch {}
          };
          cursorReq.onerror = (ev) => { try { ev?.preventDefault?.(); } catch {} };
        } catch {}
      };
      countReq.onerror = (ev) => { try { ev?.preventDefault?.(); } catch {} };
      tx.oncomplete = () => resolve();
      tx.onerror = (ev) => { try { ev?.preventDefault?.(); } catch {} resolve(); };
      tx.onabort = () => resolve();
    } catch (err) {
      handleDbTxError(err);
      resolve();
    }
  });
}

/**
 * Clear all persisted light polygon cache entries from IndexedDB (or only those matching `sceneId`, optionally scoped by `worldId`).
 */
export async function clearPolyCacheDB(sceneId = null, worldId = null) {
  const db = await openPolyCacheDB();
  if (!db) return false;

  return new Promise((resolve) => {
    try {
      const tx = db.transaction(STORE_NAME, "readwrite");
      const store = tx.objectStore(STORE_NAME);
      if (!sceneId && !worldId) {
        store.clear();
      } else {
        const cursorReq = store.openCursor();
        cursorReq.onsuccess = () => {
          try {
            const cursor = cursorReq.result;
            if (!cursor) return;
            const v = cursor.value;
            const sceneMatch = !sceneId || v?.sceneId === sceneId;
            const worldMatch = !worldId || v?.worldId === worldId;
            if (sceneMatch && worldMatch) cursor.delete();
            cursor.continue();
          } catch {}
        };
        cursorReq.onerror = (ev) => { try { ev?.preventDefault?.(); } catch {} };
      }
      tx.oncomplete = () => resolve(true);
      tx.onerror = (ev) => { try { ev?.preventDefault?.(); } catch {} handleDbTxError(tx.error); resolve(false); };
      tx.onabort = () => { handleDbTxError(tx.error); resolve(false); };
    } catch (err) {
      handleDbTxError(err);
      resolve(false);
    }
  });
}
