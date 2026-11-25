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

export function resolveFoundryRoute(src) {
  if (!src || typeof src !== "string") return src;
  if (/^(?:https?:|data:|blob:|file:|\/\/)/i.test(src)) return src;
  const getRoute = globalThis.foundry?.utils?.getRoute;
  if (typeof getRoute === "function") {
    try {
      return getRoute(src);
    } catch {}
  }
  return src;
}

/**
 * Evaluate Foundry v14 token ownership permission without materializing lazy ActorDelta.
 * Precedence matches Foundry v14: delta[uid] -> base[uid] -> delta.default -> base.default (ignoring INHERIT = -1).
 */
export function hasTokenPermissionLazy(doc, user, level = "OWNER") {
  if (!doc || !user) return false;
  if (user.isGM) return true;
  if (!doc.isLazyDelta) {
    try {
      if (typeof doc.testUserPermission === "function") return Boolean(doc.testUserPermission(user, level));
      if (level === "OWNER" && "isOwner" in doc) return Boolean(doc.isOwner);
      return Boolean(doc.baseActor?.testUserPermission?.(user, level));
    } catch {
      return false;
    }
  }
  const levels = globalThis.CONST?.DOCUMENT_OWNERSHIP_LEVELS || { NONE: 0, LIMITED: 1, OBSERVER: 2, OWNER: 3, INHERIT: -1 };
  const levelKey = typeof level === "string" ? level.toUpperCase() : level;
  const reqLvl = typeof level === "number" ? level : (levels[levelKey] ?? 3);
  const inheritLvl = levels.INHERIT ?? -1;
  const deltaOwn = doc._source?.delta?.ownership;
  const baseOwn = doc.baseActor?.ownership;
  const uid = user.id;

  if (uid && typeof deltaOwn?.[uid] === "number" && deltaOwn[uid] !== inheritLvl) {
    return deltaOwn[uid] >= reqLvl;
  }
  if (uid && typeof baseOwn?.[uid] === "number" && baseOwn[uid] !== inheritLvl) {
    return baseOwn[uid] >= reqLvl;
  }
  if (typeof deltaOwn?.default === "number" && deltaOwn.default !== inheritLvl) {
    return deltaOwn.default >= reqLvl;
  }
  if (typeof baseOwn?.default === "number" && baseOwn.default !== inheritLvl) {
    return baseOwn.default >= reqLvl;
  }
  if (!baseOwn && typeof doc.baseActor?.testUserPermission === "function") {
    try {
      return Boolean(doc.baseActor.testUserPermission(user, levelKey));
    } catch {
      return false;
    }
  }
  return reqLvl <= 0;
}

/**
 * In Foundry v14, unset `level.elevation.bottom` resolves to `-Infinity` and `top` to `Infinity` (ExtendedNumberField).
 * Always fall back to finite `base` -> finite `bottom` -> `0` when a finite default elevation is required.
 */
function toFiniteNumber(val) {
  if (val === null || val === undefined || val === "") return NaN;
  const n = Number(val);
  return Number.isFinite(n) ? n : NaN;
}

export function getLevelBaseElevation(level) {
  const base = toFiniteNumber(level?.elevation?.base);
  if (Number.isFinite(base)) return base;
  const bottom = toFiniteNumber(level?.elevation?.bottom);
  if (Number.isFinite(bottom)) return bottom;
  return 0;
}

/**
 * Preserve Foundry v14's exact `level.elevation.bottom` (including `-Infinity` for basements/undercrofts)
 * for level ordering, `isUpper` checks, pyramid ground mesh elevation, and depth comparisons.
 */
export function getLevelBottomElevation(level) {
  const bottom = level?.elevation?.bottom;
  if (typeof bottom === "number" && !Number.isNaN(bottom) && bottom !== Infinity) return bottom;
  return getLevelBaseElevation(level);
}

/**
 * Consistent level elevation ordering comparator matching Foundry v14's `levels.sorted`:
 * compares `getLevelBottomElevation` first, breaking equal-bottom ties (e.g. both unset `-Infinity`) by `level.index`.
 */
export function isLevelAbove(levelA, levelB) {
  if (!levelA || !levelB || levelA === levelB) return false;
  const ea = getLevelBottomElevation(levelA);
  const eb = getLevelBottomElevation(levelB);
  if (ea !== eb) return ea > eb;
  return (levelA.index ?? 0) > (levelB.index ?? 0);
}

/**
 * In Foundry v14, unset `level.elevation.top` resolves to `Infinity` at runtime (ExtendedNumberField).
 * Always fall back to `base/bottom + 20` when `top` is non-finite so roof occlusion, indoor lights, and Showstopper stay consistent.
 */
export function getLevelRoofElevation(level) {
  const top = toFiniteNumber(level?.elevation?.top);
  if (Number.isFinite(top)) return top;
  return getLevelBaseElevation(level) + 20;
}

