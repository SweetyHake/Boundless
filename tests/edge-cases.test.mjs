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

  // Pass 1: shape is null -> fails transiently, lastKey MUST stay "" so Pass 2 retries
  audio.update([layer], { x0: 0, y0: 0, x1: 1000, y1: 1000, scale: 0.05 }, resolver);
  assert.equal(audio.activeSources.size, 0);
  assert.equal(audio.lastKey, "", "lastKey must not cache an incomplete mount");
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

test("LRUTextureManager unloads stale fallback textures and tolerates null inUseSet in prune()", async () => {
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
  assert.deepEqual(unloaded, ["test.svg"], "stale fallback texture must be unloaded from PIXI.Assets");
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
