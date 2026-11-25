import test from "node:test";
import assert from "node:assert/strict";
import { installFoundryMocks } from "./helpers/foundry-mock.mjs";

const { MockLightSource, makeLevel } = installFoundryMocks();
const mod = await import("../scripts/boundless.mjs");
const { parseSparseTileSet } = mod;
const b = globalThis.Boundless;

test("parseSparseTileSet normalizes object and array formats", () => {
  assert.equal(parseSparseTileSet(null), null);
  const sObj = parseSparseTileSet({ "0": ["0_0"], "2": ["1_3.webp", [2, 1]] });
  assert.deepEqual([...sObj].sort(), ["0/0_0", "2/1_3", "2/2_1"]);
  const sArr = parseSparseTileSet(["0/0_0", "3_4_5", "1/0_1.webp"]);
  assert.deepEqual([...sArr].sort(), ["0/0_0", "1/0_1", "3/4_5"]);
});

test("foreground pyramid meshes sort above tokens, below roofs and upper floors, and keep z=0 depth on multi-level scenes", () => {
  const lvl0 = canvas.level;
  const lvl1 = makeLevel("lvl1", 1, 20, 40);
  const layer0 = b._normalizeLevelSpec({
    worldPx: 32000, tilePx: 1024, maxZoomZ: 5,
    pyramidBaseUrl: "maps/city/bg",
    foregroundPyramidBaseUrl: "maps/city/fg",
    foregroundTiles: { "0": ["0_0"], "2": ["1_1"] }
  }, lvl0, {});
  const layer1 = b._normalizeLevelSpec({
    worldPx: 32000, tilePx: 1024, maxZoomZ: 5, pyramidBaseUrl: "maps/city/bg2"
  }, lvl1, {});

  assert.equal(b.resolveForegroundPyramidTile(layer0, 2, 0, 0), null);
  assert.equal(b.resolveForegroundPyramidTile(layer0, 2, 1, 1)?.key, "lvl0::fg::2_1_1");

  b.visibleLevelLayers = [layer0, layer1];
  const fakeTex = new PIXI.Texture();
  const bgZ0 = {
    key: "lvl0::0_0_0", levelId: "lvl0", channel: "bg", layer: layer0,
    z: 0, x: 0, y: 0, src: "maps/city/bg/0/0_0.webp", tint: 0xffffff,
    x0: 0, y0: 0, sizePx: 32000, ready: false, mesh: null, alpha: 1, fadingOut: false, desired: true
  };
  const fgZ2 = {
    key: "lvl0::fg::2_1_1", levelId: "lvl0", channel: "fg", layer: layer0,
    z: 2, x: 1, y: 1, src: "maps/city/fg/2/1_1.webp", tint: 0xffffff,
    x0: 8000, y0: 8000, sizePx: 8000, ready: false, mesh: null, alpha: 1, fadingOut: false, desired: true
  };
  b.tilesByKey.set(bgZ0.key, bgZ0);
  b.tilesByKey.set(fgZ2.key, fgZ2);
  b._mountTileMesh(bgZ0, fakeTex, true);
  b._mountTileMesh(fgZ2, fakeTex, true);

  assert.equal(bgZ0.mesh.restrictsLight, true, "multi-level z=0 writes depth to block lower-level lights");
  assert.equal(fgZ2.mesh.elevation, 20);
  assert.equal(fgZ2.mesh.sortLayer, 0);
  assert.equal(fgZ2.mesh.sort, -180);
  assert.equal(fgZ2.mesh.restrictsLight, false);
  assert.notEqual(fgZ2.mesh.pluginName, "batch", "foreground SURFACE occlusion must not be downgraded to plain PIXI batch");
  assert.equal(fgZ2.mesh._occludedBySameElevationSurfaces, false);

  b.retireMesh(bgZ0.mesh);
  b.retireMesh(fgZ2.mesh);
  b.tilesByKey.clear();
  b.visibleLevelLayers = [];
});

test("camera storage key is shared across all levels of a scene", () => {
  const k1 = b._getCameraStorageKey({ id: "scene123" });
  canvas.level = makeLevel("lvl2", 2, 40, 60);
  const k2 = b._getCameraStorageKey({ id: "scene123" });
  assert.equal(k1, k2);
  assert.equal(k1, "boundless.camera.test-world.scene123");
  canvas.level = makeLevel("lvl0", 0, 0, 20);
});

test("dynamicLightMount and dynamicLightRetire emit with full extra style fields", () => {
  const rawLight = [1000, 2000, 60, 30, "#ffcc80", 0.7, "sunburst", 25, {
    speed: 5, intensity: 6, coloration: 3, attenuation: 0.8, luminosity: 0.9, angle: 90, rotation: 45
  }];
  const layer = {
    level: canvas.level, simGrid: 4, simSectorPx: 2500,
    spec: { simGrid: 4, simSectorPx: 2500, sectors: { "0_0": { l: [rawLight], w: [], d: [] } } }
  };
  b.lightBatch.build([layer], 20, null, (lid, sk, idx, raw, lvl) => b.resolveVirtualLight(lid, sk, idx, raw, lvl));

  const log = [];
  const offM = b.on("dynamicLightMount", (p) => log.push({ ev: "m", id: p.id, data: p.light.data }));
  const offR = b.on("dynamicLightRetire", (p) => log.push({ ev: "r", id: p.id, destroyed: p.light.destroyed }));

  b.active = true;
  b.visibleLevelLayers = [layer];
  b.levelLayers.set("lvl0", layer);
  canvas.effects.visionSources = new Set([{ active: true, x: 1000, y: 2000, elevation: 0, data: { level: "lvl0" } }]);
  b.updateSimAndLightBubbles(true);

  assert.equal(log.length, 1);
  assert.deepEqual(log[0].data.animation, { type: "sunburst", speed: 5, intensity: 6 });
  assert.equal(log[0].data.coloration, 3);
  assert.equal(log[0].data.attenuation, 0.8);
  assert.equal(log[0].data.luminosity, 0.9);

  MockLightSource.destroyedIds.length = 0;
  canvas.effects.visionSources = new Set();
  b.updateSimAndLightBubbles(true);
  assert.equal(log.length, 2);
  assert.equal(log[1].ev, "r");
  assert.equal(log[1].destroyed, false, "retire emitted before destroy()");
  assert.ok(MockLightSource.destroyedIds.includes("MegaLight.lvl0::0_0_0"));

  offM();
  offR();
  b.unmount({ clearTextures: true });
});

