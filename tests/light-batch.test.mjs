import test from "node:test";
import assert from "node:assert/strict";
import { installFoundryMocks } from "./helpers/foundry-mock.mjs";

const { MockCSP } = installFoundryMocks();
const {
  MegaLightBatch,
  computeShaderAttenuation,
  extractLightStyle,
  encodeLightAnimPhase
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
