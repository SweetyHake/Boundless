import { MODULE_ID } from "./utils.mjs";
import {
  PERF_CONFIG,
  perfStats,
  isPrimePerfActive,
  wrapFoundryMethod,
  wrapTargetMethod
} from "./perf-patcher.mjs";

/**
 * Boundless GPU Render Optimizer (Foundry VTT v14 / PIXI 7).
 * Zero-config, non-destructive rendering optimizations active on ALL scenes:
 *  1. Batched sprite rendering for WallsLayer (replaces 2 PIXI.Graphics/wall with 1 shared atlas).
 *  2. Batched sprite bg/border for ControlIcon (notes, lights, sounds, drawings).
 *  3. Token UI layer render batching with built-in viewport frustum culling.
 *  4. Token resource bars & status effects bitmap caching.
 *  5. Precomputed 2D tileable Noise/FBM LUT for animated light shaders.
 *  6. Configurable lighting effects filter resolution scaling & optional UI backdrop blur toggle.
 *
 * Automatically yields overlapping GPU patches when `fvtt-perf-optim` (Prime Performance) is active.
 */

let _gpuInstalled = false;
let _uiAtlas = null;
let _noiseLutTexture = null;

export function invalidateTokenLayerCache() {}

function destroyTokenLayerCache() {}

function ensureTokenLayerCacheHooks() {}

// ---------------------------------------------------------------------------
// 1. Shared Pre-baked UI Atlas (Wall line, Wall endpoint, ControlIcon bg/border)
// ---------------------------------------------------------------------------

