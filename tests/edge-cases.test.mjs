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

test("computeStitchPyramidPlan aligns padded scenes to (0,0) over pyramidSpan instead of padded worldPx", async () => {
  installBaseGlobals();
  const { computeStitchPyramidPlan } = await import("../scripts/scene-baker.mjs");

  // Typical Foundry scene: 4000x4000 map with 0.25 padding -> worldPx = 6000, bounds.x/y = 1000
  const plan = computeStitchPyramidPlan({
    maxZoomZ: 3,
    worldPx: 6000,
    tilePx: 512,
    bounds: { x: 1000, y: 1000, w: 4000, h: 4000 },
    maxDim: 4096
  });
  assert.equal(plan.pyramidSpan, 4000);
  assert.equal(plan.chosenZ, 3);
  assert.equal(plan.outW, 4096);
  assert.equal(plan.outH, 4096);
  assert.equal(plan.x0, 0);
  assert.equal(plan.y0, 0);
  assert.equal(plan.x1, 7);
  assert.equal(plan.y1, 7);

  // Portrait scene (2000x4000) with padding -> x1 = 3, y1 = 7, outW = 2048, outH = 4096
  const portrait = computeStitchPyramidPlan({
    maxZoomZ: 3,
    worldPx: 6000,
    tilePx: 512,
    bounds: { x: 500, y: 1000, w: 2000, h: 4000 },
    maxDim: 4096
  });
  assert.equal(portrait.pyramidSpan, 4000);
  assert.equal(portrait.outW, 2048);
  assert.equal(portrait.outH, 4096);
  assert.equal(portrait.x0, 0);
  assert.equal(portrait.x1, 3);
  assert.equal(portrait.y1, 7);
});

test("ChunkStreamer enforces MAX_LOADED_CHUNKS budget, aborts stale fetches, and refcounts shared sectors", async () => {
  installBaseGlobals();
  globalThis.canvas = { tokens: { placeables: [] }, level: { id: "lvl1" }, grid: { size: 100 } };
  const aborted = [];
  const origFetch = globalThis.fetch;
  globalThis.fetch = (url, opts) => new Promise((_resolve, reject) => {
    opts?.signal?.addEventListener("abort", () => {
      aborted.push(url);
      const err = new Error("Aborted");
      err.name = "AbortError";
      reject(err);
    });
  });

  try {
    const { ChunkStreamer } = await import("../scripts/chunk-streamer.mjs");
    const cs = new ChunkStreamer({ onChunkLoaded() {}, onChunkUnloaded() {} });
    const layer = {
      level: { id: "lvl1" },
      worldPx: 600000,
      spec: { chunks: { baseUrl: "/chunks", chunkWorldPx: 50000, cols: 12, rows: 12, populated: [] }, sectors: {}, overlays: {} }
    };
    cs.mount([layer]);
    const st = cs.states.get("lvl1");

    // 1. Huge viewport spanning 36+ chunks -> capped to MAX_LOADED_CHUNKS (8)
    cs.update({ x0: 0, y0: 0, x1: 300000, y1: 300000, scale: 0.03 });
    assert.ok(st.pending.size <= 8, `expected <= 8 pending chunks, got ${st.pending.size}`);

    // 2. Camera jumps far away -> old pending fetches must be aborted
    cs.update({ x0: 500000, y0: 500000, x1: 550000, y1: 550000, scale: 0.2 });
    assert.ok(aborted.length > 0, "stale pending chunk fetches should be aborted when camera jumps");

    // 3. Shared border sector & overlay refcounting across adjacent chunks
    cs._mountChunkData(st, "0_0", { sectors: { "shared_s": { w: [1] }, "only_a": { w: [2] } }, overlays: { "shared_ov": { roof: true } } });
    cs._mountChunkData(st, "1_0", { sectors: { "shared_s": { w: [1] }, "only_b": { w: [3] } }, overlays: { "shared_ov": { roof: true } } });
    cs._evictChunk(st, "0_0", false);
    assert.ok(layer.spec.sectors["shared_s"], "shared sector must survive evicting only one neighbor chunk");
    assert.ok(layer.spec.overlays["shared_ov"], "shared overlay must survive evicting only one neighbor chunk");
    assert.equal(layer.spec.sectors["only_a"], undefined);
    cs._evictChunk(st, "1_0", false);
    assert.equal(layer.spec.sectors["shared_s"], undefined, "shared sector must be deleted once last referencing chunk evicts");
    assert.equal(layer.spec.overlays["shared_ov"], undefined);
    cs.unmount();
  } finally {
    globalThis.fetch = origFetch;
  }
});

test("MegaAudioStreamer retries after transient shape failure, deduplicates overlapping anchors, and restricts non-GM listeners", async () => {
  installBaseGlobals();
  let failOnce = true;
  let resolveCount = 0;
  let perceptionUpdates = 0;

  class MockSoundSource {
    constructor(opts) { this.sourceId = opts.sourceId; this.attached = false; this.shape = null; }
    initialize() { this.shape = failOnce ? null : { radius: 200 }; }
    add() { this.attached = true; }
    destroy() { this.attached = false; }
  }

  globalThis.foundry = { canvas: { sources: { PointSoundSource: MockSoundSource } } };
  globalThis.game.user = { id: "player1", isGM: false };
  globalThis.canvas = {
    ready: true,
    sounds: { livePreview: false },
    dimensions: { size: 100, distance: 5 },
    environment: { darknessLevel: 0 },
    level: { id: "lvl1" },
    grid: { size: 100 },
    perception: { update() { perceptionUpdates++; } },
    tokens: {
      placeables: [
        // Own controlled token near (500, 500)
        { destroyed: false, controlled: true, isOwner: true, center: { x: 500, y: 500 }, document: { level: "lvl1", hasPlayerOwner: true } },
        // Second overlapping owned token in the exact same sector
        { destroyed: false, controlled: true, isOwner: true, center: { x: 550, y: 550 }, document: { level: "lvl1", hasPlayerOwner: true } },
        // Another player's distant token at (50000, 50000) -> MUST NOT mount sounds for player1
        { destroyed: false, controlled: false, isOwner: false, center: { x: 50000, y: 50000 }, document: { level: "lvl1", hasPlayerOwner: true }, actor: { testUserPermission: () => false } }
      ]
    }
  };

  const { MegaAudioStreamer } = await import("../scripts/audio-streamer.mjs");
  const audio = new MegaAudioStreamer();
  const layer = {
    level: { id: "lvl1", elevation: { bottom: 20, top: 30 } },
    simGrid: 60,
    simSectorPx: 1000,
    spec: {
      sectors: {
        "0_0": { s: [[500, 500, 20, "ambient.ogg", 0.5, true, true, 0, 1]] },
        "50_50": { s: [[50000, 50000, 20, "distant.ogg", 0.5, true, true, 0, 1]] }
      }
    }
  };

  const resolver = (_lid, _sk, _si, raw) => {
    resolveCount++;
    return { x: raw[0], y: raw[1], radius: raw[2], path: raw[3], volume: raw[4], walls: true, easing: true, darkMin: 0, darkMax: 1, elevation: 25, hidden: false };
  };

  // Pass 1: shape is null -> fails transiently, lastKey MUST stay null so Pass 2 retries
  audio.update([layer], { x0: 0, y0: 0, x1: 1000, y1: 1000, scale: 0.05 }, resolver);
  assert.equal(audio.activeSources.size, 0);
  assert.equal(audio.lastKey, null, "lastKey must not cache an incomplete mount");
  assert.equal(resolveCount, 1, "overlapping anchors must visit each sector once and ignore other players' distant tokens");

  // Pass 2: shape succeeds -> sound mounts cleanly
  failOnce = false;
  audio.update([layer], { x0: 0, y0: 0, x1: 1000, y1: 1000, scale: 0.05 }, resolver);
  assert.equal(audio.activeSources.size, 1);
  assert.ok(audio.activeSources.has("lvl1::0_0_0"));
  assert.ok(!audio.activeSources.has("lvl1::50_50_0"), "must not mount distant other-player sound");
  assert.equal(perceptionUpdates, 1);
});

test("TileWorkerPool kills broken worker on postMessage throw and routes remaining jobs to healthy worker", async () => {
  installBaseGlobals();
  const { TileWorkerPool } = await import("../scripts/tile-worker-pool.mjs");

  let terminated0 = false;
  const pool = new TileWorkerPool({
    poolSize: 2,
    workerFactory(i) {
      return {
        postMessage(msg) {
          if (i === 0 && msg.type === "decode") {
            throw new Error("broken_worker_post");
          }
          if (msg.type === "decode") {
            queueMicrotask(() => this.onmessage?.({ data: { id: msg.id, bitmap: { width: 16, height: 16, close() {} }, decodeMs: 1 } }));
          }
        },
        terminate() { if (i === 0) terminated0 = true; }
      };
    }
  });

  const p1 = pool.decode("a.webp");
  const p2 = pool.decode("b.webp");
  const res = await Promise.allSettled([p1, p2]);
  assert.equal(terminated0, true, "broken worker #0 must be terminated on postMessage throw");
  assert.equal(pool._workers[0], null);
  assert.equal(res[0].status, "rejected");
  assert.equal(res[1].status, "fulfilled", "second job must succeed on healthy worker #1");
});

test("LRUTextureManager preserves Foundry PIXI.Assets on stale fallback textures and tolerates null inUseSet in prune()", async () => {
  installBaseGlobals();
  const unloaded = [];
  globalThis.PIXI.Assets = { unload: async (src) => { unloaded.push(src); } };
  let resolveTex;
  globalThis.foundry = { canvas: { loadTexture: () => new Promise(r => { resolveTex = r; }) } };

  const { LRUTextureManager } = await import("../scripts/texture-manager.mjs");
  const tm = new LRUTextureManager({ profile: "low" });
  const p = tm.load("test.svg");
  tm.clear(true); // Scene switch while fallback load is still in flight
  resolveTex({ baseTexture: { realWidth: 64, realHeight: 64, update() {} } });
  const out = await p;
  assert.equal(out, null);
  assert.deepEqual(unloaded, [], "stale Foundry-managed fallback texture must NOT be unloaded from global PIXI.Assets");
  assert.equal(tm.prune(null), 0, "prune(null) must not throw");
});

test("CharacterPinManager preserves PIXI/DOM on unchanged rebuild, clamps narrow safe bounds, and cleans up ticker on unmount", async () => {
  installBaseGlobals();
  let removedTicker = false;
  const mockTicker = { add() {}, remove() { removedTicker = true; } };
  globalThis.window = { innerWidth: 320, innerHeight: 480 };
  globalThis.document = {
    getElementById: () => null,
    createElement: () => ({ style: {}, classList: { add() {}, remove() {} }, appendChild() {}, remove() {}, addEventListener() {} }),
    body: { appendChild() {} }
  };
  globalThis.canvas = {
    controls: new PIXI.Container(),
    app: { ticker: mockTicker },
    stage: { scale: { x: 1 }, pivot: { x: 0, y: 0 } },
    screenDimensions: [320, 480],
    level: { id: "lvl1" },
    grid: { size: 100 }
  };

  const { CharacterPinManager } = await import("../scripts/character-pins.mjs");
  const mgr = new CharacterPinManager({ active: true });
  mgr._cachedLeftInset = 280;
  mgr._cachedRightInset = 280;
  mgr._lastSidebarCheckMs = performance.now();
  const safe = mgr._getSafeScreenBounds();
  assert.ok(safe.right >= safe.left + 80, `safe bounds must never invert (left=${safe.left}, right=${safe.right})`);

  // Verify rebuild diffs targets and avoids destroying unchanged entries
  mgr.container = new PIXI.Container();
  mgr.edgeLayerEl = { style: {}, remove() {} };
  mgr._ticker = mockTicker;
  mgr._tickerFn = () => {};
  mgr._tickerAdded = true;
  let destroyCalls = 0;
  const fakeEntry = {
    id: "pc1", name: "Hero", colorCss: "#f5c96b", portraitSrc: "hero.webp", isSelf: true,
    tokenDoc: { id: "pc1", parent: { id: "s1" }, x: 0, y: 0 },
    root: { position: { set() {} }, visible: false, destroy() { destroyCalls++; } },
    edgeEl: { style: {}, classList: { add() {}, remove() {} }, remove() {} },
    arrowEl: { style: {} }, levelBadgeEl: { style: {} }, subEl: { textContent: "" }
  };
  mgr.entries = [fakeEntry];
  mgr._collectTrackedTargets = () => [{ id: "pc1", name: "Hero", colorCss: "#f5c96b", portraitSrc: "hero.webp", isSelf: true, tokenDoc: fakeEntry.tokenDoc, actor: null, user: null }];
  mgr.rebuild({ flags: {} });
  assert.equal(destroyCalls, 0, "unchanged PC targets must not tear down existing PIXI/DOM pin entries");

  mgr.unmount();
  assert.equal(removedTicker, true, "unmount must remove ticker callback from stored ticker");
  assert.equal(mgr.enabled, false, "unmount must reset enabled to false");
});

test("MegaLightBatch.syncDarknessLevel accumulates 240Hz micro-steps across darkMin threshold", async () => {
  installBaseGlobals();
  const { MegaLightBatch } = await import("../scripts/light-batch.mjs");
  const lb = new MegaLightBatch();
  lb._hasDarknessRangedLights = true;
  lb._currentDarkness = 0.4998;
  lb.weightArray = new Float32Array(12);
  lb.weightBuffer = { update() {} };
  const meta = {
    vStart: 0, vCount: 12,
    baseWeight: 1, weight: 0,
    isIndoor: false,
    darkMin: 0.5, darkMax: 1.0,
    batch: null
  };
  lb.lightMetaById.set("l1", meta);

  // Feed tiny 0.00005 steps (below 0.0001 delta individually) across 0.5000
  let crossed = false;
  for (let i = 1; i <= 10; i++) {
    if (lb.syncDarknessLevel(0.4998 + i * 0.00005)) crossed = true;
  }
  assert.equal(crossed, true, "micro-stepped darkness ramp must trigger threshold crossing");
  assert.equal(meta.weight, 1, "night-only light must turn ON once darkness passes darkMin");
});

