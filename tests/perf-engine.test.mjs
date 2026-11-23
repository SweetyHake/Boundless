import test from "node:test";
import assert from "node:assert/strict";

import {
  generateNoiseLutPixels,
  rewriteShaderNoiseGlsl,
  resolveLightingScalePreset
} from "../scripts/perf-gpu.mjs";
import {
  rectInRange,
  buildMeasureCacheKey
} from "../scripts/perf-cpu.mjs";
import {
  computeExpandedViewport,
  rectsIntersect,
  isHeavyStandardScene,
  collectSceneActiveAssetUrls
} from "../scripts/perf-auto.mjs";
import { wrapTargetMethod } from "../scripts/perf-patcher.mjs";
import { computeVisualDiff } from "../scripts/perf-benchmark.mjs";

test("generateNoiseLutPixels produces valid non-constant 128x128 RGBA data", () => {
  const size = 64;
  const buf = generateNoiseLutPixels(size, 16);
  assert.equal(buf.length, size * size * 4);

  let minR = 255;
  let maxR = 0;
  let minA = 255;
  let maxA = 0;
  for (let i = 0; i < buf.length; i += 4) {
    if (buf[i] < minR) minR = buf[i];
    if (buf[i] > maxR) maxR = buf[i];
    if (buf[i + 3] < minA) minA = buf[i + 3];
    if (buf[i + 3] > maxA) maxA = buf[i + 3];
  }
  assert.ok(maxR - minR > 100, `expected wide noise range, got ${minR}..${maxR}`);
  assert.ok(maxA - minA > 40, `expected non-flat fbm4 range, got ${minA}..${maxA}`);
});

test("rewriteShaderNoiseGlsl replaces Foundry NOISE and FBM blocks idempotently", () => {
  const sampleFrag = `
precision mediump float;
varying vec2 vUvs;
uniform float time;

float random(in vec2 uv) { return fract(sin(dot(uv, vec2(12.9898, 78.233))) * 43758.5453); }

float noise(in vec2 uv) {
  const vec2 d = vec2(0.0, 1.0);
  vec2 b = floor(uv);
  vec2 f = smoothstep(vec2(0.), vec2(1.0), fract(uv));
  return mix(
    mix(random(b), random(b + d.yx), f.x),
    mix(random(b + d.xy), random(b + d.yy), f.x),
    f.y
  );
}

float fbm(in vec2 uv) {
  float total = 0.0, amp = 1.0;
  for (int i = 0; i < 4; i++) {
    total += noise(uv) * amp;
    uv += uv;
    amp *= 0.5;
  }
  return total;
}

void main() {
  gl_FragColor = vec4(fbm(vUvs + time));
}
`;

  const res = rewriteShaderNoiseGlsl(sampleFrag);
  assert.equal(res.modified, true);
  assert.ok(res.src.includes("uniform sampler2D uBoundlessNoise;"));
  assert.ok(res.src.includes("texture2D(uBoundlessNoise, uv * 0.0625).r"));
  assert.ok(res.src.includes("texture2D(uBoundlessNoise, uv * 0.0625).a * 1.8750"));
  assert.ok(!res.src.includes("for (int i = 0; i < 4; i++)"));

  // Second pass must be a no-op
  const res2 = rewriteShaderNoiseGlsl(res.src);
  assert.equal(res2.modified, false);
  assert.equal(res2.src, res.src);
});

test("resolveLightingScalePreset returns expected multipliers", () => {
  assert.deepEqual(resolveLightingScalePreset("full", 2), { illumination: 1, coloration: 1, darkness: 1 });
  assert.deepEqual(resolveLightingScalePreset("performance", 2), { illumination: 0.4, coloration: 0.65, darkness: 0.45 });
  assert.deepEqual(resolveLightingScalePreset("auto", 0), { illumination: 0.4, coloration: 0.65, darkness: 0.45 });
  assert.deepEqual(resolveLightingScalePreset("auto", 2), { illumination: 0.55, coloration: 0.85, darkness: 0.55 });
});

test("rectInRange accurately tests circle-rectangle intersection", () => {
  const box = { x: 100, y: 100, width: 100, height: 100 };
  assert.equal(rectInRange(box, { x: 150, y: 150, r: 10 }), true);
  assert.equal(rectInRange(box, { x: 250, y: 150, r: 50 }), true);
  assert.equal(rectInRange(box, { x: 251, y: 150, r: 50 }), false);
  assert.equal(rectInRange(box, { x: 230, y: 230, r: 45 }), true); // dist ~42.4
  assert.equal(rectInRange(box, { x: 230, y: 230, r: 40 }), false);
});

test("buildMeasureCacheKey distinguishes waypoints and rejects object options", () => {
  const wp1 = [{ x: 0, y: 0, elevation: 0 }, { x: 100, y: 200, elevation: 0 }];
  const wp2 = [{ x: 0, y: 0, elevation: 0 }, { x: 100, y: 200, elevation: 10 }];
  const k1 = buildMeasureCacheKey(wp1, { cost: 1 });
  const k2 = buildMeasureCacheKey(wp2, { cost: 1 });
  assert.ok(k1 && k2);
  assert.notEqual(k1, k2);
  assert.equal(buildMeasureCacheKey(wp1, { fn: { a: 1 } }), null);
});

