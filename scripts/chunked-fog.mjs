import { MODULE_ID } from "./utils.mjs";

const SOCKET_NAME = `module.${MODULE_ID}`;
const CHUNK_WORLD_PX = 5000; // 50x50 cells per chunk (20x20 grid on 1000x1000 world)
const CHUNK_TEX_PX = 256;    // ~5.12 px per cell -> 12.5x sharper than Foundry's 4096px global fog limit
const FOG_STORAGE_PREFIX = "boundless.fog";
const FOG_SAVE_DEBOUNCE_MS = 2200;
const BRUSH_SOCKET_FLUSH_MS = 75;
const BRUSH_MIN_RADIUS_PX = 100;
const BRUSH_MAX_RADIUS_PX = 6000;
const DEFAULT_BRUSH_RADIUS_PX = 600;

function getFogModes() {
  return globalThis.CONST?.FOG_EXPLORATION_MODES || { DISABLED: 0, INDIVIDUAL: 1, SHARED: 2 };
}

function getSceneFogMode(scene) {
  const modes = getFogModes();
  const mode = scene?.fog?.mode;
  if (typeof mode === "number") return mode;
  return scene?.fog?.exploration ? modes.INDIVIDUAL : modes.DISABLED;
}

function encodeCanvas(canvasEl) {
  let url = canvasEl.toDataURL("image/webp", 0.8);
  if (!url.startsWith("data:image/webp")) {
    url = canvasEl.toDataURL("image/png");
  }
  return url;
}

function isCanvasEmpty(ctx) {
  const data = ctx.getImageData(0, 0, CHUNK_TEX_PX, CHUNK_TEX_PX).data;
  for (let i = 3; i < data.length; i += 4) {
    if (data[i] !== 0) return false;
  }
  return true;
}

function cloneCanvas(srcCanvas) {
  const copy = document.createElement("canvas");
  copy.width = CHUNK_TEX_PX;
  copy.height = CHUNK_TEX_PX;
  const ctx = copy.getContext("2d", { alpha: true });
  ctx.drawImage(srcCanvas, 0, 0);
  return { canvas: copy, ctx };
}

export class ChunkedFogManager {
  enabled = false;
  mode = 0; // CONST.FOG_EXPLORATION_MODES
  sceneId = null;
  levelId = null;
  container = null;

  // "cx_cy" -> { key, cx, cy, canvas, ctx, sharedCanvas, sharedCtx, hasPrivate, texture, sprite }
  chunks = new Map();

  _saveTimer = null;
  _localCacheTimer = null;
  _storageKey = null;
  _dirtyShared = new Set();
  _dirtyPrivate = new Set();
  _lastPolySigs = new Map();
  _savingSharedByLevel = new Map();
  _savingServer = false;
  _fogGen = 0;
  _chunkLoadSeq = new Map();
  _pendingChunkLoads = new Map();
  _remoteRevealQueues = new Map();
  _lastHandledResetAt = 0;
  _seenBrushIds = new Set();

  // Saved native hooks/methods for clean unmount restoration
  _patches = null;

  // GM Fog Brush state
  brushActive = false;
  brushRadiusPx = DEFAULT_BRUSH_RADIUS_PX;
  _brushPreview = null;
  _brushDragging = false;
  _brushErase = false;
  _brushLastWorld = null;
  _brushPendingStrokes = [];
  _brushFlushTimer = null;
  _brushListeners = null;

  _buildStorageKey(sceneId, levelId, scope) {
    const worldId = game.world?.id || "world";
    const userId = scope === "shared" ? "shared" : (game.user?.id || "user");
    return `${FOG_STORAGE_PREFIX}.v2.${worldId}.${sceneId}.${levelId || "default"}.${userId}`;
  }

  _shouldEnable(scene) {
    if (!scene?.tokenVision || !canvas?.visibility?.explored) return false;
    const cfg = scene.flags?.[MODULE_ID] || {};
    if (cfg.chunkedFog === false) return false;
    const mode = getSceneFogMode(scene);
    return mode > getFogModes().DISABLED;
  }

  get isSharedMode() {
    return this.mode === getFogModes().SHARED;
  }

  mount(scene) {
    this.unmount();
    if (!this._shouldEnable(scene)) {
      this._refreshControlsUI();
      return;
    }

    this.enabled = true;
    this._fogGen++;
    this._chunkLoadSeq.clear();
    this._pendingChunkLoads.clear();
    this.mode = getSceneFogMode(scene);
    this.sceneId = scene.id;
    this.levelId = canvas.level?.id || "default";
    this._lastHandledResetAt = Number(scene?.flags?.[MODULE_ID]?.fogResetAt?.[this.levelId]) || 0;
    this._seenBrushIds.clear();
    const initBrushId = scene?.flags?.[MODULE_ID]?.fogBrush?.id;
    if (initBrushId) this._markBrushSeen(initBrushId);
    this._storageKey = this._buildStorageKey(
      this.sceneId,
      this.levelId,
      this.isSharedMode && !game.user?.isGM ? "shared" : "private"
    );

    this.container = new PIXI.Container();
    this.container.name = "BoundlessChunkedFog";
    this.container.eventMode = "none";
    canvas.visibility.explored.addChildAt(this.container, 0);

    this._installNativePatches();
    this._loadPersistedFog(scene);
    this.updateViewportCulling();
    this.revealFromActiveVision({ broadcast: this.isSharedMode && !game.user?.isGM });
    this._refreshControlsUI();
  }

  _incSavingShared(levelId) {
    if (!levelId) return;
    this._savingSharedByLevel.set(levelId, (this._savingSharedByLevel.get(levelId) || 0) + 1);
  }

  _decSavingShared(levelId) {
    if (!levelId) return;
    const next = (this._savingSharedByLevel.get(levelId) || 1) - 1;
    if (next <= 0) this._savingSharedByLevel.delete(levelId);
    else this._savingSharedByLevel.set(levelId, next);
  }

  _isSavingShared(levelId) {
    return Boolean(levelId && (this._savingSharedByLevel.get(levelId) || 0) > 0);
  }

  _refreshControlsUI() {
    try {
      if (ui?.controls?.rendered) ui.controls.render({ reset: true });
    } catch {}
  }

  _hideCoreFogSprite() {
    const sprite = canvas?.fog?.sprite;
    if (sprite && !sprite.destroyed) {
      sprite.visible = false;
    }
  }

  _installNativePatches() {
    if (this._patches || !canvas?.fog || !canvas?.visibility) return;

    const fog = canvas.fog;
    const vis = canvas.visibility;
    const origSpriteVisible = fog.sprite?.visible ?? true;
    const records = [];
    const patchMethod = (target, prop, makeWrapped) => {
      if (!target || typeof target[prop] !== "function") return;
      const hadOwn = Object.prototype.hasOwnProperty.call(target, prop);
      const orig = target[prop];
      const wrapped = makeWrapped(orig);
      target[prop] = wrapped;
      records.push({ target, prop, hadOwn, orig, wrapped });
    };

    this._hideCoreFogSprite();

    // Prevent Foundry from wasting GPU/CPU extracting a blurry 4096px global RenderTexture
    patchMethod(fog, "commit", (origCommit) => () => {
      if (!this.enabled) return origCommit.call(fog);
      this._hideCoreFogSprite();
      this.revealFromActiveVision();
    });

    patchMethod(fog, "save", (origSave) => async (options) => {
      if (!this.enabled) return origSave.call(fog, options);
      await this.saveNow();
    });

    patchMethod(fog, "isPointExplored", (origIsPointExplored) => (point) => {
      if (!this.enabled) return origIsPointExplored.call(fog, point);
      return this.isPointExplored(point);
    });

    patchMethod(fog, "reset", (origReset) => async () => {
      if (this.enabled) {
        await this.reset({ broadcast: true, persist: true });
      }
      return origReset.call(fog);
    });

    // Server-initiated fog reset broadcasts hit FogManager#_handleReset on all clients
    patchMethod(fog, "_handleReset", (origHandleReset) => async (...args) => {
      if (this.enabled) {
        await this.reset({ broadcast: false, persist: false });
      }
      return origHandleReset.apply(fog, args);
    });

    patchMethod(vis, "resetExploration", (origResetExploration) => (...args) => {
      const res = origResetExploration.apply(vis, args);
      if (this.enabled && this.container && !this.container.destroyed && vis.explored) {
        if (this.container.parent !== vis.explored) {
          vis.explored.addChildAt(this.container, 0);
        }
        this._hideCoreFogSprite();
      }
      return res;
    });

    this._patches = { fog, origSpriteVisible, records };
  }