test("Boundless lighting blocks client doorState spoofing, survives non-string dKey, and recovers from externally destroyed fading light", async () => {
  installBaseGlobals();
  const { lightingMethods } = await import("../scripts/boundless-lighting.mjs");
  let weightRestored = null;
  const ctrl = Object.assign(Object.create(lightingMethods), {
    active: true,
    doorStates: new Map(),
    openDoors: new Map(),
    closingDoorTimers: new Map(),
    dynamicLights: new Map(),
    _lightFades: new Map(),
    lastDynLightKey: "l1",
    fogManager: { handleSocketMessage: () => false },
    lightBatch: {
      setLightWeight(id, w) { weightRestored = { id, w }; },
      flushWeights() {}
    }
  });
  globalThis.canvas = { scene: { id: "s1" } };
  globalThis.game.user = { id: "player1", isGM: false };
  globalThis.game.users = new Map([["gm1", { id: "gm1", isGM: true }]]);
  globalThis.game.users.activeGM = { id: "gm1" };

  // 1. Spoofed GM doorState socket packet must NOT mutate doorStates
  await ctrl._onSocketMessage({ type: "doorState", sceneId: "s1", senderId: "gm1", dKey: "lvl::0_0_0", ds: 1 });
  assert.equal(ctrl.doorStates.size, 0, "unauthenticated doorState socket must not mutate state");

  // 2. Non-string dKey payloads must return null safely without throwing TypeError
  assert.equal(ctrl._resolveDoorByKey(12345), null);
  assert.equal(ctrl._resolveDoorByKey(["a::b"]), null);
  assert.equal(ctrl._resolveDoorByKey("lvl::bad_-1_0"), null);

  // 3. Externally destroyed PointLightSource mid-fade must restore GPU weight = 1 and clean dynamicLights
  const deadLs = { destroyed: true };
  ctrl.dynamicLights.set("l_fade", deadLs);
  ctrl._lightFades.set("l_fade", { dir: "in", t: 0.5, dur: 220, ls: deadLs, baseColorAlpha: 1, baseBgAlpha: 1 });
  ctrl._stepDynamicLightFades(16);
  assert.equal(ctrl.dynamicLights.has("l_fade"), false, "destroyed fading light must be removed from dynamicLights");
  assert.deepEqual(weightRestored, { id: "l_fade", w: 1.0 });
  assert.equal(ctrl.lastDynLightKey, null);
});

test("ChunkedFogManager guards malformed brush/polygon payloads, skips localStorage in SHARED mode, and clears remote queue on reset", async () => {
  installBaseGlobals();
  const storage = new Map();
  let throwQuota = false;
  globalThis.localStorage = {
    setItem(k, v) {
      if (throwQuota) { const e = new Error("quota"); e.name = "QuotaExceededError"; throw e; }
      storage.set(k, v);
    },
    getItem(k) { return storage.get(k) ?? null; },
    removeItem(k) { storage.delete(k); }
  };
  globalThis.document = {
    createElement() {
      return {
        width: 256, height: 256,
        getContext: () => ({ clearRect() {}, save() {}, restore() {}, beginPath() {}, arc() {}, fill() {}, moveTo() {}, lineTo() {}, closePath() {} }),
        toDataURL: () => "data:image/webp;base64,ok"
      };
    }
  };
  const { ChunkedFogManager } = await import("../scripts/chunked-fog.mjs");
  const fm = new ChunkedFogManager();
  fm.enabled = true;
  fm.sceneId = "s1";
  fm.levelId = "lvl1";
  fm.container = new PIXI.Container();
  fm._storageKey = "boundless.fog.test2";
  fm.updateViewportCulling = () => {};
  fm._scheduleSave = () => {};

  // 1. Malformed strokes (non-array, NaN) must not throw
  assert.equal(fm._applyBrushStrokes(["bad", null, [NaN, 0, 100, 0]]), false);

  // 2. Empty levelId on socket fogReveal must be rejected (no cross-level reveal leak)
  fm.mode = CONST.FOG_EXPLORATION_MODES.SHARED;
  assert.equal(fm.handleSocketMessage({ type: "fogReveal", sceneId: "s1", levelId: "", polygons: [[0, 0, 100, 0, 100, 100]] }), false);

  // 3. SHARED mode must not write to private localStorage
  fm._applyBrushStrokes([[500, 500, 200, 0]], { markDirty: false });
  fm._saveLocalCacheOnly();
  assert.equal(storage.size, 0, "SHARED mode must not write unused localStorage cache");

  // 4. INDIVIDUAL mode removes stale cache key on QuotaExceededError
  fm.mode = CONST.FOG_EXPLORATION_MODES.INDIVIDUAL;
  storage.set("boundless.fog.test2", "stale");
  throwQuota = true;
  fm._saveLocalCacheOnly();
  assert.equal(storage.has("boundless.fog.test2"), false, "QuotaExceededError must purge stale cache key");

  // 5. reset() clears pending _remoteRevealQueues for the reset level
  fm._remoteRevealQueues.set("s1::lvl1", { polygons: [[0, 0, 10, 0, 10, 10]], running: null });
  await fm.reset({ broadcast: false, persist: false });
  assert.equal(fm._remoteRevealQueues.has("s1::lvl1"), false);
});

test("VirtualLayerEditors skips stale/offscreen/edited rAF mount jobs and updates queued snapshots", async () => {
  installBaseGlobals();
  const { VirtualLayerEditors } = await import("../scripts/layer-editors.mjs");
  const ctrl = { active: true, lightEditsRev: 1 };
  const le = new VirtualLayerEditors(ctrl);
  le.lightActive = true;
  le._lightGen = 1;
  le._lastLightNeededKeys = new Set(["l_keep"]);

  const mounted = [];
  le._mountNativeLight = (item) => { mounted.push(item); };

  // Enqueue offscreen/deleted item + kept item, then overwrite kept item with updated snapshot
  le._enqueueMount("light", "l_gone", { lKey: "l_gone", x: 10 }, 1, 1);
  le._enqueueMount("light", "l_keep", { lKey: "l_keep", x: 10 }, 1, 1);
  le._enqueueMount("light", "l_keep", { lKey: "l_keep", x: 999 }, 1, 1);
  le._enqueueMount("light", "l_oldrev", { lKey: "l_oldrev", x: 5 }, 1, 0);
  le._lastLightNeededKeys.add("l_oldrev");

  // Pump synchronously
  le._pumpMountQueue();
  assert.equal(mounted.length, 1, "only in-view, current-rev item may mount");
  assert.equal(mounted[0].x, 999, "re-enqueued item must use latest snapshot");
});

test("TokenImpostorLayer zeroes orphaned GPU slots in refreshVisibility and recycles failed atlas slots", async () => {
  installBaseGlobals();
  const { TokenImpostorLayer } = await import("../scripts/token-impostors.mjs");
  const imp = new TokenImpostorLayer({}, {});
  imp.mounted = true;
  imp.atlasSize = 256; // 2x2 = 4 slots max (CELL_PX = 128)
  imp.nextSlotIdx = 4;
  imp.slotsByKey.set("bad_art", { col: 0, row: 0, ready: false, failed: true, decoding: false });
  imp._pumpAtlasDecodes = () => {};

  // Recycling failed slot succeeds even when nextSlotIdx === maxSlots
  const recycled = imp._requestAtlasSlot({ slotKey: "good_art", artSrc: "good.webp" });
  assert.ok(recycled, "failed atlas slot must be recyclable when atlas is full");
  assert.equal(imp.slotsByKey.has("bad_art"), false);

  // Orphaned GPU slot whose TokenDocument vanished from scene.tokens must be zeroed out
  imp.count = 1;
  imp.docIds = ["ghost_tok"];
  imp.stateArr = new Float32Array(16).fill(1.0);
  imp.mesh = { visible: true };
  globalThis.canvas = { scene: { tokens: new Map() }, visibility: { tokenVision: false }, effects: {} };
  imp.refreshVisibility(true);
  assert.equal(imp.stateArr[0], 0, "orphaned GPU slot alpha must be zeroed");
  assert.equal(imp.activeVisibleCount, 0);
  assert.equal(imp.mesh.visible, false);
});

test("pyramidMethods.retireMesh / acquireMesh prevents double-pool corruption and resets leaked properties", async () => {
  installBaseGlobals();
  const { pyramidMethods } = await import("../scripts/boundless-pyramid.mjs");
  const ctrl = Object.assign(Object.create(pyramidMethods), { meshPool: [] });

  const makePoint = (x = 0, y = 0) => ({ x, y, set(nx, ny = nx) { this.x = nx; this.y = ny; } });
  const mesh = {
    destroyed: false,
    name: "Tile.Old",
    visible: false,
    renderable: false,
    alpha: 0.2,
    unoccludedAlpha: 0.3,
    occludedAlpha: 0.08,
    restrictsLight: true,
    restrictsWeather: true,
    elevation: 25,
    sort: 99,
    sortLayer: 5,
    angle: 45,
    tint: 0xff0000,
    anchor: makePoint(0.5, 0.5),
    position: makePoint(100, 200),
    pivot: makePoint(10, 20),
    skew: makePoint(1, 2),
    scale: makePoint(2, 3),
    filters: [{ name: "customFilter" }],
    filterArea: { x: 1, y: 2 },
    mask: { name: "maskObj" },
    parent: { removeChild() {} }
  };

  // Retiring twice must push only once
  ctrl.retireMesh(mesh);
  ctrl.retireMesh(mesh);
  assert.equal(ctrl.meshPool.length, 1, "double retireMesh must not duplicate mesh in pool");

  // Re-acquiring must cleanly reset every property
  const reused = ctrl.acquireMesh();
  assert.equal(reused, mesh);
  assert.equal(reused._inMeshPool, false);
  assert.equal(reused.visible, true);
  assert.equal(reused.renderable, true);
  assert.equal(reused.unoccludedAlpha, 1.0);
  assert.equal(reused.occludedAlpha, 1.0);
  assert.equal(reused.restrictsLight, false);
  assert.equal(reused.restrictsWeather, false);
  assert.equal(reused.elevation, 0);
  assert.equal(reused.filters, null);
  assert.equal(reused.filterArea, null);
  assert.equal(reused.mask, null);
  assert.equal(reused.anchor.x, 0);
  assert.equal(reused.anchor.y, 0);
  assert.equal(reused.pivot.x, 0);
  assert.equal(reused.skew.x, 0);
  assert.equal(reused._occludedBySameElevationSurfaces, true);
});

test("stepCrossfades survives NaN dtMs, retires superGrid z=0 roofs, and preserves blockFlags z=6 fallback at z=7", async () => {
  installBaseGlobals();
  const { pyramidMethods } = await import("../scripts/boundless-pyramid.mjs");

  const retiredMeshes = [];
  const sgLayer = {
    level: { id: "lvl1", isView: true },
    hasPyramid: true,
    zOffset: 3,
    lastTargetZ: 0,
    bounds: { x: 0, y: 0, w: 600000, h: 600000 },
    spec: { blockFlags: ["6666"] }
  };
  const z7Layer = {
    level: { id: "lvl2", isView: true },
    hasPyramid: true,
    zOffset: 0,
    lastTargetZ: 7,
    bounds: { x: 0, y: 0, w: 100000, h: 100000 },
    spec: { blockFlags: ["6666"] }
  };

  globalThis.canvas = {
    ready: true,
    stage: { scale: { x: 0.01 }, pivot: { x: 300000, y: 300000 } },
    screenDimensions: [1600, 1000],
    dimensions: { width: 600000, height: 600000 },
    primary: { sortDirty: false, levelTextures: [] },
    masks: { occlusion: { occludedSurfaces: null }, depth: { renderDirty: false } },
    tiles: { placeables: [] }
  };

  const roofMesh = { visible: true, destroyed: false, occlusionMode: 1 };
  const fadeTile = { key: "lvl1::1_0_0", levelId: "lvl1", channel: "bg", layer: sgLayer, z: 1, x: 0, y: 0, x0: 0, y0: 0, sizePx: 300000, ready: true, desired: true, alpha: 0.5, awaitingSwap: false, mesh: { visible: true, unoccludedAlpha: 0.5 } };
  const fallbackZ6 = { key: "lvl2::6_0_0", levelId: "lvl2", channel: "bg", layer: z7Layer, z: 6, x: 0, y: 0, x0: 0, y0: 0, sizePx: 1562.5, ready: true, desired: true, isReveal: true, alpha: 1.0, awaitingSwap: false, mesh: { visible: true, unoccludedAlpha: 1.0 } };

  const ctrl = Object.assign(Object.create(pyramidMethods), {
    active: true,
    visibleLevelLayers: [sgLayer, z7Layer],
    levelLayers: new Map([["lvl1", sgLayer], ["lvl2", z7Layer]]),
    tilesByKey: new Map([[fadeTile.key, fadeTile], [fallbackZ6.key, fallbackZ6]]),
    activeOverlays: new Map([["lvl1::ov1", { levelId: "lvl1", retiring: true, roofMesh, ovSpec: { cx: 300000, cy: 300000, w: 500, h: 500 } }]]),
    activeVirtualTiles: new Map(),
    pendingTileMounts: [],
    pendingOverlayMounts: [],
    pendingVirtualTileMounts: [],
    _revealTileKeys: new Set([fallbackZ6.key]),
    _hiddenNativeLevelBg: new Map(),
    _hiddenNativeLevelFg: new Map(),
    _tilesDirty: true,
    tokenStreamer: { step() {} },
    texMgr: { needsPrune: () => false },
    _emit() {},
    _isRoofRevealed: () => false,
    _shouldMountRoofs: () => false,
    retireMesh(m) { retiredMeshes.push(m); },
    syncRoofTokenOcclusion() {},
    invalidateShowstopperSurfaces() {}
  });

  ctrl.stepCrossfades(NaN);

  assert.ok(Number.isFinite(fadeTile.alpha) && fadeTile.alpha > 0.5, "NaN dtMs must fall back cleanly and advance fade");
  assert.equal(ctrl.activeOverlays.size, 0, "superGrid z=0 retiring roof must retire even when localZ < 0");
  assert.equal(retiredMeshes.length, 1);
  assert.equal(fallbackZ6.desired, true, "live blockFlags z=6 fallback tile at targetZ=7 must not be deleted on reveal cleanup");
});

test("computePredictiveViewportRect never inverts bounds and isLevelAbove handles Infinity/ties", async () => {
  installBaseGlobals();
  const { computePredictiveViewportRect, getLevelBottomElevation, isLevelAbove } = await import("../scripts/utils.mjs");

  // Camera panned far off the left/top edge + non-finite velocity -> x0 <= x1, y0 <= y1, finite numbers
  const rect = computePredictiveViewportRect(-50000, -50000, 1600, 1000, 0, 10000, 10000, { velX: NaN, velY: Infinity });
  assert.ok(Number.isFinite(rect.x0) && Number.isFinite(rect.x1) && rect.x0 <= rect.x1);
  assert.ok(Number.isFinite(rect.y0) && Number.isFinite(rect.y1) && rect.y0 <= rect.y1);

  // +Infinity bottom must fall back to finite base/0, while -Infinity is preserved
  assert.equal(getLevelBottomElevation({ elevation: { bottom: Infinity, base: 10 } }), 10);
  assert.equal(getLevelBottomElevation({ elevation: { bottom: -Infinity, base: 0 } }), -Infinity);

  // Equal-bottom tie-breaker by level.index
  const lvlA = { index: 0, elevation: { bottom: -Infinity } };
  const lvlB = { index: 1, elevation: { bottom: -Infinity } };
  assert.equal(isLevelAbove(lvlB, lvlA), true);
  assert.equal(isLevelAbove(lvlA, lvlB), false);
});