test("computeExpandedViewport and rectsIntersect work with stage transform", () => {
  const stage = { worldTransform: { a: 0.5, d: 0.5, tx: -100, ty: -50 } };
  const screen = { x: 0, y: 0, width: 1000, height: 500 };
  // Unpadded world rect: x in [200..2200], y in [100..1100]
  const vp = computeExpandedViewport(stage, screen, 0.5, 400);
  assert.equal(vp.minX, 200 - 1000);
  assert.equal(vp.maxX, 2200 + 1000);
  assert.equal(vp.minY, 100 - 500);
  assert.equal(vp.maxY, 1100 + 500);

  assert.equal(rectsIntersect(0, 0, 50, 50, vp), true);
  assert.equal(rectsIntersect(5000, 5000, 5100, 5100, vp), false);
});

test("isHeavyStandardScene and collectSceneActiveAssetUrls detect heavy scenes and assets", () => {
  assert.equal(isHeavyStandardScene({ width: 4000, height: 4000, tiles: { size: 5 }, lights: { size: 10 } }), false);
  assert.equal(isHeavyStandardScene({ width: 8000, height: 6000, tiles: { size: 2 }, lights: { size: 2 } }), true);
  assert.equal(isHeavyStandardScene({ width: 2000, height: 2000, tiles: { size: 35 }, lights: { size: 2 } }), true);
  assert.equal(isHeavyStandardScene({ width: 8000, height: 6000, flags: { boundless: { enabled: true } } }), false);

  const used = collectSceneActiveAssetUrls({
    background: { src: "worlds/test/map.webp?v=1" },
    levels: [{ background: { src: "worlds/test/floor2.webp" } }],
    tiles: [{ texture: { src: "assets/rug.webp" } }],
    tokens: [{ texture: { src: "tokens/hero.webp" }, ring: { subject: { texture: "tokens/hero_ring.webp" } } }]
  });
  assert.ok(used.has("worlds/test/map.webp"));
  assert.ok(used.has("worlds/test/floor2.webp"));
  assert.ok(used.has("assets/rug.webp"));
  assert.ok(used.has("tokens/hero.webp"));
  assert.ok(used.has("tokens/hero_ring.webp"));
});

test("wrapTargetMethod wraps once without double-wrapping", () => {
  const obj = { calls: 0, add(x) { this.calls++; return x + 1; } };
  wrapTargetMethod(obj, "add", "test.add", function (wrapped, x) {
    return wrapped(x) * 10;
  });
  wrapTargetMethod(obj, "add", "test.add", function (wrapped, x) {
    return wrapped(x) * 100;
  });
  assert.equal(obj.add(2), 30);
  assert.equal(obj.calls, 1);
});

test("rewriteShaderNoiseGlsl handles arbitrary FBM octaves and amp", () => {
  const frag2Oct = `
precision mediump float;
float noise(in vec2 uv) {
  const vec2 d = vec2(0.0, 1.0);
  vec2 b = floor(uv);
  vec2 f = smoothstep(vec2(0.), vec2(1.0), fract(uv));
  return mix(mix(random(b), random(b + d.yx), f.x), mix(random(b + d.xy), random(b + d.yy), f.x), f.y);
}
float fbm(in vec2 uv) {
  float total = 0.0, amp = 0.5;
  for (int i = 0; i < 2; i++) {
    total += noise(uv) * amp;
    uv += uv;
    amp *= 0.5;
  }
  return total;
}
`;
  const res = rewriteShaderNoiseGlsl(frag2Oct);
  assert.equal(res.modified, true);
  assert.ok(res.src.includes("texture2D(uBoundlessNoise, uv * 0.0625).g * 0.7500"));
});

test("collectSceneActiveAssetUrls supports v14 object foreground on scene and levels", () => {
  const used = collectSceneActiveAssetUrls({
    background: { src: "maps/base.webp" },
    foreground: { src: "maps/roof.webp", tint: "#ffffff" },
    levels: [
      { background: { src: "maps/lvl2_bg.webp" }, foreground: { src: "maps/lvl2_fg.webp" } }
    ]
  });
  assert.ok(used.has("maps/base.webp"));
  assert.ok(used.has("maps/roof.webp"));
  assert.ok(used.has("maps/lvl2_bg.webp"));
  assert.ok(used.has("maps/lvl2_fg.webp"));
});

test("computeVisualDiff measures identical and divergent RGBA frames accurately", () => {
  const a = new Uint8ClampedArray([100, 120, 140, 255, 50, 60, 70, 255, 200, 200, 200, 255, 10, 20, 30, 255]);
  const same = new Uint8ClampedArray(a);
  assert.deepEqual(computeVisualDiff(a, same, 20), { meanAbsDiff: 0, mismatchPct: 0, maxDelta: 0 });

  const b = new Uint8ClampedArray(a);
  b[0] = 160; // delta 60 on 1 of 4 pixels -> 25% mismatch
  const d = computeVisualDiff(a, b, 20);
  assert.equal(d.mismatchPct, 25);
  assert.equal(d.maxDelta, 60);
  assert.equal(d.meanAbsDiff, 5);
});
