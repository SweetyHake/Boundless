import test from "node:test";
import assert from "node:assert/strict";

// Minimal global stubs for Node test environment
function installBaseGlobals() {
  globalThis.CONST = globalThis.CONST || {
    OCCLUSION_MODES: { NONE: 0, FADE: 1, RADIAL: 2, VISION: 3 },
    FOG_EXPLORATION_MODES: { DISABLED: 0, INDIVIDUAL: 1, SHARED: 2 }
  };
  globalThis.game = {
    user: { id: "gm1", isGM: true },
    users: { activeGM: { id: "gm1" } },
    world: { id: "test-world" },
    scenes: new Map()
  };
  globalThis.CONFIG = {
    Canvas: { dispositionColors: { CONTROLLED: 0xFF9829 } },
    AmbientLight: { documentClass: class {} },
    AmbientSound: { documentClass: class {} },
    Tile: { documentClass: class {} }
  };
  globalThis.Hooks = { on() {}, once() {}, callAll() {} };
  globalThis.PIXI = {
    Graphics: class {
      constructor() {
        this.clearCalls = 0;
        this.rectCalls = 0;
        this.circleCalls = 0;
        this.visible = false;
        this.destroyed = false;
      }
      clear() { this.clearCalls++; }
      lineStyle() {}
      beginFill() {}
      endFill() {}
      drawRoundedRect() { this.rectCalls++; }
      drawCircle() { this.circleCalls++; }
      destroy() { this.destroyed = true; }
    },
    Container: class {
      constructor() { this.children = []; this.destroyed = false; }
      addChild(c) { this.children.push(c); c.parent = this; }
      addChildAt(c, idx) { this.children.splice(idx, 0, c); c.parent = this; }
      removeChild(c) { const i = this.children.indexOf(c); if (i >= 0) this.children.splice(i, 1); }
      destroy() { this.destroyed = true; }
    },
    Sprite: class {
      constructor(tex) { this.texture = tex; this.position = { set() {} }; this.destroyed = false; }
      destroy() { this.destroyed = true; }
    },
    Texture: {
      WHITE: {},
      EMPTY: {},
      from() { return { destroyed: false, baseTexture: { updates: 0, update() { this.updates++; } }, destroy() { this.destroyed = true; } }; }
    },
    MIPMAP_MODES: { OFF: 0, ON: 1 },
    SCALE_MODES: { LINEAR: 1 },
    WRAP_MODES: { CLAMP: 33071 }
  };
}

test("TokenImpostorLayer.queueUpsertToken coalesces 50 upserts into 1 vision scan and honors same-tick removeToken", async () => {
  installBaseGlobals();
  const { TokenImpostorLayer } = await import("../scripts/token-impostors.mjs");

  const imp = new TokenImpostorLayer({}, {});
  imp.mounted = true;
  imp._gen = 1;

  let visChecks = 0;
  let flushes = 0;
  const upsertedIds = [];
  imp._collectVisionCheckers = () => {
    visChecks++;
    return { tokenVision: false, isGM: true, hasActiveVision: false, visionBoxes: [], visionSourceDocIds: new Set() };
  };
  imp._upsertDocInternal = (doc) => { upsertedIds.push(doc.id); return 0; };
  imp._updateSingleTokenState = () => {};
  imp.flush = () => { flushes++; };

  for (let i = 0; i < 50; i++) {
    imp.queueUpsertToken({ id: `tok_${i}` });
  }
  // Remove one before microtask flushes -> must NOT be upserted as a phantom impostor
  imp.removeToken("tok_25");

  await Promise.resolve();
  assert.equal(visChecks, 1, "expected 1 _collectVisionCheckers call for 50 queued upserts");
  assert.equal(flushes, 1, "expected 1 flush call for 50 queued upserts");
  assert.equal(upsertedIds.length, 49);
  assert.ok(!upsertedIds.includes("tok_25"), "removed token must not be upserted after same-tick removeToken");
});

test("TokenImpostorLayer.queueUpsertToken safely no-ops if unmounted before microtask", async () => {
  installBaseGlobals();
  const { TokenImpostorLayer } = await import("../scripts/token-impostors.mjs");

  const imp = new TokenImpostorLayer({}, {});
  imp.mounted = true;
  imp._gen = 1;
  let called = 0;
  imp._collectVisionCheckers = () => { called++; return {}; };

  imp.queueUpsertToken({ id: "t1" });
  imp.unmount();

  await Promise.resolve();
  assert.equal(called, 0, "unmounted impostor layer must not process stale queued upserts");
});

