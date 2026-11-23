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

// ---------------------------------------------------------------------------
// 1. Shared Pre-baked UI Atlas (Wall line, Wall endpoint, ControlIcon bg/border)
// ---------------------------------------------------------------------------

function getUiAtlas() {
  if (_uiAtlas && _uiAtlas.base && !_uiAtlas.base.destroyed) return _uiAtlas;
  if (typeof document === "undefined" || !globalThis.PIXI) return null;

  const canvasEl = document.createElement("canvas");
  canvasEl.width = 256;
  canvasEl.height = 128;
  const ctx = canvasEl.getContext("2d");
  if (!ctx) return null;

  // (A) Wall Line texture at (2, 2, 12, 36):
  // Outer black border (top/bottom 12px each), inner white core (12px) so sprite.tint tints only the core!
  ctx.clearRect(0, 0, 256, 128);
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

  // (C) ControlIcon Background rounded square at (104, 4, 60, 60): pure white (tintable)
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

  const base = PIXI.BaseTexture.from(canvasEl, {
    scaleMode: PIXI.SCALE_MODES.LINEAR,
    mipmap: PIXI.MIPMAP_MODES.OFF
  });

  _uiAtlas = {
    base,
    wallLine: new PIXI.Texture(base, new PIXI.Rectangle(4, 2, 8, 36)),
    wallDot: new PIXI.Texture(base, new PIXI.Rectangle(32, 0, 64, 64)),
    iconBg: new PIXI.Texture(base, new PIXI.Rectangle(104, 4, 60, 60)),
    iconBorder: new PIXI.Texture(base, new PIXI.Rectangle(176, 4, 64, 64))
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

    this.line.hitArea = makeLineHitPolygon(c[0], c[1], c[2], c[3], Math.max(6, lw * 2));

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
    return wrapped();
  }, { type: "WRAPPER" });

  return [Boolean(okRefresh), Boolean(okClear)];
}

// ---------------------------------------------------------------------------
// 4. Token UI Render Batching + Viewport Frustum Culling
// ---------------------------------------------------------------------------

function getStageViewportWorldRect(padWorld = 240) {
  const stage = globalThis.canvas?.stage;
  const renderer = globalThis.canvas?.app?.renderer;
  if (!stage?.worldTransform || !renderer?.screen) return null;
  const wt = stage.worldTransform;
  const a = wt.a || 1;
  const d = wt.d || 1;
  if (Math.abs(a) < 1e-6 || Math.abs(d) < 1e-6) return null;
  const scr = renderer.screen;
  const minX = (scr.x - wt.tx) / a - padWorld;
  const maxX = (scr.x + scr.width - wt.tx) / a + padWorld;
  const minY = (scr.y - wt.ty) / d - padWorld;
  const maxY = (scr.y + scr.height - wt.ty) / d + padWorld;
  return {
    minX: Math.min(minX, maxX),
    maxX: Math.max(minX, maxX),
    minY: Math.min(minY, maxY),
    maxY: Math.max(minY, maxY)
  };
}

function renderChildSafe(child, renderer) {
  if (!child || !child.visible || !child.renderable || child.worldAlpha <= 0) return;
  child.render(renderer);
}

function attachTokenUiBatcher() {
  const objects = globalThis.canvas?.tokens?.objects;
  if (!objects || objects._blBatcherAttached) return;
  objects._blBatcherAttached = true;

  const visibleTokens = [];
  const complexTokens = [];
  const customChildren = [];

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
    // Small token counts don't need multi-pass batching overhead
    if (count < 4) return wrapped(renderer);

    const vp = PERF_CONFIG.perfAutoCulling ? getStageViewportWorldRect(260) : null;
    visibleTokens.length = 0;
    complexTokens.length = 0;
    customChildren.length = 0;

    for (let i = 0; i < count; i++) {
      const tok = kids[i];
      if (!tok || !tok.visible || !tok.renderable || tok.worldAlpha <= 0) continue;

      // Viewport frustum check (skip offscreen token UI entirely)
      if (vp && !tok.controlled && !tok.hover && !tok.isPreview) {
        const tx = tok.x ?? tok.document?.x ?? 0;
        const ty = tok.y ?? tok.document?.y ?? 0;
        const tw = tok.w || 100;
        const th = tok.h || 100;
        if (tx + tw < vp.minX || tx > vp.maxX || ty + th < vp.minY || ty > vp.maxY) {
          perfStats.tokenCulledUi++;
          continue;
        }
      }

      // If token has custom filters/masks/cullable or isn't a standard Token shape, render normally
      if (tok._mask || (tok.filters && tok.filters.length) || tok.cullable || !tok.bars) {
        complexTokens.push(tok);
      } else {
        visibleTokens.push(tok);
      }
    }

    // Pass 0: complex/non-standard children
    for (let i = 0; i < complexTokens.length; i++) {
      complexTokens[i].render(renderer);
    }

    const n = visibleTokens.length;
    if (n === 0) return;

    // Pass 1: turnMarker
    for (let i = 0; i < n; i++) renderChildSafe(visibleTokens[i].turnMarker, renderer);
    // Pass 2: border (selection / hover outline)
    for (let i = 0; i < n; i++) renderChildSafe(visibleTokens[i].border, renderer);
    // Pass 3: resource bars (batched bitmap sprites!)
    for (let i = 0; i < n; i++) renderChildSafe(visibleTokens[i].bars, renderer);
    // Pass 4: status effects (batched bitmap sprites!)
    for (let i = 0; i < n; i++) renderChildSafe(visibleTokens[i].effects, renderer);
    // Pass 5: target arrows & pips
    for (let i = 0; i < n; i++) {
      const t = visibleTokens[i];
      renderChildSafe(t.targetArrows, renderer);
      renderChildSafe(t.targetPips, renderer);
    }
    // Pass 6: nameplates (text sprites batch together!)
    for (let i = 0; i < n; i++) renderChildSafe(visibleTokens[i].nameplate, renderer);
    // Pass 7: elevation tooltips
    for (let i = 0; i < n; i++) renderChildSafe(visibleTokens[i].tooltip, renderer);

    // Pass 8: any third-party module children attached to Token containers (preserve full compatibility)
    for (let i = 0; i < n; i++) {
      const t = visibleTokens[i];
      const tKids = t.children;
      for (let j = 0; j < tKids.length; j++) {
        const c = tKids[j];
        if (
          c === t.turnMarker ||
          c === t.border ||
          c === t.bars ||
          c === t.effects ||
          c === t.targetArrows ||
          c === t.targetPips ||
          c === t.nameplate ||
          c === t.tooltip
        ) {
          continue;
        }
        renderChildSafe(c, renderer);
      }
    }

    perfStats.tokenBatchedFrames++;
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
  const okBars = wrapFoundryMethod("Token", "drawBars", function (wrapped, ...args) {
    if (this.bars) this.bars.cacheAsBitmap = false;
    const res = wrapped(...args);
    if (
      PERF_CONFIG.perfEnabled &&
      PERF_CONFIG.perfTokenUiCache &&
      !isPrimePerfActive() &&
      this.bars &&
      !this.bars.destroyed &&
      !this.isPreview &&
      this.bars.visible &&
      (this.bars.bar1?.visible || this.bars.bar2?.visible)
    ) {
      this.bars.cacheAsBitmapResolution = getBitmapCacheResolution();
      this.bars.cacheAsBitmap = true;
      perfStats.tokenBarsCached++;
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
      this.effects.children?.length > 1
    ) {
      this.effects.cacheAsBitmapResolution = getBitmapCacheResolution();
      this.effects.cacheAsBitmap = true;
      perfStats.tokenEffectsCached++;
    }
    return res;
  }, { type: "WRAPPER" });

  return [Boolean(okBars), Boolean(okDrawFx), Boolean(okRefFx)];
}