test("perf-auto normalizeAssetKey strips routePrefix, protects live BaseTextures, and preserves custom tile shaders", async () => {
  installBaseGlobals();
  globalThis.location = { origin: "https://example.test" };
  globalThis.foundry = { utils: { getRoute: (p) => `/foundry/${p}` } };

  const { normalizeAssetKey, disposeStaleSceneVramTextures, syncDecorativeTileShaders } = await import("../scripts/perf-auto.mjs");
  const { PERF_CONFIG } = await import("../scripts/perf-patcher.mjs");
  PERF_CONFIG.perfEnabled = true;
  PERF_CONFIG.perfAutoCulling = true;
  PERF_CONFIG.perfVramCleanup = true;

  assert.equal(normalizeAssetKey("https://example.test/foundry/modules/my%20mod/bg.webp?v=1"), "modules/my mod/bg.webp");
  assert.equal(normalizeAssetKey("modules/my%20mod/bg.webp"), "modules/my mod/bg.webp");
  // Malformed percent sequence must not re-include origin or routePrefix
  assert.equal(normalizeAssetKey("https://example.test/foundry/maps/100%_map.webp"), "maps/100%_map.webp");

  // Live BaseTexture attached to an active tile must NOT be disposed even if URL isn't in scene doc
  let liveDisposed = false;
  let staleDisposed = false;
  const liveBt = { realWidth: 2048, realHeight: 2048, resource: { url: "https://example.test/foundry/custom/live.webp" }, dispose() { liveDisposed = true; } };
  const staleBt = { realWidth: 2048, realHeight: 2048, resource: { url: "https://example.test/foundry/maps/old_scene.webp" }, dispose() { staleDisposed = true; } };

  const customTileMesh = { destroyed: false, pluginName: "customFxShader", occlusionMode: 0, restrictsLight: false, restrictsWeather: false, texture: { baseTexture: liveBt } };
  const defaultTileMesh = { destroyed: false, pluginName: "batchOcclusion", occlusionMode: 0, restrictsLight: false, restrictsWeather: false, texture: { baseTexture: liveBt } };

  globalThis.canvas = {
    ready: true,
    scene: { flags: {}, _source: {}, tiles: [], tokens: [], drawings: [], templates: [], notes: [] },
    app: { renderer: { texture: { managedTextures: [liveBt, staleBt] } } },
    tiles: {
      placeables: [
        { document: { alpha: 1, occlusion: {}, restrictions: {} }, isVideo: false, mesh: customTileMesh },
        { document: { alpha: 1, occlusion: {}, restrictions: {} }, isVideo: false, mesh: defaultTileMesh }
      ]
    }
  };

  disposeStaleSceneVramTextures();
  assert.equal(liveDisposed, false, "live scene tile BaseTexture must never be disposed from VRAM");
  assert.equal(staleDisposed, true, "stale off-scene large texture should be disposed");

  syncDecorativeTileShaders(true);
  assert.equal(customTileMesh.pluginName, "customFxShader", "custom tile shader must not be overwritten with batch");
  assert.equal(defaultTileMesh.pluginName, "batch", "default decorative batchOcclusion tile should use batch");
});

test("buildMeasureCacheKey bails out on waypoint terrain/cost and rewriteShaderNoiseGlsl preserves custom shaders", async () => {
  installBaseGlobals();
  const { buildMeasureCacheKey } = await import("../scripts/perf-cpu.mjs");
  const { rewriteShaderNoiseGlsl } = await import("../scripts/perf-gpu.mjs");

  assert.notEqual(buildMeasureCacheKey([{ x: 0, y: 0 }, { x: 100, y: 0 }], {}), null);
  assert.equal(buildMeasureCacheKey([{ x: 0, y: 0 }, { x: 100, y: 0, terrain: { difficulty: 2 } }], {}), null, "waypoint terrain must bypass memo cache");
  assert.equal(buildMeasureCacheKey([{ x: 0, y: 0 }, { x: 100, y: 0, cost: 10 }], {}), null, "waypoint explicit cost must bypass memo cache");

  // Custom noise() without return mix() followed by another function with return mix() must NOT be corrupted
  const customGlsl = [
    "precision mediump float;",
    "float noise(in vec2 uv) { return fract(sin(dot(uv, vec2(12.9898, 78.233)))); }",
    "float helper(float a, float b) { return mix(a, b, 0.5); }"
  ].join("\n");
  const customRes = rewriteShaderNoiseGlsl(customGlsl);
  assert.equal(customRes.modified, false, "non-Foundry noise() must not eat subsequent functions");
  assert.equal(customRes.src, customGlsl);

  // Shader without precision line but with #extension must place uniform AFTER #extension
  const extGlsl = [
    "#extension GL_OES_standard_derivatives : enable",
    "float noise(in vec2 uv) { vec2 i = floor(uv); return mix(0.0, 1.0, i.x); }"
  ].join("\n");
  const extRes = rewriteShaderNoiseGlsl(extGlsl);
  assert.equal(extRes.modified, true);
  assert.ok(extRes.src.indexOf("#extension") < extRes.src.indexOf("uniform sampler2D uBoundlessNoise;"), "uniform must be inserted after #extension directives");
});

test("lang/ru.json and lang/en.json have identical keys and contain no forbidden UI characters", async () => {
  const fs = await import("node:fs");
  const path = await import("node:path");
  const root = path.resolve(import.meta.dirname, "..");
  const ru = JSON.parse(fs.readFileSync(path.join(root, "lang/ru.json"), "utf8"));
  const en = JSON.parse(fs.readFileSync(path.join(root, "lang/en.json"), "utf8"));
  const flatten = (o, p = "") => Object.entries(o).flatMap(([k, v]) => {
    const key = p ? `${p}.${k}` : k;
    return v && typeof v === "object" && !Array.isArray(v) ? flatten(v, key) : [[key, String(v)]];
  });
  const ruMap = new Map(flatten(ru));
  const enMap = new Map(flatten(en));
  assert.deepEqual([...ruMap.keys()].sort(), [...enMap.keys()].sort(), "ru.json and en.json keys must match 1:1");
  for (const [k, v] of [...ruMap.entries(), ...enMap.entries()]) {
    assert.ok(!/[—–:]/.test(v), `UI string ${k} contains forbidden dash or colon: ${v}`);
  }
});

test("getVirtualTileBounds honors scaleX/scaleY and mirrored negative flips", async () => {
  const { getVirtualTileBounds } = await import("../scripts/utils.mjs");
  const normal = getVirtualTileBounds({ x: 100, y: 100, w: 100, h: 100, anchorX: 0.5, anchorY: 0.5, scaleX: 2, scaleY: 0.5 });
  assert.equal(normal.pivX, 100);
  assert.equal(normal.pivY, 100);
  assert.ok(Math.abs(normal.halfDiag - Math.hypot(200, 50) * 0.5) < 1e-6);

  // Mirrored X flip with asymmetric anchor (0.2 -> effective anchor 0.8 from left)
  const flipped = getVirtualTileBounds({ x: 200, y: 100, w: 100, h: 100, anchorX: 0.2, anchorY: 0.5, scaleX: -1, scaleY: 1 });
  assert.equal(flipped.pivX, 200);
  assert.ok(Math.abs(flipped.halfDiag - Math.hypot(100, 100) * 0.8) < 1e-6);
});

test("editsMethods preserves unloaded chunk doorStates and rejects malformed edit coordinates", async () => {
  installBaseGlobals();
  const { editsMethods } = await import("../scripts/boundless-edits.mjs");

  const ctx = {
    wallEdits: new Map(),
    lightEdits: new Map(),
    soundEdits: new Map(),
    tileEdits: new Map(),
    wallEditsRev: 0,
    lightEditsRev: 0,
    soundEditsRev: 0,
    tileEditsRev: 0,
    simSectors: new Map(),
    lastSimKey: "k",
    openDoors: new Map([["lvl1::0_0_0", { levelId: "lvl1" }], ["lvl1::9_9_0", { levelId: "lvl1" }]]),
    doorStates: new Map([["lvl1::0_0_0", 1], ["lvl1::9_9_0", 1], ["lvl2::0_0_0", 2]]),
    levelLayers: new Map([["lvl1", { spec: { sectors: { "0_0": { d: [] } } } }]]),
    _resolveDoorByKey: () => null,
    _clearClosingDoorTimer: () => {},
    updateSimAndLightBubbles: () => {},
    wallEditor: { syncViewport: () => {} },
    scheduleLightBatchRebuild: () => {},
    ...editsMethods
  };

  ctx.applyVirtualWallChangesLocal();
  assert.equal(ctx.doorStates.has("lvl1::0_0_0"), false, "loaded sector deleted door must be purged");
  assert.equal(ctx.doorStates.has("lvl1::9_9_0"), true, "unloaded chunk doorState must be preserved");
  assert.equal(ctx.doorStates.has("lvl2::0_0_0"), true, "non-visible level doorState must be preserved");

  const dirtyScene = {
    flags: {
      boundless: {
        wallEdits: { lvl1: { "0_0:w:0": { c: [0, 0, NaN, 10] }, "0_0:w:1": { c: [0, 0, 100, 100] }, "0_0:w:2": null } },
        tileEdits: { lvl1: { "t:0": { x: 10, y: 10, w: 0, h: 100 }, "t:1": { x: 10, y: 10, w: 100, h: 100 } } }
      }
    }
  };
  ctx._loadWallEdits(dirtyScene);
  ctx._loadTileEdits(dirtyScene);
  assert.equal(ctx.wallEdits.get("lvl1").has("0_0:w:0"), false, "NaN wall coords must be rejected");
  assert.equal(ctx.wallEdits.get("lvl1").has("0_0:w:1"), true);
  assert.equal(ctx.wallEdits.get("lvl1").get("0_0:w:2"), null);
  assert.equal(ctx.tileEdits.get("lvl1").has("t:0"), false, "zero-width tile edit must be rejected");
  assert.equal(ctx.tileEdits.get("lvl1").has("t:1"), true);
});

test("TokenStreamer._canUserControlDoc never materializes lazy ActorDelta on non-GM clients", async () => {
  installBaseGlobals();
  globalThis.game = { user: { id: "u1", isGM: false } };
  globalThis.CONST = { DOCUMENT_OWNERSHIP_LEVELS: { OWNER: 3 } };
  const { TokenStreamer } = await import("../scripts/token-streamer.mjs");
  const ts = new TokenStreamer({});

  let touchedIsOwner = false;
  const lazyUnownedDoc = {
    id: "tok1",
    viewed: true,
    isLazyDelta: true,
    _source: { hidden: false, delta: { ownership: {} } },
    baseActor: { testUserPermission: () => false },
    get isOwner() { touchedIsOwner = true; return false; }
  };
  const lazyDeltaOwnedDoc = {
    id: "tok2",
    viewed: true,
    isLazyDelta: true,
    _source: { hidden: false, delta: { ownership: { u1: 3 } } },
    baseActor: { testUserPermission: () => false },
    get isOwner() { touchedIsOwner = true; return true; }
  };

  assert.equal(ts._canUserControlDoc(lazyUnownedDoc), false);
  assert.equal(ts._canUserControlDoc(lazyDeltaOwnedDoc), true);
  assert.equal(touchedIsOwner, false, "_canUserControlDoc must never access doc.isOwner on isLazyDelta tokens");
});

test("MegaAudioStreamer tears down active sources when empty, skips radius 0, and includes moved soundEdits", async () => {
  installBaseGlobals();
  globalThis.game = { user: { id: "gm", isGM: true } };
  const created = [];
  class MockSoundSource {
    constructor(opts) { this.sourceId = opts.sourceId; this.attached = false; this.destroyed = false; }
    initialize(cfg) { this.cfg = cfg; this.shape = { radius: cfg.radius }; }
    add() { this.attached = true; created.push(this); }
    destroy() { this.destroyed = true; this.attached = false; }
  }
  globalThis.foundry = { canvas: { sources: { PointSoundSource: MockSoundSource } } };
  globalThis.canvas = {
    ready: true,
    sounds: {},
    dimensions: { size: 100, distance: 5 },
    environment: { darknessLevel: 0 },
    stage: { scale: { x: 1 } },
    level: { id: "lvl1" },
    tokens: { placeables: [] },
    perception: { update() {} }
  };

  const { MegaAudioStreamer } = await import("../scripts/audio-streamer.mjs");
  const streamer = new MegaAudioStreamer();
  const layer = {
    level: { id: "lvl1", elevation: { base: 0 } },
    simGrid: 10,
    simSectorPx: 2000,
    spec: {
      sectors: {
        "0_0": { s: [[100, 100, 0, "zero.ogg", 0.5, true, true, 0, 1, 5]] },
        "5_5": { s: [[10500, 10500, 20, "moved.ogg", 0.6, true, true, 0, 1, 5]] }
      }
    }
  };
  const soundEdits = new Map([
    ["lvl1", new Map([["5_5:s:0", { x: 200, y: 200, radius: 20, path: "moved.ogg", volume: 0.6, walls: true, easing: true, darkMin: 0, darkMax: 1, elevation: 5, hidden: false }]])]
  ]);

  streamer.update([layer], { x0: 0, y0: 0, x1: 800, y1: 800, scale: 1 }, null, soundEdits);
  assert.equal(streamer.activeSources.size, 1, "radius 0 must be skipped and moved soundEdit must play");
  assert.equal(created[0].cfg.path, "moved.ogg");

  // Moving viewport far away (0 anchors at macro zoom) must tear down active sources even if lastKey was ""
  streamer.lastKey = "";
  streamer.update([layer], { x0: 0, y0: 0, x1: 800, y1: 800, scale: 0.05 }, null, soundEdits);
  assert.equal(streamer.activeSources.size, 0, "active sources must be torn down when no anchors remain");
  assert.equal(created[0].destroyed, true);
});