test("TokenStreamer.onTokenUpdated coalesces 40 burst moves into 1 scheduleSync microtask", async () => {
  installBaseGlobals();
  globalThis.canvas = { tokens: { objects: {} } };
  const { TokenStreamer } = await import("../scripts/token-streamer.mjs");

  const ts = new TokenStreamer({});
  ts.enabled = true;
  ts.sceneId = "sc1";
  ts._lastVp = { x0: 0, y0: 0, x1: 2000, y1: 2000, scale: 1 };

  let syncCalls = 0;
  let queuedUpserts = 0;
  ts.scheduleSync = () => { syncCalls++; };
  ts.impostors.queueUpsertToken = () => { queuedUpserts++; };

  for (let i = 0; i < 40; i++) {
    ts.onTokenUpdated({ id: `t${i}`, parent: { id: "sc1" }, x: i * 100, y: 0, _object: { destroyed: false, parent: canvas.tokens.objects } }, { x: i * 100 });
  }

  await Promise.resolve();
  assert.equal(syncCalls, 1, "burst moves must coalesce into a single scheduleSync");
  assert.equal(queuedUpserts, 40);
});

test("MacroSelectionOverlay.refresh(false) skips PIXI redraw on pure pan and redraws on zoom or force", async () => {
  installBaseGlobals();
  const parent = new PIXI.Container();
  globalThis.canvas = {
    interface: parent,
    stage: { scale: { x: 0.1 } },
    grid: { size: 100 },
    tokens: {
      controlled: [{ destroyed: false, x: 100, y: 100, w: 100, h: 100, document: { width: 1, height: 1 } }]
    }
  };
  const { MacroSelectionOverlay } = await import("../scripts/boundless-selection.mjs");

  const ov = new MacroSelectionOverlay({ active: true });
  ov.mount();
  assert.equal(ov.gfx.visible, true);
  const initialRects = ov.gfx.rectCalls;
  assert.equal(initialRects, 1);

  // Pure pan (same scale) with force=false -> zero redraws
  ov.refresh(false);
  ov.refresh(false);
  assert.equal(ov.gfx.rectCalls, initialRects, "pure pan must skip redraw when scale is unchanged");

  // Zoom change with force=false -> redraws
  canvas.stage.scale.x = 0.08;
  ov.refresh(false);
  assert.equal(ov.gfx.rectCalls, initialRects + 1, "zoom change must trigger redraw");

  // Forced refresh (e.g. token moved at same scale) -> redraws
  ov.refresh(true);
  assert.equal(ov.gfx.rectCalls, initialRects + 2, "forced refresh must trigger redraw");
});

test("ChunkedFogManager caches encodedUrl per chunk and uploads texture once per brush batch", async () => {
  installBaseGlobals();
  let encodeCalls = 0;
  globalThis.document = {
    createElement() {
      return {
        width: 256,
        height: 256,
        getContext() {
          return {
            clearRect() {}, save() {}, restore() {}, beginPath() {}, arc() {}, fill() {},
            globalCompositeOperation: "source-over", fillStyle: "#fff"
          };
        },
        toDataURL() {
          encodeCalls++;
          return `data:image/webp;base64,fake_${encodeCalls}`;
        }
      };
    }
  };
  const storage = new Map();
  globalThis.localStorage = {
    setItem(k, v) { storage.set(k, v); },
    getItem(k) { return storage.get(k) ?? null; },
    removeItem(k) { storage.delete(k); }
  };

  const { ChunkedFogManager } = await import("../scripts/chunked-fog.mjs");
  const fm = new ChunkedFogManager();
  fm.enabled = true;
  fm.container = new PIXI.Container();
  fm._storageKey = "boundless.fog.test";
  fm.updateViewportCulling = () => {};
  fm._scheduleSave = () => {};

  // 20 brush stamps in a single batch inside chunk 0_0 -> 1 GPU baseTexture.update()
  const strokes = Array.from({ length: 20 }, (_, i) => [500 + i * 20, 500, 200, 0]);
  fm._applyBrushStrokes(strokes, { markDirty: true });
  const chunk = fm.chunks.get("0_0");
  assert.ok(chunk, "chunk 0_0 should be created");
  assert.equal(chunk.texture.baseTexture.updates, 1, "batch brush strokes must trigger only 1 GPU upload per chunk");

  // Local cache save encodes chunk once, second call hits cached encodedUrl (0 extra toDataURL)
  fm._saveLocalCacheOnly();
  assert.equal(encodeCalls, 1);
  fm._saveLocalCacheOnly();
  assert.equal(encodeCalls, 1, "unchanged chunk must reuse cached encodedUrl");

  // Mutating chunk invalidates encodedUrl cache
  fm._applyBrushStrokes([[600, 600, 100, 0]], { markDirty: true });
  assert.equal(chunk.encodedUrl, null);
  fm._saveLocalCacheOnly();
  assert.equal(encodeCalls, 2, "mutated chunk must re-encode on next cache save");
});

