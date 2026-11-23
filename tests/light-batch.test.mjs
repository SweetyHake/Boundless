import test from "node:test";
import assert from "node:assert/strict";
import { installFoundryMocks } from "./helpers/foundry-mock.mjs";

const { MockCSP } = installFoundryMocks();
const {
  MegaLightBatch,
  computeShaderAttenuation,
  extractLightStyle,
  encodeLightAnimPhase,
  computeLevelBakedPolys
} = await import("../scripts/light-batch.mjs");

test("computeShaderAttenuation matches Foundry v14 curve", () => {
  assert.ok(Math.abs(computeShaderAttenuation(0.5) - 0.277992) < 1e-5);
  assert.equal(computeShaderAttenuation(0), 0);
  assert.equal(computeShaderAttenuation(1), 1);
});

test("extractLightStyle applies defaults and preserves explicit values", () => {
  assert.deepEqual(extractLightStyle(null), {
    speed: 3, intensity: 3, attenuation: 0.5, luminosity: 0.5, coloration: null
  });
  assert.deepEqual(extractLightStyle({ speed: 5, intensity: 6, coloration: 2, attenuation: 0.8, luminosity: 0.9 }), {
    speed: 5, intensity: 6, attenuation: 0.8, luminosity: 0.9, coloration: 2
  });
});

test("encodeLightAnimPhase maps animation families to distinct shader modes", () => {
  assert.equal(encodeLightAnimPhase("", 12, false), -1.0);
  const flicker = encodeLightAnimPhase("torch", 12, false);
  assert.ok(flicker >= 0 && flicker < 1000);
  const pulse = encodeLightAnimPhase("pulse", 12, false);
  assert.ok(pulse >= 1000 && pulse < 2000);
  const rays = encodeLightAnimPhase("sunburst", 12, false);
  assert.ok(rays >= 2000 && rays < 3000);
  const chroma = encodeLightAnimPhase("chroma", 12, false);
  assert.ok(chroma >= 3000 && chroma < 4000);
  const rotCone = encodeLightAnimPhase("sunburst", 12, true);
  assert.ok(rotCone >= 4000 && rotCone < 5000);
});

test("MegaLightBatch caches polygons across same-scene rebuilds and invalidates on edits or scene change", () => {
  const lb = new MegaLightBatch();
  const lighthouse = [1000, 2000, 60, 30, "#ffcc80", 0.7, "sunburst", 25, {
    speed: 5, intensity: 6, coloration: 3, attenuation: 0.8, luminosity: 0.9, angle: 90, rotation: 45, walls: false
  }];
  const layer = {
    level: canvas.level,
    spec: { simGrid: 4, simSectorPx: 2500, sectors: { "0_0": { l: [lighthouse], w: [], d: [] } } }
  };

  let sigVersion = "v1";
  MockCSP.resetComputeCount();

  // First build: computes polygon (cache miss) and encodes Mode 4 rotating spotlight cone
  lb.build([layer], 20, null, null, { getLevelCacheSigFn: () => sigVersion });
  assert.equal(MockCSP.computeCount, 1);
  assert.equal(lb.lastPolyCacheHits, 0);
  assert.equal(lb.lastPolyCacheMisses, 1);
  assert.ok(lb.geometry.attrs.aParams.buf[3] >= 4000, "directional sunburst without walls encodes Mode 4 rotating cone");

  // Same-scene level switch rebuild: 100% cache hit, 0 CSP recomputes!
  lb.build([layer], 20, null, null, { getLevelCacheSigFn: () => sigVersion });
  assert.equal(MockCSP.computeCount, 1);
  assert.equal(lb.lastPolyCacheHits, 1);
  assert.equal(lb.lastPolyCacheMisses, 0);

  // Wall edit / door toggle changes level signature -> recomputes!
  sigVersion = "v2";
  lb.build([layer], 20, null, null, { getLevelCacheSigFn: () => sigVersion });
  assert.equal(MockCSP.computeCount, 2);
  assert.equal(lb.lastPolyCacheMisses, 1);

  // Scene change clears cache -> recomputes!
  canvas.scene.id = "sceneB";
  lb.build([layer], 20, null, null, { getLevelCacheSigFn: () => sigVersion });
  assert.equal(MockCSP.computeCount, 3);
  canvas.scene.id = "sceneA";
});

