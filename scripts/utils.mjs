export const MODULE_ID = "boundless";
export const SHOWSTOPPER_ID = "showstopper";

export function getShowstopperMovementApi() {
  try {
    const mod = globalThis.game?.modules?.get?.(SHOWSTOPPER_ID);
    if (mod && !mod.active) return null;
    return mod?.api?.tokenMovement
      || globalThis.showstopper?.tokenMovement
      || globalThis.showstopper?.api?.tokenMovement
      || null;
  } catch {
    return null;
  }
}

export function isTextureUsable(tex) {
  return Boolean(tex && !tex.destroyed && tex.baseTexture && !tex.baseTexture.destroyed);
}

/**
 * In Foundry v14, unset `level.elevation.bottom` resolves to `-Infinity` and `top` to `Infinity` (ExtendedNumberField).
 * Always fall back to finite `base` -> finite `bottom` -> `0` when a finite default elevation is required.
 */
export function getLevelBaseElevation(level) {
  const base = Number(level?.elevation?.base);
  if (Number.isFinite(base)) return base;
  const bottom = Number(level?.elevation?.bottom);
  if (Number.isFinite(bottom)) return bottom;
  return 0;
}

/**
 * Preserve Foundry v14's exact `level.elevation.bottom` (including `-Infinity` for basements/undercrofts)
 * for level ordering, `isUpper` checks, pyramid ground mesh elevation, and depth comparisons.
 */
export function getLevelBottomElevation(level) {
  const bottom = level?.elevation?.bottom;
  if (typeof bottom === "number" && !Number.isNaN(bottom)) return bottom;
  return getLevelBaseElevation(level);
}

/**
 * In Foundry v14, unset `level.elevation.top` resolves to `Infinity` at runtime (ExtendedNumberField).
 * Always fall back to `base/bottom + 20` when `top` is non-finite so roof occlusion, indoor lights, and Showstopper stay consistent.
 */
export function getLevelRoofElevation(level) {
  const top = Number(level?.elevation?.top);
  if (Number.isFinite(top)) return top;
  return getLevelBaseElevation(level) + 20;
}

