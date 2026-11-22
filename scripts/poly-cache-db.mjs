const DB_NAME = "boundless-light-poly-cache";
const DB_VERSION = 1;
const STORE_NAME = "levels";
const MAX_LEVEL_RECORDS = 64;

let _dbPromise = null;

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
  _dbPromise = null;
}

function openPolyCacheDB() {
  const idb = getIndexedDB();
  if (!idb) return Promise.resolve(null);
  if (_dbPromise) return _dbPromise;

  _dbPromise = new Promise((resolve) => {
    try {
      const req = idb.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(STORE_NAME)) {
          const store = db.createObjectStore(STORE_NAME, { keyPath: "key" });
          store.createIndex("updatedAt", "updatedAt", { unique: false });
        }
      };
      req.onsuccess = () => {
        const db = req.result;
        db.onversionchange = () => {
          try { db.close(); } catch {}
          _dbPromise = null;
        };
        resolve(db);
      };
      req.onerror = () => {
        _dbPromise = null;
        resolve(null);
      };
      req.onblocked = () => {
        _dbPromise = null;
        resolve(null);
      };
    } catch {
      _dbPromise = null;
      resolve(null);
    }
  });
  return _dbPromise;
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
    try {
      const tx = db.transaction(STORE_NAME, "readonly");
      const store = tx.objectStore(STORE_NAME);
      let pending = levelIds.length;
      const doneOne = () => {
        if (--pending <= 0) resolve(out);
      };
      for (const levelId of levelIds) {
        const key = makePolyCacheRecordKey(worldId, sceneId, levelId);
        const req = store.get(key);
        req.onsuccess = () => {
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
                offsets = new Float32Array(rawOffsets.buffer, rawOffsets.byteOffset, Math.floor(rawOffsets.byteLength / 4));
              } else if (Array.isArray(rawOffsets)) {
                offsets = Float32Array.from(rawOffsets);
              }
              out.set(lightId, { sig, offsets, hasNearbyWall: Boolean(hasNearbyWall) });
            }
          }
          doneOne();
        };
        req.onerror = doneOne;
      }
      tx.onerror = () => resolve(out);
      tx.onabort = () => resolve(out);
    } catch {
      resolve(out);
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
      tx.onerror = () => resolve(false);
      tx.onabort = () => resolve(false);
    } catch {
      resolve(false);
    }
  });

  if (saved && maxRecords > 0) {
    await _pruneOldRecords(db, maxRecords);
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
        const excess = (countReq.result || 0) - maxRecords;
        if (excess <= 0) return;
        const idx = store.index("updatedAt");
        let deleted = 0;
        const cursorReq = idx.openCursor();
        cursorReq.onsuccess = () => {
          const cursor = cursorReq.result;
          if (!cursor || deleted >= excess) return;
          cursor.delete();
          deleted++;
          cursor.continue();
        };
      };
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
      tx.onabort = () => resolve();
    } catch {
      resolve();
    }
  });
}

/**
 * Clear all persisted light polygon cache entries from IndexedDB (or only those matching `sceneId`).
 */
export async function clearPolyCacheDB(sceneId = null) {
  const db = await openPolyCacheDB();
  if (!db) return false;

  return new Promise((resolve) => {
    try {
      const tx = db.transaction(STORE_NAME, "readwrite");
      const store = tx.objectStore(STORE_NAME);
      if (!sceneId) {
        store.clear();
      } else {
        const cursorReq = store.openCursor();
        cursorReq.onsuccess = () => {
          const cursor = cursorReq.result;
          if (!cursor) return;
          if (cursor.value?.sceneId === sceneId) cursor.delete();
          cursor.continue();
        };
      }
      tx.oncomplete = () => resolve(true);
      tx.onerror = () => resolve(false);
      tx.onabort = () => resolve(false);
    } catch {
      resolve(false);
    }
  });
}