function getUiAtlas() {
  if (_uiAtlas && _uiAtlas.base && !_uiAtlas.base.destroyed) return _uiAtlas;
  if (typeof document === "undefined" || !globalThis.PIXI) return null;

  const canvasEl = document.createElement("canvas");
  canvasEl.width = 256;
  canvasEl.height = 256;
  const ctx = canvasEl.getContext("2d");
  if (!ctx) return null;

  // (A) Wall Line texture at (2, 2, 12, 36):
  // Outer black border (top/bottom 12px each), inner white core (12px) so sprite.tint tints only the core!
  ctx.clearRect(0, 0, 256, 256);
  ctx.fillStyle = "rgba(0,0,0,1)";
  ctx.fillRect(0, 2, 16, 36);
  ctx.fillStyle = "rgba(255,255,255,1)";
  ctx.fillRect(0, 14, 16, 12);

  // (B) Wall Endpoint circle at (32, 0, 64, 64):
  // Black outer stroke, white interior so sprite.tint paints interior while border stays black!
  ctx.save();
  ctx.translate(64, 32);
  ctx.beginPath();
  ctx.arc(0, 0, 29, 0, Math.PI * 2);
  ctx.fillStyle = "rgba(0,0,0,1)";
  ctx.fill();
  ctx.beginPath();
  ctx.arc(0, 0, 22, 0, Math.PI * 2);
  ctx.fillStyle = "rgba(255,255,255,1)";
  ctx.fill();
  ctx.restore();

  // Helper for rounded rect path
  const roundedRectPath = (x, y, w, h, r) => {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.lineTo(x + w - r, y);
    ctx.quadraticCurveTo(x + w, y, x + w, y + r);
    ctx.lineTo(x + w, y + h - r);
    ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
    ctx.lineTo(x + r, y + h);
    ctx.quadraticCurveTo(x, y + h, x, y + h - r);
    ctx.lineTo(x, y + r);
    ctx.quadraticCurveTo(x, y, x + r, y);
    ctx.closePath();
  };

  // (C) ControlIcon / DoorControl Background rounded square at (104, 4, 60, 60): pure white (tintable)
  roundedRectPath(104, 4, 60, 60, 8);
  ctx.fillStyle = "rgba(255,255,255,1)";
  ctx.fill();

  // (D) ControlIcon Border rounded square at (176, 4, 64, 64):
  // Outer black stroke + inner white stroke (matches Foundry ControlIcon._refresh)
  roundedRectPath(180, 8, 56, 56, 8);
  ctx.lineWidth = 4.5;
  ctx.strokeStyle = "rgba(0,0,0,1)";
  ctx.stroke();
  ctx.lineWidth = 2.2;
  ctx.strokeStyle = "rgba(255,255,255,1)";
  ctx.stroke();

  // (E) Plain tintable rounded border (for DoorControl orange border) at (0, 80, 64, 64)
  roundedRectPath(4, 84, 56, 56, 7);
  ctx.lineWidth = 3;
  ctx.strokeStyle = "rgba(255,255,255,1)";
  ctx.stroke();

  // (F) Soft blurred drop-shadow circle at (64, 80, 64, 64) (replaces PIXI.BlurFilter on D&D 5e MapLocation pins!)
  ctx.save();
  const sg = ctx.createRadialGradient(96, 112, 16, 96, 112, 31);
  sg.addColorStop(0, "rgba(255,255,255,0.68)");
  sg.addColorStop(0.68, "rgba(255,255,255,0.52)");
  sg.addColorStop(1, "rgba(255,255,255,0)");
  ctx.fillStyle = sg;
  ctx.beginPath();
  ctx.arc(96, 112, 31, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();

  // (G) Clean anti-aliased white circle at (128, 80, 64, 64) (for MapLocation extrude & bg fill)
  ctx.save();
  ctx.beginPath();
  ctx.arc(160, 112, 30, 0, Math.PI * 2);
  ctx.fillStyle = "rgba(255,255,255,1)";
  ctx.fill();
  ctx.restore();

  // (H) Clean anti-aliased white circle outline at (192, 80, 64, 64) (for MapLocation border stroke)
  ctx.save();
  ctx.beginPath();
  ctx.arc(224, 112, 29, 0, Math.PI * 2);
  ctx.lineWidth = 3.2;
  ctx.strokeStyle = "rgba(255,255,255,1)";
  ctx.stroke();
  ctx.restore();

  const base = PIXI.BaseTexture.from(canvasEl, {
    scaleMode: PIXI.SCALE_MODES.LINEAR,
    mipmap: PIXI.MIPMAP_MODES.OFF
  });

  _uiAtlas = {
    base,
    wallLine: new PIXI.Texture(base, new PIXI.Rectangle(4, 2, 8, 36)),
    wallDot: new PIXI.Texture(base, new PIXI.Rectangle(32, 0, 64, 64)),
    iconBg: new PIXI.Texture(base, new PIXI.Rectangle(104, 4, 60, 60)),
    iconBorder: new PIXI.Texture(base, new PIXI.Rectangle(176, 4, 64, 64)),
    plainBorder: new PIXI.Texture(base, new PIXI.Rectangle(0, 80, 64, 64)),
    softShadowCircle: new PIXI.Texture(base, new PIXI.Rectangle(64, 80, 64, 64)),
    solidCircle: new PIXI.Texture(base, new PIXI.Rectangle(128, 80, 64, 64)),
    circleOutline: new PIXI.Texture(base, new PIXI.Rectangle(192, 80, 64, 64))
  };
  return _uiAtlas;
}

// ---------------------------------------------------------------------------
// 2. Wall Graphics -> Batched Sprites
// ---------------------------------------------------------------------------

function makeLineHitPolygon(x0, y0, x1, y1, halfWidth) {
  const dx = x1 - x0;
  const dy = y1 - y0;
  const len = Math.hypot(dx, dy);
  if (len < 1e-4) {
    return new PIXI.Rectangle(x0 - halfWidth, y0 - halfWidth, halfWidth * 2, halfWidth * 2);
  }
  const nx = (-dy / len) * halfWidth;
  const ny = (dx / len) * halfWidth;
  return new PIXI.Polygon([
    x0 + nx, y0 + ny,
    x1 + nx, y1 + ny,
    x1 - nx, y1 - ny,
    x0 - nx, y0 - ny
  ]);
}

function makeEndpointsHitArea(x0, y0, x1, y1, r) {
  const r2 = r * r;
  return {
    contains(x, y) {
      const dx0 = x - x0;
      const dy0 = y - y0;
      if (dx0 * dx0 + dy0 * dy0 <= r2) return true;
      const dx1 = x - x1;
      const dy1 = y - y1;
      return dx1 * dx1 + dy1 * dy1 <= r2;
    }
  };
}

function getWallLineWidth() {
  const s = globalThis.canvas?.dimensions?.uiScale || 1;
  return Math.max(2, Math.round(2 * s));
}

function patchWallSprites() {
  const okLine = wrapFoundryMethod("Wall", "_refreshLine", function (wrapped) {
    if (!PERF_CONFIG.perfEnabled || !PERF_CONFIG.perfWallSprites) {
      if (this._blLineSprite) this._blLineSprite.visible = false;
      if (this.line) this.line.hitArea = null;
      return wrapped();
    }
    const atlas = getUiAtlas();
    if (!atlas || !this.line || this.line.destroyed) return wrapped();

    const c = this.document?.c;
    if (!c || c.length < 4) return wrapped();
    const wc = this._getWallColor();
    const lw = getWallLineWidth();

    this.line.clear();
    let sp = this._blLineSprite;
    if (!sp || sp.destroyed) {
      sp = new PIXI.Sprite(atlas.wallLine);
      sp.anchor.set(0, 0.5);
      sp.eventMode = "none";
      this._blLineSprite = sp;
      this.line.addChild(sp);
    }

    const dx = c[2] - c[0];
    const dy = c[3] - c[1];
    const len = Math.hypot(dx, dy);
    sp.visible = len > 0.1;
    sp.position.set(c[0], c[1]);
    sp.rotation = Math.atan2(dy, dx);
    sp.width = len;
    sp.height = lw * 3;
    sp.tint = wc;

    const hitPad = Math.max(6, lw * 2);
    const hitKey = `${c[0]},${c[1]},${c[2]},${c[3]},${hitPad}`;
    const hitChanged = this._blHitKey !== hitKey || !this.line.hitArea;
    if (hitChanged) {
      this._blHitKey = hitKey;
      this.line.hitArea = makeLineHitPolygon(c[0], c[1], c[2], c[3], hitPad);
    }
    if (this.doorControl) this.doorControl.reposition();
    if (hitChanged) {
      globalThis.foundry?.canvas?.interaction?.MouseInteractionManager?.emulateMoveEvent?.();
    }

    if (this.directionIcon) {
      this.directionIcon.position.set((c[0] + c[2]) * 0.5, (c[1] + c[3]) * 0.5);
      this.directionIcon.tint = wc;
    }
    perfStats.wallSpritesUpdated++;
  }, { type: "MIXED" });

  const okEnd = wrapFoundryMethod("Wall", "_refreshEndpoints", function (wrapped) {
    if (!PERF_CONFIG.perfEnabled || !PERF_CONFIG.perfWallSprites) {
      if (this._blEndA) this._blEndA.visible = false;
      if (this._blEndB) this._blEndB.visible = false;
      if (this.endpoints) this.endpoints.hitArea = null;
      return wrapped();
    }
    const atlas = getUiAtlas();
    if (!atlas || !this.endpoints || this.endpoints.destroyed) return wrapped();

    const c = this.coords || this.document?.c;
    if (!c || c.length < 4) return wrapped();
    const wc = this._getWallColor();
    const lw = getWallLineWidth();
    const cr = (this.hover || this.layer?.highlightObjects) ? lw * 4 : lw * 3;
    const dia = (cr + lw * 0.6) * 2;

    this.endpoints.clear();
    if (!this._blEndA || this._blEndA.destroyed) {
      this._blEndA = new PIXI.Sprite(atlas.wallDot);
      this._blEndA.anchor.set(0.5);
      this._blEndA.eventMode = "none";
      this.endpoints.addChild(this._blEndA);
    }
    if (!this._blEndB || this._blEndB.destroyed) {
      this._blEndB = new PIXI.Sprite(atlas.wallDot);
      this._blEndB.anchor.set(0.5);
      this._blEndB.eventMode = "none";
      this.endpoints.addChild(this._blEndB);
    }

    this._blEndA.visible = true;
    this._blEndA.position.set(c[0], c[1]);
    this._blEndA.width = this._blEndA.height = dia;
    this._blEndA.tint = wc;

    this._blEndB.visible = true;
    this._blEndB.position.set(c[2], c[3]);
    this._blEndB.width = this._blEndB.height = dia;
    this._blEndB.tint = wc;

    this.endpoints.hitArea = makeEndpointsHitArea(c[0], c[1], c[2], c[3], cr + lw);
  }, { type: "MIXED" });

  return [Boolean(okLine), Boolean(okEnd)];
}

// ---------------------------------------------------------------------------
// 3. ControlIcon Batched Sprites (Notes, Lights, Sounds, Drawings)
// ---------------------------------------------------------------------------

function syncGraphicsChildTint(gfx, sprite) {
  if (!gfx || !sprite || sprite.destroyed) return;
  sprite.tint = gfx.tint;
}

function patchControlIcons() {
  const okRefresh = wrapFoundryMethod("ControlIcon", "_refresh", function (wrapped) {
    if (!PERF_CONFIG.perfEnabled || !PERF_CONFIG.perfControlIconCache) {
      if (this._blBgSprite) this._blBgSprite.visible = false;
      if (this._blBorderSprite) this._blBorderSprite.visible = false;
      return wrapped();
    }
    const atlas = getUiAtlas();
    if (!atlas || !this.bg || !this.border) return wrapped();

    // Let core set pivot, icon texture, tooltip, hitArea, etc. first,
    // then replace the expensive PIXI.Graphics geometry on bg & border with atlas sprites!
    wrapped();

    const size = this.size || 40;
    const s = globalThis.canvas?.dimensions?.uiScale || 1;
    const pad = Math.max(2, 2.5 * s);

    this.bg.clear();
    let bgSp = this._blBgSprite;
    if (!bgSp || bgSp.destroyed) {
      bgSp = new PIXI.Sprite(atlas.iconBg);
      bgSp.eventMode = "none";
      this._blBgSprite = bgSp;
      this.bg.addChild(bgSp);
    }
    bgSp.visible = true;
    bgSp.position.set(0, 0);
    bgSp.width = size;
    bgSp.height = size;
    bgSp.tint = this.bg.tint;

    this.border.clear();
    let bdSp = this._blBorderSprite;
    if (!bdSp || bdSp.destroyed) {
      bdSp = new PIXI.Sprite(atlas.iconBorder);
      bdSp.eventMode = "none";
      this._blBorderSprite = bdSp;
      this.border.addChild(bdSp);
    }
    bdSp.visible = true;
    bdSp.position.set(-pad, -pad);
    bdSp.width = size + pad * 2;
    bdSp.height = size + pad * 2;
    bdSp.tint = this.border.tint;

    // Keep sprite tint synced whenever Foundry mutates bg.tint / border.tint (e.g. hover/controlled)
    if (!this._blTintHooked) {
      this._blTintHooked = true;
      const origBgRender = this.bg._render;
      this.bg._render = function (renderer) {
        syncGraphicsChildTint(this, this.parent?._blBgSprite);
        return origBgRender.call(this, renderer);
      };
      const origBdRender = this.border._render;
      this.border._render = function (renderer) {
        syncGraphicsChildTint(this, this.parent?._blBorderSprite);
        return origBdRender.call(this, renderer);
      };
    }

    perfStats.controlIconsBatched++;
  }, { type: "WRAPPER" });

  const okClear = wrapFoundryMethod("ControlIcon", "_clear", function (wrapped) {
    if (this._blBgSprite) this._blBgSprite.visible = false;
    if (this._blBorderSprite) this._blBorderSprite.visible = false;
    if (this._blShadowSp) this._blShadowSp.visible = false;
    if (this._blExtrudeSp) this._blExtrudeSp.visible = false;
    if (this._blFillSp) this._blFillSp.visible = false;
    if (this._blStrokeSp) this._blStrokeSp.visible = false;
    return wrapped();
  }, { type: "WRAPPER" });

  return [Boolean(okRefresh), Boolean(okClear)];
}

// ---------------------------------------------------------------------------
// 3b. DoorControl Batched Sprites (replaces 2 PIXI.Graphics per door)
// ---------------------------------------------------------------------------

function patchDoorControls() {
  const okDraw = wrapFoundryMethod("DoorControl", "draw", async function (wrapped, ...args) {
    const res = await wrapped(...args);
    if (!PERF_CONFIG.perfEnabled || !PERF_CONFIG.perfControlIconCache || isPrimePerfActive()) {
      if (this._blDoorBg) this._blDoorBg.visible = false;
      if (this._blDoorBorder) this._blDoorBorder.visible = false;
      return res;
    }
    const atlas = getUiAtlas();
    if (!atlas || !this.bg || !this.border || this.destroyed) return res;

    const s = globalThis.canvas?.dimensions?.uiScale || 1;
    const x = -2 * s;
    const y = -2 * s;
    const sz = 44 * s;

    this.bg.clear();
    let bgSp = this._blDoorBg;
    if (!bgSp || bgSp.destroyed) {
      bgSp = new PIXI.Sprite(atlas.iconBg);
      bgSp.eventMode = "none";
      this._blDoorBg = bgSp;
      this.bg.addChild(bgSp);
    }
    bgSp.visible = true;
    bgSp.position.set(x, y);
    bgSp.width = sz;
    bgSp.height = sz;
    bgSp.tint = 0x000000;

    this.border.clear();
    let bdSp = this._blDoorBorder;
    if (!bdSp || bdSp.destroyed) {
      bdSp = new PIXI.Sprite(atlas.plainBorder);
      bdSp.eventMode = "none";
      this._blDoorBorder = bdSp;
      this.border.addChild(bdSp);
    }
    bdSp.visible = true;
    bdSp.position.set(x, y);
    bdSp.width = sz;
    bdSp.height = sz;
    bdSp.tint = 0xFF5500;
    bdSp.alpha = 0.85;

    perfStats.controlIconsBatched++;
    return res;
  }, { type: "WRAPPER" });

  return Boolean(okDraw);
}

// ---------------------------------------------------------------------------
// 3c. D&D 5e MapLocationControlIcon -> Batched Atlas Sprites (0 BlurFilter FBOs!)
// ---------------------------------------------------------------------------

let _mapLocPatched = false;
function patchDnd5eMapLocationIcons() {
  if (_mapLocPatched) return true;
  const MapLoc = globalThis.dnd5e?.canvas?.MapLocationControlIcon;
  if (!MapLoc?.prototype?._refresh) return false;
  _mapLocPatched = true;

  wrapTargetMethod(MapLoc.prototype, "_refresh", "dnd5e.MapLocationControlIcon.prototype._refresh", function (wrapped) {
    if (!PERF_CONFIG.perfEnabled || !PERF_CONFIG.perfControlIconCache || isPrimePerfActive()) {
      if (this._blShadowSp) this._blShadowSp.visible = false;
      if (this._blExtrudeSp) this._blExtrudeSp.visible = false;
      if (this._blFillSp) this._blFillSp.visible = false;
      if (this._blStrokeSp) this._blStrokeSp.visible = false;
      if (this.shadow && this._blOrigShadowFilters !== undefined) {
        this.shadow.filters = this._blOrigShadowFilters;
      }
      return wrapped();
    }
    const atlas = getUiAtlas();
    if (!atlas || !this.shadow || !this.extrude || !this.bg) return wrapped();

    // Let dnd5e compute radius, circle, hitArea, cursor, text, border visibility
    wrapped();

    const r = this.radius || (this.size || 40) / 2;
    const style = this.style || {};

    // Remove the expensive per-note PIXI.BlurFilter FBO pass!
    if (this._blOrigShadowFilters === undefined) {
      this._blOrigShadowFilters = this.shadow.filters;
    }
    this.shadow.filters = null;
    this.shadow.clear();
    let shSp = this._blShadowSp;
    if (!shSp || shSp.destroyed) {
      shSp = new PIXI.Sprite(atlas.softShadowCircle);
      shSp.anchor.set(0.5);
      shSp.eventMode = "none";
      this._blShadowSp = shSp;
      this.shadow.addChild(shSp);
    }
    shSp.visible = true;
    shSp.position.set(r + 8, r + 8);
    shSp.width = shSp.height = (r + 14) * 2;
    shSp.tint = style.shadowColor ?? 0x000000;

    // 3D extrude disc
    this.extrude.clear();
    let exSp = this._blExtrudeSp;
    if (!exSp || exSp.destroyed) {
      exSp = new PIXI.Sprite(atlas.solidCircle);
      exSp.anchor.set(0.5);
      exSp.eventMode = "none";
      this._blExtrudeSp = exSp;
      this.extrude.addChild(exSp);
    }
    exSp.visible = true;
    exSp.position.set(r + 2, r + 2);
    exSp.width = exSp.height = (r + 9.5) * 2;
    exSp.tint = style.borderColor ?? 0x000000;

    // Main background disc + outline stroke
    this.bg.clear();
    let fillSp = this._blFillSp;
    if (!fillSp || fillSp.destroyed) {
      fillSp = new PIXI.Sprite(atlas.solidCircle);
      fillSp.anchor.set(0.5);
      fillSp.eventMode = "none";
      this._blFillSp = fillSp;
      this.bg.addChild(fillSp);
    }
    fillSp.visible = true;
    fillSp.position.set(r, r);
    fillSp.width = fillSp.height = (r + 8.5) * 2;
    fillSp.tint = style.backgroundColor ?? 0xFFFFFF;

    let stSp = this._blStrokeSp;
    if (!stSp || stSp.destroyed) {
      stSp = new PIXI.Sprite(atlas.circleOutline);
      stSp.anchor.set(0.5);
      stSp.eventMode = "none";
      this._blStrokeSp = stSp;
      this.bg.addChild(stSp);
    }
    stSp.visible = true;
    stSp.position.set(r, r);
    stSp.width = stSp.height = (r + 9) * 2;
    stSp.tint = style.borderColor ?? 0x000000;

    perfStats.controlIconsBatched++;
  });

  return true;
}

// ---------------------------------------------------------------------------
// 4. Token UI Render Batching + Viewport Frustum Culling
// ---------------------------------------------------------------------------

function getStageViewportWorldRect(padWorld = 240) {
  const stage = globalThis.canvas?.stage;
  const renderer = globalThis.canvas?.app?.renderer;
  if (!stage?.worldTransform || !renderer?.screen) return null;
  const wt = stage.worldTransform;
  const a = Number.isFinite(wt.a) ? wt.a : 1;
  const b = Number.isFinite(wt.b) ? wt.b : 0;
  const c = Number.isFinite(wt.c) ? wt.c : 0;
  const d = Number.isFinite(wt.d) ? wt.d : 1;
  const tx = Number.isFinite(wt.tx) ? wt.tx : 0;
  const ty = Number.isFinite(wt.ty) ? wt.ty : 0;
  const det = a * d - b * c;
  if (Math.abs(det) < 1e-6) return null;
  const invDet = 1 / det;
  const scr = renderer.screen;
  const sx0 = scr.x, sx1 = scr.x + scr.width;
  const sy0 = scr.y, sy1 = scr.y + scr.height;
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  const corners = [[sx0, sy0], [sx1, sy0], [sx0, sy1], [sx1, sy1]];
  for (let i = 0; i < 4; i++) {
    const dx = corners[i][0] - tx;
    const dy = corners[i][1] - ty;
    const wx = (d * dx - c * dy) * invDet;
    const wy = (-b * dx + a * dy) * invDet;
    if (wx < minX) minX = wx;
    if (wx > maxX) maxX = wx;
    if (wy < minY) minY = wy;
    if (wy > maxY) maxY = wy;
  }
  return {
    minX: minX - padWorld,
    maxX: maxX + padWorld,
    minY: minY - padWorld,
    maxY: maxY + padWorld
  };
}

function renderChildSafe(child, renderer) {
  if (!child || child.destroyed || !child.visible || !child.renderable || child.worldAlpha <= 0) return;
  child.render(renderer);
}

export function isStandardTokenChild(t, c) {
  return (
    c === t.turnMarker ||
    c === t.border ||
    c === t.voidMesh ||
    c === t.detectionFilterMesh ||
    c === t.bars ||
    c === t.effects ||
    c === t.targetArrows ||
    c === t.targetPips ||
    c === t.nameplate ||
    c === t.tooltip ||
    c === t.levelIndicator
  );
}

export function hasAnyCustomChild(t) {
  const kids = t.children;
  for (let j = 0; j < kids.length; j++) {
    const c = kids[j];
    if (!c || c.destroyed || !c.visible || !c.renderable || c.worldAlpha <= 0) continue;
    if (!isStandardTokenChild(t, c)) return true;
  }
  return false;
}

function hasCustomUnderlayChild(t) {
  const kids = t.children;
  for (let j = 0; j < kids.length; j++) {
    const c = kids[j];
    if (!c || c.destroyed || !c.visible || !c.renderable || c.worldAlpha <= 0) continue;
    if (!isStandardTokenChild(t, c) && (c.zIndex ?? 0) < 0) return true;
  }
  return false;
}

function renderBatchedTokenPasses(renderer, visibleTokens) {
  const n = visibleTokens.length;
  if (n === 0) return;

  for (let i = 0; i < n; i++) renderChildSafe(visibleTokens[i].turnMarker, renderer);
  // Render normal-depth borders before voidMesh; hovered / highlighted borders (zIndex > 0) render after tooltip
  // so voidMesh ERASE cutout never punches holes in hover borders on pop-out tokens (Hero in a Box / Multiple Rings).
  for (let i = 0; i < n; i++) {
    const b = visibleTokens[i].border;
    if (b && (b.zIndex ?? 0) <= 0) renderChildSafe(b, renderer);
  }
  // Render voidMesh (ERASE cutout) & detectionFilterMesh strictly BEFORE UI overlays (bars, effects, nameplates)
  // so voidMesh never erases token bars, status icons, or tooltips.
  for (let i = 0; i < n; i++) renderChildSafe(visibleTokens[i].voidMesh, renderer);
  for (let i = 0; i < n; i++) renderChildSafe(visibleTokens[i].detectionFilterMesh, renderer);
  for (let i = 0; i < n; i++) renderChildSafe(visibleTokens[i].bars, renderer);
  for (let i = 0; i < n; i++) renderChildSafe(visibleTokens[i].effects, renderer);
  for (let i = 0; i < n; i++) {
    const t = visibleTokens[i];
    renderChildSafe(t.targetArrows, renderer);
    renderChildSafe(t.targetPips, renderer);
  }
  for (let i = 0; i < n; i++) renderChildSafe(visibleTokens[i].nameplate, renderer);
  for (let i = 0; i < n; i++) renderChildSafe(visibleTokens[i].tooltip, renderer);
  for (let i = 0; i < n; i++) renderChildSafe(visibleTokens[i].levelIndicator, renderer);

  for (let i = 0; i < n; i++) {
    const t = visibleTokens[i];
    const tKids = t.children;
    for (let j = 0; j < tKids.length; j++) {
      const c = tKids[j];
      if (isStandardTokenChild(t, c)) continue;
      renderChildSafe(c, renderer);
    }
  }
  for (let i = 0; i < n; i++) {
    const b = visibleTokens[i].border;
    if (b && (b.zIndex ?? 0) > 0) renderChildSafe(b, renderer);
  }
}

function attachTokenUiBatcher() {
  const objects = globalThis.canvas?.tokens?.objects;
  if (!objects || objects._blBatcherAttached) return;
  objects._blBatcherAttached = true;

  const batchTokens = [];

  wrapTargetMethod(objects, "render", "TokenLayer.objects.render", function (wrapped, renderer) {
    if (!PERF_CONFIG.perfEnabled || !PERF_CONFIG.perfTokenUiBatching || isPrimePerfActive()) {
      return wrapped(renderer);
    }
    if (!this.visible || this.worldAlpha <= 0 || !this.renderable) return;
    if (this._mask || (this.filters && this.filters.length) || this.cullable) {
      return wrapped(renderer);
    }

    const kids = this.children;
    const count = kids.length;
    if (count < 4) return wrapped(renderer);
    if (this.sortableChildren && this.sortDirty) this.sortChildren();

    const vp = PERF_CONFIG.perfAutoCulling ? getStageViewportWorldRect(260) : null;
    batchTokens.length = 0;

    for (let i = 0; i < count; i++) {
      const tok = kids[i];
      if (!tok || tok.destroyed || !tok.visible || !tok.renderable || tok.worldAlpha <= 0) continue;

      const hasLargeExtension = Boolean(
        tok.turnMarker?.visible ||
        tok._mask ||
        (tok.filters && tok.filters.length) ||
        hasAnyCustomChild(tok)
      );
      if (vp && !tok.controlled && !tok.hover && !tok.isPreview && !hasLargeExtension) {
        const tx = tok.x ?? tok.document?.x ?? 0;
        const ty = tok.y ?? tok.document?.y ?? 0;
        const tw = tok.w || 100;
        const th = tok.h || 100;
        if (tx + tw < vp.minX || tx > vp.maxX || ty + th < vp.minY || ty > vp.maxY) {
          perfStats.tokenCulledUi++;
          continue;
        }
      }

      // Preserve exact z-order with complex tokens (masks, filters, vision-5e non-precise detections, under-token auras)
      if (
        tok._mask ||
        (tok.filters && tok.filters.length) ||
        !tok.bars ||
        tok.detectionFilter != null ||
        (tok._detectionLevel !== undefined && tok._detectionLevel < 2) ||
        hasCustomUnderlayChild(tok)
      ) {
        if (batchTokens.length > 0) {
          renderBatchedTokenPasses(renderer, batchTokens);
          batchTokens.length = 0;
        }
        tok.render(renderer);
      } else {
        batchTokens.push(tok);
      }
    }

    if (batchTokens.length > 0) {
      renderBatchedTokenPasses(renderer, batchTokens);
      batchTokens.length = 0;
    }
    perfStats.tokenBatchedFrames++;
  });
}

// ---------------------------------------------------------------------------
// 4b. LightingLayer GM View Batcher + Viewport Frustum Culling
// ---------------------------------------------------------------------------

function attachLightingLayerBatcher() {
  const objects = globalThis.canvas?.lighting?.objects;
  if (!objects || objects._blLightBatcherAttached) return;
  objects._blLightBatcherAttached = true;

  const visLights = [];
  const complexLights = [];

  wrapTargetMethod(objects, "render", "LightingLayer.objects.render", function (wrapped, renderer) {
    if (!PERF_CONFIG.perfEnabled || (!PERF_CONFIG.perfControlIconCache && !PERF_CONFIG.perfAutoCulling) || isPrimePerfActive()) return wrapped(renderer);
    if (!this.visible || this.worldAlpha <= 0 || !this.renderable) return;
    if (this._mask || (this.filters && this.filters.length) || this.cullable) return wrapped(renderer);
    const kids = this.children;
    const count = kids.length;
    if (count < 32) return wrapped(renderer);
    if (this.sortableChildren && this.sortDirty) this.sortChildren();

    const vp = PERF_CONFIG.perfAutoCulling ? getStageViewportWorldRect(260) : null;
    const distPx = globalThis.canvas?.dimensions?.distancePixels || 20;
    visLights.length = 0;
    complexLights.length = 0;
    for (let i = 0; i < count; i++) {
      const al = kids[i];
      if (!al || al.destroyed || !al.visible || !al.renderable || al.worldAlpha <= 0) continue;
      if (vp && !al.controlled && !al.hover && !al.isPreview) {
        const lx = al.document?.x ?? al.x ?? 0;
        const ly = al.document?.y ?? al.y ?? 0;
        const cfgR = Math.max(al.document?.config?.dim || 0, al.document?.config?.bright || 0) * distPx;
        const r = Math.max(80, al.radius || al.lightSource?.radius || cfgR || 100);
        if (lx + r < vp.minX || lx - r > vp.maxX || ly + r < vp.minY || ly - r > vp.maxY) continue;
      }
      if (al._mask || (al.filters && al.filters.length)) {
        complexLights.push(al);
      } else {
        visLights.push(al);
      }
    }

    for (let i = 0; i < complexLights.length; i++) complexLights[i].render(renderer);
    const n = visLights.length;
    if (n === 0) return;
    // Pass 1: field Graphics (radius rings)
    for (let i = 0; i < n; i++) renderChildSafe(visLights[i].field, renderer);
    // Pass 2: controls (batched sprites)
    for (let i = 0; i < n; i++) renderChildSafe(visLights[i].controls ?? visLights[i].controlIcon, renderer);
    // Pass 3: remaining children (tooltips, custom overlays)
    for (let i = 0; i < n; i++) {
      const al = visLights[i];
      const ctrl = al.controls ?? al.controlIcon;
      const alKids = al.children;
      for (let j = 0; j < alKids.length; j++) {
        const c = alKids[j];
        if (c === al.field || c === ctrl) continue;
        renderChildSafe(c, renderer);
      }
    }
    perfStats.lightingLayerBatched++;
  });
}

// ---------------------------------------------------------------------------
// 5. Token Bars & Effects Bitmap Caching
// ---------------------------------------------------------------------------

function getBitmapCacheResolution() {
  const r = globalThis.canvas?.app?.renderer?.resolution || 1;
  return Math.max(1, Math.min(2, r));
}

function patchTokenUiCaching() {
  const cacheBar = (bar) => {
    if (!bar || bar.destroyed || !bar.visible) return false;
    bar.cacheAsBitmapResolution = getBitmapCacheResolution();
    bar.cacheAsBitmap = true;
    return true;
  };

  const okBars = wrapFoundryMethod("Token", "drawBars", function (wrapped, ...args) {
    if (this.bars) {
      this.bars.cacheAsBitmap = false;
      if (this.bars.bar1) this.bars.bar1.cacheAsBitmap = false;
      if (this.bars.bar2) this.bars.bar2.cacheAsBitmap = false;
    }
    const res = wrapped(...args);
    if (
      PERF_CONFIG.perfEnabled &&
      PERF_CONFIG.perfTokenUiCache &&
      !isPrimePerfActive() &&
      this.bars &&
      !this.bars.destroyed &&
      !this.isPreview &&
      this.bars.visible &&
      (this.bars.children?.length ?? 0) <= 2
    ) {
      // Cache bar1 and bar2 individually instead of the whole token-sized `this.bars` container (avoids 10MB empty VRAM on Huge/Gargantuan tokens)
      const c1 = cacheBar(this.bars.bar1);
      const c2 = cacheBar(this.bars.bar2);
      if (c1 || c2) perfStats.tokenBarsCached++;
    }
    return res;
  }, { type: "WRAPPER" });

  const okDrawBar = wrapFoundryMethod("Token", "_drawBar", function (wrapped, number, bar, data, ...rest) {
    if (this.bars) this.bars.cacheAsBitmap = false;
    if (bar) bar.cacheAsBitmap = false;
    const res = wrapped(number, bar, data, ...rest);
    if (
      PERF_CONFIG.perfEnabled &&
      PERF_CONFIG.perfTokenUiCache &&
      !isPrimePerfActive() &&
      this.bars?.visible &&
      bar && !bar.destroyed && bar.visible && !this.isPreview &&
      (this.bars?.children?.length ?? 0) <= 2
    ) {
      cacheBar(bar);
    }
    return res;
  }, { type: "WRAPPER" });

  const okDrawFx = wrapFoundryMethod("Token", "_drawEffects", function (wrapped, ...args) {
    if (this.effects) this.effects.cacheAsBitmap = false;
    return wrapped(...args);
  }, { type: "WRAPPER" });

  const okRefFx = wrapFoundryMethod("Token", "_refreshEffects", function (wrapped, ...args) {
    if (this.effects) this.effects.cacheAsBitmap = false;
    const res = wrapped(...args);
    if (
      PERF_CONFIG.perfEnabled &&
      PERF_CONFIG.perfTokenUiCache &&
      !isPrimePerfActive() &&
      this.effects &&
      !this.effects.destroyed &&
      !this.isPreview &&
      !this.effects.overlay &&
      this.effects.children?.length >= 5 &&
      this.effects.children.every(ch => ch === this.effects.bg || (ch instanceof PIXI.Sprite && !ch.children?.length && (!ch.eventMode || ch.eventMode === "none" || ch.eventMode === "passive")))
    ) {
      this.effects.cacheAsBitmapResolution = getBitmapCacheResolution();
      this.effects.cacheAsBitmap = true;
      perfStats.tokenEffectsCached++;
    }
    return res;
  }, { type: "WRAPPER" });

  return [Boolean(okBars), Boolean(okDrawBar), Boolean(okDrawFx), Boolean(okRefFx)];
}

export function clearTokenUiBitmapCaches() {
  destroyTokenLayerCache();
  const placeables = globalThis.canvas?.tokens?.placeables;
  if (!placeables) return;
  for (const tok of placeables) {
    if (tok.bars) {
      tok.bars.cacheAsBitmap = false;
      if (tok.bars.bar1) tok.bars.bar1.cacheAsBitmap = false;
      if (tok.bars.bar2) tok.bars.bar2.cacheAsBitmap = false;
    }
    if (tok.effects) tok.effects.cacheAsBitmap = false;
  }
}

// ---------------------------------------------------------------------------
// 6. Precomputed Tileable Noise/FBM LUT for Animated Light Shaders
// ---------------------------------------------------------------------------

function hash2Periodic(ix, iy, period) {
  const px = ((ix % period) + period) % period;
  const py = ((iy % period) + period) % period;
  const dot = px * 12.9898 + py * 78.233;
  const s = Math.sin(dot) * 43758.5453123;
  return s - Math.floor(s);
}

function periodicValueNoise(x, y, period) {
  const ix = Math.floor(x);
  const iy = Math.floor(y);
  const fx = x - ix;
  const fy = y - iy;
  const ux = fx * fx * (3 - 2 * fx);
  const uy = fy * fy * (3 - 2 * fy);
  const a = hash2Periodic(ix, iy, period);
  const b = hash2Periodic(ix + 1, iy, period);
  const c = hash2Periodic(ix, iy + 1, period);
  const d = hash2Periodic(ix + 1, iy + 1, period);
  const ab = a + (b - a) * ux;
  const cd = c + (d - c) * ux;
  return ab + (cd - ab) * uy;
}

export function generateNoiseLutPixels(size = 128, basePeriod = 16) {
  const data = new Uint8Array(size * size * 4);
  for (let py = 0; py < size; py++) {
    const v = (py / size) * basePeriod;
    for (let px = 0; px < size; px++) {
      const u = (px / size) * basePeriod;
      const n1 = periodicValueNoise(u, v, basePeriod);
      const n2 = periodicValueNoise(u * 2, v * 2, basePeriod * 2);
      const n3 = periodicValueNoise(u * 4, v * 4, basePeriod * 4);
      const n4 = periodicValueNoise(u * 8, v * 8, basePeriod * 8);

      const fbm2 = (n1 + 0.5 * n2) / 1.5;
      const fbm3 = (n1 + 0.5 * n2 + 0.25 * n3) / 1.75;
      const fbm4 = (n1 + 0.5 * n2 + 0.25 * n3 + 0.125 * n4) / 1.875;

      const idx = (py * size + px) * 4;
      data[idx] = Math.max(0, Math.min(255, Math.round(n1 * 255)));
      data[idx + 1] = Math.max(0, Math.min(255, Math.round(fbm2 * 255)));
      data[idx + 2] = Math.max(0, Math.min(255, Math.round(fbm3 * 255)));
      data[idx + 3] = Math.max(0, Math.min(255, Math.round(fbm4 * 255)));
    }
  }
  return data;
}

function getNoiseLutTexture() {
  if (_noiseLutTexture && !_noiseLutTexture.destroyed) return _noiseLutTexture;
  if (!globalThis.PIXI) return null;
  const size = 128;
  const pixels = generateNoiseLutPixels(size, 16);
  const tex = PIXI.Texture.fromBuffer(pixels, size, size, {
    format: PIXI.FORMATS.RGBA,
    type: PIXI.TYPES.UNSIGNED_BYTE,
    scaleMode: PIXI.SCALE_MODES.LINEAR,
    wrapMode: PIXI.WRAP_MODES.REPEAT,
    mipmap: PIXI.MIPMAP_MODES.OFF
  });
  _noiseLutTexture = tex;
  return tex;
}

/**
 * Pure GLSL rewriter: replaces Foundry's expensive procedural `noise(in vec2 uv)` and
 * `fbm(in vec2 uv)` with single hardware `texture2D(uBoundlessNoise, ...)` lookups.
 * Returns `{ src, modified }`.
 */
export function rewriteShaderNoiseGlsl(src) {
  if (typeof src !== "string" || !src.length) return { src, modified: false };
  if (src.includes("uBoundlessNoise")) return { src, modified: false };
  // Skip WebGL2 GLSL 300 es custom shaders (texture2D / uniform ordering rules differ)
  if (/^\s*#version\s+300\s+es\b/m.test(src)) return { src, modified: false };

  let out = src;
  let modified = false;

  // Match Foundry's AbstractBaseShader.NOISE block strictly within a single function body (no `{` or `}` crossing)
  const noiseRe = /float\s+noise\s*\(\s*in\s+vec2\s+uv\s*\)\s*\{[^{}]*?return\s+mix\s*\([^{}]*?\);\s*\}/;
  if (noiseRe.test(out)) {
    out = out.replace(
      noiseRe,
      "float noise(in vec2 uv) { return texture2D(uBoundlessNoise, uv * 0.0625).r; }"
    );
    modified = true;
  }

  // Match Foundry's AdaptiveLightingShader.FBM(octaves, amp) block
  const fbmRe = /float\s+fbm\s*\(\s*in\s+vec2\s+uv\s*\)\s*\{\s*float\s+total\s*=\s*0\.0\s*,\s*amp\s*=\s*([0-9.]+)\s*;\s*for\s*\(\s*int\s+i\s*=\s*0\s*;\s*i\s*<\s*(\d+)\s*;\s*i\+\+\s*\)\s*\{\s*total\s*\+=\s*noise\s*\(\s*uv\s*\)\s*\*\s*amp\s*;\s*uv\s*\+=\s*uv\s*;\s*amp\s*\*=\s*0\.5\s*;\s*\}\s*return\s+total\s*;\s*\}/;
  const fbmMatch = fbmRe.exec(out);
  if (fbmMatch) {
    const amp = Number(fbmMatch[1]) || 1.0;
    const oct = Math.max(1, Math.min(4, Number(fbmMatch[2]) || 4));
    const channelMap = { 1: ["r", 1.0], 2: ["g", 1.5], 3: ["b", 1.75], 4: ["a", 1.875] };
    const [ch, norm] = channelMap[oct] || ["a", 1.875];
    const scale = (amp * norm).toFixed(4);
    out = out.replace(
      fbmRe,
      `float fbm(in vec2 uv) { return texture2D(uBoundlessNoise, uv * 0.0625).${ch} * ${scale}; }`
    );
    modified = true;
  }

  if (modified) {
    // Inject uniform after precision declaration, or after leading #version / #extension directives
    const precRe = /(precision\s+\w+\s+float\s*;)/;
    if (precRe.test(out)) {
      out = out.replace(precRe, "$1\nuniform sampler2D uBoundlessNoise;");
    } else {
      const lines = out.split("\n");
      let insertAt = 0;
      while (insertAt < lines.length && /^\s*(?:#(?:version|extension|pragma)\b|\/\/|$)/.test(lines[insertAt])) {
        insertAt++;
      }
      lines.splice(insertAt, 0, "uniform sampler2D uBoundlessNoise;");
      out = lines.join("\n");
    }
  }

  return { src: out, modified };
}

function patchAnimatedLightShaders() {
  const Adaptive = globalThis.foundry?.canvas?.rendering?.shaders?.AdaptiveLightingShader;
  if (!Adaptive) return false;

  const patchedClasses = new Set();
  const patchClassFrag = (cls, name) => {
    if (!cls || patchedClasses.has(cls) || typeof cls._createFragmentShader !== "function") return;
    patchedClasses.add(cls);
    wrapTargetMethod(cls, "_createFragmentShader", `${name}._createFragmentShader`, function (wrapped, ...args) {
      const src = wrapped(...args);
      if (!PERF_CONFIG.perfEnabled || !PERF_CONFIG.perfLightShaders || isPrimePerfActive()) return src;
      const res = rewriteShaderNoiseGlsl(src);
      if (res.modified) perfStats.lightShadersOptimized++;
      return res.src;
    });
  };

  const anims = globalThis.CONFIG?.Canvas?.lightAnimations || {};
  for (const [k, def] of Object.entries(anims)) {
    for (const key of ["illuminationShader", "colorationShader", "backgroundShader"]) {
      if (def?.[key]) patchClassFrag(def[key], `${k}.${key}`);
    }
  }

  // Always bind uBoundlessNoise whenever a compiled program references it (shader programs stay cached on classes even if setting toggles off)
  wrapTargetMethod(Adaptive, "create", "AdaptiveLightingShader.create", function (wrapped, uniforms = {}, options = {}) {
    const shader = wrapped(uniforms, options);
    if (shader?.program?.fragmentSrc?.includes("uBoundlessNoise")) {
      const tex = getNoiseLutTexture();
      if (tex && shader.uniforms) {
        shader.uniforms.uBoundlessNoise = tex;
      }
    }
    return shader;
  });

  return patchedClasses.size > 0;
}

// ---------------------------------------------------------------------------
// 7. Lighting Effects Filter Render Scale & AppV2 Backdrop Blur
// ---------------------------------------------------------------------------

const LIGHTING_SCALE_PRESETS = {
  full: { illumination: 1.0, coloration: 1.0, darkness: 1.0 },
  balanced: { illumination: 0.55, coloration: 0.85, darkness: 0.55 },
  performance: { illumination: 0.4, coloration: 0.65, darkness: 0.45 }
};

export function resolveLightingScalePreset(mode, perfMode = 2) {
  if (mode === "full" || mode === "balanced" || mode === "performance") {
    return LIGHTING_SCALE_PRESETS[mode];
  }
  // "auto": keep illumination/darkness soft & cheap (visually indistinguishable), preserve coloration crispness
  if (perfMode <= 0) return LIGHTING_SCALE_PRESETS.performance;
  return LIGHTING_SCALE_PRESETS.balanced;
}

const _origFilterResDescs = new WeakMap();

export function restoreFilterResolution(filter) {
  if (!filter) return false;
  const saved = _origFilterResDescs.get(filter);
  if (!saved) {
    delete filter._blResMult;
    return false;
  }
  try {
    if (saved.hadOwn && saved.desc) {
      Object.defineProperty(filter, "resolution", saved.desc);
    } else {
      delete filter.resolution;
    }
  } catch {}
  _origFilterResDescs.delete(filter);
  delete filter._blResMult;
  return true;
}

export function applyLightingRenderScale() {
  if (isPrimePerfActive()) return;
  if (!globalThis.canvas?.ready) return;
  if (globalThis.Boundless?._mounting) return;
  const effects = globalThis.canvas?.effects;
  if (!effects) return;

  const mode = PERF_CONFIG.perfEnabled ? PERF_CONFIG.perfLightingScale : "full";
  const perfMode = globalThis.canvas?.performance?.mode ?? 2;
  const preset = resolveLightingScalePreset(mode, perfMode);

  const applyOne = (layer, mult) => {
    const filter = layer?.filter;
    if (!filter || filter.destroyed) return;
    // Do not override filters whose resolution is locked by Boundless mega-map engine
    if (globalThis.Boundless?._patchedFilters?.has?.(filter)) return;
    try {
      if (mult >= 0.999) {
        restoreFilterResolution(filter);
        return;
      }
      if (filter._blResMult === mult && _origFilterResDescs.has(filter)) return;
      if (!_origFilterResDescs.has(filter)) {
        const hadOwn = Object.prototype.hasOwnProperty.call(filter, "resolution");
        const desc = hadOwn ? Object.getOwnPropertyDescriptor(filter, "resolution") : null;
        _origFilterResDescs.set(filter, { hadOwn, desc });
      }
      // Redefine via dynamic getter so Foundry v14's non-MAX no-op setter on illumination.filter is bypassed cleanly
      Object.defineProperty(filter, "resolution", {
        configurable: true,
        enumerable: true,
        get() {
          const rt = globalThis.canvas?.app?.renderer?.renderTexture?.current;
          const base = rt ? rt.resolution : (globalThis.canvas?.app?.renderer?.resolution || 1);
          return Math.max(0.25, Math.round(base * mult * 1000) / 1000);
        },
        set() {}
      });
      filter._blResMult = mult;
    } catch {}
  };
  applyOne(effects.illumination, preset.illumination);
  applyOne(effects.coloration, preset.coloration);
  applyOne(effects.darkness, preset.darkness);
}

export function applyDisableUiBlur() {
  if (typeof document === "undefined" || !document.body) return;
  const blurOff = Boolean(PERF_CONFIG.perfEnabled && PERF_CONFIG.perfDisableUiBlur);
  document.body.classList.toggle("boundless-no-blur", blurOff);
  document.body.classList.toggle("boundless-ui-perf", Boolean(PERF_CONFIG.perfEnabled));
}

// ---------------------------------------------------------------------------
// Lifecycle Installer
// ---------------------------------------------------------------------------

export function installGpuPerfEngine() {
  if (_gpuInstalled) return;
  _gpuInstalled = true;

  if (globalThis.game?.settings?.get?.("core", "noCanvas")) return;

  const primeActive = isPrimePerfActive();
  if (primeActive) {
    console.info(`${MODULE_ID} | Prime Performance (fvtt-perf-optim) detected; yielding overlapping GPU patches to avoid double-wrapping.`);
  } else {
    patchWallSprites();
    patchControlIcons();
    patchDoorControls();
    patchDnd5eMapLocationIcons();
    patchTokenUiCaching();
    patchAnimatedLightShaders();
  }

  Hooks.once("ready", () => {
    if (!isPrimePerfActive()) patchDnd5eMapLocationIcons();
  });

  Hooks.on("canvasReady", () => {
    invalidateTokenLayerCache();
    if (!isPrimePerfActive()) {
      attachLightingLayerBatcher();
      patchDnd5eMapLocationIcons();
      attachTokenUiBatcher();
      applyLightingRenderScale();
    }
    applyDisableUiBlur();
  });

  Hooks.on("lightingRefresh", () => {
    if (!isPrimePerfActive()) applyLightingRenderScale();
  });

  applyDisableUiBlur();
}

let _lastSpriteIconsSig = null;

export function refreshGpuPerfSettings() {
  applyDisableUiBlur();
  if (isPrimePerfActive()) return;
  applyLightingRenderScale();
  if (!PERF_CONFIG.perfEnabled || !PERF_CONFIG.perfTokenUiCache) {
    clearTokenUiBitmapCaches();
  }
  const spriteIconsSig = `${PERF_CONFIG.perfEnabled ? 1 : 0}:${PERF_CONFIG.perfWallSprites ? 1 : 0}:${PERF_CONFIG.perfControlIconCache ? 1 : 0}`;
  if (spriteIconsSig === _lastSpriteIconsSig) return;
  _lastSpriteIconsSig = spriteIconsSig;
  // Re-render walls, notes, doors, sounds, and template icons only when sprite/icon toggles actually change
  const walls = globalThis.canvas?.walls?.placeables;
  if (walls?.length) {
    for (const w of walls) {
      w.renderFlags?.set?.({ refreshLine: true, refreshEndpoints: true });
    }
  }
  const notes = globalThis.canvas?.notes?.placeables;
  if (notes?.length) {
    for (const n of notes) {
      if (n.controlIcon && !n.controlIcon.destroyed) {
        try { n.controlIcon._refresh?.(); } catch {}
      }
    }
  }
  const templates = globalThis.canvas?.templates?.placeables;
  if (templates?.length) {
    for (const tpl of templates) {
      if (tpl.controlIcon && !tpl.controlIcon.destroyed) {
        try { tpl.controlIcon._refresh?.(); } catch {}
      }
    }
  }
  const doors = globalThis.canvas?.controls?.doors?.children;
  if (doors?.length) {
    for (const d of doors) {
      if (d && !d.destroyed && typeof d.draw === "function") {
        try { d.draw(); } catch {}
      }
    }
  }
  const sounds = globalThis.canvas?.sounds?.placeables;
  if (sounds?.length) {
    for (const s of sounds) {
      if (s.controlIcon && !s.controlIcon.destroyed) {
        try { s.controlIcon._refresh?.(); } catch {}
      }
    }
  }
}