test("ChunkStreamer._fetchChunk protects newer request from stale abort race", async () => {
  installBaseGlobals();
  globalThis.canvas = { tokens: { placeables: [] }, level: { id: "lvl1" } };
  const resolvers = [];
  const prevFetch = globalThis.fetch;
  globalThis.fetch = () => new Promise((resolve, reject) => resolvers.push({ resolve, reject }));
  try {
    const { ChunkStreamer } = await import("../scripts/chunk-streamer.mjs");
    const mounted = [];
    const cs = new ChunkStreamer({ onChunkLoaded: (_l, ck, data) => mounted.push({ ck, data }) });
    const layer = { level: { id: "lvl1" }, worldPx: 20000, spec: { chunks: { baseUrl: "chunks", chunkWorldPx: 5000, cols: 4, rows: 4, populated: ["0_0"] } } };
    cs.mount([layer]);
    const st = cs.states.get("lvl1");
    st.lastNeeded = new Set(["0_0"]);

    cs._fetchChunk(st, "0_0"); // req #1
    cs._fetchChunk(st, "0_0"); // req #2 supersedes req #1
    const req2 = st.pending.get("0_0");

    // Stale req #1 rejects late — must NOT wipe req #2 from st.pending!
    resolvers[0].reject(new Error("late_stale_error"));
    await new Promise(r => setTimeout(r, 10));
    assert.equal(st.pending.get("0_0"), req2, "stale rejection must not delete newer pending request");

    resolvers[1].resolve({ ok: true, json: async () => ({ sectors: { "0_0": { w: [] } } }) });
    await new Promise(r => setTimeout(r, 10));
    assert.equal(mounted.length, 1);
    assert.equal(st.loaded.has("0_0"), true);
  } finally {
    globalThis.fetch = prevFetch;
  }
});

test("scene-baker decodes URL-encoded filenames, preserves radius 0, and deduplicates shared multi-level manifestUrl", async () => {
  installBaseGlobals();
  const prevFetch = globalThis.fetch;
  const prevFP = globalThis.FilePicker;
  const prevUser = globalThis.game.user;
  const { getDirAndFilename, virtualSoundToDocData, bakeSceneEditsToManifest } = await import("../scripts/scene-baker.mjs");

  const parsed = getDirAndFilename("worlds/my%20world/maps/%D0%9A%D0%B0%D1%80%D1%82%D0%B0%201.json?v=2", "fallback");
  assert.equal(parsed.dir, "worlds/my world/maps");
  assert.equal(parsed.filename, "Карта 1.json");
  assert.equal(parsed.redirected, false);

  const zeroSound = virtualSoundToDocData({ x: 10, y: 20, elevation: 5, radius: 0, path: "a.ogg" }, "lvl1");
  assert.equal(zeroSound.radius, 0, "radius 0 must not be coerced to 20");

  let uploadCount = 0;
  let uploadedManifest = null;
  try {
    globalThis.game.user = { isGM: true };
    globalThis.game.i18n = { localize: (k) => k, format: (k) => k };
    globalThis.fetch = async () => ({
      ok: true,
      json: async () => ({
        format: "boundless-pyramid-v1",
        levels: {
          lvlA: { worldPx: 4000, simGrid: 2, simSectorPx: 2000, tiles: [], sectors: { "0_0": { w: [], d: [], l: [[100, 100, 20, 10, "#fff", 0.5, ""]], s: [], t: [], o: [] } } },
          lvlB: { worldPx: 4000, simGrid: 2, simSectorPx: 2000, tiles: [], sectors: { "0_0": { w: [], d: [], l: [[200, 200, 20, 10, "#fff", 0.5, ""]], s: [], t: [], o: [] } } }
        }
      })
    });
    globalThis.FilePicker = {
      createDirectory: async () => {},
      browse: async () => {},
      upload: async (_src, dir, file) => {
        uploadCount++;
        uploadedManifest = JSON.parse(await file.text());
        return { path: `${dir}/${file.name}` };
      }
    };
    globalThis.foundry = { applications: { apps: { FilePicker: globalThis.FilePicker } }, utils: { getRoute: (p) => p } };
    globalThis.canvas = { scene: { id: "other" }, dimensions: { size: 100, distance: 5 } };

    const levels = [
      { id: "lvlA", name: "Floor A", elevation: { base: 0 }, flags: { boundless: { enabled: true, manifestUrl: "worlds/w/shared.json" } }, async update() {} },
      { id: "lvlB", name: "Floor B", elevation: { base: 10 }, flags: { boundless: { enabled: true, manifestUrl: "worlds/w/shared.json" } }, async update() {} }
    ];
    const scene = {
      id: "scShared",
      name: "Shared",
      levels,
      flags: {
        boundless: {
          lightEdits: {
            lvlA: { "0_0:l:0": { x: 111, y: 111, dim: 30, bright: 15, color: "#f00", alpha: 0.5, anim: "", elevation: 6 } },
            lvlB: { "0_0:l:0": { x: 222, y: 222, dim: 30, bright: 15, color: "#0f0", alpha: 0.5, anim: "", elevation: 16 } }
          }
        }
      },
      async update() {},
      async deleteEmbeddedDocuments() {}
    };
    const controller = {
      manifestCache: new Map(),
      lightBatch: { clearPolyCacheDB: async () => {} },
      collectLevelSpatialData: () => ({ sectors: {}, tiles: [], tileIdsToDelete: [], wallIdsToDelete: [], lightIdsToDelete: [], soundIdsToDelete: [] }),
      mount: async () => {}
    };

    await bakeSceneEditsToManifest(controller, scene, { absorbNative: false });
    assert.equal(uploadCount, 1, "shared manifestUrl across 2 levels must upload once without clobbering");
    assert.equal(uploadedManifest.levels.lvlA.sectors["0_0"].l[0][0], 111);
    assert.equal(uploadedManifest.levels.lvlB.sectors["0_0"].l[0][0], 222);
  } finally {
    globalThis.fetch = prevFetch;
    globalThis.FilePicker = prevFP;
    globalThis.game.user = prevUser;
  }
});

test("TileWorkerPool resets _supported on destroy() and respawns crashed worker slots on subsequent decode()", async () => {
  const { TileWorkerPool } = await import("../scripts/tile-worker-pool.mjs");
  let spawnCount = 0;
  const pool = new TileWorkerPool({
    poolSize: 1,
    workerFactory() {
      const id = ++spawnCount;
      return {
        onmessage: null,
        onerror: null,
        onmessageerror: null,
        postMessage(msg) {
          if (id === 1 && msg.type === "decode") {
            throw new Error("transient_crash");
          }
          if (msg.type === "decode") {
            queueMicrotask(() => this.onmessage?.({ data: { id: msg.id, bitmap: { width: 8, height: 8, close() {} }, decodeMs: 1 } }));
          }
        },
        terminate() {}
      };
    }
  });

  await assert.rejects(pool.decode("a.webp"));
  assert.equal(pool._workers[0], null);

  // Next decode must respawn slot 0 and succeed
  const bmp = await pool.decode("b.webp");
  assert.equal(bmp.width, 8);
  assert.equal(spawnCount, 2);

  pool.destroy();
  assert.equal(pool._supported, null, "destroy() must reset _supported to null");
});

test("hasTokenPermissionLazy respects Foundry v14 precedence including explicit delta deny and INHERIT", async () => {
  installBaseGlobals();
  globalThis.CONST.DOCUMENT_OWNERSHIP_LEVELS = { INHERIT: -1, NONE: 0, LIMITED: 1, OBSERVER: 2, OWNER: 3 };
  const { hasTokenPermissionLazy } = await import("../scripts/utils.mjs");

  const player = { id: "u1", isGM: false };
  const gm = { id: "gm1", isGM: true };

  // Explicit delta[uid] = NONE (0) must override baseActor[uid] = OWNER (3)
  const docDenied = {
    isLazyDelta: true,
    _source: { delta: { ownership: { u1: 0, default: 3 } } },
    baseActor: { ownership: { u1: 3, default: 3 } }
  };
  assert.equal(hasTokenPermissionLazy(docDenied, player, "OWNER"), false);
  assert.equal(hasTokenPermissionLazy(docDenied, player, "LIMITED"), false);
  assert.equal(hasTokenPermissionLazy(docDenied, gm, "OWNER"), true);

  // INHERIT (-1) in delta[uid] must fall through to baseActor[uid]
  const docInherit = {
    isLazyDelta: true,
    _source: { delta: { ownership: { u1: -1, default: 0 } } },
    baseActor: { ownership: { u1: 2, default: 0 } }
  };
  assert.equal(hasTokenPermissionLazy(docInherit, player, "OBSERVER"), true);
  assert.equal(hasTokenPermissionLazy(docInherit, player, "OWNER"), false);

  // delta.default overrides base.default when per-user entries are absent
  const docDeltaDefault = {
    isLazyDelta: true,
    _source: { delta: { ownership: { default: 1 } } },
    baseActor: { ownership: { default: 3 } }
  };
  assert.equal(hasTokenPermissionLazy(docDeltaDefault, player, "LIMITED"), true);
  assert.equal(hasTokenPermissionLazy(docDeltaDefault, player, "OBSERVER"), false);
});

test("VirtualWallEditor batched GM door updates resolve DoorInfo, notify perception, and revert by seq on error", async () => {
  installBaseGlobals();
  globalThis.foundry = {
    utils: {
      isEmpty: (o) => !o || Object.keys(o).length === 0,
      deepClone: (o) => structuredClone(o),
      expandObject: (o) => o
    }
  };
  const { VirtualWallEditor } = await import("../scripts/wall-editor.mjs");

  let rejectUpdate;
  const perceptionCalls = [];
  const applied = [];
  const doorInfos = new Map([
    ["lvl1:0_0:d:0", { dKey: "lvl1:0_0:d:0", defaultDs: 0 }],
    ["lvl1:0_0:d:1", { dKey: "lvl1:0_0:d:1", defaultDs: 2 }]
  ]);

  const scene = {
    flags: { boundless: { doorStates: {} } },
    update: () => new Promise((_res, rej) => { rejectUpdate = rej; })
  };
  globalThis.canvas = {
    scene,
    perception: { update: (flags) => perceptionCalls.push(flags) }
  };

  const controller = {
    active: true,
    _pendingDoorCommits: new Map(),
    _resolveDoorByKey: (k) => doorInfos.get(k) ?? null,
    _normalizeDoorState: (ds, def) => (Number.isFinite(ds) ? ds : def),
    _applyDoorStateLocal: (info, ds, opts) => {
      assert.equal(typeof info, "object", "must receive resolved DoorInfo object, not string key");
      applied.push({ dKey: info.dKey, ds, opts });
      return true;
    },
    updateSimAndLightBubbles: () => {}
  };

  const editor = new VirtualWallEditor(controller);
  const makeEntry = (id, dKey, ds) => ({
    id,
    dKey,
    isDoor: true,
    levelId: "lvl1",
    wKey: dKey.slice(5),
    doc: { id, ds, door: 1, updateSource() {} }
  });
  editor.mountedById.set("w1", makeEntry("w1", "lvl1:0_0:d:0", 0));
  editor.mountedById.set("w2", makeEntry("w2", "lvl1:0_0:d:1", 2));

  await editor._commitVirtualUpdates([
    { _id: "w1", ds: 1 },
    { _id: "w2", ds: 0 }
  ]);

  assert.equal(applied.length, 2);
  assert.equal(applied[0].ds, 1);
  assert.equal(applied[1].ds, 0);
  assert.equal(perceptionCalls[0].initializeVision, true);
  assert.equal(perceptionCalls[0].initializeSounds, true);

  // Trigger rejection -> must revert both doors to their defaultDs (0 and 2)
  rejectUpdate(new Error("db_fail"));
  await new Promise(r => setTimeout(r, 10));
  assert.equal(applied.length, 4);
  assert.equal(applied[2].ds, 0);
  assert.equal(applied[3].ds, 2);
  assert.equal(controller._pendingDoorCommits.size, 0);
});

test("TileWorkerPool keeps isSupported() true while respawn attempts remain so LRUTextureManager can recover", async () => {
  const { TileWorkerPool } = await import("../scripts/tile-worker-pool.mjs");
  let spawns = 0;
  const pool = new TileWorkerPool({
    poolSize: 1,
    workerFactory() {
      const idx = ++spawns;
      return {
        onmessage: null,
        onerror: null,
        onmessageerror: null,
        postMessage(msg) {
          if (idx === 1 && msg.type === "decode") {
            queueMicrotask(() => this.onerror?.({ message: "worker_oom" }));
            return;
          }
          if (msg.type === "decode") {
            queueMicrotask(() => this.onmessage?.({ data: { id: msg.id, bitmap: { width: 16, height: 16, close() {} }, decodeMs: 1 } }));
          }
        },
        terminate() {}
      };
    }
  });

  await assert.rejects(pool.decode("tile1.webp"));
  assert.equal(pool.isSupported(), true, "isSupported() must remain true while respawn attempts remain");

  const bmp = await pool.decode("tile2.webp");
  assert.equal(bmp.width, 16);
  assert.equal(spawns, 2);
  pool.destroy();
});

test("ChunkedFogManager SHARED brush reveal does not taint privateCanvas, while erase clears both and marks _dirtyPrivate", async () => {
  installBaseGlobals();
  globalThis.CONST.FOG_EXPLORATION_MODES = { DISABLED: 0, INDIVIDUAL: 1, SHARED: 2 };
  const { ChunkedFogManager } = await import("../scripts/chunked-fog.mjs");

  const makeMockCtx = () => ({
    ops: [],
    globalCompositeOperation: "source-over",
    fillStyle: "",
    save() {},
    restore() {},
    beginPath() {},
    arc(x, y, r) { this.ops.push({ op: this.globalCompositeOperation, x, y, r }); },
    fill() {},
    clearRect() {},
    drawImage() {}
  });

  const fog = new ChunkedFogManager();
  fog.enabled = true;
  fog.container = {};
  fog.sceneId = "sc1";
  fog.levelId = "lvl1";
  fog.mode = globalThis.CONST.FOG_EXPLORATION_MODES.SHARED;

  const sharedCtx = makeMockCtx();
  const privateCtx = makeMockCtx();
  const displayCtx = makeMockCtx();
  const chunk = {
    cx: 0,
    cy: 0,
    key: "0_0",
    sprite: { visible: true },
    canvas: { width: 512, height: 512 },
    ctx: displayCtx,
    sharedCanvas: { width: 512, height: 512 },
    sharedCtx,
    privateCanvas: { width: 512, height: 512 },
    privateCtx,
    hasPrivate: true,
    texture: { baseTexture: { update() {} } }
  };
  fog.chunks.set("0_0", chunk);
  fog._getOrCreateChunk = () => chunk;
  fog._recompositeChunk = () => {};
  fog._scheduleSave = () => {};
  fog._scheduleLocalCacheSave = () => {};

  // Reveal stroke in SHARED mode: must touch sharedCtx only, NEVER privateCtx or _dirtyPrivate
  fog._applyBrushStrokes([[200, 200, 50, 0]], { markDirty: true });
  assert.equal(sharedCtx.ops.length, 1);
  assert.equal(privateCtx.ops.length, 0, "SHARED reveal must not draw into privateCtx");
  assert.equal(fog._dirtyShared.has("0_0"), true);
  assert.equal(fog._dirtyPrivate.has("0_0"), false, "SHARED reveal must not mark _dirtyPrivate");

  // Erase stroke in SHARED mode: must erase both sharedCtx and privateCtx and mark _dirtyPrivate
  fog._applyBrushStrokes([[200, 200, 50, 1]], { markDirty: true });
  assert.equal(sharedCtx.ops.length, 2);
  assert.equal(sharedCtx.ops[1].op, "destination-out");
  assert.equal(privateCtx.ops.length, 1);
  assert.equal(privateCtx.ops[0].op, "destination-out");
  assert.equal(fog._dirtyPrivate.has("0_0"), true, "SHARED erase with hasPrivate must mark _dirtyPrivate");
});

