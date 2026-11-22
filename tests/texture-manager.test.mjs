import test from "node:test";
import assert from "node:assert/strict";
import { installFoundryMocks } from "./helpers/foundry-mock.mjs";

installFoundryMocks();
const { LRUTextureManager, resolveVramBudget } = await import("../scripts/texture-manager.mjs");

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

test("resolveVramBudget adapts to hardware memory/cores and explicit presets", () => {
  const lowAuto = resolveVramBudget("auto", { deviceMemory: 4, hardwareConcurrency: 8 });
  assert.equal(lowAuto.effectiveProfile, "low");
  assert.equal(lowAuto.maxBytes, 512 * 1024 * 1024);

  const midAuto = resolveVramBudget("auto", { deviceMemory: 8, hardwareConcurrency: 4 });
  assert.equal(midAuto.effectiveProfile, "balanced");
  assert.equal(midAuto.maxBytes, 1024 * 1024 * 1024);

  const highAuto = resolveVramBudget("auto", { deviceMemory: 8, hardwareConcurrency: 12 });
  assert.equal(highAuto.effectiveProfile, "high");
  assert.equal(highAuto.maxBytes, 1536 * 1024 * 1024);

  const ultra = resolveVramBudget("ultra", { deviceMemory: 4, hardwareConcurrency: 2 });
  assert.equal(ultra.effectiveProfile, "ultra");
  assert.equal(ultra.maxBytes, 2048 * 1024 * 1024);
});

test("setVramProfile updates live budget and triggers needsPrune when exceeded", () => {
  const mgr = new LRUTextureManager({ profile: "ultra" });
  mgr.totalBytes = 700 * 1024 * 1024;
  assert.equal(mgr.needsPrune(), false);

  mgr.setVramProfile("low");
  assert.equal(mgr.needsPrune(), true);
  assert.equal(mgr.getStats().vramBudgetMB, 512);
  assert.equal(mgr.getStats().vramProfile, "low");
});