export function clearTokenUiBitmapCaches() {
  const placeables = globalThis.canvas?.tokens?.placeables;
  if (!placeables) return;
  for (const tok of placeables) {
    if (tok.bars) tok.bars.cacheAsBitmap = false;
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

  let out = src;
  let modified = false;

  // Match Foundry's AbstractBaseShader.NOISE block
  const noiseRe = /float\s+noise\s*\(\s*in\s+vec2\s+uv\s*\)\s*\{[\s\S]*?return\s+mix\s*\([\s\S]*?\);\s*\}/;
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
    // Inject uniform right after precision declaration or at top of shader
    const precRe = /(precision\s+\w+\s+float\s*;)/;
    if (precRe.test(out)) {
      out = out.replace(precRe, "$1\nuniform sampler2D uBoundlessNoise;");
    } else {
      out = `uniform sampler2D uBoundlessNoise;\n${out}`;
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

  // Inject uBoundlessNoise uniform when AdaptiveLightingShader.create instantiates a rewritten program
  wrapTargetMethod(Adaptive, "create", "AdaptiveLightingShader.create", function (wrapped, uniforms = {}, options = {}) {
    const shader = wrapped(uniforms, options);
    if (
      PERF_CONFIG.perfEnabled &&
      PERF_CONFIG.perfLightShaders &&
      !isPrimePerfActive() &&
      shader?.program?.fragmentSrc?.includes("uBoundlessNoise")
    ) {
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

export function applyLightingRenderScale() {
  if (isPrimePerfActive()) return;
  const effects = globalThis.canvas?.effects;
  const baseRes = globalThis.canvas?.app?.renderer?.resolution || 1;
  if (!effects) return;

  const mode = PERF_CONFIG.perfEnabled ? PERF_CONFIG.perfLightingScale : "full";
  const perfMode = globalThis.canvas?.performance?.mode ?? 2;
  const preset = resolveLightingScalePreset(mode, perfMode);

  for (const [layerKey, mult] of Object.entries(preset)) {
    const layer = effects[layerKey];
    const filter = layer?.filter;
    if (!filter) continue;
    const targetRes = Math.max(0.25, Math.min(baseRes, Number((baseRes * mult).toFixed(3))));
    if (Math.abs((filter.resolution || baseRes) - targetRes) > 0.01) {
      filter.resolution = targetRes;
    }
  }
}

export function applyDisableUiBlur() {
  if (typeof document === "undefined" || !document.body) return;
  const active = Boolean(PERF_CONFIG.perfEnabled && PERF_CONFIG.perfDisableUiBlur);
  document.body.classList.toggle("boundless-no-blur", active);
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
    patchTokenUiCaching();
    patchAnimatedLightShaders();
  }

  Hooks.on("canvasReady", () => {
    if (!isPrimePerfActive()) {
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

export function refreshGpuPerfSettings() {
  applyDisableUiBlur();
  if (isPrimePerfActive()) return;
  applyLightingRenderScale();
  if (!PERF_CONFIG.perfEnabled || !PERF_CONFIG.perfTokenUiCache) {
    clearTokenUiBitmapCaches();
  }
  // Re-render walls if currently active so toggle takes effect immediately
  const walls = globalThis.canvas?.walls?.placeables;
  if (walls?.length) {
    for (const w of walls) {
      w.renderFlags?.set?.({ refreshLine: true, refreshEndpoints: true });
    }
  }
}