test("perf-auto handles 90-degree rotated camera viewport and avoids deprecated TileDocument#occlusion.mode", async () => {
  installBaseGlobals();
  const { computeExpandedViewport, syncSingleDecorativeTile } = await import("../scripts/perf-auto.mjs");

  // 90 deg rotation matrix: a=0, b=1, c=-1, d=0 -> det = 1
  const stage = { worldTransform: { a: 0, b: 1, c: -1, d: 0, tx: 100, ty: 50 } };
  const vp = computeExpandedViewport(stage, { x: 0, y: 0, width: 200, height: 100 }, 0, 0);
  assert.ok(vp, "rotated stage with a=0,d=0 must produce a valid viewport");
  assert.equal(vp.minX, -50);
  assert.equal(vp.maxX, 50);
  assert.equal(vp.minY, -100);
  assert.equal(vp.maxY, 100);

  // TileDocument with v14 occlusion.modes Set must NEVER touch deprecated occlusion.mode getter
  let deprecatedRead = false;
  const occ = {
    modes: new Set(),
    get mode() { deprecatedRead = true; return 0; }
  };
  const mesh = { pluginName: "batchOcclusion", _shader: { pluginName: "batchOcclusion" }, unoccludedAlpha: 1, destroyed: false };
  const tile = { mesh, document: { alpha: 1, occlusion: occ, restrictions: {} }, isVideo: false };

  syncSingleDecorativeTile(tile, true);
  assert.equal(deprecatedRead, false, "must not access deprecated doc.occlusion.mode when modes Set exists");
  assert.equal(mesh.pluginName, "batch");
  assert.equal(mesh._blFastBatch, true);

  // If a third-party module swaps the tile's shader to a custom one, sync must release our batch override
  mesh._shader = { pluginName: "customFxShader" };
  syncSingleDecorativeTile(tile, true);
  assert.equal(mesh.pluginName, null);
  assert.equal(mesh._blFastBatch, false);
});

test("applyLightingRenderScale overrides Foundry v14 non-MAX no-op setter and restores original descriptor on full", async () => {
  installBaseGlobals();
  const { PERF_CONFIG } = await import("../scripts/perf-patcher.mjs");
  const { applyLightingRenderScale } = await import("../scripts/perf-gpu.mjs");

  const prevEnabled = PERF_CONFIG.perfEnabled;
  const prevScale = PERF_CONFIG.perfLightingScale;
  try {
    const makeFilter = () => {
      const f = { destroyed: false };
      Object.defineProperty(f, "resolution", {
        configurable: true,
        enumerable: true,
        get() { return 1; },
        set() {} // Foundry v14 LOW/MED/HIGH no-op setter
      });
      return f;
    };
    const illumFilter = makeFilter();
    const colorFilter = makeFilter();
    const darkFilter = makeFilter();

    globalThis.canvas = {
      ready: true,
      performance: { mode: 2 },
      app: { renderer: { resolution: 2, renderTexture: { current: null } } },
      effects: {
        illumination: { filter: illumFilter },
        coloration: { filter: colorFilter },
        darkness: { filter: darkFilter }
      }
    };

    PERF_CONFIG.perfEnabled = true;
    PERF_CONFIG.perfLightingScale = "balanced";
    applyLightingRenderScale();
    assert.equal(illumFilter.resolution, 1.1, "balanced scale 0.55 * renderer resolution 2 = 1.1");
    assert.equal(colorFilter.resolution, 1.7, "balanced scale 0.85 * renderer resolution 2 = 1.7");

    PERF_CONFIG.perfLightingScale = "full";
    applyLightingRenderScale();
    assert.equal(illumFilter.resolution, 1, "full mode must restore original getter");
    assert.equal(illumFilter._blResMult, undefined);
  } finally {
    PERF_CONFIG.perfEnabled = prevEnabled;
    PERF_CONFIG.perfLightingScale = prevScale;
  }
});

test("buildMeasureCacheKey distinguishes undefined elevation from 0 and uses exact keys for short paths", async () => {
  const { buildMeasureCacheKey } = await import("../scripts/perf-cpu.mjs");

  const kUndef = buildMeasureCacheKey([{ x: 100, y: 100 }, { x: 200, y: 100 }], {});
  const kZero = buildMeasureCacheKey([{ x: 100, y: 100, elevation: 0 }, { x: 200, y: 100, elevation: 0 }], {});
  assert.ok(kUndef && kZero);
  assert.notEqual(kUndef, kZero, "elevation: undefined and elevation: 0 must not collide");
  assert.ok(kUndef.startsWith("E:"), "short paths (<= 12 waypoints) must use exact string key");
});

test("resolveFoundryClass skips deprecated foundry.canvas.tokens and resolves Roll from foundry.dice", async () => {
  installBaseGlobals();
  let deprecatedTokensTouched = false;
  class FakeRoll {}
  globalThis.foundry = {
    canvas: {
      get tokens() { deprecatedTokensTouched = true; return {}; },
      layers: {},
      placeables: {}
    },
    dice: { Roll: FakeRoll }
  };
  const { resolveFoundryClass } = await import("../scripts/perf-patcher.mjs");
  const resolved = resolveFoundryClass("Roll");
  assert.equal(resolved?.cls, FakeRoll);
  assert.equal(resolved?.path, "foundry.dice.Roll");
  assert.equal(deprecatedTokensTouched, false, "must never enumerate deprecated foundry.canvas.tokens");
});

test("isStandardTokenChild recognizes Foundry v14 levelIndicator so Token UI culling stays active", async () => {
  const { isStandardTokenChild } = await import("../scripts/perf-gpu.mjs");
  const lvlInd = { name: "levelIndicator" };
  const aura = { name: "customAura" };
  const tok = {
    turnMarker: {}, border: {}, voidMesh: {}, detectionFilterMesh: {},
    bars: {}, effects: {}, targetArrows: {}, targetPips: {},
    nameplate: {}, tooltip: {}, levelIndicator: lvlInd
  };
  assert.equal(isStandardTokenChild(tok, lvlInd), true, "v14 levelIndicator must be treated as a standard token child");
  assert.equal(isStandardTokenChild(tok, aura), false, "custom third-party children must still be detected");
});

test("applyLightingRenderScale defers during Boundless._mounting and restoreFilterResolution cleanly unwraps", async () => {
  installBaseGlobals();
  const { PERF_CONFIG } = await import("../scripts/perf-patcher.mjs");
  const { applyLightingRenderScale, restoreFilterResolution } = await import("../scripts/perf-gpu.mjs");

  const prevBoundless = globalThis.Boundless;
  const prevScale = PERF_CONFIG.perfLightingScale;
  const prevEnabled = PERF_CONFIG.perfEnabled;
  try {
    const f = { destroyed: false };
    Object.defineProperty(f, "resolution", { configurable: true, enumerable: true, get() { return 2; }, set() {} });
    globalThis.canvas = {
      ready: true,
      performance: { mode: 2 },
      app: { renderer: { resolution: 2, renderTexture: { current: null } } },
      effects: { illumination: { filter: f }, coloration: {}, darkness: {} }
    };
    PERF_CONFIG.perfEnabled = true;
    PERF_CONFIG.perfLightingScale = "balanced";

    globalThis.Boundless = { _mounting: true };
    applyLightingRenderScale();
    assert.equal(f.resolution, 2, "must not patch filter while Boundless is mid-mount");

    globalThis.Boundless = { _mounting: false };
    applyLightingRenderScale();
    assert.equal(f.resolution, 1.1);

    assert.equal(restoreFilterResolution(f), true);
    assert.equal(f.resolution, 2, "restoreFilterResolution must restore Foundry's original getter");
    assert.equal(f._blResMult, undefined);
  } finally {
    globalThis.Boundless = prevBoundless;
    PERF_CONFIG.perfLightingScale = prevScale;
    PERF_CONFIG.perfEnabled = prevEnabled;
  }
});

test("pyramidMethods.hasReadyOtherZCovering handles zoom-out (other.z > e.z) on translucent fg and isUpper channels", async () => {
  const { pyramidMethods } = await import("../scripts/boundless-pyramid.mjs");
  const baseTile = { levelId: "l1", channel: "bg", z: 3, x0: 0, y0: 0, sizePx: 1000, layer: { isUpper: false } };
  const fgTile = { levelId: "l1", channel: "fg", z: 3, x0: 0, y0: 0, sizePx: 1000, layer: { isUpper: false } };
  const upperTile = { levelId: "l1", channel: "bg", z: 3, x0: 0, y0: 0, sizePx: 1000, layer: { isUpper: true } };
  const higherZ = [{ z: 4, x0: 0, y0: 0, sizePx: 500 }];

  assert.equal(pyramidMethods.hasReadyOtherZCovering(baseTile, higherZ), false, "opaque bg only checks lower-Z ancestors");
  assert.equal(pyramidMethods.hasReadyOtherZCovering(fgTile, higherZ), true, "translucent fg must detect higher-Z tiles on zoom-out");
  assert.equal(pyramidMethods.hasReadyOtherZCovering(upperTile, higherZ), true, "translucent isUpper must detect higher-Z tiles on zoom-out");
});

test("MegaAudioStreamer scopes token/preview anchors strictly to their own levelId", async () => {
  installBaseGlobals();
  const { MegaAudioStreamer } = await import("../scripts/audio-streamer.mjs");
  const created = [];
  globalThis.foundry = {
    canvas: {
      sources: {
        PointSoundSource: class {
          constructor() { this.attached = true; this.shape = {}; created.push(this); }
          initialize(cfg) { this.cfg = cfg; return this; }
          add() {}
          destroy() { this.destroyed = true; }
        }
      }
    }
  };
  globalThis.canvas = {
    ready: true,
    dimensions: { size: 100, distance: 5 },
    environment: { darknessLevel: 0 },
    tokens: { placeables: [{ controlled: true, document: { id: "t1", level: "lvlA", x: 100, y: 100, width: 1, height: 1 }, center: { x: 150, y: 150 }, destroyed: false }] },
    sounds: { livePreview: null, sources: new Map() }
  };

  const layerA = { level: { id: "lvlA", elevation: { base: 0 } }, simGrid: 2, simSectorPx: 1000, spec: { sectors: { "0_0": { s: [[150, 150, 20, "a.ogg", 0.5, false, true, 0, 1, 5]] } } } };
  const layerB = { level: { id: "lvlB", elevation: { base: 10 } }, simGrid: 2, simSectorPx: 1000, spec: { sectors: { "0_0": { s: [[150, 150, 20, "b.ogg", 0.5, false, true, 0, 1, 15]] } } } };

  const streamer = new MegaAudioStreamer();
  // Use macro scale (< 0.15) so viewport anchor is inactive and only the lvlA token anchor drives streaming
  streamer.update([layerA, layerB], { x0: 0, y0: 0, x1: 500, y1: 500, scale: 0.05 });
  assert.equal(streamer.activeSources.size, 1, "lvlA token anchor must NOT mount sounds on lvlB");
  assert.equal(created[0].cfg.path, "a.ogg");
});

test("ChunkedFogManager filters multi-level visionSources and allows concurrent multi-GM sharedFog updates", async () => {
  installBaseGlobals();
  globalThis.CONST.FOG_EXPLORATION_MODES = { DISABLED: 0, INDIVIDUAL: 1, SHARED: 2 };
  const { ChunkedFogManager } = await import("../scripts/chunked-fog.mjs");

  const fog = new ChunkedFogManager();
  fog.enabled = true;
  fog.container = {};
  fog.sceneId = "sc1";
  fog.levelId = "lvl1";
  fog.mode = globalThis.CONST.FOG_EXPLORATION_MODES.SHARED;

  const appliedPolys = [];
  fog._applyPolygons = (polys) => { appliedPolys.push(...polys); return true; };

  globalThis.canvas = {
    effects: {
      visionSources: new Set([
        { active: true, sourceId: "v1", level: { id: "lvl1" }, los: { points: [0, 0, 100, 0, 100, 100] }, object: { document: { level: "lvl1", hasPlayerOwner: true } } },
        { active: true, sourceId: "v2", level: { id: "lvl2" }, los: { points: [500, 500, 600, 500, 600, 600] }, object: { document: { level: "lvl2", hasPlayerOwner: true } } }
      ])
    },
    tokens: { controlled: [] }
  };

  fog.revealFromActiveVision({ broadcast: false });
  assert.equal(appliedPolys.length, 1, "must ignore vision polygons from lvl2 while viewing lvl1");
  assert.equal(appliedPolys[0][0], 0);

  // Multi-GM concurrent sharedFog: suppress own echo while saving, accept another GM's patch!
  let mergedCount = 0;
  fog._mergeChunkMap = () => { mergedCount++; };
  fog._incSavingShared("lvl1");
  fog.onSceneFogFlagsChanged({}, { lvl1: { "0_0": "data:image/png;base64,AA" } }, "gm1");
  assert.equal(mergedCount, 0, "own in-flight save echo must be suppressed");
  fog.onSceneFogFlagsChanged({}, { lvl1: { "0_0": "data:image/png;base64,BB" } }, "gm2");
  assert.equal(mergedCount, 1, "another GM's sharedFog update must NOT be dropped during local save");
  fog._decSavingShared("lvl1");
});

test("lightingMethods._onSocketMessage handles cross-scene fogReveal and doorRequest on activeGM while enforcing lock/secret guards", async () => {
  installBaseGlobals();
  const { lightingMethods } = await import("../scripts/boundless-lighting.mjs");

  const sceneUpdates = [];
  let fogHandled = 0;
  const remoteScene = {
    id: "otherScene",
    levels: new Map([["lvl1", { id: "lvl1", flags: { boundless: { inlineManifest: { sectors: { "0_0": { d: [[0, 0, 100, 0, 1, 0], [0, 0, 100, 0, 2, 0], [0, 0, 100, 0, 1, 2]] } } } } } }]]),
    flags: { boundless: { doorStates: {} } },
    async update(patch) { sceneUpdates.push(patch); }
  };
  globalThis.game.scenes = new Map([["otherScene", remoteScene]]);
  globalThis.canvas = { scene: { id: "gmCurrentScene" } };

  const ctrl = {
    ...lightingMethods,
    active: false, // GM is on a standard non-Boundless scene!
    fogManager: {
      handleSocketMessage(payload) {
        if (payload.type === "fogReveal") { fogHandled++; return true; }
        return false;
      }
    }
  };

  await ctrl._onSocketMessage({ type: "fogReveal", sceneId: "otherScene", senderId: "player1", polygons: [[0, 0, 10, 0, 10, 10]] });
  assert.equal(fogHandled, 1, "cross-scene fogReveal must reach fogManager even when GM is on an inactive/other scene");

  // Normal unlocked door -> persisted via remoteScene.update
  await ctrl._onSocketMessage({ type: "doorRequest", sceneId: "otherScene", senderId: "player1", dKey: "lvl1::0_0_0", ds: 1 });
  assert.equal(sceneUpdates.length, 1);
  assert.equal(sceneUpdates[0]["flags.boundless.doorStates.lvl1::0_0_0"], 1);

  // Secret door (idx 1) and locked door (idx 2) -> rejected
  await ctrl._onSocketMessage({ type: "doorRequest", sceneId: "otherScene", senderId: "player1", dKey: "lvl1::0_0_1", ds: 1 });
  await ctrl._onSocketMessage({ type: "doorRequest", sceneId: "otherScene", senderId: "player1", dKey: "lvl1::0_0_2", ds: 1 });
  assert.equal(sceneUpdates.length, 1, "secret and locked doors on remote scenes must remain protected");
});