test("unmount preserves texMgr cache across same-scene level switches and clears on scene switch", async () => {
  b.texMgr.workerPool._supported = true;
  b.texMgr.workerPool.decode = async () => ({ width: 256, height: 256, close() {} });
  await b.texMgr.load("maps/city/0/0_0.webp", { isPinned: true });
  b._mountedSceneId = "sceneA";
  b._cachedSceneId = "sceneA";
  b.active = true;

  // Same-scene level teardown keeps cache warm
  b.unmount();
  assert.equal(b.texMgr.lru.size, 1);
  assert.equal(b._cachedSceneId, "sceneA");

  // Explicit scene switch (or mounting sceneB) clears VRAM cache
  b.mount({ id: "sceneB", flags: {}, levels: [] });
  assert.equal(b.texMgr.lru.size, 0);
  assert.equal(b._cachedSceneId, null);
});

test("getLevelCacheSigFn handles openDoors Map keys and wallEdits without throwing", () => {
  b.openDoors.set("lvl0::1_2_0", { levelId: "lvl0" });
  b.openDoors.set("lvl1::0_0_0", { levelId: "lvl1" });
  const opts = b._getLightBatchBuildOpts();
  const s0 = opts.getLevelCacheSigFn("lvl0");
  const s1 = opts.getLevelCacheSigFn("lvl1");
  assert.ok(s0.includes("1_2_0"));
  assert.ok(!s0.includes("0_0_0"));
  assert.ok(s1.includes("0_0_0"));
  b.openDoors.clear();
});

test("computeSmartSelectAllPlan implements safe two-stage Ctrl+A on global and large scenes", async () => {
  const { computeSmartSelectAllPlan } = await import("../scripts/boundless-selection.mjs");

  // Small standard scene keeps 100% native Foundry behavior
  const small = computeSmartSelectAllPlan({
    isBoundless: false, totalOnLevel: 25, inViewCount: 10, lastState: null, nowMs: 1000, layerName: "tokens", levelId: "lvl0"
  });
  assert.equal(small.action, "native");

  // 1st Ctrl+A on Boundless map selects only viewport and prompts for level expansion
  const first = computeSmartSelectAllPlan({
    isBoundless: true, totalOnLevel: 147, inViewCount: 22, lastState: null, nowMs: 1000, layerName: "tokens", levelId: "lvl0"
  });
  assert.equal(first.action, "viewport");
  assert.equal(first.notify, true);
  assert.ok(first.nextState);

  // 2nd Ctrl+A within 2.5s on same layer & level expands to entire level
  const second = computeSmartSelectAllPlan({
    isBoundless: true, totalOnLevel: 147, inViewCount: 22, lastState: first.nextState, nowMs: 2200, layerName: "tokens", levelId: "lvl0"
  });
  assert.equal(second.action, "level");
  assert.equal(second.nextState, null);

  // After 2.5s window expires, starts fresh at viewport again
  const expired = computeSmartSelectAllPlan({
    isBoundless: true, totalOnLevel: 147, inViewCount: 22, lastState: first.nextState, nowMs: 4000, layerName: "tokens", levelId: "lvl0"
  });
  assert.equal(expired.action, "viewport");

  // Switching layer or level resets repeat state
  const diffLayer = computeSmartSelectAllPlan({
    isBoundless: true, totalOnLevel: 147, inViewCount: 22, lastState: first.nextState, nowMs: 1500, layerName: "walls", levelId: "lvl0"
  });
  assert.equal(diffLayer.action, "viewport");

  // Empty viewport prompts to press again for full level
  const emptyVp = computeSmartSelectAllPlan({
    isBoundless: true, totalOnLevel: 147, inViewCount: 0, lastState: null, nowMs: 1000, layerName: "tokens", levelId: "lvl0"
  });
  assert.equal(emptyVp.action, "prompt-level-empty");
  const expandAfterEmpty = computeSmartSelectAllPlan({
    isBoundless: true, totalOnLevel: 147, inViewCount: 0, lastState: emptyVp.nextState, nowMs: 1800, layerName: "tokens", levelId: "lvl0"
  });
  assert.equal(expandAfterEmpty.action, "level");

  // When all objects are already in viewport, select without noisy notification
  const allInView = computeSmartSelectAllPlan({
    isBoundless: true, totalOnLevel: 12, inViewCount: 12, lastState: null, nowMs: 1000, layerName: "tokens", levelId: "lvl0"
  });
  assert.equal(allInView.action, "viewport");
  assert.equal(allInView.notify, false);
});