  _removeNativePatches() {
    if (!this._patches) return;
    const { fog, origSpriteVisible, records } = this._patches;

    try {
      for (const { target, prop, hadOwn, orig, wrapped } of records) {
        if (target[prop] === wrapped) {
          if (hadOwn) target[prop] = orig;
          else delete target[prop];
        }
      }
      if (fog.sprite && !fog.sprite.destroyed) {
        fog.sprite.visible = origSpriteVisible;
      }
    } catch {}
    this._patches = null;
  }

  _getOrCreateChunk(cx, cy) {
    const key = `${cx}_${cy}`;
    let entry = this.chunks.get(key);
    if (entry) return entry;

    const c = document.createElement("canvas");
    c.width = CHUNK_TEX_PX;
    c.height = CHUNK_TEX_PX;
    const ctx = c.getContext("2d", { alpha: true, willReadFrequently: true });
    ctx.clearRect(0, 0, CHUNK_TEX_PX, CHUNK_TEX_PX);

    const texture = PIXI.Texture.from(c, {
      mipmap: PIXI.MIPMAP_MODES.OFF,
      scaleMode: PIXI.SCALE_MODES.LINEAR,
      wrapMode: PIXI.WRAP_MODES.CLAMP
    });

    const sprite = new PIXI.Sprite(texture);
    sprite.position.set(cx * CHUNK_WORLD_PX, cy * CHUNK_WORLD_PX);
    sprite.width = CHUNK_WORLD_PX;
    sprite.height = CHUNK_WORLD_PX;
    sprite.tint = 0xFF0000; // Foundry VisibilityFilter reads red channel as explored mask
    sprite.eventMode = "none";
    this.container?.addChild(sprite);

    entry = {
      key,
      cx,
      cy,
      canvas: c,
      ctx,
      sharedCanvas: null, // Copy-on-write shared buffer for GM in SHARED mode when private exploration diverges
      sharedCtx: null,
      privateCanvas: null, // Dedicated GM-private layer so shared resets/replaces can cleanly recomposite
      privateCtx: null,
      hasPrivate: false,
      encodedUrl: null,
      texture,
      sprite
    };
    this.chunks.set(key, entry);
    return entry;
  }

  _ensureSharedCopy(chunk) {
    if (chunk.sharedCanvas) return;
    const cloned = cloneCanvas(chunk.canvas);
    chunk.sharedCanvas = cloned.canvas;
    chunk.sharedCtx = cloned.ctx;
    chunk.hasPrivate = true;
  }

  _ensurePrivateCopy(chunk) {
    this._ensureSharedCopy(chunk);
    if (chunk.privateCanvas) return;
    const pCanvas = document.createElement("canvas");
    pCanvas.width = CHUNK_TEX_PX;
    pCanvas.height = CHUNK_TEX_PX;
    const pCtx = pCanvas.getContext("2d", { alpha: true, willReadFrequently: true });
    pCtx.clearRect(0, 0, CHUNK_TEX_PX, CHUNK_TEX_PX);
    chunk.privateCanvas = pCanvas;
    chunk.privateCtx = pCtx;
    chunk.hasPrivate = true;
  }

  _recompositeChunk(chunk) {
    if (!chunk?.ctx || !chunk.sharedCanvas) return;
    chunk.ctx.clearRect(0, 0, CHUNK_TEX_PX, CHUNK_TEX_PX);
    chunk.ctx.drawImage(chunk.sharedCanvas, 0, 0);
    if (chunk.privateCanvas) {
      chunk.ctx.drawImage(chunk.privateCanvas, 0, 0);
    }
  }

  _drawPolygonToCtx(ctx, pts, ox, oy) {
    const scale = CHUNK_TEX_PX / CHUNK_WORLD_PX;
    ctx.save();
    ctx.globalCompositeOperation = "source-over";
    ctx.fillStyle = "#ffffff";
    ctx.beginPath();
    ctx.moveTo((pts[0] - ox) * scale, (pts[1] - oy) * scale);
    for (let i = 2; i < pts.length; i += 2) {
      ctx.lineTo((pts[i] - ox) * scale, (pts[i + 1] - oy) * scale);
    }
    ctx.closePath();
    ctx.fill();
    ctx.restore();
  }

  _drawCircleToCtx(ctx, x, y, radiusPx, ox, oy, erase) {
    const scale = CHUNK_TEX_PX / CHUNK_WORLD_PX;
    const cx = (x - ox) * scale;
    const cy = (y - oy) * scale;
    const r = Math.max(1.5, radiusPx * scale);
    ctx.save();
    ctx.globalCompositeOperation = erase ? "destination-out" : "source-over";
    ctx.fillStyle = "#ffffff";
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }

  _applyPolygons(polygons, { target = "shared", markDirty = true, maxChunks = Infinity } = {}) {
    if (!this.enabled || !this.container || !Array.isArray(polygons) || !polygons.length) return false;
    const touched = new Set();
    const scene = game.scenes?.get?.(this.sceneId) ?? (canvas?.scene?.id === this.sceneId ? canvas.scene : null);
    const pad = Math.max(0, Number(scene?.padding) || 0);
    const totalW = Number(canvas?.dimensions?.width) || Number(scene?.dimensions?.width) || ((scene?.width || 100000) * (1 + pad * 2));
    const totalH = Number(canvas?.dimensions?.height) || Number(scene?.dimensions?.height) || ((scene?.height || 100000) * (1 + pad * 2));
    const maxCx = Math.max(0, Math.ceil(totalW / CHUNK_WORLD_PX));
    const maxCy = Math.max(0, Math.ceil(totalH / CHUNK_WORLD_PX));

    const polyCap = Math.min(polygons.length, 256);
    for (let pi = 0; pi < polyCap; pi++) {
      const pts = polygons[pi];
      if (!Array.isArray(pts) || pts.length < 6 || pts.length > 4096) continue;
      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      let valid = true;
      for (let i = 0; i < pts.length; i += 2) {
        const px = pts[i], py = pts[i + 1];
        if (!Number.isFinite(px) || !Number.isFinite(py)) { valid = false; break; }
        if (px < minX) minX = px;
        if (px > maxX) maxX = px;
        if (py < minY) minY = py;
        if (py > maxY) maxY = py;
      }
      if (!valid || !Number.isFinite(minX)) continue;

      const rawCx0 = Math.floor(minX / CHUNK_WORLD_PX);
      const rawCy0 = Math.floor(minY / CHUNK_WORLD_PX);
      const rawCx1 = Math.floor(maxX / CHUNK_WORLD_PX);
      const rawCy1 = Math.floor(maxY / CHUNK_WORLD_PX);
      if (rawCx1 < 0 || rawCy1 < 0 || rawCx0 > maxCx || rawCy0 > maxCy) continue;
      const cx0 = Math.max(0, Math.min(maxCx, rawCx0));
      const cy0 = Math.max(0, Math.min(maxCy, rawCy0));
      const cx1 = Math.max(0, Math.min(maxCx, rawCx1));
      const cy1 = Math.max(0, Math.min(maxCy, rawCy1));

      let hitCap = false;
      for (let cy = cy0; cy <= cy1 && !hitCap; cy++) {
        for (let cx = cx0; cx <= cx1; cx++) {
          const ck = `${cx}_${cy}`;
          const existingChunk = this.chunks.get(ck);
          if ((!existingChunk || !touched.has(existingChunk)) && touched.size >= maxChunks) {
            hitCap = true;
            break;
          }
          const chunk = existingChunk || this._getOrCreateChunk(cx, cy);
          const ox = cx * CHUNK_WORLD_PX;
          const oy = cy * CHUNK_WORLD_PX;

          if (this.isSharedMode && game.user?.isGM && target === "private") {
            // Keep GM-only exploration out of sharedCanvas so players never inherit GM-only peeks
            this._ensurePrivateCopy(chunk);
            this._drawPolygonToCtx(chunk.privateCtx, pts, ox, oy);
            this._drawPolygonToCtx(chunk.ctx, pts, ox, oy);
            if (markDirty) this._dirtyPrivate.add(chunk.key);
          } else {
            this._drawPolygonToCtx(chunk.ctx, pts, ox, oy);
            if (chunk.sharedCtx) {
              this._drawPolygonToCtx(chunk.sharedCtx, pts, ox, oy);
            }
            if (markDirty) {
              if (this.isSharedMode) this._dirtyShared.add(chunk.key);
              else this._dirtyPrivate.add(chunk.key);
            }
          }
          touched.add(chunk);
        }
      }
    }

    if (touched.size > 0) {
      for (const chunk of touched) {
        chunk.encodedUrl = null;
        chunk.texture.baseTexture.update();
      }
      this.updateViewportCulling();
      if (markDirty || this._dirtyPrivate.size > 0) this._scheduleSave();
      return true;
    }
    return false;
  }