test("MegaLightBatch.detachChunk preserves shared-sector resident metadata and _buildNativeEdgesSig tracks direction & threshold", async () => {
  installBaseGlobals();
  const { MegaLightBatch } = await import("../scripts/light-batch.mjs");
  const lb = new MegaLightBatch();

  const batchA = { lightIds: ["lvl1::0_0_0"], weightArray: new Float32Array(4), illumMesh: null, colorMesh: null, geometry: null };
  const batchB = { lightIds: ["lvl1::0_0_0"], weightArray: new Float32Array(4), illumMesh: null, colorMesh: null, geometry: null };
  const metaB = { id: "lvl1::0_0_0", weight: 1, batch: batchB };
  lb.chunkBatches.set("lvl1::0_0", batchA);
  lb.chunkBatches.set("lvl1::1_0", batchB);
  lb.lightMetaById.set("lvl1::0_0_0", metaB);
  lb.totalLights = 1;
  lb.activeLightsCount = 1;

  lb.detachChunk("lvl1", "0_0");
  assert.equal(lb.lightMetaById.get("lvl1::0_0_0"), metaB, "evicting chunk A must not delete chunk B's live lightMetaById");
  assert.equal(lb.totalLights, 1);

  const e1 = { a: { x: 0, y: 0 }, b: { x: 100, y: 0 }, light: 20, direction: 0, threshold: { light: 0, attenuation: false } };
  const e2 = { a: { x: 0, y: 0 }, b: { x: 100, y: 0 }, light: 20, direction: 1, threshold: { light: 0, attenuation: false } };
  const e3 = { a: { x: 0, y: 0 }, b: { x: 100, y: 0 }, light: 20, direction: 0, threshold: { light: 10, attenuation: true } };
  assert.notEqual(lb._buildNativeEdgesSig([e1]), lb._buildNativeEdgesSig([e2]), "direction change must change native edges sig");
  assert.notEqual(lb._buildNativeEdgesSig([e1]), lb._buildNativeEdgesSig([e3]), "threshold.light change must change native edges sig");
});

test("LRUTextureManager._loadFallback caches repeated missing URLs in missingSrcs to prevent 404 storms", async () => {
  installBaseGlobals();
  let loadCalls = 0;
  globalThis.foundry = {
    canvas: {
      loadTexture: async () => { loadCalls++; throw new Error("404"); }
    }
  };
  const { LRUTextureManager } = await import("../scripts/texture-manager.mjs");
  const tm = new LRUTextureManager();

  await tm.load("missing-prop.svg");
  await tm.load("missing-prop.svg");
  await tm.load("missing-prop.svg");
  assert.equal(loadCalls, 2, "must cache missing non-worker asset after 2 consecutive failures");
  assert.equal(tm.missingSrcs.has("missing-prop.svg"), true);
  tm.clear(true);
  assert.equal(tm.missingSrcs.size, 0);
});

test("hasAnyCustomChild ignores hidden/non-renderable children (e.g. vision-5e SpriteMesh) so UI culling stays active", async () => {
  const { hasAnyCustomChild } = await import("../scripts/perf-gpu.mjs");
  const lvlInd = { visible: true, renderable: true, worldAlpha: 1, destroyed: false };
  const hiddenV5eMesh = { visible: true, renderable: false, worldAlpha: 1, destroyed: false };
  const visibleAura = { visible: true, renderable: true, worldAlpha: 1, destroyed: false };
  const tokHidden = { levelIndicator: lvlInd, children: [lvlInd, hiddenV5eMesh] };
  const tokAura = { levelIndicator: lvlInd, children: [lvlInd, visibleAura] };

  assert.equal(hasAnyCustomChild(tokHidden), false, "non-renderable custom child must not disable token UI frustum culling");
  assert.equal(hasAnyCustomChild(tokAura), true, "active visible custom child must still opt out of culling");
});

test("syncSingleDecorativeTile releases batch override when a custom direct shader has pluginName === null", async () => {
  installBaseGlobals();
  const { syncSingleDecorativeTile } = await import("../scripts/perf-auto.mjs");
  const mesh = { pluginName: "batchOcclusion", _shader: { pluginName: "batchOcclusion" }, unoccludedAlpha: 1, destroyed: false };
  const tile = { mesh, document: { alpha: 1, occlusion: { modes: new Set() }, restrictions: {} }, isVideo: false };

  syncSingleDecorativeTile(tile, true);
  assert.equal(mesh.pluginName, "batch");
  assert.equal(mesh._blFastBatch, true);

  // Direct non-batched shader (static classPluginName = null)
  mesh._shader = { pluginName: null };
  syncSingleDecorativeTile(tile, true);
  assert.equal(mesh.pluginName, null, "must release batch override for custom direct shaders with pluginName === null");
  assert.equal(mesh._blFastBatch, false);
});

test("MegaAudioStreamer.update never materializes lazy ActorDelta on canvasPan", async () => {
  installBaseGlobals();
  globalThis.CONST.DOCUMENT_OWNERSHIP_LEVELS = { INHERIT: -1, NONE: 0, LIMITED: 1, OBSERVER: 2, OWNER: 3 };
  const { MegaAudioStreamer } = await import("../scripts/audio-streamer.mjs");
  let actorTouched = false;
  const lazyDoc = {
    id: "npc1",
    level: "lvl1",
    isLazyDelta: true,
    _source: { delta: { ownership: {} } },
    baseActor: { hasPlayerOwner: false, ownership: { default: 0 } },
    get actor() { actorTouched = true; return null; },
    get hasPlayerOwner() { actorTouched = true; return false; }
  };
  const tok = {
    controlled: false,
    destroyed: false,
    center: { x: 100, y: 100 },
    document: lazyDoc,
    get isOwner() { actorTouched = true; return false; },
    get actor() { actorTouched = true; return null; }
  };
  globalThis.foundry = { canvas: { sources: { PointSoundSource: class {} } } };
  globalThis.canvas = {
    ready: true,
    dimensions: { size: 100, distance: 5 },
    environment: { darknessLevel: 0 },
    tokens: { placeables: [tok] },
    sounds: { livePreview: null }
  };

  const streamer = new MegaAudioStreamer();
  const layer = { level: { id: "lvl1", elevation: { base: 0 } }, simGrid: 2, simSectorPx: 1000, spec: { sectors: {} } };

  // Test both GM and non-GM paths
  globalThis.game.user = { id: "gm1", isGM: true };
  streamer.update([layer], { x0: 0, y0: 0, x1: 500, y1: 500, scale: 0.05 });
  globalThis.game.user = { id: "u1", isGM: false };
  streamer.update([layer], { x0: 0, y0: 0, x1: 500, y1: 500, scale: 0.05 });
  assert.equal(actorTouched, false, "MegaAudioStreamer must never trigger lazy ActorDelta materialization");
});

test("lightingMethods rejects non-canonical dKey syntax and toggles mmv_* edges for moved doors", async () => {
  installBaseGlobals();
  const { lightingMethods } = await import("../scripts/boundless-lighting.mjs");

  const edges = new Map();
  class FakeEdge { constructor(a, b, opts) { this.a = a; this.b = b; Object.assign(this, opts); } }
  globalThis.foundry = { canvas: { geometry: { edges: { Edge: FakeEdge } } } };
  globalThis.canvas = { dimensions: { size: 100, distance: 5 }, perception: { update() {} } };

  const layer = {
    level: { id: "lvl1", edges },
    simGrid: 4,
    simSectorPx: 1000,
    spec: { sectors: { "0_0": { d: [[100, 100, 200, 100, 1, 0]] } } }
  };
  const ctrl = {
    ...lightingMethods,
    levelLayers: new Map([["lvl1", layer]]),
    doorStates: new Map(),
    openDoors: new Map(),
    simSectors: new Map([["lvl1::2_0", { level: layer.level, edgeIds: [] }]]),
    closingDoorTimers: new Map(),
    wallEditor: { mountedByDoorKey: new Map(), applyDoorStateToMounted: () => false },
    resolveVirtualWall: () => ({
      c: [2100, 100, 2200, 100], // moved from sector 0_0 into sector 2_0
      move: 20, sight: 20, light: 20, sound: 20, dir: 0, door: 1, ds: 0
    })
  };

  // Crafted dot-injection key must be rejected
  assert.equal(ctrl._resolveDoorByKey("lvl1::0.0_0_0"), null, "non-canonical float dKey must be rejected");
  assert.equal(ctrl._resolveDoorByKey("lvl1::0_0_w0.0"), null);

  const info = ctrl._resolveDoorByKey("lvl1::0_0_0");
  assert.ok(info);
  assert.equal(info.kind, "d");
  assert.equal(info.sk, "0_0");

  // Simulate moved-door edge in destination sector 2_0
  const mEid = "mmv_lvl1_2_0_d_0_0_0";
  edges.set(mEid, { id: mEid });

  // Open moved door -> mmv_* edge must be removed
  ctrl._applyDoorStateLocal(info, 1, { playSound: false, deferRefresh: true });
  assert.equal(edges.has(mEid), false, "opening a moved door must delete its mmv_* edge");

  // Close moved door while only destination sector 2_0 (not home 0_0) is in simSectors -> mmv_* edge must be restored
  ctrl._applyDoorStateLocal(info, 0, { playSound: false, deferRefresh: true });
  assert.equal(edges.has(mEid), true, "closing a moved door must restore its mmv_* edge in active destination sector");
});

test("TokenImpostorLayer.refreshTokenStates updates O(K) slots and flush() coalesces atlas uploads during active decodes", async () => {
  installBaseGlobals();
  const { TokenImpostorLayer } = await import("../scripts/token-impostors.mjs");

  const imp = new TokenImpostorLayer({}, {});
  imp.mounted = true;
  imp.count = 100;
  let visScanCalls = 0;
  const updatedIds = [];
  imp._collectVisionCheckers = () => { visScanCalls++; return {}; };
  imp._updateSingleTokenState = (doc) => { updatedIds.push(doc.id); };

  imp.refreshTokenStates([{ id: "t1" }, { id: "t2" }]);
  assert.equal(visScanCalls, 1, "must compute vision checkers only once for the toggled batch");
  assert.deepEqual(updatedIds, ["t1", "t2"]);

  // Atlas upload coalescing while decodes are in flight
  let atlasUploads = 0;
  imp.atlasTexture = { baseTexture: { update() { atlasUploads++; } } };
  imp.atlasDirty = true;
  imp._activeDecodes = 2;
  imp._lastAtlasUploadMs = performance.now();
  imp.flush();
  assert.equal(atlasUploads, 0, "must defer 2048x2048 atlas upload inside 180ms window while decodes are streaming");

  imp._activeDecodes = 0;
  imp._decodeQueue = [];
  imp.flush();
  assert.equal(atlasUploads, 1, "must flush atlas immediately once decode queue drains");
});

test("TokenStreamer.materializeAndSelect calls applyRenderFlags before hex _overlapsSelection", async () => {
  installBaseGlobals();
  const { TokenStreamer } = await import("../scripts/token-streamer.mjs");
  const { TokenImpostorLayer } = await import("../scripts/token-impostors.mjs");

  let appliedBeforeOverlap = false;
  let controlled = false;
  const tokObj = {
    destroyed: false,
    parent: null,
    controlled: false,
    shape: null,
    async draw() {},
    applyRenderFlags() { this.shape = { type: "hex" }; },
    _overlapsSelection() {
      appliedBeforeOverlap = Boolean(this.shape);
      return appliedBeforeOverlap;
    },
    control() { this.controlled = true; controlled = true; return true; }
  };
  const doc = { id: "hexTok1", viewed: true, _source: { x: 100, y: 100, width: 1, height: 1 }, _object: null };
  const tokenLayer = {
    active: true,
    objects: { addChild(c) { c.parent = this; } },
    createObject: () => tokObj
  };
  globalThis.ui = { controls: { rendered: false }, notifications: { info() {}, warn() {} } };
  globalThis.canvas = {
    ready: true,
    grid: { size: 100, isHexagonal: true },
    stage: { scale: { x: 1 } },
    scene: { id: "sc1", tokens: new Map([["hexTok1", doc]]) },
    tokens: tokenLayer
  };

  const streamer = new TokenStreamer({ active: true });
  streamer.enabled = true;
  streamer.impostors = new TokenImpostorLayer({}, streamer);
  streamer.materializeAndSelect([doc], {
    releaseOthers: false,
    maxCount: 1,
    selectionRect: { x: 0, y: 0, width: 500, height: 500 }
  });
  await new Promise(r => setTimeout(r, 30));
  assert.equal(appliedBeforeOverlap, true, "applyRenderFlags() must populate shape before _overlapsSelection on hex grids");
  assert.equal(controlled, true, "freshly materialized hex token overlapping selectionRect must be controlled");
});

