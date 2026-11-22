import test from "node:test";
import assert from "node:assert/strict";
import { installFoundryMocks } from "./helpers/foundry-mock.mjs";

installFoundryMocks();
const { LRUTextureManager } = await import("../scripts/texture-manager.mjs");

test("LRUTextureManager caches 404 in missingSrcs without fallback retry", async () => {
  const mgr = new LRUTextureManager();
  let calls = 0;
  mgr.workerPool._supported = true;
  mgr.workerPool.decode = async () => {
    calls++;
    const err = new Error("HTTP 404");
    err.notFound = true;
    throw err;
  };
  let fallbackCalls = 0;
  globalThis.foundry.canvas.loadTexture = async () => { fallbackCalls++; return null; };

  assert.equal(await mgr.load("maps/fg/4/9_9.webp"), null);
  assert.equal(await mgr.load("maps/fg/4/9_9.webp"), null);
  assert.equal(calls, 1);
  assert.equal(fallbackCalls, 0);
  assert.equal(mgr.getStats().missingCount, 1);
});

test("cancelInflight keeps decoded GPU textures warm while clear(true) evicts all", async () => {
  const mgr = new LRUTextureManager();
  let closed = 0;
  mgr.workerPool._supported = true;
  mgr.workerPool.decode = async () => ({ width: 512, height: 512, close() { closed++; } });

  const tex = await mgr.load("maps/bg/0/0_0.webp", { isPinned: true });
  assert.ok(tex);
  assert.equal(mgr.lru.size, 1);

  // Same-scene level switch: cancelInflight preserves resident textures
  mgr.cancelInflight();
  assert.equal(mgr.lru.size, 1);
  assert.equal(mgr.getSync("maps/bg/0/0_0.webp"), tex);
  assert.equal(closed, 0);

  // Scene switch: clear(true) disposes everything cleanly
  mgr.clear(true);
  assert.equal(mgr.lru.size, 0);
  assert.equal(mgr.totalBytes, 0);
  assert.equal(closed, 1);
});