export function smoothstep(edge0, edge1, x) {
  if (edge0 === edge1) return x < edge0 ? 0 : 1;
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
  const stage = globalThis.canvas?.stage;
  const a = stageScale;
  const d = stage?.scale?.y || stageScale;
  const posX = Number.isFinite(stage?.position?.x) ? stage.position.x : sw * 0.5;
  const posY = Number.isFinite(stage?.position?.y) ? stage.position.y : sh * 0.5;
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
  const sx = Number.isFinite(tSpec.scaleX) && tSpec.scaleX !== 0 ? tSpec.scaleX : 1;
  const sy = Number.isFinite(tSpec.scaleY) && tSpec.scaleY !== 0 ? tSpec.scaleY : 1;
  const rawAx = tSpec.anchorX != null ? tSpec.anchorX : 0.5;
  const rawAy = tSpec.anchorY != null ? tSpec.anchorY : 0.5;
  const ax = sx < 0 ? (1 - rawAx) : rawAx;
  const ay = sy < 0 ? (1 - rawAy) : rawAy;
  const effW = Math.abs(tSpec.w || 0) * Math.abs(sx);
  const effH = Math.abs(tSpec.h || 0) * Math.abs(sy);
  const pivX = tSpec.anchorX == null ? (tSpec.x + (tSpec.w || 0) * 0.5) : tSpec.x;
  const pivY = tSpec.anchorY == null ? (tSpec.y + (tSpec.h || 0) * 0.5) : tSpec.y;
  const halfDiag = Math.hypot(effW, effH) * Math.max(ax, 1 - ax, ay, 1 - ay);
  return { pivX, pivY, halfDiag };
}

/** Convert Foundry v14 wall threshold (in scene distance units) into pixel-scaled Edge threshold (including darkness). */
export function buildEdgeThresholdPx(threshold, pxPerFt) {
  if (!threshold || typeof threshold !== "object") return undefined;
  const lNum = toFiniteNumber(threshold.light);
  const sNum = toFiniteNumber(threshold.sight);
  const sndNum = toFiniteNumber(threshold.sound);
  const light = Number.isFinite(lNum) ? lNum * pxPerFt : null;
  const sight = Number.isFinite(sNum) ? sNum * pxPerFt : null;
  const sound = Number.isFinite(sndNum) ? sndNum * pxPerFt : null;
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

/**
 * Compute world-space viewport bounds with optional velocity-biased lookahead padding.
 * Shifts tile prefetch margin forward along the pan vector while trimming excess trailing margin
 * so VRAM usage stays roughly constant and fast pans don't flash low-LOD tiles.
 */
export function computePredictiveViewportRect(
  pivotX,
  pivotY,
  screenW,
  screenH,
  scale,
  maxW,
  maxH,
  {
    padFraction = 0.25,
    velX = 0,
    velY = 0,
    lookaheadSec = 0.35,
    maxLeadFraction = 0.65,
    minTrailFraction = 0.1
  } = {}
) {
  const s = (Number.isFinite(scale) && scale > 0) ? scale : 1;
  const px = Number.isFinite(pivotX) ? pivotX : 0;
  const py = Number.isFinite(pivotY) ? pivotY : 0;
  const sw = (Number.isFinite(screenW) && screenW > 0) ? screenW : 1600;
  const sh = (Number.isFinite(screenH) && screenH > 0) ? screenH : 1000;
  const mw = (Number.isFinite(maxW) && maxW > 0) ? maxW : 100000;
  const mh = (Number.isFinite(maxH) && maxH > 0) ? maxH : 100000;
  const padFrac = (Number.isFinite(padFraction) && padFraction >= 0) ? padFraction : 0;
  const vx = Number.isFinite(velX) ? velX : 0;
  const vy = Number.isFinite(velY) ? velY : 0;

  const wWorld = sw / s;
  const hWorld = sh / s;
  const basePadX = wWorld * padFrac;
  const basePadY = hWorld * padFrac;

  let padLeft = basePadX;
  let padRight = basePadX;
  let padTop = basePadY;
  let padBottom = basePadY;

  if (padFrac > 0 && (vx || vy)) {
    const minTrailX = wWorld * Math.min(minTrailFraction, padFrac);
    const minTrailY = hWorld * Math.min(minTrailFraction, padFrac);
    const leadX = Math.max(-wWorld * maxLeadFraction, Math.min(wWorld * maxLeadFraction, vx * lookaheadSec));
    const leadY = Math.max(-hWorld * maxLeadFraction, Math.min(hWorld * maxLeadFraction, vy * lookaheadSec));

    if (leadX > 0) {
      padRight = basePadX + leadX;
      padLeft = Math.max(minTrailX, basePadX - leadX * 0.45);
    } else if (leadX < 0) {
      padLeft = basePadX - leadX;
      padRight = Math.max(minTrailX, basePadX + leadX * 0.45);
    }

    if (leadY > 0) {
      padBottom = basePadY + leadY;
      padTop = Math.max(minTrailY, basePadY - leadY * 0.45);
    } else if (leadY < 0) {
      padTop = basePadY - leadY;
      padBottom = Math.max(minTrailY, basePadY + leadY * 0.45);
    }
  }

  const x0 = Math.max(0, Math.min(mw, px - wWorld * 0.5 - padLeft));
  const y0 = Math.max(0, Math.min(mh, py - hWorld * 0.5 - padTop));
  const x1 = Math.max(x0, Math.min(mw, px + wWorld * 0.5 + padRight));
  const y1 = Math.max(y0, Math.min(mh, py + hWorld * 0.5 + padBottom));

  return { scale: s, x0, y0, x1, y1 };
}

/**
 * Check whether a TokenDocument has any non-GM player owner without materializing
 * a lazy synthetic ActorDelta (which would instantiate a full Actor on 500+ NPCs).
 */
export function hasPlayerOwnerLazy(doc) {
  if (!doc) return false;
  if (!doc.isLazyDelta) return Boolean(doc.hasPlayerOwner);
  const baseActorId = doc._source?.actorId ?? doc.actorId;
  const baseActor = baseActorId ? globalThis.game?.actors?.get?.(baseActorId) : null;
  if (!baseActor) return false;
  return Boolean(baseActor.hasPlayerOwner);
}