test("editsMethods skips video tiles during baking and preserves cached manifest POIs for inactive scenes", async () => {
  installBaseGlobals();
  globalThis.CONST.OCCLUSION_MODES = { NONE: 0, FADE: 1, RADIAL: 2, VISION: 3 };
  globalThis.foundry = { utils: { deepClone: (o) => structuredClone(o) } };
  const { editsMethods } = await import("../scripts/boundless-edits.mjs");

  const scene = {
    id: "scVideo",
    width: 4000,
    height: 4000,
    flags: { boundless: { manifestUrl: "worlds/w/m.json" } },
    tiles: [
      { id: "tImg", x: 100, y: 100, width: 200, height: 200, texture: { src: "img/table.webp" }, elevation: 0 },
      { id: "tVid", x: 300, y: 300, width: 200, height: 200, texture: { src: "vfx/fire.webm" }, elevation: 0 }
    ],
    walls: [],
    lights: [],
    sounds: []
  };
  const level = { id: "lvl1", elevation: { base: 0 } };
  const spatial = editsMethods.collectLevelSpatialData(scene, level);
  assert.equal(spatial.tiles.length, 1, "video tile must NOT be absorbed into static manifest");
  assert.deepEqual(spatial.tileIdsToDelete, ["tImg"]);

  // getEffectivePOIs when viewing a different scene must still consult manifestCache
  globalThis.canvas = { scene: { id: "otherScene" } };
  const cachedManifest = { pois: [{ id: "p1", name: "Capital", x: 100, y: 100 }] };
  const ctrl = {
    ...editsMethods,
    manifest: null,
    manifestCache: new Map([["worlds/w/m.json", cachedManifest]]),
    poiManager: { resolvePois: (_sc, man) => man?.pois ?? [] }
  };
  const pois = ctrl.getEffectivePOIs(scene);
  assert.equal(pois.length, 1);
  assert.equal(pois[0].name, "Capital");
});

test("bakeSceneToBoundless rejects direct API re-baking of an already-baked scene", async () => {
  installBaseGlobals();
  const { bakeSceneToBoundless } = await import("../scripts/scene-baker.mjs");

  const bakedScene = {
    id: "scBaked",
    name: "Baked Map",
    flags: { boundless: { enabled: true, manifestUrl: "worlds/w/boundless/m.json" } },
    levels: [{ id: "lvl1", background: { src: null }, foreground: null, flags: { boundless: { enabled: true, manifestUrl: "worlds/w/boundless/m.json" } } }]
  };
  await assert.rejects(
    bakeSceneToBoundless({}, bakedScene, { createCopy: false }),
    /already baked/i
  );
});

test("TokenStreamer.onCombatChanged queues unmounted combatants using _queuedIds and { doc, distSq } format", async () => {
  installBaseGlobals();
  const { TokenStreamer } = await import("../scripts/token-streamer.mjs");
  const { TokenImpostorLayer } = await import("../scripts/token-impostors.mjs");

  const doc = { id: "npcCombat1", viewed: true, _source: { x: 200, y: 200, width: 1, height: 1 }, _object: null };
  globalThis.game.combat = {
    combatants: [{ sceneId: "sc1", tokenId: "npcCombat1" }]
  };
  globalThis.canvas = {
    ready: true,
    scene: { id: "sc1", tokens: new Map([["npcCombat1", doc]]) },
    tokens: { objects: { children: [] } }
  };

  const streamer = new TokenStreamer({ active: true });
  streamer.enabled = true;
  streamer.impostors = new TokenImpostorLayer({}, streamer);
  streamer._pumping = true; // prevent rAF scheduling in unit test

  assert.doesNotThrow(() => streamer.onCombatChanged());
  assert.equal(streamer._queuedIds.has("npcCombat1"), true);
  assert.equal(streamer._drawQueue.length, 1);
  assert.equal(streamer._drawQueue[0].doc, doc);
  assert.equal(streamer._drawQueue[0].distSq, 0);
});

test("lightingMethods enforces player doorRequest authorization and pause guard", async () => {
  installBaseGlobals();
  const { lightingMethods } = await import("../scripts/boundless-lighting.mjs");

  const hiddenScene = { id: "scHidden", active: false, navigation: false, testUserPermission: () => false, tokens: [] };
  const activeScene = { id: "scActive", active: true, navigation: true, testUserPermission: () => true, tokens: [] };
  const player = { id: "p1", isGM: false, active: true };
  const gm = { id: "gm1", isGM: true, active: true };
  globalThis.game.users = { get: (id) => (id === "p1" ? player : id === "gm1" ? gm : null) };

  globalThis.game.paused = false;
  assert.equal(lightingMethods._isAuthorizedDoorRequester({ senderId: "p1" }, hiddenScene), false, "player must not toggle doors on hidden scene");
  assert.equal(lightingMethods._isAuthorizedDoorRequester({ senderId: "p1" }, activeScene), true, "player can toggle doors on active scene when unpaused");
  globalThis.game.paused = true;
  assert.equal(lightingMethods._isAuthorizedDoorRequester({ senderId: "p1" }, activeScene), false, "player must not toggle doors while game is paused");
  assert.equal(lightingMethods._isAuthorizedDoorRequester({ senderId: "gm1" }, hiddenScene), true, "GM remains authorized");
});

test("ChunkedFogManager discards stale user-flag fog via fogResetId and rejects oversized/unauthorized fogReveal", async () => {
  installBaseGlobals();
  const { ChunkedFogManager } = await import("../scripts/chunked-fog.mjs");

  let mergedCount = 0;
  let userCleaned = false;
  globalThis.game.user = {
    id: "u1",
    isGM: false,
    flags: {
      boundless: {
        fog: { sc1: { lvl1: { "0_0": "data:image/png;base64,AA==" } } },
        fogMeta: { sc1: { lvl1: { resetId: "oldReset", savedAt: 100 } } }
      }
    },
    update: async () => { userCleaned = true; }
  };
  const mgr = new ChunkedFogManager();
  mgr.sceneId = "sc1";
  mgr.levelId = "lvl1";
  mgr.fogMode = 0;
  mgr._mergeChunkMap = () => { mergedCount++; };

  const scene = {
    id: "sc1",
    flags: { boundless: { fogResetId: { lvl1: "newReset" }, fogResetAt: { lvl1: 500 } } }
  };
  mgr._loadPersistedFog(scene);
  assert.equal(mergedCount, 0, "stale user-flag fog written before latest reset must be discarded");
  assert.equal(userCleaned, true, "stale user-flag fog should be pruned asynchronously");

  // Polygon size cap rejects continent-wide spoofed reveal polygons
  const filtered = mgr._filterReasonablePolygons([
    [0, 0, 500, 0, 500, 500],
    [0, 0, 50000, 0, 50000, 50000]
  ]);
  assert.equal(filtered.length, 1, "oversized spoofed fogReveal polygon must be dropped");
});

test("scene-baker handles elongated aspect ratio, maxDim < tilePx stitch scaling, and literal % in getDirAndFilename", async () => {
  const { computePyramidPlan, computeStitchPyramidPlan, getDirAndFilename } = await import("../scripts/scene-baker.mjs");

  // 8000x2000 bounds with 4000x4000 fill image -> vertical density needs z=4 (not z=2)
  const plan = computePyramidPlan(8000, 2000, 4000, 4000, 1024);
  assert.equal(plan.maxZoomZ, 4, "elongated bounds with high vertical source resolution must preserve vertical zoom detail");

  // Stitch when maxDim < tilePx must scale down instead of cropping 75%
  const stitch = computeStitchPyramidPlan({ maxZoomZ: 0, worldPx: 4000, tilePx: 1024, bounds: { x: 0, y: 0, w: 4000, h: 4000 }, maxDim: 512 });
  assert.equal(stitch.outW, 512);
  assert.equal(stitch.outH, 512);
  assert.ok(Math.abs(stitch.tileWorld * stitch.scaleZ - 512) < 0.01, "stitched tile width must fit maxDim when maxDim < tilePx");

  // Literal % in one path segment must not prevent decoding %20 in other segments
  const parsed = getDirAndFilename("worlds/my%20world/100%_map/pyramid_manifest.json", "fallback");
  assert.equal(parsed.dir, "worlds/my world/100%_map");
  assert.equal(parsed.filename, "pyramid_manifest.json");
});

test("Boundless.mount does not set _mounting on standard scenes, and TokenImpostorLayer destroys VBO buffers", async () => {
  installBaseGlobals();
  globalThis.Hooks = { on() {}, once() {} };
  const { Boundless } = await import("../scripts/boundless.mjs");
  const { TokenImpostorLayer } = await import("../scripts/token-impostors.mjs");

  const standardScene = { id: "std1", name: "Tavern", flags: {}, levels: [] };
  const p = Boundless.mount(standardScene);
  assert.equal(Boundless._mounting, false, "mounting a standard non-Boundless scene must not block applyLightingRenderScale with _mounting");
  await p;

  const imp = new TokenImpostorLayer({}, {});
  let bufDestroyed = 0;
  let geomDestroyed = false;
  const fakeGeom = {
    buffers: [{ destroy() { bufDestroyed++; } }, { destroy() { bufDestroyed++; } }],
    destroy() { geomDestroyed = true; }
  };
  imp._destroyGeometry(fakeGeom);
  assert.equal(bufDestroyed, 2, "all PIXI.Buffer VBOs must be destroyed explicitly");
  assert.equal(geomDestroyed, true);
});

test("overlayMethods renders hidden tiles at 0.5x for GM without alpha^2 on batchOcclusion and masks hoverFade with SURFACE", async () => {
  installBaseGlobals();
  globalThis.CONST.OCCLUSION_MODES = { NONE: 0, FADE: 1, RADIAL: 2, VISION: 4, SURFACE: 8 };
  globalThis.foundry = {
    canvas: { groups: { PrimaryCanvasGroup: { SORT_LAYERS: { TILES: 500 } } } },
    utils: { Color: { from: () => ({ valid: true, valueOf: () => 0xffffff }) } }
  };
  const { overlayMethods } = await import("../scripts/boundless-overlays.mjs");

  const makeMesh = () => ({
    anchor: { set() {} },
    position: { set() {} },
    scale: { x: 1, y: 1 },
    pluginName: "batchOcclusion",
    updateCanvasTransform() {}
  });
  const added = [];
  globalThis.canvas = { primary: { addChild(m) { added.push(m); } } };

  const ctrl = {
    ...overlayMethods,
    active: true,
    _mountGen: 1,
    tileEditsRev: 0,
    levelLayers: new Map([["lvl1", { level: { id: "lvl1", isView: true }, isUpper: false, lastTargetZ: 2, zOffset: 0, simGrid: 4, simSectorPx: 1000 }]]),
    activeVirtualTiles: new Map(),
    texMgr: { getSync: () => ({ width: 100, height: 100, baseTexture: { valid: true, destroyed: false }, destroyed: false }) },
    acquireMesh: makeMesh,
    _shouldMountInteriorTiles: () => true,
    _syncShowstopperMeshDof: () => {},
    _emit: () => {}
  };
  const layer = ctrl.levelLayers.get("lvl1");
  const tex = { width: 100, height: 100, baseTexture: { valid: true, destroyed: false }, destroyed: false };

  // Semi-transparent tile with FADE | SURFACE occlusion: m.alpha must stay 1.0 (not 0.5^2) and hoverFade must be false
  const occMesh = ctrl._mountVirtualTileMesh({
    fullId: "lvl1::0", lid: "lvl1", tid: 0, layer, defaultElev: 0, reqRev: 0, gen: 1, tex,
    tSpec: { src: "a.webp", x: 100, y: 100, w: 200, h: 200, alpha: 0.5, hidden: false, occlusionMode: 1 | 8 }
  }, { x0: 0, y0: 0, x1: 1000, y1: 1000, scale: 1 });
  assert.equal(occMesh.alpha, 1.0, "batchOcclusion mesh must keep m.alpha=1.0 to avoid alpha^2 darkening");
  assert.equal(occMesh.unoccludedAlpha, 0.5);
  assert.equal(occMesh.hoverFade, false, "combined FADE | SURFACE occlusion must not enable hoverFade");

  // Hidden decorative tile for GM: uses batch shader with alpha * 0.5
  const decMesh = ctrl._mountVirtualTileMesh({
    fullId: "lvl1::1", lid: "lvl1", tid: 1, layer, defaultElev: 0, reqRev: 0, gen: 1, tex,
    tSpec: { src: "b.webp", x: 100, y: 100, w: 200, h: 200, alpha: 0.8, hidden: true, occlusionMode: 0 }
  }, { x0: 0, y0: 0, x1: 1000, y1: 1000, scale: 1 });
  assert.equal(decMesh.pluginName, "batch");
  assert.ok(Math.abs(decMesh.alpha - 0.4) < 1e-6, "hidden decorative tile for GM must render at 0.5x alpha");
});

test("utils edge cases: case-insensitive hasTokenPermissionLazy, NONE level, smoothstep equal edges, and null anchorX", async () => {
  installBaseGlobals();
  globalThis.CONST.DOCUMENT_OWNERSHIP_LEVELS = { INHERIT: -1, NONE: 0, LIMITED: 1, OBSERVER: 2, OWNER: 3 };
  const { hasTokenPermissionLazy, smoothstep, getVirtualTileBounds } = await import("../scripts/utils.mjs");

  const doc = { isLazyDelta: true, _source: { delta: { ownership: {} } }, baseActor: { ownership: { u1: 2, default: 0 } } };
  assert.equal(hasTokenPermissionLazy(doc, { id: "u1", isGM: false }, "observer"), true, "lowercase 'observer' must not escalate to OWNER");
  assert.equal(hasTokenPermissionLazy({ isLazyDelta: true, _source: {}, baseActor: { ownership: {} } }, { id: "u2", isGM: false }, "NONE"), true, "NONE (0) permission must return true");
  assert.equal(Number.isNaN(smoothstep(5, 5, 5)), false, "smoothstep(e, e, e) must not produce NaN");
  assert.equal(smoothstep(5, 5, 5), 1);
  assert.equal(smoothstep(5, 5, 4), 0);

  const b = getVirtualTileBounds({ x: 100, y: 200, w: 400, h: 200, anchorX: null, anchorY: null });
  assert.equal(b.pivX, 300, "null anchorX must center pivot like undefined");
  assert.equal(b.pivY, 300);
});

test("perf-auto preserves third-party mesh.renderable = false hides (fa-nexus / burn-living-map)", async () => {
  installBaseGlobals();
  const { PERF_CONFIG } = await import("../scripts/perf-patcher.mjs");
  const { updateStandardSceneCulling, restoreAllStandardCulling } = await import("../scripts/perf-auto.mjs");

  const prevEnabled = PERF_CONFIG.perfEnabled;
  const prevAuto = PERF_CONFIG.perfAutoCulling;
  PERF_CONFIG.perfEnabled = true;
  PERF_CONFIG.perfAutoCulling = true;
  try {
    const thirdPartyHiddenMesh = {
      renderable: false,
      destroyed: false,
      canvasBounds: { x: 100, y: 100, width: 100, height: 100 }
    };
    const offscreenMesh = {
      renderable: true,
      destroyed: false,
      canvasBounds: { x: 9000, y: 9000, width: 100, height: 100 }
    };
    const tiles = [
      { mesh: thirdPartyHiddenMesh, document: { x: 100, y: 100, width: 100, height: 100 } },
      { mesh: offscreenMesh, document: { x: 9000, y: 9000, width: 100, height: 100 } }
    ];
    for (let i = 0; i < 12; i++) {
      tiles.push({
        mesh: { renderable: true, destroyed: false, canvasBounds: { x: 200, y: 200, width: 50, height: 50 } },
        document: { x: 200, y: 200, width: 50, height: 50 }
      });
    }
    globalThis.canvas = {
      ready: true,
      scene: { id: "std2", flags: {} },
      level: { id: "lvl1", flags: {} },
      stage: { worldTransform: { a: 1, b: 0, c: 0, d: 1, tx: 0, ty: 0 } },
      app: { renderer: { screen: { x: 0, y: 0, width: 1000, height: 1000 } } },
      tiles: { placeables: tiles, highlightObjects: false }
    };

    updateStandardSceneCulling();
    assert.equal(thirdPartyHiddenMesh.renderable, false, "third-party hidden mesh must stay renderable=false on viewport culling");
    assert.equal(offscreenMesh.renderable, false, "offscreen tile should be culled by Boundless");
    assert.equal(offscreenMesh._blStdCulled, true);

    restoreAllStandardCulling();
    assert.equal(thirdPartyHiddenMesh.renderable, false, "restoreAllStandardCulling must NOT unhide third-party hidden meshes");
    assert.equal(offscreenMesh.renderable, true, "Boundless-culled tile must be restored");
  } finally {
    PERF_CONFIG.perfEnabled = prevEnabled;
    PERF_CONFIG.perfAutoCulling = prevAuto;
  }
});