export function smoothstep(edge0, edge1, x) {
  const t = Math.max(0, Math.min(1, (x - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
}

export function escapeHtml(str) {
  return String(str ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export function loc(key, fallback = "") {
  return game.i18n?.has?.(key) ? game.i18n.localize(key) : (fallback || key);
}

export function getEffectiveScale(scale) {
  const grid = canvas?.grid?.size || canvas?.dimensions?.size || 100;
  return (Number(scale) || 0) * (grid / 100);
}

export function getLiveStageTransform(stageScale, px, py, sw, sh) {
  const a = stageScale;
  const d = canvas.stage?.scale?.y || stageScale;
  const posX = Number.isFinite(canvas.stage?.position?.x) ? canvas.stage.position.x : sw * 0.5;
  const posY = Number.isFinite(canvas.stage?.position?.y) ? canvas.stage.position.y : sh * 0.5;
  return { a, d, tx: posX - px * a, ty: posY - py * d };
}

export function getExistingSheet(doc) {
  if (!doc) return null;
  if ("_sheet" in doc) return doc._sheet;
  return doc.sheet ?? null;
}

export function isSheetActiveOrRendering(sheet, placeable = null) {
  if (!sheet) return false;
  if (sheet.rendered || sheet._preview || placeable?._preview?.previewType === "config") return true;
  const renderingState = foundry?.applications?.api?.ApplicationV2?.RENDER_STATES?.RENDERING ?? 1;
  return typeof sheet.state === "number" && sheet.state >= renderingState;
}

function _hashVirtualId(prefix, input) {
  let h1 = 0x811c9dc5;
  let h2 = 0x9e3779b9;
  for (let i = 0; i < input.length; i++) {
    const ch = input.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 0x01000193);
    h2 = Math.imul(h2 ^ (ch + i), 0x85ebca6b);
  }
  const p1 = (h1 >>> 0).toString(36).padStart(7, "0").slice(0, 7);
  const p2 = (h2 >>> 0).toString(36).padStart(7, "0").slice(0, 7);
  return `${prefix}${p1}${p2}`.slice(0, 16);
}

export function makeVirtualId(prefix, levelId, key) {
  return _hashVirtualId(prefix, `${prefix}|${levelId}|${key}`);
}

export function makeVirtualWallId(levelId, wKey) {
  // Deterministic 16-char alphanumeric ID matching legacy wall ID format (`mm` + 14 base36 chars)
  return _hashVirtualId("mm", `${levelId}|${wKey}`);
}

export function attachVirtualCollectionProxy(doc, id, realColl) {
  if (!doc || !realColl) return;
  const collProxy = new Proxy(realColl, {
    get(target, prop) {
      if (prop === "has") return (k) => k === id || target.has(k);
      if (prop === "get") return (k, opts) => (k === id ? doc : target.get(k, opts));
      const val = Reflect.get(target, prop, target);
      return typeof val === "function" ? val.bind(target) : val;
    }
  });
  Object.defineProperty(doc, "collection", { get: () => collProxy, configurable: true });
}

export function getVirtualTileBounds(tSpec) {
  const ax = tSpec.anchorX !== undefined ? tSpec.anchorX : 0.5;
  const ay = tSpec.anchorY !== undefined ? tSpec.anchorY : 0.5;
  const pivX = tSpec.anchorX === undefined ? (tSpec.x + tSpec.w * 0.5) : tSpec.x;
  const pivY = tSpec.anchorY === undefined ? (tSpec.y + tSpec.h * 0.5) : tSpec.y;
  const halfDiag = Math.hypot(tSpec.w || 0, tSpec.h || 0) * Math.max(ax, 1 - ax, ay, 1 - ay);
  return { pivX, pivY, halfDiag };
}

/** Convert Foundry v14 wall threshold (in scene distance units) into pixel-scaled Edge threshold (including darkness). */
export function buildEdgeThresholdPx(threshold, pxPerFt) {
  if (!threshold || typeof threshold !== "object") return undefined;
  const light = Number.isFinite(Number(threshold.light)) ? Number(threshold.light) * pxPerFt : null;
  const sight = Number.isFinite(Number(threshold.sight)) ? Number(threshold.sight) * pxPerFt : null;
  const sound = Number.isFinite(Number(threshold.sound)) ? Number(threshold.sound) * pxPerFt : null;
  if (light === null && sight === null && sound === null) return undefined;
  return {
    light,
    darkness: light,
    sight,
    sound,
    attenuation: Boolean(threshold.attenuation)
  };
}

export function hasSpecOverlays(overlays) {
  if (!overlays) return false;
  if (Array.isArray(overlays)) return overlays.length > 0;
  for (const k in overlays) {
    if (Object.prototype.hasOwnProperty.call(overlays, k)) return true;
  }
  return false;
}

export function isPointUnderRoofSpec(px, py, ov) {
  if (!ov?.roof || ov.walls?.includes("anchor_")) return false;
  const dx = px - ov.cx;
  const dy = py - ov.cy;
  const rot = ((ov.rot || 0) % 360 + 360) % 360;
  if (rot === 0 || rot === 180) {
    return Math.abs(dx) <= ov.w * 0.5 && Math.abs(dy) <= ov.h * 0.5;
  }
  if (rot === 90 || rot === 270) {
    return Math.abs(dx) <= ov.h * 0.5 && Math.abs(dy) <= ov.w * 0.5;
  }
  const rad = -rot * (Math.PI / 180);
  const c = Math.cos(rad);
  const s = Math.sin(rad);
  const lx = dx * c - dy * s;
  const ly = dx * s + dy * c;
  return Math.abs(lx) <= ov.w * 0.5 && Math.abs(ly) <= ov.h * 0.5;
}
