import test from "node:test";
import assert from "node:assert/strict";
import {
  getLevelBaseElevation,
  getLevelBottomElevation,
  getLevelRoofElevation,
  smoothstep,
  makeVirtualId,
  buildEdgeThresholdPx,
  hasSpecOverlays,
  isPointUnderRoofSpec
} from "../scripts/utils.mjs";

test("elevation helpers handle v14 finite and infinite ExtendedNumberField bounds", () => {
  const infLevel = { elevation: { bottom: -Infinity, top: Infinity, base: 10 } };
  assert.equal(getLevelBaseElevation(infLevel), 10);
  assert.equal(getLevelBottomElevation(infLevel), -Infinity);
  assert.equal(getLevelRoofElevation(infLevel), 30);

  const finLevel = { elevation: { bottom: 0, top: 19, base: 0 } };
  assert.equal(getLevelBaseElevation(finLevel), 0);
  assert.equal(getLevelBottomElevation(finLevel), 0);
  assert.equal(getLevelRoofElevation(finLevel), 19);
});

test("smoothstep clamps endpoints and interpolates midpoint", () => {
  assert.equal(smoothstep(0, 10, -5), 0);
  assert.equal(smoothstep(0, 10, 5), 0.5);
  assert.equal(smoothstep(0, 10, 15), 1);
});

test("makeVirtualId is deterministic 16-char alphanumeric", () => {
  const a = makeVirtualId("ml", "lvl0", "1_2:l:0");
  const b = makeVirtualId("ml", "lvl0", "1_2:l:0");
  const c = makeVirtualId("ml", "lvl0", "1_2:l:1");
  assert.equal(a, b);
  assert.notEqual(a, c);
  assert.equal(a.length, 16);
  assert.ok(a.startsWith("ml"));
});

test("buildEdgeThresholdPx converts distance thresholds to pixels", () => {
  assert.equal(buildEdgeThresholdPx(null, 20), undefined);
  assert.deepEqual(buildEdgeThresholdPx({ light: 10, sight: 15, attenuation: true }, 20), {
    light: 200,
    darkness: 200,
    sight: 300,
    sound: null,
    attenuation: true
  });
});

test("hasSpecOverlays & isPointUnderRoofSpec handle axis-aligned and rotated roofs", () => {
  assert.equal(hasSpecOverlays(null), false);
  assert.equal(hasSpecOverlays({}), false);
  assert.equal(hasSpecOverlays({ a: { roof: "r.webp" } }), true);

  const ov = { cx: 1000, cy: 1000, w: 400, h: 200, rot: 90, roof: "r.webp" };
  assert.equal(isPointUnderRoofSpec(1050, 1180, ov), true);
  assert.equal(isPointUnderRoofSpec(1180, 1050, ov), false);
});