test("Boundless lighting onChunkLoaded coalesces burst chunk loads and aborts cleanly on unmount", async () => {
  installBaseGlobals();
  const { lightingMethods } = await import("../scripts/boundless-lighting.mjs");

  const makeMockController = () => {
    const calls = { pyramid: 0, bubbles: 0, wallSync: 0, layerSync: 0, roofBake: 0 };
    const ctrl = Object.assign(Object.create(lightingMethods), {
      active: true,
      _mountGen: 1,
      _inUpdatePyramid: false,
      openDoors: new Map(),
      doorStates: new Map(),
      lightBatch: { queueChunkBake() {}, detachChunk() {}, bakedRoofMask: null },
      audioStreamer: { lastKey: "x" },
      wallEditor: { syncViewport() { calls.wallSync++; } },
      layerEditors: { syncViewport() { calls.layerSync++; } },
      _reconcileChunkDoorStates() {},
      _bakeRoofMaskFromList() { calls.roofBake++; },
      updatePyramid() { calls.pyramid++; },
      updateSimAndLightBubbles() { calls.bubbles++; }
    });
    return { ctrl, calls };
  };

  // 1. Burst of 6 chunk loads -> single coalesced refresh
  {
    const { ctrl, calls } = makeMockController();
    const layer = { level: { id: "lvl1" }, spec: { overlays: { o1: { roof: true, cx: 100, cy: 100, w: 50, h: 50 } } } };
    for (let i = 0; i < 6; i++) {
      ctrl.onChunkLoaded(layer, `c_${i}`, { overlays: [layer.spec.overlays.o1] });
    }
    await Promise.resolve();
    assert.equal(calls.pyramid, 1);
    assert.equal(calls.bubbles, 1);
    assert.equal(calls.wallSync, 1);
    assert.equal(calls.layerSync, 1);
    assert.equal(calls.roofBake, 1);
  }

  // 2. Unmount before microtask -> zero stale refresh calls
  {
    const { ctrl, calls } = makeMockController();
    const layer = { level: { id: "lvl1" }, spec: {} };
    ctrl.onChunkLoaded(layer, "c_0", {});
    ctrl.active = false;
    ctrl._mountGen++;
    await Promise.resolve();
    assert.equal(calls.pyramid, 0);
    assert.equal(calls.bubbles, 0);
  }
});

test("VirtualLayerEditors cancels queued rAF mounts cleanly on layer deactivation", async () => {
  installBaseGlobals();
  const { VirtualLayerEditors } = await import("../scripts/layer-editors.mjs");
  const le = new VirtualLayerEditors({ active: true });
  le.lightActive = true;
  le._lightGen = 1;

  let mounted = 0;
  le._mountNativeLight = () => { mounted++; };

  for (let i = 0; i < 10; i++) {
    le._enqueueMount("light", `l_${i}`, { lKey: `l_${i}` }, 1, 0);
  }
  assert.equal(le._mountQueue.length, 10);

  // Immediately deactivate / clear before rAF fires
  le._clearLights();
  assert.equal(le._mountQueue.length, 0);
  assert.equal(le._mountQueuedKeys.size, 0);

  await new Promise(r => setTimeout(r, 30));
  assert.equal(mounted, 0, "cancelled mount queue must not mount stale lights");
});