test("computeLevelBakedPolys eliminates CSP raycasts on cold build and invalidates when doors open or walls change", () => {
  const spec = {
    worldPx: 10000,
    simGrid: 4,
    simSectorPx: 2500,
    sectors: {
      "0_0": {
        w: [[900, 1800, 1100, 1800, 20, 20, 20, 20, 0]],
        d: [],
        l: [[1000, 2000, 30, 15, "#ffaa44", 0.5, "torch", 6]]
      }
    }
  };

  MockCSP.resetComputeCount();
  const baked = computeLevelBakedPolys(spec, 20, { level: canvas.level });
  assert.ok(baked && baked.wg && Array.isArray(baked.polys["0_0_0"]));
  assert.equal(MockCSP.computeCount, 1);

  // Cold MegaLightBatch with spec.bakedPolys uses 0 CSP raycasts!
  const lb = new MegaLightBatch();
  const layer = { level: canvas.level, spec: { ...spec, bakedPolys: baked } };
  lb.build([layer], 20, null, null, { getLevelCacheSigFn: () => "we:0|od:" });
  assert.equal(MockCSP.computeCount, 1);
  assert.equal(lb.lastPolyCacheBakedHits, 1);
  assert.equal(lb.lastPolyCacheMisses, 0);

  // Open door invalidates bakedPolys and recomputes live CSP!
  lb.clearPolyCache();
  lb.build([layer], 20, null, null, { getLevelCacheSigFn: () => "we:0|od:0_0_0" });
  assert.equal(MockCSP.computeCount, 2);
  assert.equal(lb.lastPolyCacheBakedHits, 0);
  assert.equal(lb.lastPolyCacheMisses, 1);
});

test("prewarmLevelPolysTimeSliced warms adjacent level polygons and respects abort", async () => {
  const lb = new MegaLightBatch();
  const adjLevel = { id: "lvl2", elevation: { bottom: 20, top: 29, base: 20 }, edges: canvas.level.edges };
  const layer = {
    level: adjLevel,
    spec: {
      worldPx: 10000,
      simGrid: 4,
      simSectorPx: 2500,
      sectors: {
        "0_0": {
          w: [[500, 500, 700, 500, 20, 20, 20, 20, 0]],
          d: [],
          l: [
            [600, 600, 30, 15, "#ffaa00", 0.5, ""],
            [650, 650, 30, 15, "#ffaa00", 0.5, ""]
          ]
        }
      }
    }
  };

  MockCSP.resetComputeCount();
  const r1 = await lb.prewarmLevelPolysTimeSliced(layer, 20, null, null, { sceneId: "sceneA", budgetMs: 5 });
  assert.equal(r1.aborted, false);
  assert.equal(r1.computed, 2);
  assert.equal(MockCSP.computeCount, 2);

  // Second run skips everything (already in _polyCache)
  const r2 = await lb.prewarmLevelPolysTimeSliced(layer, 20, null, null, { sceneId: "sceneA", budgetMs: 5 });
  assert.equal(r2.computed, 0);
  assert.equal(r2.skipped, 2);

  // Aborted run stops cleanly without computing
  lb.clearPolyCache();
  const r3 = await lb.prewarmLevelPolysTimeSliced(layer, 20, null, null, { sceneId: "sceneA", shouldAbort: () => true });
  assert.equal(r3.aborted, true);
  assert.equal(r3.computed, 0);
});

test("MegaLightBatch defers heavy cold polygon baking into non-blocking slices when threshold is exceeded", async () => {
  const lb = new MegaLightBatch();
  const lights = [];
  for (let i = 0; i < 6; i++) {
    lights.push([1000 + i * 20, 1000, 30, 15, "#ffcc80", 0.5, "", 6]);
  }
  const layer = {
    level: canvas.level,
    spec: {
      worldPx: 10000,
      simGrid: 4,
      simSectorPx: 2500,
      sectors: {
        "0_0": {
          w: [[950, 950, 1200, 950, 20, 20, 20, 20, 0]],
          d: [],
          l: lights
        }
      }
    }
  };

  MockCSP.resetComputeCount();
  let readyCalled = 0;
  await new Promise((resolve) => {
    lb.build([layer], 20, null, null, {
      timeSliceThreshold: 1,
      syncBudgetMs: 0,
      deferredBudgetMs: 10,
      onDeferredPolysReady: () => {
        readyCalled++;
        resolve();
      }
    });
    // Synchronous build only computed 1 light and deferred the rest!
    assert.equal(MockCSP.computeCount, 1);
  });

  assert.equal(readyCalled, 1);
  assert.equal(MockCSP.computeCount, 6);
  // Subsequent rebuild is 100% cache hit
  lb.build([layer], 20, null, null, { timeSliceThreshold: 1, syncBudgetMs: 0 });
  assert.equal(lb.lastPolyCacheHits, 6);
  assert.equal(lb.lastPolyCacheMisses, 0);
});
