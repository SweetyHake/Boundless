import test from "node:test";
import assert from "node:assert/strict";
import { installFoundryMocks } from "./helpers/foundry-mock.mjs";

installFoundryMocks();

const {
  loadLevelPolysFromDB,
  saveLevelPolysToDB,
  clearPolyCacheDB,
  resetPolyCacheDBConnection
} = await import("../scripts/poly-cache-db.mjs");
const { MegaLightBatch, hashLevelWallGeometry } = await import("../scripts/light-batch.mjs");

function createFakeIndexedDB() {
  const records = new Map();
  const makeReq = (fn) => {
    const req = { result: undefined, onsuccess: null, onerror: null };
    queueMicrotask(() => {
      try {
        req.result = fn();
        req.onsuccess?.();
      } catch (err) {
        req.error = err;
        req.onerror?.();
      }
    });
    return req;
  };
  const db = {
    objectStoreNames: { contains: () => true },
    createObjectStore: () => ({ createIndex: () => {} }),
    close() {},
    transaction() {
      const tx = {
        oncomplete: null,
        onerror: null,
        onabort: null,
        objectStore() {
          return {
            get(key) {
              return makeReq(() => records.get(key));
            },
            put(val) {
              records.set(val.key, structuredClone(val));
              return makeReq(() => val.key);
            },
            clear() {
              records.clear();
              return makeReq(() => undefined);
            },
            count() {
              return makeReq(() => records.size);
            },
            index() {
              return {
                openCursor() {
                  const ordered = Array.from(records.values()).sort((a, b) => a.updatedAt - b.updatedAt);
                  let idx = 0;
                  const req = { result: null, onsuccess: null, onerror: null };
                  const advance = () => {
                    queueMicrotask(() => {
                      if (idx >= ordered.length) {
                        req.result = null;
                        req.onsuccess?.();
                        return;
                      }
                      const cur = ordered[idx++];
                      req.result = {
                        value: cur,
                        delete() { records.delete(cur.key); },
                        continue() { advance(); }
                      };
                      req.onsuccess?.();
                    });
                  };
                  advance();
                  return req;
                }
              };
            },
            openCursor() {
              const all = Array.from(records.values());
              let idx = 0;
              const req = { result: null, onsuccess: null, onerror: null };
              const advance = () => {
                queueMicrotask(() => {
                  if (idx >= all.length) {
                    req.result = null;
                    req.onsuccess?.();
                    return;
                  }
                  const cur = all[idx++];
                  req.result = {
                    value: cur,
                    delete() { records.delete(cur.key); },
                    continue() { advance(); }
                  };
                  req.onsuccess?.();
                });
              };
              advance();
              return req;
            }
          };
        }
      };
      setTimeout(() => tx.oncomplete?.(), 0);
      return tx;
    }
  };
  return {
    records,
    api: {
      open() {
        const req = { result: db, onupgradeneeded: null, onsuccess: null, onerror: null, onblocked: null };
        queueMicrotask(() => {
          req.onupgradeneeded?.();
          req.onsuccess?.();
        });
        return req;
      }
    }
  };
}

test("hashLevelWallGeometry is deterministic and invalidates when walls or doors change", () => {
  const secA = {
    "0_0": { w: [[100, 100, 400, 100, 20, 20, 20, 20, 0]], d: [[400, 100, 500, 100, 1, 0]] },
    "1_0": { w: [[500, 100, 900, 100, 20, 20, 20, 20, 0]] }
  };
  const secB = {
    "1_0": { w: [[500, 100, 900, 100, 20, 20, 20, 20, 0]] },
    "0_0": { w: [[100, 100, 400, 100, 20, 20, 20, 20, 0]], d: [[400, 100, 500, 100, 1, 0]] }
  };
  const secMoved = {
    "0_0": { w: [[100, 100, 405, 100, 20, 20, 20, 20, 0]], d: [[400, 100, 500, 100, 1, 0]] },
    "1_0": { w: [[500, 100, 900, 100, 20, 20, 20, 20, 0]] }
  };
  assert.equal(hashLevelWallGeometry(secA), hashLevelWallGeometry(secB));
  assert.notEqual(hashLevelWallGeometry(secA), hashLevelWallGeometry(secMoved));
});

test("poly-cache-db safely no-ops when indexedDB is unavailable", async () => {
  const prev = globalThis.indexedDB;
  try {
    globalThis.indexedDB = undefined;
    resetPolyCacheDBConnection();
    const map = await loadLevelPolysFromDB("w1", "s1", ["lvl1"]);
    assert.equal(map.size, 0);
    const ok = await saveLevelPolysToDB("w1", "s1", new Map([["lvl1", [["lvl1::0_0_0", "sig", null, false]]]]));
    assert.equal(ok, false);
  } finally {
    globalThis.indexedDB = prev;
    resetPolyCacheDBConnection();
  }
});

test("MegaLightBatch persists and hydrates Float32Array shadow polygons across simulated F5 reload", async () => {
  const prev = globalThis.indexedDB;
  const fake = createFakeIndexedDB();
  try {
    globalThis.indexedDB = fake.api;
    resetPolyCacheDBConnection();

    const batch1 = new MegaLightBatch();
    batch1._polyCacheSceneId = "sceneA";
    batch1._polyCache.set("lvl1::0_0_0", {
      sig: "100,200,400,360,0,1|lvl1|wg:1:abc",
      offsets: new Float32Array([0.5, 0.25, -0.5, 0.75, 0.1, -0.8]),
      hasNearbyWall: true
    });
    batch1._polyCache.set("lvl1::0_0_1", {
      sig: "500,500,200,360,0,1|lvl1|wg:1:abc",
      offsets: null,
      hasNearbyWall: false
    });

    const saved = await batch1.persistPolyCacheToDB("world1", "sceneA", ["lvl1"]);
    assert.equal(saved, true);
    assert.equal(fake.records.size, 1);

    // Simulate fresh page load (empty RAM cache)
    const batch2 = new MegaLightBatch();
    const hydrated = await batch2.hydratePolyCacheFromDB("world1", "sceneA", ["lvl1"]);
    assert.equal(hydrated, 2);

    const hit0 = batch2._polyCache.get("lvl1::0_0_0");
    assert.ok(hit0);
    assert.equal(hit0.hasNearbyWall, true);
    assert.ok(hit0.offsets instanceof Float32Array);
    assert.equal(hit0.offsets.length, 6);
    assert.ok(Math.abs(hit0.offsets[1] - 0.25) < 1e-6);

    // Second hydration for same level is skipped (already hydrated in RAM)
    assert.equal(await batch2.hydratePolyCacheFromDB("world1", "sceneA", ["lvl1"]), 0);

    // Clear by sceneId removes stored record
    await batch2.clearPolyCacheDB("sceneA");
    assert.equal(fake.records.size, 0);
    assert.equal(batch2._polyCache.size, 0);
  } finally {
    globalThis.indexedDB = prev;
    resetPolyCacheDBConnection();
  }
});
