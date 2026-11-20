const MODULE_ID = "boundless";
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
  _storageKey = null;
  _dirtyShared = new Set();
  _dirtyPrivate = new Set();
  _lastPolySigs = new Map();
  _applyingRemoteFlag = false;
  _savingServer = false;

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
    this.mode = getSceneFogMode(scene);
    this.sceneId = scene.id;
    this.levelId = canvas.level?.id || "default";
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
    this.revealFromActiveVision({ broadcast: false });
    this._refreshControlsUI();
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
    const origCommit = fog.commit;
    const origSave = fog.save;
    const origReset = fog.reset;
    const origIsPointExplored = fog.isPointExplored;
    const origResetExploration = vis.resetExploration;

    this._patches = {
      fog,
      vis,
      origSpriteVisible,
      origCommit,
      origSave,
      origReset,
      origIsPointExplored,
      origResetExploration
    };

    this._hideCoreFogSprite();

    // Prevent Foundry from wasting GPU/CPU extracting a blurry 4096px global RenderTexture
    fog.commit = () => {
      if (!this.enabled) return origCommit.call(fog);
      this._hideCoreFogSprite();
      this.revealFromActiveVision();
    };

    fog.save = async (options) => {
      if (!this.enabled) return origSave.call(fog, options);
      await this.saveNow();
    };

    fog.isPointExplored = (point) => {
      if (!this.enabled) return origIsPointExplored.call(fog, point);
      return this.isPointExplored(point);
    };

    fog.reset = async () => {
      if (this.enabled) {
        await this.reset({ broadcast: true, persist: true });
      }
      return origReset.call(fog);
    };

    vis.resetExploration = (...args) => {
      const res = origResetExploration.apply(vis, args);
      if (this.enabled && this.container && !this.container.destroyed && vis.explored) {
        if (this.container.parent !== vis.explored) {
          vis.explored.addChildAt(this.container, 0);
        }
        this._hideCoreFogSprite();
      }
      return res;
    };
  }

  _removeNativePatches() {
    if (!this._patches) return;
    const {
      fog,
      vis,
      origSpriteVisible,
      origCommit,
      origSave,
      origReset,
      origIsPointExplored,
      origResetExploration
    } = this._patches;

    try {
      fog.commit = origCommit;
      fog.save = origSave;
      fog.reset = origReset;
      fog.isPointExplored = origIsPointExplored;
      vis.resetExploration = origResetExploration;
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
      sharedCanvas: null, // Copy-on-write buffer for GM in SHARED mode when private exploration diverges
      sharedCtx: null,
      hasPrivate: false,
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

  _applyPolygons(polygons, { target = "shared", markDirty = true } = {}) {
    if (!this.enabled || !this.container || !polygons?.length) return false;
    const touched = new Set();

    for (const pts of polygons) {
      if (!pts || pts.length < 6) continue;
      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      for (let i = 0; i < pts.length; i += 2) {
        const px = pts[i], py = pts[i + 1];
        if (px < minX) minX = px;
        if (px > maxX) maxX = px;
        if (py < minY) minY = py;
        if (py > maxY) maxY = py;
      }

      const cx0 = Math.max(0, Math.floor(minX / CHUNK_WORLD_PX));
      const cy0 = Math.max(0, Math.floor(minY / CHUNK_WORLD_PX));
      const cx1 = Math.floor(maxX / CHUNK_WORLD_PX);
      const cy1 = Math.floor(maxY / CHUNK_WORLD_PX);

      for (let cy = cy0; cy <= cy1; cy++) {
        for (let cx = cx0; cx <= cx1; cx++) {
          const chunk = this._getOrCreateChunk(cx, cy);
          const ox = cx * CHUNK_WORLD_PX;
          const oy = cy * CHUNK_WORLD_PX;

          if (this.isSharedMode && game.user?.isGM && target === "private") {
            // Keep GM-only exploration out of sharedCanvas so players never inherit GM-only peeks
            this._ensureSharedCopy(chunk);
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
      for (const chunk of touched) chunk.texture.baseTexture.update();
      this.updateViewportCulling();
      if (markDirty) this._scheduleSave();
      return true;
    }
    return false;
  }

  _applyBrushStrokes(strokes, { markDirty = true } = {}) {
    if (!this.enabled || !this.container || !strokes?.length) return false;
    const touched = new Set();

    for (const stroke of strokes) {
      const [x, y, radiusPx, erase] = stroke;
      if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(radiusPx)) continue;
      const cx0 = Math.max(0, Math.floor((x - radiusPx) / CHUNK_WORLD_PX));
      const cy0 = Math.max(0, Math.floor((y - radiusPx) / CHUNK_WORLD_PX));
      const cx1 = Math.floor((x + radiusPx) / CHUNK_WORLD_PX);
      const cy1 = Math.floor((y + radiusPx) / CHUNK_WORLD_PX);

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
          touched.add(chunk);
          if (markDirty) {
            if (this.isSharedMode) this._dirtyShared.add(chunk.key);
            if (!this.isSharedMode || chunk.hasPrivate) this._dirtyPrivate.add(chunk.key);
          }
        }
      }
    }

    if (touched.size > 0) {
      for (const chunk of touched) chunk.texture.baseTexture.update();
      this.updateViewportCulling();
      if (markDirty) this._scheduleSave();
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
    if (!this.enabled || !payload) return false;
    if (payload.sceneId !== this.sceneId) return false;
    if (payload.levelId && payload.levelId !== this.levelId) return false;

    if (payload.type === "fogReveal") {
      if (!this.isSharedMode || !Array.isArray(payload.polygons)) return true;
      // Only activeGM needs to mark shared chunks dirty for DB persistence; other clients cache locally
      const isAuthoritativeGM = game.users?.activeGM?.id === game.user?.id;
      this._applyPolygons(payload.polygons, { target: "shared", markDirty: isAuthoritativeGM });
      if (!isAuthoritativeGM) {
        // Keep local cache fresh on non-GM clients without triggering server writes
        this._saveLocalCacheOnly();
      }
      return true;
    }

    if (payload.type === "fogBrush") {
      if (!Array.isArray(payload.strokes)) return true;
      // In INDIVIDUAL mode each player persists GM brush reveal to their own user flags;
      // in SHARED mode the GM already persists to scene.flags
      const shouldPersist = !this.isSharedMode;
      this._applyBrushStrokes(payload.strokes, { markDirty: shouldPersist });
      if (!shouldPersist) this._saveLocalCacheOnly();
      return true;
    }

    if (payload.type === "fogReset") {
      this.reset({ broadcast: false, persist: false });
      return true;
    }

    return false;
  }

  onSceneFogFlagsChanged(scene, sharedFogChanges) {
    if (!this.enabled || !this.isSharedMode || !sharedFogChanges || this._applyingRemoteFlag) return;
    const levelPatch = sharedFogChanges[this.levelId];
    if (!levelPatch || typeof levelPatch !== "object") return;
    this._mergeChunkMap(levelPatch, { intoShared: true });
  }

  // ===== Persistence (Server Flags + Fast Local Cache) =====

  _scheduleSave() {
    if (this._saveTimer !== null) clearTimeout(this._saveTimer);
    this._saveTimer = setTimeout(() => {
      this._saveTimer = null;
      this.saveNow();
    }, FOG_SAVE_DEBOUNCE_MS);
  }

  _saveLocalCacheOnly() {
    if (!this._storageKey) return;
    try {
      const data = {};
      for (const [key, chunk] of this.chunks) {
        data[key] = encodeCanvas(chunk.canvas);
      }
      localStorage.setItem(this._storageKey, JSON.stringify(data));
    } catch {}
  }

  async saveNow() {
    if (!this.enabled || (!this._dirtyShared.size && !this._dirtyPrivate.size)) return;
    const scene = canvas?.scene;
    if (!scene || scene.id !== this.sceneId) return;

    const sharedKeys = Array.from(this._dirtyShared);
    const privateKeys = Array.from(this._dirtyPrivate);
    this._dirtyShared.clear();
    this._dirtyPrivate.clear();

    // 1. Fast local cache update
    this._saveLocalCacheOnly();

    // 2. Server persistence in SHARED mode (GM writes to Scene flags; remote socket reveals are only marked dirty on activeGM)
    if (this.isSharedMode && sharedKeys.length && game.user?.isGM) {
      const update = {};
      for (const key of sharedKeys) {
        const chunk = this.chunks.get(key);
        if (!chunk) continue;
        const srcCanvas = chunk.sharedCanvas || chunk.canvas;
        const srcCtx = chunk.sharedCtx || chunk.ctx;
        if (isCanvasEmpty(srcCtx)) {
          update[`flags.${MODULE_ID}.sharedFog.${this.levelId}.-=${key}`] = null;
        } else {
          update[`flags.${MODULE_ID}.sharedFog.${this.levelId}.${key}`] = encodeCanvas(srcCanvas);
        }
      }
      if (Object.keys(update).length) {
        this._applyingRemoteFlag = true;
        try {
          await scene.update(update);
        } catch (err) {
          console.warn(`${MODULE_ID} | Failed to persist shared chunked fog:`, err);
        } finally {
          this._applyingRemoteFlag = false;
        }
      }
    }

    // 3. Server persistence for INDIVIDUAL mode (or GM private layer in SHARED mode) via User flags
    if (privateKeys.length && game.user) {
      const update = {};
      for (const key of privateKeys) {
        const chunk = this.chunks.get(key);
        if (!chunk) continue;
        if (isCanvasEmpty(chunk.ctx)) {
          update[`flags.${MODULE_ID}.fog.${this.sceneId}.${this.levelId}.-=${key}`] = null;
        } else {
          update[`flags.${MODULE_ID}.fog.${this.sceneId}.${this.levelId}.${key}`] = encodeCanvas(chunk.canvas);
        }
      }
      if (Object.keys(update).length) {
        try {
          await game.user.update(update);
        } catch (err) {
          console.warn(`${MODULE_ID} | Failed to persist personal chunked fog:`, err);
        }
      }
    }
  }

  _mergeChunkMap(mapObj, { intoShared = false, intoPrivate = false } = {}) {
    if (!mapObj || typeof mapObj !== "object") return;
    const mountSceneId = this.sceneId;
    const mountLevelId = this.levelId;

    for (const [key, dataUrl] of Object.entries(mapObj)) {
      if (typeof dataUrl !== "string" || !dataUrl.startsWith("data:image/")) continue;
      const [cxStr, cyStr] = key.split("_");
      const cx = Number(cxStr), cy = Number(cyStr);
      if (!Number.isInteger(cx) || !Number.isInteger(cy)) continue;

      const img = new Image();
      img.onload = () => {
        if (!this.enabled || !this.container || this.sceneId !== mountSceneId || this.levelId !== mountLevelId) return;
        const chunk = this._getOrCreateChunk(cx, cy);
        if (intoPrivate && this.isSharedMode && game.user?.isGM) {
          this._ensureSharedCopy(chunk);
          chunk.ctx.drawImage(img, 0, 0, CHUNK_TEX_PX, CHUNK_TEX_PX);
        } else {
          chunk.ctx.drawImage(img, 0, 0, CHUNK_TEX_PX, CHUNK_TEX_PX);
          if (intoShared && chunk.sharedCtx) {
            chunk.sharedCtx.drawImage(img, 0, 0, CHUNK_TEX_PX, CHUNK_TEX_PX);
          }
        }
        chunk.texture.baseTexture.update();
        this.updateViewportCulling();
      };
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
      // Fallback to localStorage cache if user flags were not saved yet
      if (!personalFromUser && this._storageKey) {
        try {
          const raw = localStorage.getItem(this._storageKey);
          if (raw) this._mergeChunkMap(JSON.parse(raw), { intoPrivate: true });
        } catch {}
      }
    }
  }

  async reset({ broadcast = true, persist = true } = {}) {
    if (this._saveTimer !== null) {
      clearTimeout(this._saveTimer);
      this._saveTimer = null;
    }
    this._dirtyShared.clear();
    this._dirtyPrivate.clear();
    this._lastPolySigs.clear();

    for (const chunk of this.chunks.values()) {
      chunk.sprite.parent?.removeChild(chunk.sprite);
      chunk.sprite.destroy();
      chunk.texture.destroy(true);
    }
    this.chunks.clear();

    if (this._storageKey) {
      try { localStorage.removeItem(this._storageKey); } catch {}
    }

    if (persist && this.sceneId && this.levelId) {
      const scene = canvas?.scene;
      if (game.user?.isGM && scene?.id === this.sceneId && scene.flags?.[MODULE_ID]?.sharedFog?.[this.levelId]) {
        this._applyingRemoteFlag = true;
        try {
          await scene.update({ [`flags.${MODULE_ID}.sharedFog.-=${this.levelId}`]: null });
        } catch (err) {
          console.warn(`${MODULE_ID} | Failed to clear shared fog flags:`, err);
        } finally {
          this._applyingRemoteFlag = false;
        }
      }
      if (game.user?.flags?.[MODULE_ID]?.fog?.[this.sceneId]?.[this.levelId]) {
        try {
          await game.user.update({ [`flags.${MODULE_ID}.fog.${this.sceneId}.-=${this.levelId}`]: null });
        } catch (err) {
          console.warn(`${MODULE_ID} | Failed to clear user fog flags:`, err);
        }
      }
    }

    if (broadcast && this.sceneId) {
      game.socket?.emit(SOCKET_NAME, {
        type: "fogReset",
        sceneId: this.sceneId,
        levelId: this.levelId,
        senderId: game.user?.id
      });
    }

    if (this.enabled) {
      this.revealFromActiveVision({ broadcast: false });
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
    if (!this._brushPendingStrokes.length || !this.sceneId) return;
    const strokes = this._brushPendingStrokes.splice(0);
    game.socket?.emit(SOCKET_NAME, {
      type: "fogBrush",
      sceneId: this.sceneId,
      levelId: this.levelId,
      senderId: game.user?.id,
      strokes
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
      if (!this.brushActive || ev.button !== 0) return;
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
      if (!this.brushActive) return;
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
        for (let i = 1; i <= steps; i++) {
          const t = i / steps;
          this.brushStamp(
            prev.x + (pos.x - prev.x) * t,
            prev.y + (pos.y - prev.y) * t,
            this.brushRadiusPx,
            { erase: this._brushErase, broadcast: true }
          );
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
      if (!this.brushActive || !ev.altKey) return;
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
        this.setBrushActive(false);
      }
    };

    view.addEventListener("pointerdown", onPointerDown, true);
    window.addEventListener("pointermove", onPointerMove, true);
    window.addEventListener("pointerup", onPointerUp, true);
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
      view.removeEventListener("wheel", onWheel, true);
      window.removeEventListener("keydown", onKeyDown, true);
      this._brushListeners = null;
    }
    if (this._brushPreview) {
      this._brushPreview.parent?.removeChild(this._brushPreview);
      this._brushPreview.destroy();
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

    this._removeNativePatches();

    this.enabled = false;
    this.mode = 0;
    this._dirtyShared.clear();
    this._dirtyPrivate.clear();
    this._lastPolySigs.clear();

    for (const chunk of this.chunks.values()) {
      chunk.sprite.parent?.removeChild(chunk.sprite);
      chunk.sprite.destroy();
      chunk.texture.destroy(true);
    }
    this.chunks.clear();

    if (this.container) {
      this.container.parent?.removeChild(this.container);
      this.container.destroy({ children: true });
      this.container = null;
    }

    this.sceneId = null;
    this.levelId = null;
    this._storageKey = null;
  }
}

export function registerFogControls(controller) {
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