  _applyBrushStrokes(strokes, { markDirty = true } = {}) {
    if (!this.enabled || !this.container || !Array.isArray(strokes) || !strokes.length) return false;
    const touched = new Set();
    const scene = game.scenes?.get?.(this.sceneId) ?? (canvas?.scene?.id === this.sceneId ? canvas.scene : null);
    const pad = Math.max(0, Number(scene?.padding) || 0);
    const totalW = Number(canvas?.dimensions?.width) || Number(scene?.dimensions?.width) || ((scene?.width || 100000) * (1 + pad * 2));
    const totalH = Number(canvas?.dimensions?.height) || Number(scene?.dimensions?.height) || ((scene?.height || 100000) * (1 + pad * 2));
    const maxCx = Math.max(0, Math.ceil(totalW / CHUNK_WORLD_PX));
    const maxCy = Math.max(0, Math.ceil(totalH / CHUNK_WORLD_PX));

    for (const stroke of strokes) {
      if (!Array.isArray(stroke)) continue;
      const [x, y, rawRadiusPx, erase] = stroke;
      if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(rawRadiusPx)) continue;
      const radiusPx = Math.max(1, Math.min(BRUSH_MAX_RADIUS_PX * 2, rawRadiusPx));
      const rawCx0 = Math.floor((x - radiusPx) / CHUNK_WORLD_PX);
      const rawCy0 = Math.floor((y - radiusPx) / CHUNK_WORLD_PX);
      const rawCx1 = Math.floor((x + radiusPx) / CHUNK_WORLD_PX);
      const rawCy1 = Math.floor((y + radiusPx) / CHUNK_WORLD_PX);
      if (rawCx1 < 0 || rawCy1 < 0 || rawCx0 > maxCx || rawCy0 > maxCy) continue;
      const cx0 = Math.max(0, Math.min(maxCx, rawCx0));
      const cy0 = Math.max(0, Math.min(maxCy, rawCy0));
      const cx1 = Math.max(0, Math.min(maxCx, rawCx1));
      const cy1 = Math.max(0, Math.min(maxCy, rawCy1));

      for (let cy = cy0; cy <= cy1; cy++) {
        for (let cx = cx0; cx <= cx1; cx++) {
          const key = `${cx}_${cy}`;
          // Do not create brand-new empty chunks when erasing unexplored void
          if (erase && !this.chunks.has(key)) continue;
          const chunk = this._getOrCreateChunk(cx, cy);
          const ox = cx * CHUNK_WORLD_PX;
          const oy = cy * CHUNK_WORLD_PX;

          this._drawCircleToCtx(chunk.ctx, x, y, radiusPx, ox, oy, Boolean(erase));
          if (chunk.sharedCtx) {
            this._drawCircleToCtx(chunk.sharedCtx, x, y, radiusPx, ox, oy, Boolean(erase));
          }
          // In SHARED mode, only erase strokes touch GM's privateCanvas; shared reveal strokes stay strictly in sharedCanvas
          if (chunk.privateCtx && (erase || !this.isSharedMode)) {
            this._drawCircleToCtx(chunk.privateCtx, x, y, radiusPx, ox, oy, Boolean(erase));
          }
          touched.add(chunk);
          if (markDirty) {
            if (this.isSharedMode) {
              this._dirtyShared.add(chunk.key);
              if (erase && chunk.hasPrivate) this._dirtyPrivate.add(chunk.key);
            } else {
              this._dirtyPrivate.add(chunk.key);
            }
          } else if (erase && this.isSharedMode && game.user?.isGM && chunk.hasPrivate) {
            // Another GM erased fog across a chunk where this GM holds personal private fog: persist the private erase
            this._dirtyPrivate.add(chunk.key);
          }
        }
      }
    }