test("ChunkedFogManager._loadPersistedFog tolerates player clock skew when meta.resetId matches sceneResetId", async () => {
  installBaseGlobals();
  const { ChunkedFogManager } = await import("../scripts/chunked-fog.mjs");

  let mergedCount = 0;
  let userDeleted = false;
  globalThis.game.user = {
    id: "u1",
    isGM: false,
    flags: {
      boundless: {
        fog: { sc1: { lvl1: { "0_0": "data:image/png;base64,AA==" } } },
        // Player clock lags 10 minutes behind GM's fogResetAt, but resetId matches!
        fogMeta: { sc1: { lvl1: { resetId: "reset42", savedAt: 100 } } }
      }
    },
    update: async () => { userDeleted = true; }
  };
  const mgr = new ChunkedFogManager();
  mgr.sceneId = "sc1";
  mgr.levelId = "lvl1";
  mgr.fogMode = 0;
  mgr._mergeChunkMap = () => { mergedCount++; };

  const scene = {
    id: "sc1",
    flags: { boundless: { fogResetId: { lvl1: "reset42" }, fogResetAt: { lvl1: 999999 } } }
  };
  mgr._loadPersistedFog(scene);
  assert.equal(mergedCount, 1, "valid player fog with matching resetId must survive GM/player clock skew");
  assert.equal(userDeleted, false, "valid player fog must NOT be deleted due to clock skew");
});

test("PoiManager blocks non-GM flyTo on hidden POIs and cleans incomplete superGrid buckets on zoom-out", async () => {
  installBaseGlobals();
  const { PoiManager } = await import("../scripts/poi.mjs");

  const mgr = new PoiManager({});
  globalThis.game.user = { id: "p1", isGM: false };
  globalThis.canvas = { ready: true, stage: { scale: { x: 1 } } };
  const okPlayer = await mgr.flyTo({ id: "secret", x: 500, y: 500, hidden: true });
  assert.equal(okPlayer, false, "non-GM must not flyTo a hidden POI");

  // Incomplete superGrid bucket must be evicted when pending sub-pins are cancelled on orbital zoom-out
  let destroyedCount = 0;
  mgr.container = {};
  mgr._superGridInfo = { cols: 6, rows: 6, regionPx: 100000 };
  mgr._superGridSubProvinces.set("0_0", {
    lastUsedMs: 1,
    entries: [{ root: { parent: null, destroy() { destroyedCount++; } } }]
  });
  mgr._pendingSubPins = [{ key: "0_0", subPoi: {}, orderIndex: 1001 }];
  mgr._syncSuperGridSubPins(0.01, { a: 0.01, d: 0.01, tx: 0, ty: 0 }, 1000, 1000);
  assert.equal(mgr._pendingSubPins.length, 0);
  assert.equal(mgr._superGridSubProvinces.has("0_0"), false, "incomplete province bucket must be removed on orbital abort");
  assert.equal(destroyedCount, 1);
});

test("VirtualLayerEditors._clearLights({ keepProtected: true }) keeps open config sheets alive on zoom-out", async () => {
  installBaseGlobals();
  const { VirtualLayerEditors } = await import("../scripts/layer-editors.mjs");

  globalThis.canvas = { level: { id: "lvl1" } };
  let closedOnSwitch = false;
  const ed = new VirtualLayerEditors({ active: true });
  const openEntry = {
    id: "ml1", key: "0_0:l:0", levelId: "lvl1",
    doc: { _sheet: { rendered: true, close() { closedOnSwitch = true; } } },
    placeable: { controlled: false, destroyed: false, destroy() {} }
  };
  const idleEntry = {
    id: "ml2", key: "0_0:l:1", levelId: "lvl1",
    doc: { _sheet: null },
    placeable: { controlled: false, destroyed: false, destroy() {} }
  };
  ed.lightsByKey.set(openEntry.key, openEntry);
  ed.lightsById.set(openEntry.id, openEntry);
  ed.lightsByKey.set(idleEntry.key, idleEntry);
  ed.lightsById.set(idleEntry.id, idleEntry);

  ed._clearLights({ keepProtected: true });
  assert.equal(ed.lightsByKey.has(openEntry.key), true, "light with open sheet on current level must survive zoom-out clear");
  assert.equal(closedOnSwitch, false, "must not close open sheet on same level");
  assert.equal(ed.lightsByKey.has(idleEntry.key), false, "idle light should be unmounted on zoom-out");

  // Switching to another level must tear down protected entries from the old level
  globalThis.canvas = { level: { id: "lvl2" } };
  ed._clearLights({ keepProtected: true });
  assert.equal(ed.lightsByKey.has(openEntry.key), false, "old-level sheet must be closed after level switch");
  assert.equal(closedOnSwitch, true);
});

test("VirtualWallEditor prioritizes viewed level in _getDoorLayers and hides other-level DoorControls", async () => {
  installBaseGlobals();
  const { VirtualWallEditor } = await import("../scripts/wall-editor.mjs");

  const layerGround = { level: { id: "ground", elevation: { base: 0 } }, spec: { sectors: {} } };
  const layerUpper = { level: { id: "upper", elevation: { base: 10 } }, spec: { sectors: {} } };
  globalThis.canvas = {
    level: layerUpper.level,
    scene: { id: "s1" }
  };
  const ctrl = {
    active: true,
    levelLayers: new Map([["ground", layerGround], ["upper", layerUpper]]),
    visibleLevelLayers: [layerGround, layerUpper]
  };
  const editor = new VirtualWallEditor(ctrl);
  const ordered = editor._getDoorLayers(true);
  assert.equal(ordered[0].level.id, "upper", "viewed level must come first so lower floors cannot exhaust doorCap");
  assert.equal(ordered[1].level.id, "ground");

  const dcGround = { visible: true, isVisible: true, destroyed: false };
  const dcUpper = { visible: true, isVisible: true, destroyed: false };
  editor.mountedByDoorKey.set("ground::0_0_0", { levelId: "ground", wall: { doorControl: dcGround } });
  editor.mountedByDoorKey.set("upper::0_0_0", { levelId: "upper", wall: { doorControl: dcUpper } });
  editor.refreshDoorVisibility();
  assert.equal(dcGround.visible, false, "DoorControl from non-viewed level must be hidden");
  assert.equal(dcUpper.visible, true, "DoorControl on viewed level must stay visible");
});

test("MegaLightBatch returns -1.0 shader time when animateLightSources is false", async () => {
  installBaseGlobals();
  const { MegaLightBatch } = await import("../scripts/light-batch.mjs");

  const lb = new MegaLightBatch();
  globalThis.canvas = {
    effects: { animateLightSources: false },
    app: { ticker: { lastTime: 12345 } }
  };
  assert.equal(lb._getEffectiveShaderTime(), -1.0, "disabled animation must send negative uTime sentinel so shader stays static");

  globalThis.canvas.effects.animateLightSources = true;
  assert.equal(lb._getEffectiveShaderTime(), 12.345);
});

test("ChunkedFogManager._loadPersistedFog treats missing fogMeta as stale when sceneResetId is set", async () => {
  installBaseGlobals();
  const { ChunkedFogManager } = await import("../scripts/chunked-fog.mjs");

  let mergedCount = 0;
  let clearedFlag = false;
  globalThis.game.user = {
    id: "u1",
    isGM: false,
    flags: {
      boundless: {
        fog: { sc1: { lvl1: { "0_0": "data:image/png;base64,AA==" } } }
        // No fogMeta at all (legacy / pre-reset fog)
      }
    },
    update: async () => { clearedFlag = true; }
  };
  const mgr = new ChunkedFogManager();
  mgr.sceneId = "sc1";
  mgr.levelId = "lvl1";
  mgr.fogMode = 0;
  mgr._mergeChunkMap = () => { mergedCount++; };

  const scene = {
    id: "sc1",
    flags: { boundless: { fogResetId: { lvl1: "reset99" }, fogResetAt: { lvl1: 5000 } } }
  };
  mgr._loadPersistedFog(scene);
  assert.equal(mergedCount, 0, "legacy player fog without fogMeta must NOT resurrect after GM Reset Fog");
  assert.equal(clearedFlag, true, "stale legacy fog flag should be cleaned up");
});

test("overlayMethods.isPointUnderBakedRoof respects maxZ and pyramidMethods._saveCameraNow targets explicit sceneId", async () => {
  installBaseGlobals();
  const { overlayMethods } = await import("../scripts/boundless-overlays.mjs");
  const { pyramidMethods } = await import("../scripts/boundless-pyramid.mjs");

  // 1) isPointUnderBakedRoof must ignore virtual roof tiles above their maxZ cutoff
  const lvlObj = { id: "lvl1", isView: true, elevation: { bottom: 0, top: 20 } };
  globalThis.canvas = { level: lvlObj, masks: {} };
  const tileSpec = { x: 0, y: 0, w: 500, h: 500, elevation: 20, alpha: 1, minZ: 1, maxZ: 4, src: "roof.webp" };
  const ovCtrl = {
    ...overlayMethods,
    activeOverlays: new Map(),
    activeVirtualTiles: new Map(),
    resolveVirtualTile: (_lid, _tid, raw) => raw,
    _collectVirtualTileCandidates: () => [0],
    levelLayers: new Map([[
      "lvl1",
      {
        level: lvlObj,
        simGrid: 4,
        simSectorPx: 1000,
        lastTargetZ: 5,
        spec: {
          tiles: [tileSpec]
        }
      }
    ]])
  };
  assert.equal(ovCtrl.isPointUnderBakedRoof("lvl1", 100, 100, 0), false, "roof tile with maxZ=4 must not occlude when curTargetZ=5");
  ovCtrl.levelLayers.get("lvl1").lastTargetZ = 4;
  assert.equal(ovCtrl.isPointUnderBakedRoof("lvl1", 100, 100, 0), true, "roof tile with maxZ=4 should occlude when curTargetZ=4 and unmounted");

  // 2) _saveCameraNow(true, prevSceneId) must write to prevSceneId even if canvas.scene already switched
  const storage = new Map();
  globalThis.localStorage = {
    setItem(k, v) { storage.set(k, v); },
    getItem(k) { return storage.get(k) ?? null; }
  };
  globalThis.game = { world: { id: "w1" }, user: { id: "u1" } };
  globalThis.canvas = {
    scene: { id: "newScene" },
    stage: { pivot: { x: 1234, y: 5678 }, scale: { x: 0.75 } }
  };
  const pyrCtrl = {
    ...pyramidMethods,
    active: true,
    _mountedSceneId: "oldScene",
    _lastSavedCamStr: ""
  };
  pyrCtrl._saveCameraNow(true, "oldScene");
  assert.equal(storage.has("boundless.camera.w1.oldScene"), true, "camera must be saved under prevSceneId");
  assert.equal(storage.has("boundless.camera.w1.newScene"), false, "must NOT overwrite newScene camera slot");
});

test("TokenImpostorLayer evicts LRU atlas slots when full and resets atlas on flush({ forceAtlas: true })", async () => {
  installBaseGlobals();
  const { TokenImpostorLayer } = await import("../scripts/token-impostors.mjs");

  const layer = new TokenImpostorLayer({});
  layer.mounted = true;
  layer.atlasCanvas = { width: 1024, height: 1024 };
  let clearRectCalls = 0;
  layer.atlasCtx = { clearRect() { clearRectCalls++; } };
  layer.atlasBaseTex = { update() {}, destroy() {} };
  layer.atlasTex = { destroy() {} };
  layer._initAtlas = () => {
    layer.atlasCanvas = { width: 1024, height: 1024 };
    layer.atlasCtx = { clearRect() { clearRectCalls++; } };
    layer.atlasBaseTex = { update() {} };
  };
  layer._decodeAndPack = async () => {};

  // Fill atlas manually up to capacity (CELL_PX=160 -> atlasSize=320 => 2x2 = 4 slots)
  layer.atlasSize = 320;
  for (let i = 0; i < 4; i++) {
    const k = `T|art_${i}.webp`;
    layer.slotsByKey.set(k, {
      col: i % 2,
      row: Math.floor(i / 2),
      ready: true,
      failed: false,
      decoding: false,
      lastUsedMs: 100 + i * 10,
      spec: { slotKey: k, artSrc: `art_${i}.webp` }
    });
    layer.docsByKey.set(k, new Set([`tok_${i}`]));
  }
  layer.nextSlotIdx = 4;

  // Requesting a 5th slot must evict the oldest LRU slot (art_0.webp)
  const evicted = layer._requestAtlasSlot({ slotKey: "T|art_new.webp", artSrc: "art_new.webp" });
  assert.ok(evicted, "should allocate a slot via LRU eviction when atlas is full");
  assert.equal(layer.slotsByKey.has("T|art_0.webp"), false, "oldest LRU slot must be evicted");
  assert.equal(layer.slotsByKey.has("T|art_new.webp"), true, "new slot must be registered");
  assert.equal(evicted.col, 0);
  assert.equal(evicted.row, 0);

  // flush({ forceAtlas: true }) must bypass the 180ms streaming throttle and immediately upload atlasTexture
  let atlasUpdates = 0;
  layer.atlasTexture = { baseTexture: { update() { atlasUpdates++; } } };
  layer.atlasDirty = true;
  layer._activeDecodes = 1;
  layer._lastAtlasUploadMs = performance.now();
  layer.flush();
  assert.equal(atlasUpdates, 0, "normal flush should throttle atlas upload while streaming");
  layer.flush({ forceAtlas: true });
  assert.equal(atlasUpdates, 1, "forceAtlas flush must immediately upload atlasTexture");
  assert.equal(layer.atlasDirty, false);
});