    if (touched.size > 0) {
      for (const chunk of touched) {
        chunk.encodedUrl = null;
        chunk.texture.baseTexture.update();
      }
      this.updateViewportCulling();
      if (markDirty || this._dirtyPrivate.size > 0) this._scheduleSave();
      return true;
    }
    return false;
  }

  _polygonSignature(pts) {
    const n = pts.length;
    const mid = (n >> 1) & ~1;
    const q1 = (n >> 2) & ~1;
    const q3 = ((n * 3) >> 2) & ~1;
    return `${n}:${Math.round(pts[0] / 12)},${Math.round(pts[1] / 12)}:${Math.round(pts[q1] / 12)},${Math.round(pts[q1 + 1] / 12)}:${Math.round(pts[mid] / 12)},${Math.round(pts[mid + 1] / 12)}:${Math.round(pts[q3] / 12)},${Math.round(pts[q3 + 1] / 12)}`;
  }

  revealFromActiveVision({ broadcast = true } = {}) {
    if (!this.enabled || !this.container || !canvas?.effects?.visionSources?.size) return;

    const skipBulkGmPrivate = Boolean(game.user?.isGM && (canvas.tokens?.controlled?.length || 0) > 6);
    const sharedPolys = [];
    const privatePolys = [];

    for (const vs of canvas.effects.visionSources) {
      if (!vs?.active) continue;
      if (skipBulkGmPrivate && !vs.object?.document?.hasPlayerOwner) continue;
      const poly = vs.los || vs.shape;
      const pts = poly?.points;
      if (!pts || pts.length < 6) continue;

      const sid = vs.sourceId || vs.object?.id || "v";
      const sig = this._polygonSignature(pts);
      if (this._lastPolySigs.get(sid) === sig) continue;
      this._lastPolySigs.set(sid, sig);

      // Compact integer array for minimal socket payload
      const rounded = new Array(pts.length);
      for (let i = 0; i < pts.length; i++) rounded[i] = Math.round(pts[i]);

      if (this.isSharedMode) {
        // Native v14 SHARED semantics: player vision & player-owned tokens contribute to party shared fog;
        // GM-only tokens stay in GM private exploration
        const isPlayerOwned = !game.user?.isGM || Boolean(vs.object?.document?.hasPlayerOwner);
        if (isPlayerOwned) sharedPolys.push(rounded);
        else privatePolys.push(rounded);
      } else {
        privatePolys.push(rounded);
      }
    }

    if (sharedPolys.length) {
      this._applyPolygons(sharedPolys, { target: "shared", markDirty: true });
      if (broadcast && this.isSharedMode) {
        game.socket?.emit(SOCKET_NAME, {
          type: "fogReveal",
          sceneId: this.sceneId,
          levelId: this.levelId,
          senderId: game.user?.id,
          polygons: sharedPolys
        });
      }
    }

    if (privatePolys.length) {
      this._applyPolygons(privatePolys, { target: "private", markDirty: true });
    }
  }

  isPointExplored(point) {
    if (!point || !Number.isFinite(point.x) || !Number.isFinite(point.y)) return false;
    if (!canvas?.scene?.tokenVision) return true;
    if (!this.enabled) return false;

    const cx = Math.floor(point.x / CHUNK_WORLD_PX);
    const cy = Math.floor(point.y / CHUNK_WORLD_PX);
    const chunk = this.chunks.get(`${cx}_${cy}`);
    if (!chunk) return false;

    const scale = CHUNK_TEX_PX / CHUNK_WORLD_PX;
    const px = Math.floor((point.x - cx * CHUNK_WORLD_PX) * scale);
    const py = Math.floor((point.y - cy * CHUNK_WORLD_PX) * scale);
    const x0 = Math.max(0, px - 1);
    const y0 = Math.max(0, py - 1);
    const w = Math.min(CHUNK_TEX_PX - x0, px + 2 - x0);
    const h = Math.min(CHUNK_TEX_PX - y0, py + 2 - y0);
    if (w <= 0 || h <= 0) return false;

    const pixels = chunk.ctx.getImageData(x0, y0, w, h).data;
    for (let i = 3; i < pixels.length; i += 4) {
      if (pixels[i] > 16) return true;
    }
    return false;
  }

  updateViewportCulling(vp = null) {
    if (!this.enabled || !this.chunks.size) return;
    if (!vp) {
      const scale = canvas.stage?.scale?.x || 1;
      const pivot = canvas.stage?.pivot;
      const [sw, sh] = canvas.screenDimensions || [1920, 1080];
      if (!pivot) return;
      const w = (sw / scale) * 0.65;
      const h = (sh / scale) * 0.65;
      vp = { x0: pivot.x - w, y0: pivot.y - h, x1: pivot.x + w, y1: pivot.y + h };
    }
    for (const chunk of this.chunks.values()) {
      const x0 = chunk.cx * CHUNK_WORLD_PX;
      const y0 = chunk.cy * CHUNK_WORLD_PX;
      chunk.sprite.visible = !(x0 + CHUNK_WORLD_PX < vp.x0 || x0 > vp.x1 || y0 + CHUNK_WORLD_PX < vp.y0 || y0 > vp.y1);
    }
  }

  // ===== Socket & Scene Flag Sync =====

  handleSocketMessage(payload) {
    if (!payload) return false;

    // On activeGM, persist SHARED-mode exploration sent from players on a different scene/level
    // even while the GM is currently viewing another level or scene.
    if (
      payload.type === "fogReveal" &&
      Array.isArray(payload.polygons) &&
      payload.sceneId &&
      (payload.sceneId !== this.sceneId || (payload.levelId && payload.levelId !== this.levelId))
    ) {
      if (game.users?.activeGM?.id === game.user?.id) {
        this._persistRemoteSharedReveal(payload).catch(() => {});
        return true;
      }
      return false;
    }

    if (!this.enabled) return false;
    if (payload.sceneId !== this.sceneId) return false;
    if (typeof payload.levelId !== "string" || payload.levelId !== this.levelId) return false;

    if (payload.type === "fogReveal") {
      if (!this.isSharedMode || !Array.isArray(payload.polygons)) return true;
      // Only activeGM needs to mark shared chunks dirty for DB persistence
      const isAuthoritativeGM = game.users?.activeGM?.id === game.user?.id;
      const cappedPolys = payload.polygons.length > 64 ? payload.polygons.slice(0, 64) : payload.polygons;
      this._applyPolygons(cappedPolys, { target: "shared", markDirty: isAuthoritativeGM, maxChunks: 64 });
      return true;
    }

    // Never trust client-spoofable socket messages for GM-only fogBrush or fogReset;
    // those propagate strictly via server-authorized Scene document flags (`onSceneFogBrushChanged` / `onSceneFogResetChanged`).
    if (payload.type === "fogBrush" || payload.type === "fogReset") {
      return true;
    }

    return false;
  }

  _persistRemoteSharedReveal(payload) {
    const sceneId = payload?.sceneId;
    if (!sceneId || !Array.isArray(payload.polygons) || !payload.polygons.length) return Promise.resolve();
    const targetScene = game.scenes?.get?.(sceneId);
    if (
      !targetScene ||
      !targetScene.tokenVision ||
      targetScene.flags?.[MODULE_ID]?.chunkedFog === false ||
      getSceneFogMode(targetScene) !== getFogModes().SHARED
    ) return Promise.resolve();
    let targetLevelId;
    if (payload.levelId != null) {
      if (
        typeof payload.levelId !== "string" ||
        !payload.levelId ||
        payload.levelId.startsWith("-=") ||
        !/^[A-Za-z0-9_-]+$/.test(payload.levelId)
      ) return Promise.resolve();
      if (targetScene.levels?.size) {
        if (!targetScene.levels.has(payload.levelId)) return Promise.resolve();
      } else if (payload.levelId !== "default") {
        return Promise.resolve();
      }
      targetLevelId = payload.levelId;
    } else {
      targetLevelId = targetScene.initialLevel?.id || "default";
    }
    const queueKey = `${sceneId}::${targetLevelId}`;

    let q = this._remoteRevealQueues.get(queueKey);
    if (!q) {
      q = { polygons: [], running: null };
      this._remoteRevealQueues.set(queueKey, q);
    }
    for (const pts of payload.polygons) {
      if (q.polygons.length >= 512) break;
      if (Array.isArray(pts) && pts.length >= 6) q.polygons.push(pts);
    }
    if (!q.running) {
      const run = async () => {
        try {
          await this._drainRemoteSharedRevealQueue(queueKey, sceneId, targetLevelId);
        } catch (err) {
          console.warn(`${MODULE_ID} | Failed to persist remote shared fog reveal:`, err);
        } finally {
          const cur = this._remoteRevealQueues.get(queueKey);
          if (cur) {
            cur.running = null;
            if (!cur.polygons.length) {
              this._remoteRevealQueues.delete(queueKey);
            } else {
              cur.running = run();
            }
          }
        }
      };
      q.running = run();
    }
    return q.running;
  }

  async _drainRemoteSharedRevealQueue(queueKey, sceneId, targetLevelId) {
    const MAX_REMOTE_CHUNKS_PER_BATCH = 64;
    while (true) {
      const q = this._remoteRevealQueues.get(queueKey);
      if (!q || !q.polygons.length) break;
      const batchPolys = q.polygons.splice(0, 64);

      const targetScene = game.scenes?.get?.(sceneId);
      if (
        !targetScene ||
        !targetScene.tokenVision ||
        targetScene.flags?.[MODULE_ID]?.chunkedFog === false ||
        getSceneFogMode(targetScene) !== getFogModes().SHARED
      ) break;
      const resetAtBefore = Number(targetScene.flags?.[MODULE_ID]?.fogResetAt?.[targetLevelId]) || 0;
      // If activeGM switched to this exact (sceneId, targetLevelId), apply locally instead of racing with stale flags
      if (this.enabled && this.sceneId === sceneId && this.levelId === targetLevelId) {
        this._applyPolygons(batchPolys.slice(0, 64), { target: "shared", markDirty: true, maxChunks: MAX_REMOTE_CHUNKS_PER_BATCH });
        continue;
      }
      const existingMap = targetScene.flags?.[MODULE_ID]?.sharedFog?.[targetLevelId] || {};
      const pad = Math.max(0, Number(targetScene.padding) || 0);
      const totalW = Number(targetScene.dimensions?.width) || ((targetScene.width || 100000) * (1 + pad * 2));
      const totalH = Number(targetScene.dimensions?.height) || ((targetScene.height || 100000) * (1 + pad * 2));
      const maxCx = Math.max(0, Math.ceil(totalW / CHUNK_WORLD_PX));
      const maxCy = Math.max(0, Math.ceil(totalH / CHUNK_WORLD_PX));

      const polysByChunk = new Map();
      const polyLim = Math.min(batchPolys.length, 64);
      for (let pi = 0; pi < polyLim; pi++) {
        const pts = batchPolys[pi];
        if (!Array.isArray(pts) || pts.length < 6 || pts.length > 4096) continue;
        let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
        let valid = true;
        for (let i = 0; i < pts.length; i += 2) {
          const px = pts[i], py = pts[i + 1];
          if (!Number.isFinite(px) || !Number.isFinite(py)) { valid = false; break; }
          if (px < minX) minX = px;
          if (px > maxX) maxX = px;
          if (py < minY) minY = py;
          if (py > maxY) maxY = py;
        }
        if (!valid || !Number.isFinite(minX)) continue;
        const rawCx0 = Math.floor(minX / CHUNK_WORLD_PX);
        const rawCy0 = Math.floor(minY / CHUNK_WORLD_PX);
        const rawCx1 = Math.floor(maxX / CHUNK_WORLD_PX);
        const rawCy1 = Math.floor(maxY / CHUNK_WORLD_PX);
        if (rawCx1 < 0 || rawCy1 < 0 || rawCx0 > maxCx || rawCy0 > maxCy) continue;
        const cx0 = Math.max(0, Math.min(maxCx, rawCx0));
        const cy0 = Math.max(0, Math.min(maxCy, rawCy0));
        const cx1 = Math.max(0, Math.min(maxCx, rawCx1));
        const cy1 = Math.max(0, Math.min(maxCy, rawCy1));
        let hitCap = false;
        for (let cy = cy0; cy <= cy1 && !hitCap; cy++) {
          for (let cx = cx0; cx <= cx1; cx++) {
            const ck = `${cx}_${cy}`;
            if (!polysByChunk.has(ck) && polysByChunk.size >= MAX_REMOTE_CHUNKS_PER_BATCH) {
              hitCap = true;
              break;
            }
            let arr = polysByChunk.get(ck);
            if (!arr) { arr = []; polysByChunk.set(ck, arr); }
            arr.push(pts);
          }
        }
      }
      if (!polysByChunk.size) continue;

      const scale = CHUNK_TEX_PX / CHUNK_WORLD_PX;
      const update = {};
      let aborted = false;
      for (const [ck, polys] of polysByChunk) {
        const [cx, cy] = ck.split("_").map(Number);
        const c = document.createElement("canvas");
        c.width = CHUNK_TEX_PX;
        c.height = CHUNK_TEX_PX;
        const ctx = c.getContext("2d", { alpha: true });
        const prevUrl = existingMap[ck];
        if (typeof prevUrl === "string" && prevUrl.startsWith("data:image/")) {
          await new Promise((resolve) => {
            const img = new Image();
            img.onload = () => { try { ctx.drawImage(img, 0, 0, CHUNK_TEX_PX, CHUNK_TEX_PX); } catch {} resolve(); };
            img.onerror = resolve;
            img.src = prevUrl;
          });
        }
        // Re-check reset & mode after async image decode so cleared fog can NEVER be resurrected
        const resetAtNow = Number(targetScene.flags?.[MODULE_ID]?.fogResetAt?.[targetLevelId]) || 0;
        if (resetAtNow > resetAtBefore || getSceneFogMode(targetScene) !== getFogModes().SHARED) {
          aborted = true;
          break;
        }
        const ox = cx * CHUNK_WORLD_PX;
        const oy = cy * CHUNK_WORLD_PX;
        ctx.save();
        ctx.fillStyle = "#ffffff";
        ctx.globalCompositeOperation = "source-over";
        for (const pts of polys) {
          ctx.beginPath();
          ctx.moveTo((pts[0] - ox) * scale, (pts[1] - oy) * scale);
          for (let i = 2; i < pts.length; i += 2) {
            ctx.lineTo((pts[i] - ox) * scale, (pts[i + 1] - oy) * scale);
          }
          ctx.closePath();
          ctx.fill();
        }
        ctx.restore();
        update[`flags.${MODULE_ID}.sharedFog.${targetLevelId}.${ck}`] = encodeCanvas(c);
      }
      if (aborted) break;
      // Final check: if GM switched to this level while decoding, route through live local chunks instead of clobbering
      if (this.enabled && this.sceneId === sceneId && this.levelId === targetLevelId) {
        this._applyPolygons(batchPolys.slice(0, 64), { target: "shared", markDirty: true, maxChunks: MAX_REMOTE_CHUNKS_PER_BATCH });
        continue;
      }
      if (Object.keys(update).length) {
        try {
          await targetScene.update(update);
        } catch (err) {
          console.warn(`${MODULE_ID} | Failed to update remote shared fog:`, err);
        }
      }
    }
  }

  onSceneFogFlagsChanged(scene, sharedFogChanges) {
    if (!this.enabled || !this.isSharedMode || this._isSavingShared(this.levelId)) return;
    if (sharedFogChanges === null) {
      this._clearAllSharedChunksLocal();
      return;
    }
    if (!sharedFogChanges || typeof sharedFogChanges !== "object") return;
    if (`-=${this.levelId}` in sharedFogChanges || sharedFogChanges[this.levelId] === null) {
      this._clearAllSharedChunksLocal();
      return;
    }
    const levelPatch = sharedFogChanges[this.levelId];
    if (!levelPatch || typeof levelPatch !== "object") return;
    this._mergeChunkMap(levelPatch, { intoShared: true, replace: true });
  }

  onSceneFogResetChanged(scene, fogResetAtChanges) {
    if (!this.enabled || !fogResetAtChanges || typeof fogResetAtChanges !== "object") return;
    const nextResetAt = Number(fogResetAtChanges[this.levelId]) || 0;
    if (nextResetAt > this._lastHandledResetAt) {
      this._lastHandledResetAt = nextResetAt;
      this.reset({ broadcast: false, persist: false });
    }
  }

  _markBrushSeen(id) {
    if (!id) return;
    this._seenBrushIds.add(id);
    while (this._seenBrushIds.size > 64) {
      const oldest = this._seenBrushIds.values().next().value;
      this._seenBrushIds.delete(oldest);
    }
  }

  onSceneFogBrushChanged(scene, brushPayload) {
    if (!this.enabled || !brushPayload || typeof brushPayload !== "object") return;
    if (!brushPayload.id || this._seenBrushIds.has(brushPayload.id)) return;
    this._markBrushSeen(brushPayload.id);
    const fullBrush = scene?.flags?.[MODULE_ID]?.fogBrush;
    const levelId = brushPayload.levelId ?? fullBrush?.levelId;
    const strokes = Array.isArray(brushPayload.strokes) ? brushPayload.strokes : fullBrush?.strokes;
    if (levelId && levelId !== this.levelId) return;
    if (!Array.isArray(strokes) || !strokes.length) return;
    const shouldPersist = !this.isSharedMode;
    this._applyBrushStrokes(strokes, { markDirty: shouldPersist });
    if (!shouldPersist) this._scheduleLocalCacheSave();
  }

  _clearAllSharedChunksLocal() {
    this._fogGen++;
    this._chunkLoadSeq.clear();
    this._pendingChunkLoads.clear();
    for (const [key, chunk] of Array.from(this.chunks.entries())) {
      if (chunk.hasPrivate && chunk.sharedCtx) {
        chunk.sharedCtx.clearRect(0, 0, CHUNK_TEX_PX, CHUNK_TEX_PX);
        this._recompositeChunk(chunk);
        chunk.encodedUrl = null;
        chunk.texture.baseTexture.update();
      } else {
        this._destroyChunkEntry(chunk);
        this.chunks.delete(key);
      }
    }
  }

  _destroyChunkEntry(chunk) {
    if (!chunk) return;
    try { chunk.sprite?.parent?.removeChild(chunk.sprite); } catch {}
    if (chunk.sprite && !chunk.sprite.destroyed) {
      try { chunk.sprite.destroy(); } catch {}
    }
    if (chunk.texture && !chunk.texture.destroyed) {
      try { chunk.texture.destroy(true); } catch {}
    }
  }

  // ===== Persistence (Server Flags + Fast Local Cache) =====

  _scheduleSave() {
    if (this._saveTimer !== null) clearTimeout(this._saveTimer);
    this._saveTimer = setTimeout(() => {
      this._saveTimer = null;
      this.saveNow();
    }, FOG_SAVE_DEBOUNCE_MS);
  }

  _scheduleLocalCacheSave(delayMs = 1500) {
    if (this._localCacheTimer !== null) return;
    this._localCacheTimer = setTimeout(() => {
      this._localCacheTimer = null;
      if (this.enabled) this._saveLocalCacheOnly();
    }, delayMs);
  }

  _saveLocalCacheOnly() {
    // In SHARED mode, authoritative fog lives in scene flags; never pollute private localStorage cache or waste quota
    if (this.isSharedMode || !this._storageKey || this._pendingChunkLoads.size > 0) return;
    try {
      const scene = game.scenes?.get?.(this.sceneId) ?? (canvas?.scene?.id === this.sceneId ? canvas.scene : null);
      const resetId = scene?.flags?.[MODULE_ID]?.fogResetId?.[this.levelId] || "";
      const chunks = {};
      for (const [key, chunk] of this.chunks) {
        if (!chunk.encodedUrl) chunk.encodedUrl = encodeCanvas(chunk.canvas);
        chunks[key] = chunk.encodedUrl;
      }
      localStorage.setItem(this._storageKey, JSON.stringify({ savedAt: Date.now(), resetId, chunks }));
    } catch (err) {
      // Remove stale cache key on QuotaExceededError so outdated fog never resurfaces
      if (err?.name === "QuotaExceededError") {
        try { localStorage.removeItem(this._storageKey); } catch {}
      }
    }
  }

  async saveNow() {
    if (!this.enabled || (!this._dirtyShared.size && !this._dirtyPrivate.size)) return;
    // Capture scene/level/chunks synchronously BEFORE any await so unmount()/mount() cannot race or corrupt another level!
    const sceneId = this.sceneId;
    const levelId = this.levelId;
    const isSharedMode = this.isSharedMode;
    const scene = game.scenes?.get?.(sceneId) ?? (canvas?.scene?.id === sceneId ? canvas.scene : null);
    if (!scene || !sceneId || !levelId) return;

    const sharedKeys = [];
    for (const key of Array.from(this._dirtyShared)) {
      if ((this._pendingChunkLoads.get(key) || 0) > 0) continue;
      sharedKeys.push(key);
      this._dirtyShared.delete(key);
    }
    const privateKeys = [];
    for (const key of Array.from(this._dirtyPrivate)) {
      if ((this._pendingChunkLoads.get(key) || 0) > 0) continue;
      privateKeys.push(key);
      this._dirtyPrivate.delete(key);
    }
    if (!sharedKeys.length && !privateKeys.length) return;

    // 1. Fast local cache update
    this._saveLocalCacheOnly();

    // 2. Pre-encode both server payloads synchronously while chunks are still live
    let sharedUpdate = null;
    if (isSharedMode && sharedKeys.length && game.user?.isGM) {
      const update = {};
      for (const key of sharedKeys) {
        const chunk = this.chunks.get(key);
        if (!chunk) continue;
        const srcCanvas = chunk.sharedCanvas || chunk.canvas;
        const srcCtx = chunk.sharedCtx || chunk.ctx;
        if (isCanvasEmpty(srcCtx)) {
          update[`flags.${MODULE_ID}.sharedFog.${levelId}.-=${key}`] = null;
        } else {
          update[`flags.${MODULE_ID}.sharedFog.${levelId}.${key}`] = encodeCanvas(srcCanvas);
        }
      }
      if (Object.keys(update).length) sharedUpdate = update;
    }

    let privateUpdate = null;
    if (privateKeys.length && game.user) {
      const update = {};
      for (const key of privateKeys) {
        const chunk = this.chunks.get(key);
        if (!chunk) continue;
        const privCanvas = (isSharedMode && chunk.privateCanvas) ? chunk.privateCanvas : chunk.canvas;
        const privCtx = (isSharedMode && chunk.privateCtx) ? chunk.privateCtx : chunk.ctx;
        if (isCanvasEmpty(privCtx)) {
          update[`flags.${MODULE_ID}.fog.${sceneId}.${levelId}.-=${key}`] = null;
        } else {
          update[`flags.${MODULE_ID}.fog.${sceneId}.${levelId}.${key}`] = encodeCanvas(privCanvas);
        }
      }
      if (Object.keys(update).length) privateUpdate = update;
    }

    // 3. Persist to server asynchronously with per-level re-entrancy guard & retry-on-failure requeue
    if (sharedUpdate) {
      this._incSavingShared(levelId);
      try {
        await scene.update(sharedUpdate);
      } catch (err) {
        console.warn(`${MODULE_ID} | Failed to persist shared chunked fog:`, err);
        if (this.enabled && this.sceneId === sceneId && this.levelId === levelId) {
          for (const key of sharedKeys) this._dirtyShared.add(key);
          this._scheduleSave();
        }
      } finally {
        this._decSavingShared(levelId);
      }
    }

    if (privateUpdate && game.user) {
      try {
        await game.user.update(privateUpdate);
      } catch (err) {
        console.warn(`${MODULE_ID} | Failed to persist personal chunked fog:`, err);
        if (this.enabled && this.sceneId === sceneId && this.levelId === levelId) {
          for (const key of privateKeys) this._dirtyPrivate.add(key);
          this._scheduleSave();
        }
      }
    }
  }

  _mergeChunkMap(mapObj, { intoShared = false, intoPrivate = false, replace = false } = {}) {
    if (!mapObj || typeof mapObj !== "object") return;
    const mountSceneId = this.sceneId;
    const mountLevelId = this.levelId;
    const gen = this._fogGen;

    for (const [rawKey, dataUrl] of Object.entries(mapObj)) {
      const isDeletion = rawKey.startsWith("-=") || dataUrl === null;
      const key = rawKey.startsWith("-=") ? rawKey.slice(2) : rawKey;
      const [cxStr, cyStr] = key.split("_");
      const cx = Number(cxStr), cy = Number(cyStr);
      if (!Number.isInteger(cx) || !Number.isInteger(cy)) continue;

      const seqKey = `${intoPrivate ? "priv" : "shared"}:${key}`;
      const seq = (this._chunkLoadSeq.get(seqKey) || 0) + 1;
      this._chunkLoadSeq.set(seqKey, seq);

      if (isDeletion) {
        const existing = this.chunks.get(key);
        if (!existing) continue;
        if (intoShared && existing.hasPrivate && existing.sharedCtx) {
          existing.sharedCtx.clearRect(0, 0, CHUNK_TEX_PX, CHUNK_TEX_PX);
          this._recompositeChunk(existing);
          existing.encodedUrl = null;
          existing.texture.baseTexture.update();
        } else {
          this._destroyChunkEntry(existing);
          this.chunks.delete(key);
        }
        continue;
      }

      if (typeof dataUrl !== "string" || !dataUrl.startsWith("data:image/")) continue;

      this._pendingChunkLoads.set(key, (this._pendingChunkLoads.get(key) || 0) + 1);
      let settled = false;
      const finishPending = () => {
        if (settled) return;
        settled = true;
        if (gen !== this._fogGen) return;
        const rem = (this._pendingChunkLoads.get(key) || 1) - 1;
        if (rem <= 0) {
          this._pendingChunkLoads.delete(key);
          if (this.enabled && (this._dirtyShared.has(key) || this._dirtyPrivate.has(key))) {
            this._scheduleSave();
          }
        } else {
          this._pendingChunkLoads.set(key, rem);
        }
      };

      const img = new Image();
      img.onload = () => {
        if (
          !this.enabled ||
          !this.container ||
          gen !== this._fogGen ||
          this._chunkLoadSeq.get(seqKey) !== seq ||
          this.sceneId !== mountSceneId ||
          this.levelId !== mountLevelId
        ) {
          finishPending();
          return;
        }
        const chunk = this._getOrCreateChunk(cx, cy);
        if (intoPrivate && this.isSharedMode && game.user?.isGM) {
          this._ensurePrivateCopy(chunk);
          if (replace) chunk.privateCtx.clearRect(0, 0, CHUNK_TEX_PX, CHUNK_TEX_PX);
          chunk.privateCtx.drawImage(img, 0, 0, CHUNK_TEX_PX, CHUNK_TEX_PX);
          this._recompositeChunk(chunk);
        } else {
          if (replace) {
            if (intoShared && chunk.sharedCtx) {
              chunk.sharedCtx.clearRect(0, 0, CHUNK_TEX_PX, CHUNK_TEX_PX);
              chunk.sharedCtx.drawImage(img, 0, 0, CHUNK_TEX_PX, CHUNK_TEX_PX);
              if (chunk.hasPrivate && chunk.privateCanvas) {
                this._recompositeChunk(chunk);
              } else {
                chunk.ctx.clearRect(0, 0, CHUNK_TEX_PX, CHUNK_TEX_PX);
                chunk.ctx.drawImage(img, 0, 0, CHUNK_TEX_PX, CHUNK_TEX_PX);
              }
            } else {
              chunk.ctx.clearRect(0, 0, CHUNK_TEX_PX, CHUNK_TEX_PX);
              chunk.ctx.drawImage(img, 0, 0, CHUNK_TEX_PX, CHUNK_TEX_PX);
            }
          } else {
            chunk.ctx.drawImage(img, 0, 0, CHUNK_TEX_PX, CHUNK_TEX_PX);
            if (intoShared && chunk.sharedCtx) {
              chunk.sharedCtx.drawImage(img, 0, 0, CHUNK_TEX_PX, CHUNK_TEX_PX);
            }
          }
        }
        chunk.encodedUrl = null;
        chunk.texture.baseTexture.update();
        this.updateViewportCulling();
        finishPending();
      };
      img.onerror = finishPending;
      img.src = dataUrl;
    }
  }

  _loadPersistedFog(scene) {
    const sharedFromScene = scene?.flags?.[MODULE_ID]?.sharedFog?.[this.levelId];
    const personalFromUser = game.user?.flags?.[MODULE_ID]?.fog?.[this.sceneId]?.[this.levelId];

    if (this.isSharedMode) {
      if (sharedFromScene) {
        this._mergeChunkMap(sharedFromScene, { intoShared: true });
      }
      if (game.user?.isGM && personalFromUser) {
        this._mergeChunkMap(personalFromUser, { intoPrivate: true });
      }
    } else {
      if (personalFromUser) {
        this._mergeChunkMap(personalFromUser, { intoPrivate: true });
      }
      // Fallback to localStorage cache if user flags were not saved yet (respecting GM fogResetAt timestamp)
      if (!personalFromUser && this._storageKey) {
        try {
          const raw = localStorage.getItem(this._storageKey);
          if (raw) {
            const parsed = JSON.parse(raw);
            const resetAt = Number(scene?.flags?.[MODULE_ID]?.fogResetAt?.[this.levelId]) || 0;
            const sceneResetId = scene?.flags?.[MODULE_ID]?.fogResetId?.[this.levelId] || "";
            const isWrapped = parsed && typeof parsed === "object" && "chunks" in parsed && typeof parsed.chunks === "object";
            const savedAt = isWrapped ? (Number(parsed.savedAt) || 0) : 0;
            const cachedResetId = isWrapped ? (parsed.resetId || "") : "";
            const chunkMap = isWrapped ? parsed.chunks : parsed;
            if ((sceneResetId && cachedResetId !== sceneResetId) || (resetAt > 0 && savedAt < resetAt)) {
              localStorage.removeItem(this._storageKey);
            } else if (chunkMap) {
              this._mergeChunkMap(chunkMap, { intoPrivate: true });
            }
          }
        } catch {}
      }
    }
  }

  async reset({ broadcast = true, persist = true } = {}) {
    if (this._saveTimer !== null) {
      clearTimeout(this._saveTimer);
      this._saveTimer = null;
    }
    if (this._localCacheTimer !== null) {
      clearTimeout(this._localCacheTimer);
      this._localCacheTimer = null;
    }
    if (this._brushFlushTimer !== null) {
      clearTimeout(this._brushFlushTimer);
      this._brushFlushTimer = null;
    }
    this._brushPendingStrokes = [];
    this._fogGen++;
    this._chunkLoadSeq.clear();
    this._pendingChunkLoads.clear();
    this._dirtyShared.clear();
    this._dirtyPrivate.clear();
    this._lastPolySigs.clear();
    if (this.sceneId && this.levelId) {
      this._remoteRevealQueues.delete(`${this.sceneId}::${this.levelId}`);
    }

    for (const chunk of this.chunks.values()) {
      this._destroyChunkEntry(chunk);
    }
    this.chunks.clear();

    if (this._storageKey) {
      try { localStorage.removeItem(this._storageKey); } catch {}
    }

    const sceneId = this.sceneId;
    const levelId = this.levelId;
    if (persist && sceneId && levelId) {
      const scene = game.scenes?.get?.(sceneId) ?? (canvas?.scene?.id === sceneId ? canvas.scene : null);
      if (game.user?.isGM && scene) {
        const resetAt = Date.now();
        const resetId = foundry.utils.randomID();
        this._lastHandledResetAt = resetAt;
        const scenePatch = {
          [`flags.${MODULE_ID}.fogResetAt.${levelId}`]: resetAt,
          [`flags.${MODULE_ID}.fogResetId.${levelId}`]: resetId
        };
        if (scene.flags?.[MODULE_ID]?.sharedFog?.[levelId]) {
          scenePatch[`flags.${MODULE_ID}.sharedFog.-=${levelId}`] = null;
        }
        this._incSavingShared(levelId);
        try {
          await scene.update(scenePatch);
        } catch (err) {
          console.warn(`${MODULE_ID} | Failed to clear shared fog flags:`, err);
        } finally {
          this._decSavingShared(levelId);
        }
      }
      if (game.user?.isGM && game.users) {
        // Clear per-user INDIVIDUAL / GM-private fog flags across all users (online & offline) so F5 never revives reset fog
        const updates = [];
        for (const u of game.users) {
          if (u?.flags?.[MODULE_ID]?.fog?.[sceneId]?.[levelId]) {
            updates.push({ _id: u.id, [`flags.${MODULE_ID}.fog.${sceneId}.-=${levelId}`]: null });
          }
        }
        if (updates.length) {
          try {
            if (typeof User?.updateDocuments === "function") {
              await User.updateDocuments(updates);
            } else {
              for (const u of game.users) {
                if (u?.flags?.[MODULE_ID]?.fog?.[sceneId]?.[levelId]) {
                  await u.update({ [`flags.${MODULE_ID}.fog.${sceneId}.-=${levelId}`]: null });
                }
              }
            }
          } catch (err) {
            console.warn(`${MODULE_ID} | Failed to clear user fog flags:`, err);
          }
        }
      } else if (game.user?.flags?.[MODULE_ID]?.fog?.[sceneId]?.[levelId]) {
        try {
          await game.user.update({ [`flags.${MODULE_ID}.fog.${sceneId}.-=${levelId}`]: null });
        } catch (err) {
          console.warn(`${MODULE_ID} | Failed to clear user fog flags:`, err);
        }
      }
    }

    if (this.enabled && this.sceneId === sceneId && this.levelId === levelId) {
      this.revealFromActiveVision({ broadcast: this.isSharedMode && !game.user?.isGM });
    }
  }

  // ===== GM Fog Brush =====

  brushStamp(x, y, radiusPx = this.brushRadiusPx, { erase = false, broadcast = true } = {}) {
    if (!this.enabled || !game.user?.isGM) return false;
    const stroke = [Math.round(x), Math.round(y), Math.round(radiusPx), erase ? 1 : 0];
    this._applyBrushStrokes([stroke], { markDirty: true });
    if (broadcast) {
      this._queueBrushStrokeBroadcast(stroke);
    }
    return true;
  }

  _queueBrushStrokeBroadcast(stroke) {
    this._brushPendingStrokes.push(stroke);
    if (this._brushFlushTimer !== null) return;
    this._brushFlushTimer = setTimeout(() => {
      this._flushBrushBroadcast();
    }, BRUSH_SOCKET_FLUSH_MS);
  }

  _flushBrushBroadcast() {
    if (this._brushFlushTimer !== null) {
      clearTimeout(this._brushFlushTimer);
      this._brushFlushTimer = null;
    }
    if (!this._brushPendingStrokes.length || !this.sceneId || !game.user?.isGM) return;
    const scene = game.scenes?.get?.(this.sceneId) ?? (canvas?.scene?.id === this.sceneId ? canvas.scene : null);
    if (!scene) {
      this._brushPendingStrokes = [];
      return;
    }
    const strokes = this._brushPendingStrokes.splice(0);
    const id = foundry.utils.randomID();
    this._markBrushSeen(id);
    scene.update({
      [`flags.${MODULE_ID}.fogBrush`]: {
        id,
        levelId: this.levelId,
        strokes
      }
    }).catch(err => {
      console.warn(`${MODULE_ID} | Failed to broadcast GM fog brush via scene flags:`, err);
    });
  }

  _clientToWorld(ev) {
    const view = canvas?.app?.view;
    if (!view || !canvas?.stage) return null;
    const rect = view.getBoundingClientRect();
    const sx = ev.clientX - rect.left;
    const sy = ev.clientY - rect.top;
    return canvas.stage.worldTransform.applyInverse({ x: sx, y: sy });
  }

  _redrawBrushPreview(worldPos, erase) {
    if (!this._brushPreview || !worldPos) return;
    const g = this._brushPreview;
    const scale = canvas?.stage?.scale?.x || 1;
    const lineW = Math.max(2, 2.5 / scale);
    const color = erase ? 0xff5a5a : 0x5ce1ff;
    g.clear();
    g.lineStyle(lineW, color, 0.92);
    g.beginFill(color, 0.14);
    g.drawCircle(worldPos.x, worldPos.y, this.brushRadiusPx);
    g.endFill();
    g.visible = true;
  }

  setBrushActive(active) {
    const next = Boolean(active && this.enabled && game.user?.isGM);
    if (next === this.brushActive) return;
    this.brushActive = next;

    if (!next) {
      this._teardownBrush();
      this._refreshControlsUI();
      return;
    }

    const view = canvas?.app?.view;
    if (!view || !canvas?.controls) {
      this.brushActive = false;
      return;
    }

    this._brushPreview = new PIXI.Graphics();
    this._brushPreview.name = "BoundlessFogBrushPreview";
    this._brushPreview.zIndex = 2000;
    this._brushPreview.eventMode = "none";
    this._brushPreview.visible = false;
    canvas.controls.addChild(this._brushPreview);

    const onPointerDown = (ev) => {
      if (!this.brushActive || !canvas?.lighting?.active || ev.button !== 0) return;
      ev.preventDefault();
      ev.stopPropagation();
      const pos = this._clientToWorld(ev);
      if (!pos) return;
      this._brushDragging = true;
      this._brushErase = Boolean(ev.shiftKey);
      this._brushLastWorld = pos;
      this._redrawBrushPreview(pos, this._brushErase);
      this.brushStamp(pos.x, pos.y, this.brushRadiusPx, { erase: this._brushErase, broadcast: true });
    };

    const onPointerMove = (ev) => {
      if (!this.brushActive || !canvas?.lighting?.active) return;
      const pos = this._clientToWorld(ev);
      if (!pos) return;
      const erase = this._brushDragging ? this._brushErase : Boolean(ev.shiftKey);
      this._redrawBrushPreview(pos, erase);
      if (!this._brushDragging) return;

      const prev = this._brushLastWorld || pos;
      const dist = Math.hypot(pos.x - prev.x, pos.y - prev.y);
      const step = Math.max(30, this.brushRadiusPx * 0.35);
      if (dist >= step) {
        const steps = Math.min(24, Math.ceil(dist / step));
        const strokes = new Array(steps);
        const r = Math.round(this.brushRadiusPx);
        const er = this._brushErase ? 1 : 0;
        for (let i = 1; i <= steps; i++) {
          const t = i / steps;
          strokes[i - 1] = [
            Math.round(prev.x + (pos.x - prev.x) * t),
            Math.round(prev.y + (pos.y - prev.y) * t),
            r,
            er
          ];
        }
        // Apply all interpolated brush stamps in a single batch (1 GPU texture upload per chunk instead of up to 24)
        this._applyBrushStrokes(strokes, { markDirty: true });
        for (let i = 0; i < strokes.length; i++) {
          this._queueBrushStrokeBroadcast(strokes[i]);
        }
        this._brushLastWorld = pos;
      }
    };

    const onPointerUp = () => {
      if (!this._brushDragging) return;
      this._brushDragging = false;
      this._brushLastWorld = null;
      this._flushBrushBroadcast();
    };

    const onWheel = (ev) => {
      if (!this.brushActive || !canvas?.lighting?.active || !ev.altKey) return;
      ev.preventDefault();
      ev.stopPropagation();
      const factor = ev.deltaY > 0 ? 0.85 : 1.18;
      this.brushRadiusPx = Math.max(
        BRUSH_MIN_RADIUS_PX,
        Math.min(BRUSH_MAX_RADIUS_PX, Math.round(this.brushRadiusPx * factor))
      );
      const pos = this._clientToWorld(ev);
      if (pos) this._redrawBrushPreview(pos, Boolean(ev.shiftKey));
    };

    const onKeyDown = (ev) => {
      if (!this.brushActive) return;
      if (ev.key === "Escape") {
        ev.preventDefault();
        ev.stopPropagation();
        this.setBrushActive(false);
      }
    };

    view.addEventListener("pointerdown", onPointerDown, true);
    window.addEventListener("pointermove", onPointerMove, true);
    window.addEventListener("pointerup", onPointerUp, true);
    window.addEventListener("pointercancel", onPointerUp, true);
    window.addEventListener("blur", onPointerUp);
    view.addEventListener("wheel", onWheel, { capture: true, passive: false });
    window.addEventListener("keydown", onKeyDown, true);

    this._brushListeners = { view, onPointerDown, onPointerMove, onPointerUp, onWheel, onKeyDown };
    this._refreshControlsUI();
    ui.notifications?.info(game.i18n.localize("BOUNDLESS.FogBrushHint"));
  }

  _teardownBrush() {
    this._flushBrushBroadcast();
    this._brushDragging = false;
    this._brushLastWorld = null;
    if (this._brushListeners) {
      const { view, onPointerDown, onPointerMove, onPointerUp, onWheel, onKeyDown } = this._brushListeners;
      view.removeEventListener("pointerdown", onPointerDown, true);
      window.removeEventListener("pointermove", onPointerMove, true);
      window.removeEventListener("pointerup", onPointerUp, true);
      window.removeEventListener("pointercancel", onPointerUp, true);
      window.removeEventListener("blur", onPointerUp);
      view.removeEventListener("wheel", onWheel, true);
      window.removeEventListener("keydown", onKeyDown, true);
      this._brushListeners = null;
    }
    if (this._brushPreview) {
      try { this._brushPreview.parent?.removeChild(this._brushPreview); } catch {}
      if (!this._brushPreview.destroyed) {
        try { this._brushPreview.destroy(); } catch {}
      }
      this._brushPreview = null;
    }
  }

  unmount() {
    if (this.brushActive) {
      this.brushActive = false;
      this._teardownBrush();
    } else {
      this._teardownBrush();
    }

    if (this.enabled) {
      // Flush local cache synchronously and fire best-effort server save
      this._saveLocalCacheOnly();
      if (this._dirtyShared.size || this._dirtyPrivate.size) {
        this.saveNow().catch(() => {});
      }
    }

    if (this._saveTimer !== null) {
      clearTimeout(this._saveTimer);
      this._saveTimer = null;
    }
    if (this._localCacheTimer !== null) {
      clearTimeout(this._localCacheTimer);
      this._localCacheTimer = null;
    }

    this._removeNativePatches();

    this._fogGen++;
    this._chunkLoadSeq.clear();
    this._pendingChunkLoads.clear();
    this._seenBrushIds.clear();
    this.enabled = false;
    this.mode = 0;
    this._dirtyShared.clear();
    this._dirtyPrivate.clear();
    this._lastPolySigs.clear();
    if (this.sceneId && this.levelId) {
      this._remoteRevealQueues.delete(`${this.sceneId}::${this.levelId}`);
    }

    for (const chunk of this.chunks.values()) {
      this._destroyChunkEntry(chunk);
    }
    this.chunks.clear();

    if (this.container) {
      try { this.container.parent?.removeChild(this.container); } catch {}
      if (!this.container.destroyed) {
        try { this.container.destroy({ children: true }); } catch {}
      }
      this.container = null;
    }

    this.sceneId = null;
    this.levelId = null;
    this._storageKey = null;
  }
}

export function registerFogControls(controller) {
  Hooks.on("deactivateLightingLayer", () => {
    controller.fogManager?.setBrushActive(false);
  });

  Hooks.on("getSceneControlButtons", (controls) => {
    const lighting = controls?.lighting;
    if (!lighting?.tools) return;

    const fogMgr = controller.fogManager;
    lighting.tools.boundlessFogBrush = {
      name: "boundlessFogBrush",
      order: 5.5,
      title: "BOUNDLESS.FogBrushTool",
      icon: "fa-solid fa-paintbrush",
      toggle: true,
      active: Boolean(fogMgr?.brushActive),
      visible: Boolean(game.user?.isGM && controller.active && fogMgr?.enabled),
      onChange: (_event, active) => {
        fogMgr?.setBrushActive(Boolean(active));
      }
    };
  });
}
