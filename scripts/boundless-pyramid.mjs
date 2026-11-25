import {
  MODULE_ID,
  getShowstopperMovementApi,
  isTextureUsable,
  getLevelBaseElevation,
  getLevelBottomElevation,
  getLevelRoofElevation,
  isLevelAbove,
  getEffectiveScale,
  getVirtualTileBounds,
  hasSpecOverlays,
  computePredictiveViewportRect
} from "./utils.mjs";

export const MAX_GPU_UPLOAD_BYTES_PER_FRAME = 16 * 1024 * 1024; // ~16 MB/frame fresh WebGL texture upload cap to avoid mipmap stalls
export const CROSSFADE_MS = 160;       // Smooth invisible LOD blend duration
export const WORLD_MIN_SCALE = 0.008;        // Seamless full-world zoom-out
export const CAMERA_STORAGE_PREFIX = "boundless.camera";
export const CAMERA_SAVE_DEBOUNCE_MS = 250;
export const NOOP_TRANSFORM = () => {};
export const EMPTY_ARRAY = Object.freeze([]);

export const pyramidMethods = {
  applyVramProfile(profile = null) {
    let chosen = profile;
    if (chosen === null || chosen === undefined) {
      try {
        chosen = game.settings?.get?.(MODULE_ID, "vramProfile") ?? "auto";
      } catch {
        chosen = "auto";
      }
    }
    const resolved = this.texMgr.setVramProfile(chosen);
    if (this.active && this.texMgr.needsPrune()) {
      this._pruneNeeded = true;
    }
    return resolved;
  },

  _updateCameraVelocity(now = performance.now()) {
    const pivot = canvas?.stage?.pivot;
    const scale = canvas?.stage?.scale?.x;
    if (!pivot || !Number.isFinite(pivot.x) || !Number.isFinite(pivot.y) || !Number.isFinite(scale) || scale <= 0) {
      this._camVelX = 0;
      this._camVelY = 0;
      this._camPrevX = null;
      this._camPrevY = null;
      this._camPrevMs = 0;
      return;
    }
    if (this._camPrevMs > 0 && this._camPrevX !== null && this._camPrevY !== null) {
      const dtMs = now - this._camPrevMs;
      if (dtMs > 4 && dtMs < 250) {
        const dx = pivot.x - this._camPrevX;
        const dy = pivot.y - this._camPrevY;
        const [rawSw, rawSh] = canvas.screenDimensions || [];
        const sw = (Number.isFinite(rawSw) && rawSw > 0) ? rawSw : 1600;
        const sh = (Number.isFinite(rawSh) && rawSh > 0) ? rawSh : 1000;
        const maxJump = Math.max(sw, sh) / scale * 2.5;
        const dist = Math.hypot(dx, dy);
        if (!Number.isFinite(dist) || dist > maxJump) {
          this._camVelX = 0;
          this._camVelY = 0;
        } else {
          const dtSec = dtMs / 1000;
          const vx = dx / dtSec;
          const vy = dy / dtSec;
          const alpha = Math.min(1, dtSec * 14);
          this._camVelX = (Number.isFinite(this._camVelX) ? this._camVelX : 0) * (1 - alpha) + vx * alpha;
          this._camVelY = (Number.isFinite(this._camVelY) ? this._camVelY : 0) * (1 - alpha) + vy * alpha;
        }
      } else if (dtMs >= 250) {
        this._camVelX = 0;
        this._camVelY = 0;
      }
    }
    this._camPrevX = pivot.x;
    this._camPrevY = pivot.y;
    this._camPrevMs = now;
  },

  _getCameraVelocity(now = performance.now()) {
    if (!this._camPrevMs || (now - this._camPrevMs) > 220) {
      return { velX: 0, velY: 0 };
    }
    return { velX: this._camVelX, velY: this._camVelY };
  },

  isActivelyMoving() {
    return this.isCameraFlying || (this._lastPanMs > 0 && (performance.now() - this._lastPanMs) < 160);
  },

  _getCameraStorageKey(scene = canvas.scene) {
    const sid = typeof scene === "string" ? scene : scene?.id;
    if (!sid) return null;
    const worldId = game.world?.id || "world";
    return `${CAMERA_STORAGE_PREFIX}.${worldId}.${sid}`;
  },

  _saveCameraNow(force = false, sceneOrId = null) {
    if (!this.active || this._restoringCamera || (!force && !canvas?.ready) || !canvas?.stage?.pivot || !canvas.stage.scale) return;
    const key = this._getCameraStorageKey(sceneOrId || this._mountedSceneId || canvas.scene);
    if (!key) return;
    const x = canvas.stage.pivot.x;
    const y = canvas.stage.pivot.y;
    const scale = canvas.stage.scale.x;
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(scale) || scale <= 0) return;
    try {
      localStorage.setItem(key, JSON.stringify({
        x: Math.round(x),
        y: Math.round(y),
        scale: Number(scale.toFixed(5))
      }));
    } catch {}
  },

  scheduleCameraSave() {
    if (!this.active || this._restoringCamera || this.isCameraFlying) return;
    if (this._camSaveTimer !== null) clearTimeout(this._camSaveTimer);
    this._camSaveTimer = setTimeout(() => {
      this._camSaveTimer = null;
      this._saveCameraNow();
    }, CAMERA_SAVE_DEBOUNCE_MS);
  },

  setCameraFlying(flying) {
    const next = Boolean(flying);
    if (this.isCameraFlying === next) return;
    this.isCameraFlying = next;
    if (!next && this.active && canvas?.ready) {
      this.syncZoomLimits({ animate: false });
      this.updatePyramid();
      this.scheduleViewportLightSync();
      this._saveCameraNow();
    }
  },

  prewarmArea(worldX, worldY, targetScale) {
    if (!this.active || this._mounting || !this.visibleLevelLayers.length || !canvas?.ready) return;
    this.chunkStreamer.prewarmPoint(worldX, worldY);
    this.tokenStreamer.prewarmTarget(worldX, worldY, targetScale);
    const [sw = 1600, sh = 1000] = canvas.screenDimensions || [];
    const safeScale = Math.max(0.01, targetScale || 0.45);
    const halfW = (sw / safeScale) * 0.55;
    const halfH = (sh / safeScale) * 0.55;

    const urls = [];
    const queued = new Set();
    const maxBudget = 12;

    for (const layer of this.visibleLevelLayers) {
      if ((!layer.hasPyramid && !layer.hasForegroundPyramid) || urls.length >= maxBudget) continue;
      const { bounds } = layer;
      const channels = [];
      if (layer.hasPyramid && layer.maxZoomZ >= 1) channels.push("bg");
      if (layer.hasForegroundPyramid && layer.foregroundMaxZoomZ >= 1) channels.push("fg");
      for (const ch of channels) {
        if (urls.length >= maxBudget) break;
        const maxZ = ch === "fg" ? layer.foregroundMaxZoomZ : layer.maxZoomZ;
        const destZ = Math.max(1, this._computeTargetZ(layer, safeScale, { maxZoomZ: maxZ }));
        // Warm intermediate levels first (closest in time during descent), then destination level
        const levelsToWarm = [];
        if (destZ - 2 >= 1) levelsToWarm.push(destZ - 2);
        if (destZ - 1 >= 1) levelsToWarm.push(destZ - 1);
        levelsToWarm.push(destZ);

        for (const z of levelsToWarm) {
          if (urls.length >= maxBudget) break;
          const { nx, ny } = this._getPyramidGridDims(layer, z);
          const tileWorldSize = this._getPyramidTileSize(layer, z);
          const padFactor = z === destZ ? 0.9 : 0.4;
          const bx0 = Math.max(bounds.x, worldX - halfW * padFactor);
          const by0 = Math.max(bounds.y, worldY - halfH * padFactor);
          const bx1 = Math.min(bounds.x + bounds.w, worldX + halfW * padFactor);
          const by1 = Math.min(bounds.y + bounds.h, worldY + halfH * padFactor);
          if (bx0 >= bx1 || by0 >= by1) continue;

          const tx0 = Math.max(0, Math.floor((bx0 - bounds.x) / tileWorldSize));
          const ty0 = Math.max(0, Math.floor((by0 - bounds.y) / tileWorldSize));
          const tx1 = Math.min(nx - 1, Math.floor((bx1 - 0.001 - bounds.x) / tileWorldSize));
          const ty1 = Math.min(ny - 1, Math.floor((by1 - 0.001 - bounds.y) / tileWorldSize));

          for (let ty = ty0; ty <= ty1 && urls.length < maxBudget; ty++) {
            for (let tx = tx0; tx <= tx1 && urls.length < maxBudget; tx++) {
              const spec = ch === "fg"
                ? this.resolveForegroundPyramidTile(layer, z, tx, ty)
                : this.resolvePyramidTile(layer, z, tx, ty);
              if (!spec?.src || queued.has(spec.src) || this.texMgr.getSync(spec.src)) continue;
              queued.add(spec.src);
              urls.push(spec.src);
            }
          }
        }
      }
    }

    if (!urls.length) return;
    // Cancel stale background prewarm jobs and queue new ones at low priority (2) in off-main-thread workers
    this.texMgr.cancelPrewarm();
    const gen = ++this._prewarmGen;
    let idx = 0;
    const pump = () => {
      if (!this.active || this._prewarmGen !== gen || idx >= urls.length) return;
      const batch = Math.min(2, urls.length - idx);
      let done = 0;
      for (let i = 0; i < batch; i++) {
        const src = urls[idx++];
        this.texMgr.load(src, { mipmap: true, priority: 2 }).finally(() => {
          done++;
          if (done === batch && this.active && this._prewarmGen === gen && idx < urls.length) {
            requestAnimationFrame(pump);
          }
        });
      }
    };
    requestAnimationFrame(pump);
  },

  _restoreCamera(scene) {
    const key = this._getCameraStorageKey(scene);
    if (!key) return false;
    try {
      let raw = localStorage.getItem(key);
      if (!raw && canvas.level?.id) {
        const legacyKey = `${key}.${canvas.level.id}`;
        raw = localStorage.getItem(legacyKey);
        if (raw) {
          localStorage.setItem(key, raw);
          localStorage.removeItem(legacyKey);
        }
      }
      if (!raw) return false;
      const saved = JSON.parse(raw);
      if (!Number.isFinite(saved?.x) || !Number.isFinite(saved?.y) || !Number.isFinite(saved?.scale) || saved.scale <= 0) {
        return false;
      }
      this._restoringCamera = true;
      try {
        canvas.pan({ x: saved.x, y: saved.y, scale: saved.scale });
      } finally {
        this._restoringCamera = false;
      }
      return true;
    } catch {
      return false;
    }
  },

  syncZoomLimits() {
    if (!this.active || !canvas?.dimensions?.scale) return;
    canvas.dimensions.scale.min = this._worldMinScale;
  },

  queueZoomLimitSync() {
    this.syncZoomLimits();
  },

  _getPyramidGridDims(layer, z) {
    const sg = layer.superGrid;
    if (sg) {
      const macroMaxZ = sg.macroMaxZ ?? 2;
      if (z <= macroMaxZ) {
        const n = 1 << z;
        return { nx: n, ny: n };
      }
      const localN = 1 << (z - (macroMaxZ + 1));
      return { nx: (sg.cols || 6) * localN, ny: (sg.rows || 6) * localN };
    }
    const n = 1 << z;
    return { nx: n, ny: n };
  },

  _getPyramidGridSize(layer, z) {
    const { nx, ny } = this._getPyramidGridDims(layer, z);
    return Math.max(nx, ny);
  },

  _getPyramidTileSize(layer, z) {
    const sg = layer.superGrid;
    if (sg) {
      const macroMaxZ = sg.macroMaxZ ?? 2;
      if (z > macroMaxZ) {
        const localN = 1 << (z - (macroMaxZ + 1));
        return (sg.regionPx || 100000) / localN;
      }
    }
    const span = Math.max(layer.bounds?.w || layer.worldPx || 100000, layer.bounds?.h || layer.worldPx || 100000);
    return span / (1 << z);
  },

  _shouldMountRoofs(layer, scale = canvas?.stage?.scale?.x ?? 1) {
    if (!layer) return false;
    if (!layer.hasPyramid) return true;
    const effScale = getEffectiveScale(scale);
    const threshold = layer._roofsMountedMode ? 0.21 : 0.24;
    const active = effScale >= threshold;
    layer._roofsMountedMode = active;
    return active;
  },

  _shouldMountInteriorTiles(layer, scale = canvas?.stage?.scale?.x ?? 1) {
    if (!layer) return false;
    if (!layer.hasPyramid) return true;
    const effScale = getEffectiveScale(scale);
    const threshold = layer._interiorTilesMounted ? 0.40 : 0.45;
    const active = effScale >= threshold;
    layer._interiorTilesMounted = active;
    return active;
  },

  _computeTargetZ(layer, scale, { hysteresis = false, maxZoomZ = null, prevZOverride = null } = {}) {
    const { worldPx, tilePx, superGrid } = layer;
    const effMaxZ = maxZoomZ ?? layer.maxZoomZ;
    const rawPrevZ = prevZOverride !== null ? prevZOverride : layer.lastTargetZ;
    const prevZ = hysteresis && Number.isInteger(rawPrevZ) && rawPrevZ >= 0 ? rawPrevZ : -1;
    const applyHyst = (exact) => {
      const z = Math.ceil(exact);
      if (prevZ >= 0 && prevZ <= effMaxZ) {
        if (z === prevZ + 1 && exact < prevZ + 0.08) return prevZ;
        if (z === prevZ - 1 && exact > prevZ - 1 - 0.08) return prevZ;
      }
      return z;
    };
    if (superGrid) {
      const macroMaxZ = superGrid.macroMaxZ ?? 2;
      const regionPx = superGrid.regionPx || 100000;
      const localRatio = (regionPx * scale) / tilePx;
      const localThreshold = (prevZ > macroMaxZ) ? 0.86 : 0.96;
      if (localRatio >= (hysteresis ? localThreshold : 0.92)) {
        const exactLocal = (macroMaxZ + 1) + Math.log2(Math.max(0.5, localRatio));
        const z = hysteresis ? applyHyst(exactLocal) : Math.ceil(exactLocal);
        return Math.max(macroMaxZ + 1, Math.min(effMaxZ, z));
      }
      const macroExact = Math.log2(Math.max(0.5, (worldPx * scale) / tilePx));
      return Math.max(0, Math.min(macroMaxZ, applyHyst(macroExact)));
    }
    const span = Math.max(layer.bounds?.w || worldPx, layer.bounds?.h || worldPx);
    const exactZ = Math.log2((span * scale) / tilePx);
    return Math.max(0, Math.min(effMaxZ, applyHyst(exactZ)));
  },

  /**
   * Build a lightweight 256x256 CPU alpha map from a level's z=0 texture (via 2D canvas, zero WebGL stalls)
   * so lower visible levels can skip mounting props & pyramid tiles completely hidden beneath opaque upper floors.
   */
  _buildLevelOpacityMask(layer, e, tex) {
    if (!layer || layer.isUpper || layer.opacityMask || e.z !== 0) return;
    const src = tex?.baseTexture?.resource?.source;
    if (!src) return;
    try {
      const dim = 512;
      const cv = typeof OffscreenCanvas !== "undefined"
        ? new OffscreenCanvas(dim, dim)
        : document.createElement("canvas");
      cv.width = dim;
      cv.height = dim;
      const ctx = cv.getContext("2d", { willReadFrequently: true });
      if (!ctx) return;
      ctx.clearRect(0, 0, dim, dim);
      ctx.drawImage(src, 0, 0, dim, dim);
      const rgba = ctx.getImageData(0, 0, dim, dim).data;
      const alpha = new Uint8Array(dim * dim);
      // Build 2D Integral Image (prefix sum of opaque pixels) for O(1) rectangular occlusion queries (4 array reads!)
      const stride = dim + 1;
      const prefix = new Uint32Array(stride * stride);
      let opaqueCount = 0;
      for (let py = 0; py < dim; py++) {
        const rowA = py * dim;
        const rowP = (py + 1) * stride;
        const prevP = py * stride;
        let rowSum = 0;
        for (let px = 0; px < dim; px++) {
          const a = rgba[(rowA + px) * 4 + 3];
          alpha[rowA + px] = a;
          if (a >= 240) {
            opaqueCount++;
            rowSum++;
          }
          prefix[rowP + px + 1] = prefix[prevP + px + 1] + rowSum;
        }
      }
      cv.width = 0;
      cv.height = 0;
      if (opaqueCount === 0) return;
      layer.opacityMask = {
        alpha,
        prefix,
        stride,
        w: dim,
        h: dim,
        x0: e.x0,
        y0: e.y0,
        worldW: e.sizePx,
        worldH: e.sizePx
      };
      let invalidatedLower = false;
      for (const other of this.visibleLevelLayers) {
        if (other !== layer && !other.level?.isView && isLevelAbove(layer.level, other.level)) {
          other.lastTileKey = "";
          other.lastPyramidKey = "";
          invalidatedLower = true;
        }
      }
      if (invalidatedLower) {
        queueMicrotask(() => {
          if (this.active) this.updatePyramid();
        });
      }
    } catch (err) {
      console.warn(`${MODULE_ID} | Failed to build opacity mask for level "${layer.level?.name}":`, err);
    }
  },

  /**
   * Returns true if world rect (rx, ry, rw, rh) on a lower (non-viewed) level is 100% covered
   * by opaque floor pixels (alpha >= 240, with 1-texel safety margin) of higher visible level(s).
   */
  _isRectOccludedByUpperLevels(layer, rx, ry, rw, rh) {
    if (!layer || layer.level?.isView || layer.isUpper) return false;
    let uppers = null;
    for (let i = 0; i < this.visibleLevelLayers.length; i++) {
      const u = this.visibleLevelLayers[i];
      if (!u.isUpper && u.opacityMask && isLevelAbove(u.level, layer.level)) {
        if (!uppers) uppers = [u.opacityMask];
        else uppers.push(u.opacityMask);
      }
    }
    if (!uppers) return false;

    // Fast path: single upper level covers entire rect (most common: Floor 1 over Basement)
    for (let uIdx = 0; uIdx < uppers.length; uIdx++) {
      const m = uppers[uIdx];
      if (rx < m.x0 || ry < m.y0 || rx + rw > m.x0 + m.worldW || ry + rh > m.y0 + m.worldH) continue;
      const sx = m.w / m.worldW;
      const sy = m.h / m.worldH;
      const ix0 = Math.max(0, Math.floor((rx - m.x0) * sx));
      const iy0 = Math.max(0, Math.floor((ry - m.y0) * sy));
      const ix1 = Math.min(m.w - 1, Math.ceil((rx + rw - m.x0) * sx));
      const iy1 = Math.min(m.h - 1, Math.ceil((ry + rh - m.y0) * sy));
      if (m.prefix) {
        const st = m.stride;
        const p = m.prefix;
        const total = (ix1 - ix0 + 1) * (iy1 - iy0 + 1);
        const opaque = p[(iy1 + 1) * st + (ix1 + 1)] - p[iy0 * st + (ix1 + 1)] - p[(iy1 + 1) * st + ix0] + p[iy0 * st + ix0];
        if (opaque === total) return true;
        continue;
      }
      const data = m.alpha;
      const mw = m.w;
      let allOpaque = true;
      for (let py = iy0; py <= iy1; py++) {
        const row = py * mw;
        for (let px = ix0; px <= ix1; px++) {
          if (data[row + px] < 240) {
            allOpaque = false;
            break;
          }
        }
        if (!allOpaque) break;
      }
      if (allOpaque) return true;
    }
    return false;
  },

  _markDepthDirty({ elev = false, syncElev = false } = {}) {
    this._depthDirty = true;
    if (syncElev) this._depthElevSyncNeeded = true;
    const dm = canvas.masks?.depth;
    if (dm) {
      dm.renderDirty = true;
      if (elev) dm._elevationDirty = true;
    }
  },

  _collectVirtualTileCandidates(lid, spec, sx0, sy0, sx1, sy1) {
    const tiles = spec?.tiles;
    if (!tiles?.length) return EMPTY_ARRAY;
    const sectors = spec.sectors;
    if (!sectors) {
      const all = new Array(tiles.length);
      for (let i = 0; i < tiles.length; i++) all[i] = i;
      return all;
    }
    let set = null;
    for (let sy = sy0; sy <= sy1; sy++) {
      for (let sx = sx0; sx <= sx1; sx++) {
        const list = sectors[`${sx}_${sy}`]?.t;
        if (!list?.length) continue;
        if (!set) set = new Set();
        for (let i = 0; i < list.length; i++) set.add(list[i]);
      }
    }
    const lvlEdits = this.tileEdits.get(lid);
    if (lvlEdits?.size) {
      for (const [tKey, ov] of lvlEdits) {
        if (!ov || !tKey.startsWith("t:")) continue;
        const tid = Number(tKey.slice(2));
        if (Number.isInteger(tid) && tiles[tid]) {
          if (!set) set = new Set();
          set.add(tid);
        }
      }
    }
    return set || EMPTY_ARRAY;
  },

  _isVirtualTileOccludedByUpper(layer, tSpec) {
    if (!layer || layer.level?.isView || layer.isUpper || !tSpec) return false;
    const { pivX, pivY, halfDiag } = getVirtualTileBounds(tSpec);
    return this._isRectOccludedByUpperLevels(layer, pivX - halfDiag, pivY - halfDiag, halfDiag * 2, halfDiag * 2);
  },

  acquireMesh() {
    while (this.meshPool.length > 0) {
      const m = this.meshPool.pop();
      if (!m || m.destroyed) continue;
      m._inMeshPool = false;
      m.name = null;
      m.hidden = false;
      m.visible = true;
      m.renderable = true;
      m.alpha = 1.0;
      m.unoccludedAlpha = 1.0;
      m.occludedAlpha = 1.0;
      m.occluded = false;
      m.hoverFade = false;
      m.occlusionMode = CONST.OCCLUSION_MODES.NONE;
      m.restrictsLight = false;
      m.restrictsWeather = false;
      m.elevation = 0;
      m.sort = 0;
      m.sortLayer = 0;
      m.zIndex = 0;
      m.angle = 0;
      m.anchor?.set?.(0, 0);
      m.position?.set?.(0, 0);
      m.pivot?.set?.(0, 0);
      m.skew?.set?.(0, 0);
      m.scale?.set?.(1, 1);
      m.tint = 0xffffff;
      m.filters = null;
      m.filterArea = null;
      m.mask = null;
      m.textureAlphaThreshold = 0.75;
      m._occludedBySameElevationSurfaces = true;
      m._ssDofBlurPx = 0;
      m._boundlessMesh = true;
      m._boundlessTile = false;
      m._boundlessFgTile = false;
      if (Object.prototype.hasOwnProperty.call(m, "updateCanvasTransform")) delete m.updateCanvasTransform;
      // Must reset to null (NOT "batchOcclusion") so PrimarySpriteMesh#pluginName getter falls back to this._shader.pluginName
      // and switches to "batchDepth" during CanvasDepthMask#renderDepthData!
      m.pluginName = null;
      return m;
    }
    const PrimarySpriteMesh = foundry.canvas.primary.PrimarySpriteMesh;
    const m = new PrimarySpriteMesh({ texture: PIXI.Texture.WHITE });
    m.anchor.set(0, 0);
    m.eventMode = "none";
    m.textureAlphaThreshold = 0.75;
    m._occludedBySameElevationSurfaces = true;
    m._inMeshPool = false;
    m._boundlessMesh = true;
    m._boundlessTile = false;
    m._boundlessFgTile = false;
    return m;
  },

  retireMesh(m) {
    if (!m || m.destroyed || m._inMeshPool) return;
    // Clear any Showstopper Depth-of-Field filter, custom filters, & occlusion state before pooling so reused meshes never inherit stale state
    m.name = null;
    m.hidden = false;
    m.visible = true;
    m.renderable = true;
    m.alpha = 1.0;
    m.unoccludedAlpha = 1.0;
    m.occludedAlpha = 1.0;
    m.restrictsLight = false;
    m.restrictsWeather = false;
    m.elevation = 0;
    m.sort = 0;
    m.sortLayer = 0;
    m.zIndex = 0;
    m.angle = 0;
    m.tint = 0xffffff;
    m.anchor?.set?.(0, 0);
    m.position?.set?.(0, 0);
    m.pivot?.set?.(0, 0);
    m.skew?.set?.(0, 0);
    m.scale?.set?.(1, 1);
    m._boundlessTile = false;
    m._boundlessFgTile = false;
    if (Object.prototype.hasOwnProperty.call(m, "updateCanvasTransform")) delete m.updateCanvasTransform;
    if (Object.prototype.hasOwnProperty.call(m, "_occludedBySameElevationSurfaces")) delete m._occludedBySameElevationSurfaces;
    m.pluginName = null;
    m.texture = PIXI.Texture.EMPTY;
    m.debounceSetOcclusion?.cancel?.();
    m.hoverFade = false;
    m.occlusionMode = CONST.OCCLUSION_MODES.NONE;
    m.occluded = false;
    if (m._occlusionState) {
      m._occlusionState.fade = 0;
      m._occlusionState.radial = 0;
      m._occlusionState.vision = 0;
      m._occlusionState.surface = 0;
    }
    if (m._hoverFadeState) {
      m._hoverFadeState.hovered = false;
      m._hoverFadeState.faded = false;
      m._hoverFadeState.fading = false;
      m._hoverFadeState.hoveredTime = 0;
      m._hoverFadeState._hoveredTime = 0;
      m._hoverFadeState.fadingTime = 0;
      m._hoverFadeState.occlusion = 0;
    }
    m._ssDofBlurPx = 0;
    if (m._ssDofBlurFilter) {
      try { m._ssDofBlurFilter.blur = 0; } catch {}
    }
    m.filters = null;
    m.filterArea = null;
    m.mask = null;
    m._ssSetFilterArea = false;
    m.parent?.removeChild(m);
    if (this.meshPool.length < 1024) {
      m._inMeshPool = true;
      this.meshPool.push(m);
    } else {
      try { m._ssDofBlurFilter?.destroy?.(); } catch {}
      m._ssDofBlurFilter = null;
      m.destroy();
    }
  },

  /**
   * Apply Showstopper elevation Depth-of-Field blur immediately to a newly streamed mesh
   * and queue a coalesced perspective sync so meshes streamed mid-flight match the focal plane on frame 1.
   */
  _syncShowstopperMeshDof(m) {
    if (!m || m.destroyed) return;
    const ssApi = getShowstopperMovementApi();
    if (!ssApi) return;
    try {
      if (!ssApi.getTokenMovementSetting?.("vertical") || !ssApi.getTokenMovementSetting?.("verticalBlur")) return;
      const baseElev = getLevelBaseElevation(canvas?.level);
      const obsElev = Number(ssApi.getObserverElevation?.());
      if (!Number.isFinite(obsElev) || Math.abs(obsElev - baseElev) <= 0.05) return;
      if (typeof ssApi.computeElevationPerspective === "function") {
        const grid = canvas?.grid?.size ?? 100;
        const sceneDist = Number(canvas?.scene?.grid?.distance ?? canvas?.grid?.distance) || 5;
        const obsPersp = ssApi.computeElevationPerspective(obsElev, obsElev, {
          gridSize: grid, gridDistance: sceneDist, tokenSize: grid, hoverBlend: 1, baseElevation: baseElev
        });
        const mElev = Number.isFinite(Number(m.elevation)) ? Number(m.elevation) : baseElev;
        const mPersp = ssApi.computeElevationPerspective(mElev, obsElev, {
          gridSize: grid, gridDistance: sceneDist, tokenSize: grid, hoverBlend: 0, baseElevation: baseElev
        });
        const occAlpha = Number.isFinite(Number(obsPersp?.cameraOcclusionAlpha)) ? Number(obsPersp.cameraOcclusionAlpha) : 1;
        const blurPx = (Number(mPersp?.dofBlurPx) || 0) * occAlpha;
        m._ssDofBlurPx = blurPx > 0.22 ? blurPx : 0;
      }
      this._scheduleShowstopperDofSync();
    } catch {}
  },

  _scheduleShowstopperDofSync() {
    if (this._ssDofSyncQueued) return;
    const ssApi = getShowstopperMovementApi();
    if (!ssApi?.syncElevationPerspective) return;
    this._ssDofSyncQueued = true;
    queueMicrotask(() => {
      this._ssDofSyncQueued = false;
      if (!this.active || !canvas?.ready) return;
      try {
        ssApi.syncElevationPerspective({ immediate: true });
      } catch {}
    });
  },

  invalidateShowstopperSurfaces(immediate = false) {
    const ssApi = getShowstopperMovementApi();
    if (!ssApi?.invalidateSupportingSurfaces) return;
    if (!immediate && this.isActivelyMoving()) {
      const now = performance.now();
      if ((now - this._lastShowstopperMs) < 200) {
        this._showstopperDirty = true;
        return;
      }
    }
    this._showstopperDirty = false;
    this._lastShowstopperMs = performance.now();
    try {
      ssApi.invalidateSupportingSurfaces();
    } catch {}
  },

  resolvePyramidTile(layer, z, x, y) {
    const lid = layer.level.id;
    const flags = layer.spec.blockFlags;
    const sg = layer.superGrid;

    if (sg) {
      const macroMaxZ = sg.macroMaxZ ?? 2;
      if (z <= macroMaxZ) {
        const mBase = sg.macroPyramidUrl || layer.pyramidBaseUrl;
        return { levelId: lid, z, x, y, key: `${lid}::${z}_${x}_${y}`, src: `${mBase}/${z}/${x}_${y}.webp`, tint: 0xffffff };
      }
      const localZ = z - (macroMaxZ + 1);
      const localN = 1 << localZ;
      const gx = Math.max(0, Math.min((sg.cols || 6) - 1, Math.floor(x / localN)));
      const gy = Math.max(0, Math.min((sg.rows || 6) - 1, Math.floor(y / localN)));
      const lx = x - gx * localN;
      const ly = y - gy * localN;
      const tint = sg.parsedTints?.[gy]?.[gx] ?? 0xffffff;
      const bBase = sg.basePyramidUrl || `modules/${MODULE_ID}/assets/pyramid`;

      if (!flags || localZ <= 4) {
        return { levelId: lid, z, x, y, key: `${lid}::${z}_${x}_${y}`, src: `${bBase}/${localZ}/${lx}_${ly}.webp`, tint };
      }
      if (localZ === 5) {
        const ch = flags[ly]?.[lx] || "6";
        const src = ch === "F" ? `${bBase}/forest/5_${lx % 4}_${ly % 4}.webp` : `${bBase}/5/${lx}_${ly}.webp`;
        return { levelId: lid, z, x, y, key: `${lid}::${z}_${x}_${y}`, src, tint };
      }
      if (localZ === 6) {
        const bx = lx >> 1, by = ly >> 1;
        const ch = flags[by]?.[bx] || "6";
        const src = ch === "F"
          ? `${bBase}/forest/6_${bx % 4}_${by % 4}_${lx % 2}_${ly % 2}.webp`
          : `${bBase}/6/${lx}_${ly}.webp`;
        return { levelId: lid, z, x, y, key: `${lid}::${z}_${x}_${y}`, src, tint };
      }
      // localZ === 7
      const bx = lx >> 2, by = ly >> 2;
      const ch = flags[by]?.[bx] || "6";
      if (ch === "6" || ch === "F") {
        const px = lx >> 1, py = ly >> 1;
        const pGlobalX = gx * (localN >> 1) + px;
        const pGlobalY = gy * (localN >> 1) + py;
        const pZ = z - 1;
        const src = ch === "F"
          ? `${bBase}/forest/6_${bx % 4}_${by % 4}_${px % 2}_${py % 2}.webp`
          : `${bBase}/6/${px}_${py}.webp`;
        return { levelId: lid, z: pZ, x: pGlobalX, y: pGlobalY, key: `${lid}::${pZ}_${pGlobalX}_${pGlobalY}`, src, tint };
      }
      return { levelId: lid, z, x, y, key: `${lid}::${z}_${x}_${y}`, src: `${bBase}/7/${lx}_${ly}.webp`, tint };
    }

    const base = layer.pyramidBaseUrl;
    if (!flags || z <= 4) {
      return { levelId: lid, z, x, y, key: `${lid}::${z}_${x}_${y}`, src: `${base}/${z}/${x}_${y}.webp` };
    }
    if (z === 5) {
      const ch = flags[y]?.[x] || "6";
      const src = ch === "F" ? `${base}/forest/5_${x % 4}_${y % 4}.webp` : `${base}/5/${x}_${y}.webp`;
      return { levelId: lid, z: 5, x, y, key: `${lid}::5_${x}_${y}`, src };
    }
    if (z === 6) {
      const bx = x >> 1, by = y >> 1;
      const ch = flags[by]?.[bx] || "6";
      const src = ch === "F"
        ? `${base}/forest/6_${bx % 4}_${by % 4}_${x % 2}_${y % 2}.webp`
        : `${base}/6/${x}_${y}.webp`;
      return { levelId: lid, z: 6, x, y, key: `${lid}::6_${x}_${y}`, src };
    }
    // z === 7
    const bx = x >> 2, by = y >> 2;
    const ch = flags[by]?.[bx] || "6";
    if (ch === "6" || ch === "F") {
      const px = x >> 1, py = y >> 1;
      const src = ch === "F"
        ? `${base}/forest/6_${bx % 4}_${by % 4}_${px % 2}_${py % 2}.webp`
        : `${base}/6/${px}_${py}.webp`;
      return { levelId: lid, z: 6, x: px, y: py, key: `${lid}::6_${px}_${py}`, src };
    }
    return { levelId: lid, z: 7, x, y, key: `${lid}::7_${x}_${y}`, src: `${base}/7/${x}_${y}.webp` };
  },

  hasForegroundTile(layer, z, x, y) {
    if (!layer?.hasForegroundPyramid) return false;
    const set = layer.foregroundTileSet;
    if (!set) return true;
    return set.has(`${z}/${x}_${y}`);
  },

  resolveForegroundPyramidTile(layer, z, x, y) {
    if (!this.hasForegroundTile(layer, z, x, y)) return null;
    const lid = layer.level.id;
    return {
      levelId: lid,
      channel: "fg",
      z,
      x,
      y,
      key: `${lid}::fg::${z}_${x}_${y}`,
      src: `${layer.foregroundPyramidBaseUrl}/${z}/${x}_${y}.webp`
    };
  },

  _syncPyramidChannel(layer, vp, channel) {
    const isFg = channel === "fg";
    if (isFg ? !layer.hasForegroundPyramid : !layer.hasPyramid) return false;

    const { bounds } = layer;
    const targetZ = isFg
      ? this._computeTargetZ(layer, vp.scale, {
          hysteresis: true,
          maxZoomZ: layer.foregroundMaxZoomZ,
          prevZOverride: layer.lastForegroundTargetZ
        })
      : layer.lastTargetZ;
    if (isFg) layer.lastForegroundTargetZ = targetZ;

    const bx0 = Math.max(bounds.x, vp.x0);
    const by0 = Math.max(bounds.y, vp.y0);
    const bx1 = Math.min(bounds.x + bounds.w, vp.x1);
    const by1 = Math.min(bounds.y + bounds.h, vp.y1);
    const overlapsBounds = bx0 < bx1 && by0 < by1;

    let tx0 = 0, ty0 = 0, tx1 = 0, ty1 = 0;
    if (targetZ > 0 && overlapsBounds) {
      const { nx, ny } = this._getPyramidGridDims(layer, targetZ);
      const tileWorldSize = this._getPyramidTileSize(layer, targetZ);
      tx0 = Math.max(0, Math.floor((bx0 - bounds.x) / tileWorldSize));
      ty0 = Math.max(0, Math.floor((by0 - bounds.y) / tileWorldSize));
      tx1 = Math.min(nx - 1, Math.floor((bx1 - 0.001 - bounds.x) / tileWorldSize));
      ty1 = Math.min(ny - 1, Math.floor((by1 - 0.001 - bounds.y) / tileWorldSize));
    }

    const pyrKey = `${overlapsBounds ? 1 : 0}_${targetZ}_${tx0}_${ty0}_${tx1}_${ty1}`;
    const prevKey = isFg ? layer.lastForegroundPyramidKey : layer.lastPyramidKey;
    if (pyrKey === prevKey) return false;

    if (isFg) layer.lastForegroundPyramidKey = pyrKey;
    else layer.lastPyramidKey = pyrKey;

    const lid = layer.level.id;
    const desiredMap = new Map();
    if (overlapsBounds) {
      if (isFg) {
        const fgBase = this.resolveForegroundPyramidTile(layer, 0, 0, 0);
        if (fgBase) desiredMap.set(fgBase.key, fgBase);
      } else {
        const baseKey = `${lid}::0_0_0`;
        const mBase = layer.superGrid?.macroPyramidUrl || layer.pyramidBaseUrl;
        desiredMap.set(baseKey, { levelId: lid, channel: "bg", z: 0, x: 0, y: 0, key: baseKey, src: `${mBase}/0/0_0.webp` });
      }
      if (targetZ > 0) {
        const tileWorldSize = this._getPyramidTileSize(layer, targetZ);
        const checkUpperOcc = !layer.level?.isView && !layer.isUpper;
        for (let ty = ty0; ty <= ty1; ty++) {
          for (let tx = tx0; tx <= tx1; tx++) {
            if (checkUpperOcc) {
              const wx = bounds.x + tx * tileWorldSize;
              const wy = bounds.y + ty * tileWorldSize;
              if (this._isRectOccludedByUpperLevels(layer, wx, wy, tileWorldSize, tileWorldSize)) continue;
            }
            const spec = isFg
              ? this.resolveForegroundPyramidTile(layer, targetZ, tx, ty)
              : this.resolvePyramidTile(layer, targetZ, tx, ty);
            if (spec) desiredMap.set(spec.key, spec);
          }
        }
      }
    }

    const desiredSrcs = new Set();
    for (const spec of desiredMap.values()) desiredSrcs.add(spec.src);

    for (const [k, entry] of this.tilesByKey) {
      if (entry.levelId !== lid || (entry.channel || "bg") !== channel) continue;
      const inDesired = desiredMap.has(k);
      const keepReveal = !isFg && Boolean(entry.isReveal && this._revealTileKeys.has(k));
      if (!keepReveal && entry.isReveal) {
        entry.isReveal = false;
        this._revealTileKeys.delete(k);
      }
      entry.desired = inDesired || keepReveal;
      if (entry.desired) {
        entry.fadingOut = false;
        desiredSrcs.add(entry.src);
      } else {
        if (!entry.ready && entry.z > 2) {
          this.tilesByKey.delete(k);
          if (!desiredSrcs.has(entry.src)) this.texMgr.cancel(entry.src);
        }
      }
    }

    for (const [k, spec] of desiredMap) {
      if (!this.tilesByKey.has(k)) {
        this.ensureTile(layer, spec, spec.z === 0);
      }
    }
    this._tilesDirty = true;
    return true;
  },

  getViewportWorldRect(padFraction = 0.25, worldPx = null, { predictive = false } = {}) {
    const scale = canvas?.stage?.scale?.x || 1;
    const pivot = canvas?.stage?.pivot || { x: 0, y: 0 };
    const [rawSw, rawSh] = canvas?.screenDimensions || [];
    const sw = (Number.isFinite(rawSw) && rawSw > 0) ? rawSw : 1600;
    const sh = (Number.isFinite(rawSh) && rawSh > 0) ? rawSh : 1000;
    const maxW = (Number.isFinite(worldPx) && worldPx > 0) ? worldPx : (canvas?.dimensions?.width || 100000);
    const maxH = (Number.isFinite(worldPx) && worldPx > 0) ? worldPx : (canvas?.dimensions?.height || 100000);
    const vel = predictive ? this._getCameraVelocity() : { velX: 0, velY: 0 };
    return computePredictiveViewportRect(pivot.x, pivot.y, sw, sh, scale, maxW, maxH, {
      padFraction,
      velX: vel.velX,
      velY: vel.velY
    });
  },

  updatePyramid() {
    if (!this.active || this._mounting || !this.visibleLevelLayers.length || !canvas?.ready || this._inUpdatePyramid) return;
    this._inUpdatePyramid = true;
    try {
    const stableVp = this.getViewportWorldRect(0.28, null, { predictive: false });
    const vp = this.isCameraFlying ? stableVp : this.getViewportWorldRect(0.28, null, { predictive: true });

    // Update GPU light frustum culling, spatial chunk streaming, POI pin scale, chunked fog culling, spatial audio, and native streamed walls/doors
    this.chunkStreamer.update(vp);
    this.lightBatch.updateViewport(stableVp);
    this.poiManager.updateViewport(stableVp);
    this.charPins.updateViewport();
    this.fogManager.updateViewportCulling(stableVp);
    // Keep token frustum culling & GPU Impostor Atlas synced even during camera flight (<0.05ms)
    this.tokenStreamer.scheduleSync(stableVp);
    if (!this.isCameraFlying) {
      this.audioStreamer.update(
        this.visibleLevelLayers,
        stableVp,
        (lid, sk, idx, raw, lvl) => this.resolveVirtualSound(lid, sk, idx, raw, lvl)
      );
      this.wallEditor.syncViewport(false, stableVp);
      this.layerEditors.syncViewport(false, stableVp);
    }
    if (this.lightBatch.useDepthTexture || this.activeOverlays.size > 0 || this.visibleLevelLayers.length > 1 || this._hasMultiElevationDepth()) {
      // Set renderDirty directly without also raising _depthDirty (avoids rendering CanvasDepthMask twice on consecutive frames!)
      if (canvas.masks?.depth) canvas.masks.depth.renderDirty = true;
      else this._depthDirty = true;
    }

    let anyTilesOrOverlaysChanged = false;
    let maxTargetZ = 0;

    // Process currently viewed level FIRST so its pyramid tiles & virtual props always jump ahead of hidden lower levels (e.g. basement)
    const orderedLayers = this.visibleLevelLayers.length > 1
      ? this.visibleLevelLayers.slice().sort((a, b) => (b.level?.isView ? 1 : 0) - (a.level?.isView ? 1 : 0))
      : this.visibleLevelLayers;
    const sharedVtSeen = orderedLayers.length > 1 ? new Set() : null;

    for (const layer of orderedLayers) {
      const targetZ = this._computeTargetZ(layer, vp.scale, { hysteresis: true });
      layer.lastTargetZ = targetZ;
      if (targetZ > maxTargetZ) maxTargetZ = targetZ;

      // 1. Quadtree Pyramid streaming for this level (background floor + optional foreground walls)
      if (this._syncPyramidChannel(layer, vp, "bg")) {
        anyTilesOrOverlaysChanged = true;
      }
      if (this._syncPyramidChannel(layer, vp, "fg")) {
        anyTilesOrOverlaysChanged = true;
      }

      // 2. Interactive House Overlays (roofs stay mounted at all zoom levels for seamless depth/light & token occlusion; walls show at targetZ >= 6)
      if (this.syncOverlayMeshes(layer, targetZ, vp)) {
        anyTilesOrOverlaysChanged = true;
      }

      // 3. Virtual Streamed Tiles (`spec.tiles` + `sectors[sk].t`) for this level
      if (this.syncVirtualTiles(layer, targetZ, vp, sharedVtSeen)) {
        anyTilesOrOverlaysChanged = true;
      }
    }

    this.lastTargetZ = maxTargetZ;
    // Synchronously reveal z=0 fallback BEFORE this frame renders whenever zoom-out/pan exposes any edge outside mounted z>0 tiles
    this._syncBaseLayerVisibility(this.getViewportWorldRect(0.0));
    this._syncIndoorLightVisibility();
    if (anyTilesOrOverlaysChanged) {
      // Sync roof token occlusion immediately in the same frame so zooming in never flashes tokens through unmounted roofs
      this.syncRoofTokenOcclusion();
      this._roofTokenOccDirty = false;
      if (this.texMgr.needsPrune()) {
        this._pruneNeeded = true;
      }
    }
    } finally {
      this._inUpdatePyramid = false;
    }
  },

  _collectInUseTextures() {
    const inUse = new Set();
    for (const [, entry] of this.tilesByKey) inUse.add(entry.src);
    for (const [, ov] of this.activeOverlays) {
      if (ov.srcWalls) inUse.add(ov.srcWalls);
      if (ov.srcRoof) inUse.add(ov.srcRoof);
    }
    for (let i = 0; i < this.pendingOverlayMounts.length; i++) {
      const po = this.pendingOverlayMounts[i];
      if (po?.ovSpec?.walls) inUse.add(po.ovSpec.walls);
      if (po?.ovSpec?.roof) inUse.add(po.ovSpec.roof);
    }
    for (const fullKey of this.overlayPending) {
      const cleanKey = fullKey.endsWith(":w") ? fullKey.slice(0, -2) : fullKey;
      const sep = cleanKey.indexOf("::");
      if (sep > 0) {
        const l = this.levelLayers.get(cleanKey.slice(0, sep));
        const rawOid = cleanKey.slice(sep + 2);
        const ovSpec = l?.spec?.overlays?.[rawOid];
        if (ovSpec?.walls) inUse.add(ovSpec.walls);
        if (ovSpec?.roof) inUse.add(ovSpec.roof);
      }
    }
    for (const [, vt] of this.activeVirtualTiles) {
      if (vt.src) inUse.add(vt.src);
    }
    for (let i = 0; i < this.pendingVirtualTileMounts.length; i++) {
      const pv = this.pendingVirtualTileMounts[i];
      if (pv?.tSpec?.src) inUse.add(pv.tSpec.src);
    }
    for (const fullId of this.virtualTilePending) {
      const sep = fullId.indexOf("::");
      if (sep > 0) {
        const lid = fullId.slice(0, sep);
        const tid = Number(fullId.slice(sep + 2));
        const l = this.levelLayers.get(lid);
        const tSpec = l ? this.resolveVirtualTile(lid, tid, l.spec?.tiles?.[tid], l.level) : null;
        if (tSpec?.src) inUse.add(tSpec.src);
      }
    }
    return inUse;
  },

  ensureTile(layer, spec, instant = false) {
    const { bounds } = layer;
    const sizePx = this._getPyramidTileSize(layer, spec.z);
    const x0 = bounds.x + spec.x * sizePx;
    const y0 = bounds.y + spec.y * sizePx;

    const prevEntry = this.tilesByKey.get(spec.key);
    if (prevEntry?.mesh) this.retireMesh(prevEntry.mesh);

    const entry = {
      key: spec.key,
      levelId: layer.level.id,
      channel: spec.channel || "bg",
      layer,
      z: spec.z,
      x: spec.x,
      y: spec.y,
      src: spec.src,
      tint: spec.tint ?? null,
      x0,
      y0,
      sizePx,
      ready: false,
      mesh: null,
      alpha: instant ? 1.0 : 0.0,
      fadingOut: false,
      desired: true
    };
    this.tilesByKey.set(spec.key, entry);
    this._tilesDirty = true;

    const isPinned = spec.z <= 1;
    const isViewedLayer = Boolean(layer.level?.isView);
    const visVp = this.getViewportWorldRect(0.0);
    const onVisScreen = !(x0 + sizePx < visVp.x0 || x0 > visVp.x1 || y0 + sizePx < visVp.y0 || y0 > visVp.y1);
    const loadPriority = (isPinned || (isViewedLayer && onVisScreen)) ? 0 : 1;
    this.texMgr.load(spec.src, { mipmap: true, isPinned, priority: loadPriority }).then(tex => {
      if (!this.active) return;
      const e = this.tilesByKey.get(spec.key);
      if (e !== entry) return;
      if (!tex || !isTextureUsable(tex)) {
        if (!e.ready) {
          this.tilesByKey.delete(spec.key);
          this._tilesDirty = true;
        }
        return;
      }
      if (e.fadingOut || (!e.desired && e.z > 0)) {
        if (!e.ready) this.tilesByKey.delete(spec.key);
        return;
      }
      if (instant || e.z === 0) {
        this._mountTileMesh(e, tex, instant);
      } else {
        const qItem = { key: spec.key, entry, tex, instant: instant || e.z === 1 };
        if (e.z <= 1 || (isViewedLayer && onVisScreen)) this.pendingTileMounts.unshift(qItem);
        else this.pendingTileMounts.push(qItem);
        this._tilesDirty = true;
      }
    });
  },

  _mountTileMesh(e, tex, instant) {
    if (!e || e.ready || e.fadingOut || (!e.desired && e.z > 0)) return false;
    const isFg = e.channel === "fg";
    if (!isTextureUsable(tex)) {
      if (this.tilesByKey.get(e.key) === e) {
        this.tilesByKey.delete(e.key);
        if (e.layer) {
          if (isFg) e.layer.lastForegroundPyramidKey = "";
          else e.layer.lastPyramidKey = "";
        }
      }
      return false;
    }
    const PrimaryCanvasGroup = foundry.canvas.groups.PrimaryCanvasGroup;
    const layer = e.layer;
    const tileElev = isFg
      ? (layer.foregroundElevation ?? getLevelRoofElevation(layer.level))
      : getLevelBottomElevation(layer.level);

    const m = this.acquireMesh();
    m._boundlessTile = true;
    m._boundlessFgTile = isFg;
    m.name = isFg
      ? `Level.${layer.level?.index ?? 0}.BoundlessFgTile.${e.key}`
      : `Level.${layer.level?.index ?? 0}.BoundlessTile.${e.key}`;
    m.anchor.set(0, 0);
    m.texture = tex;
    const rawSpecTint = isFg
      ? (layer.spec?.foregroundTint ?? layer.level?.foreground?.tint)
      : (layer.spec?.backgroundTint ?? layer.level?.background?.tint);
    let resolvedTint = 0xffffff;
    if (e.tint !== undefined && e.tint !== null) {
      resolvedTint = e.tint;
    } else if (rawSpecTint !== undefined && rawSpecTint !== null && rawSpecTint !== "") {
      if (typeof rawSpecTint === "number" && Number.isFinite(rawSpecTint)) resolvedTint = rawSpecTint;
      else {
        const c = foundry.utils.Color.from(rawSpecTint);
        if (c?.valid) resolvedTint = c.valueOf();
      }
    }
    m.tint = resolvedTint;
    const rawAlphaThresh = isFg
      ? (layer.spec?.foregroundAlphaThreshold ?? layer.level?.foreground?.alphaThreshold)
      : (layer.spec?.backgroundAlphaThreshold ?? layer.level?.background?.alphaThreshold);
    if (Number.isFinite(rawAlphaThresh)) m.textureAlphaThreshold = rawAlphaThresh;
    m.position.set(e.x0, e.y0);
    m.width = e.sizePx + 0.5;
    m.height = e.sizePx + 0.5;
    m.elevation = tileElev;
    m.sortLayer = PrimaryCanvasGroup.SORT_LAYERS.SCENE;
    // Foreground walls sit at level.elevation.top (above bottom tokens) with SCENE sortLayer (below TILES roofs/props)
    // and negative sort (< 1) so the next upper level's floor at the same elevation always draws cleanly above them.
    m.sort = isFg ? (-200 + e.z * 10) : (1 + e.z * 10);
    // Ground (non-upper, non-foreground) pyramid tiles only need SURFACE occlusion if the scene has defineSurface Regions;
    // otherwise keep OCCLUSION_MODES.NONE so non-depth tiles use the fast PIXI "batch" shader instead of batchOcclusion!
    let groundOccMode = CONST.OCCLUSION_MODES.NONE;
    if (isFg) {
      groundOccMode = CONST.OCCLUSION_MODES.SURFACE;
    } else if (!layer.isUpper) {
      const regions = canvas.regions?.placeables;
      if (regions?.length) {
        for (let ri = 0; ri < regions.length; ri++) {
          const behaviors = regions[ri]?.document?.behaviors;
          if (!behaviors?.size) continue;
          for (const b of behaviors) {
            if (!b.disabled && b.type === "defineSurface") {
              groundOccMode = CONST.OCCLUSION_MODES.SURFACE;
              break;
            }
          }
          if (groundOccMode !== CONST.OCCLUSION_MODES.NONE) break;
        }
      }
    }
    m.occlusionMode = layer.isUpper
      ? (CONST.OCCLUSION_MODES.FADE | CONST.OCCLUSION_MODES.RADIAL | CONST.OCCLUSION_MODES.SURFACE)
      : groundOccMode;
    if (isFg) m._occludedBySameElevationSurfaces = false;
    m.occludedAlpha = layer.isUpper ? 0.08 : 1.0;
    m.hoverFade = layer.isUpper;
    // On single-level worlds skip coarse z=0 depth writes; on multi-level scenes (including hybrid Boundless+native)
    // z=0 MUST write depth so lower-level (basement) lights never bleed through floors when zoomed all the way out!
    const needZ0Depth = this._hasMultiElevationDepth ? this._hasMultiElevationDepth() : (this.visibleLevelLayers.length > 1);
    m.restrictsLight = !isFg && (e.z > 0 || needZ0Depth);
    m.restrictsWeather = !isFg && (e.z > 0 || needZ0Depth);

    // Defer visibility (`awaitingSwap`) when zooming IN (`other.z < e.z`), and for semi-transparent layers (`isFg || layer.isUpper`)
    // also when zooming OUT (`other.z !== e.z`) so overlapping LODs never double-blend dark halos.
    const eCh = e.channel || "bg";
    const isTranslucentChannel = isFg || Boolean(layer.isUpper);
    let hasOtherZCovering = false;
    if (!instant && e.z > 0 && !e.isReveal) {
      for (const [, other] of this.tilesByKey) {
        const zMatch = isTranslucentChannel ? (other.z !== e.z) : (other.z < e.z);
        if (other.levelId === e.levelId && (other.channel || "bg") === eCh && other.ready && !other.awaitingSwap && other.z > 0 && zMatch && other.mesh?.visible && other.alpha >= 0.9 &&
            this.rectsOverlap(e.x0, e.y0, e.sizePx, other.x0, other.y0, other.sizePx)) {
          hasOtherZCovering = true;
          break;
        }
      }
    }
    // Keep replacement LOD tiles hidden at alpha=1.0 until all visible tiles of the new LOD are ready,
    // then swap atomically in 1 frame so semi-transparent floors/shadows never double-blend or flicker CanvasDepthMask!
    e.alpha = 1.0;
    e.awaitingSwap = hasOtherZCovering;
    m.alpha = 1.0;
    m.unoccludedAlpha = 1.0;
    m.visible = !hasOtherZCovering;
    e.mesh = m;
    e.ready = true;
    canvas.primary.addChild(m);
    m.updateCanvasTransform?.();
    // Static ground/lower pyramid tiles never move so skip per-frame quadtree churn;
    // ONLY use plain PIXI "batch" when the tile does NOT write to CanvasDepthMask AND does not use occlusionMode (e.g. SURFACE on foreground)!
    if (!layer.isUpper) {
      if (!m.restrictsLight && !m.restrictsWeather && m.occlusionMode === CONST.OCCLUSION_MODES.NONE) m.pluginName = "batch";
      m.updateCanvasTransform = NOOP_TRANSFORM;
      if (!isFg && e.z === 0) this._buildLevelOpacityMask(layer, e, tex);
    }
    if (m.visible) this._syncShowstopperMeshDof(m);
    canvas.primary.sortDirty = true;
    this._tilesDirty = true;
    if (m.visible && !isFg) {
      this._markDepthDirty({ elev: true });
    }
    return true;
  },

  _isViewportCoveredByHigherTiles(layer, visVp, channel = "bg") {
    if (!layer?.bounds || !visVp) return false;
    const lid = layer.level.id;
    const rx0 = Math.max(layer.bounds.x, visVp.x0);
    const ry0 = Math.max(layer.bounds.y, visVp.y0);
    const rx1 = Math.min(layer.bounds.x + layer.bounds.w, visVp.x1);
    const ry1 = Math.min(layer.bounds.y + layer.bounds.h, visVp.y1);
    if (rx1 <= rx0 || ry1 <= ry0) return true;
    const visHigher = [];
    for (const [, other] of this.tilesByKey) {
      if (other.levelId === lid && (other.channel || "bg") === channel && other.ready && !other.awaitingSwap && other.z > 0 && other.mesh?.visible && other.alpha >= 0.98 &&
          other.x0 < rx1 && other.x0 + other.sizePx > rx0 &&
          other.y0 < ry1 && other.y0 + other.sizePx > ry0) {
        visHigher.push(other);
      }
    }
    if (visHigher.length === 0) return false;
    const rw = rx1 - rx0;
    const rh = ry1 - ry0;
    const fracs = [0.002, 0.25, 0.5, 0.75, 0.998];
    for (let yi = 0; yi < 5; yi++) {
      const py = ry0 + rh * fracs[yi];
      for (let xi = 0; xi < 5; xi++) {
        const px = rx0 + rw * fracs[xi];
        let covered = false;
        for (let i = 0; i < visHigher.length; i++) {
          const o = visHigher[i];
          if (px >= o.x0 && px <= o.x0 + o.sizePx && py >= o.y0 && py <= o.y0 + o.sizePx) {
            covered = true;
            break;
          }
        }
        if (!covered) return false;
      }
    }
    return true;
  },

  _syncBaseLayerVisibility(visVp, levelReadyState = null, fgReadyState = null) {
    let anyBgChanged = false;
    let anyFgChanged = false;
    for (const layer of this.visibleLevelLayers) {
      const lid = layer.level.id;
      if (layer.hasPyramid) {
        const z0 = this.tilesByKey.get(`${lid}::0_0_0`);
        // Always verify actual viewport coverage so a failed/404 high-Z tile never hides the z=0 fallback and leaves a black hole
        const fullyCovered = this._isViewportCoveredByHigherTiles(layer, visVp, "bg");
        if (z0?.mesh) {
          const shouldShowBase = !fullyCovered;
          if (z0.mesh.visible !== shouldShowBase) {
            z0.mesh.visible = shouldShowBase;
            anyBgChanged = true;
          }
        }
        this._setNativeLevelTextureVisible(layer.level, "background", !fullyCovered);
      }
      if (layer.hasForegroundPyramid) {
        const stFg = fgReadyState?.get?.(lid);
        const fgZ0 = this.tilesByKey.get(`${lid}::fg::0_0_0`);
        // For sparse foreground pyramids, once targetZ > 0 and all visible desired fg tiles are ready
        // (even 0 tiles in an empty open-field area), hide the coarse z=0 fallback so walls never double-render.
        let allVisDesiredFgReady = Boolean(stFg?.visDesiredReady);
        if (!stFg && layer.lastForegroundTargetZ > 0 && layer.foregroundTileSet) {
          allVisDesiredFgReady = true;
          for (const [, tile] of this.tilesByKey) {
            if (tile.levelId === lid && tile.channel === "fg" && tile.desired && tile.z === layer.lastForegroundTargetZ && (!tile.ready || tile.awaitingSwap)) {
              allVisDesiredFgReady = false;
              break;
            }
          }
        }
        const fgCovered = Boolean(
          layer.lastForegroundTargetZ > 0 && allVisDesiredFgReady
        ) || this._isViewportCoveredByHigherTiles(layer, visVp, "fg");
        if (fgZ0?.mesh) {
          const shouldShowFgBase = !fgCovered;
          if (fgZ0.mesh.visible !== shouldShowFgBase) {
            fgZ0.mesh.visible = shouldShowFgBase;
            anyFgChanged = true;
          }
        }
        this._setNativeLevelTextureVisible(layer.level, "foreground", !fgCovered);
      }
    }
    if (anyBgChanged || anyFgChanged) {
      canvas.primary.sortDirty = true;
    }
    if (anyBgChanged) {
      const multiElev = this._hasMultiElevationDepth ? this._hasMultiElevationDepth() : (this.visibleLevelLayers.length > 1);
      this._markDepthDirty({ elev: true, syncElev: multiElev });
    }
    return anyBgChanged || anyFgChanged;
  },

  rectsOverlap(ax, ay, asz, bx, by, bsz) {
    return !(ax + asz <= bx + 1 || ax + 1 >= bx + bsz || ay + asz <= by + 1 || ay + 1 >= by + bsz);
  },

  hasReadyOtherZCovering(e, bucket = null) {
    const ch = e.channel || "bg";
    const isTranslucent = ch === "fg" || Boolean(e.layer?.isUpper);
    if (bucket) {
      for (let i = 0; i < bucket.length; i++) {
        const other = bucket[i];
        const zMatch = isTranslucent ? (other.z !== e.z) : (other.z < e.z);
        if (zMatch && this.rectsOverlap(e.x0, e.y0, e.sizePx, other.x0, other.y0, other.sizePx)) {
          return true;
        }
      }
      return false;
    }
    for (const [, other] of this.tilesByKey) {
      const zMatch = isTranslucent ? (other.z !== e.z) : (other.z < e.z);
      if (other.levelId === e.levelId && (other.channel || "bg") === ch && other.ready && !other.awaitingSwap && other.z > 0 && zMatch && other.mesh?.visible && other.alpha >= 0.9 &&
          this.rectsOverlap(e.x0, e.y0, e.sizePx, other.x0, other.y0, other.sizePx)) {
        return true;
      }
    }
    return false;
  },

  hasReadyAncestorCovering(e) {
    const ch = e.channel || "bg";
    for (const [, other] of this.tilesByKey) {
      if (other.levelId === e.levelId && (other.channel || "bg") === ch && other.ready && other.z > 0 && other.z < e.z && other.alpha >= 0.9 &&
          this.rectsOverlap(e.x0, e.y0, e.sizePx, other.x0, other.y0, other.sizePx)) {
        return true;
      }
    }
    return false;
  },

  isTileFullyReplacedByDesired(e, vp = null, bucket = null) {
    const ch = e.channel || "bg";
    const s = e.sizePx;
    let rx0 = e.x0;
    let ry0 = e.y0;
    let rx1 = e.x0 + s;
    let ry1 = e.y0 + s;
    const b = e.layer?.bounds;
    if (b) {
      rx0 = Math.max(rx0, b.x);
      ry0 = Math.max(ry0, b.y);
      rx1 = Math.min(rx1, b.x + b.w);
      ry1 = Math.min(ry1, b.y + b.h);
    }
    if (vp) {
      rx0 = Math.max(rx0, vp.x0);
      ry0 = Math.max(ry0, vp.y0);
      rx1 = Math.min(rx1, vp.x1);
      ry1 = Math.min(ry1, vp.y1);
    }
    if (rx1 <= rx0 || ry1 <= ry0) return true;
    const rw = rx1 - rx0;
    const rh = ry1 - ry0;
    const p0x = rx0 + rw * 0.25, p1x = rx0 + rw * 0.75;
    const p0y = ry0 + rh * 0.25, p1y = ry0 + rh * 0.75;
    let c0 = false, c1 = false, c2 = false, c3 = false;
    if (bucket) {
      for (let i = 0; i < bucket.length; i++) {
        const other = bucket[i];
        const ox0 = other.x0, oy0 = other.y0, ox1 = ox0 + other.sizePx, oy1 = oy0 + other.sizePx;
        if (!c0 && p0x >= ox0 && p0x <= ox1 && p0y >= oy0 && p0y <= oy1) c0 = true;
        if (!c1 && p1x >= ox0 && p1x <= ox1 && p0y >= oy0 && p0y <= oy1) c1 = true;
        if (!c2 && p0x >= ox0 && p0x <= ox1 && p1y >= oy0 && p1y <= oy1) c2 = true;
        if (!c3 && p1x >= ox0 && p1x <= ox1 && p1y >= oy0 && p1y <= oy1) c3 = true;
        if (c0 && c1 && c2 && c3) return true;
      }
      return false;
    }
    for (const [, other] of this.tilesByKey) {
      if (other.levelId === e.levelId && (other.channel || "bg") === ch && other.desired && other.ready && !other.awaitingSwap && other.mesh?.visible && other.z > 0 && other.alpha >= 0.98) {
        const ox0 = other.x0, oy0 = other.y0, ox1 = ox0 + other.sizePx, oy1 = oy0 + other.sizePx;
        if (!c0 && p0x >= ox0 && p0x <= ox1 && p0y >= oy0 && p0y <= oy1) c0 = true;
        if (!c1 && p1x >= ox0 && p1x <= ox1 && p0y >= oy0 && p0y <= oy1) c1 = true;
        if (!c2 && p0x >= ox0 && p0x <= ox1 && p1y >= oy0 && p1y <= oy1) c2 = true;
        if (!c3 && p1x >= ox0 && p1x <= ox1 && p1y >= oy0 && p1y <= oy1) c3 = true;
        if (c0 && c1 && c2 && c3) return true;
      }
    }
    return false;
  },

  _hasPendingVisibleRoofs(layer, visVp) {
    if (!layer?.hasPyramid || !visVp) return false;
    const localZ = layer.lastTargetZ - layer.zOffset;
    if (localZ < 5 || !this._shouldMountRoofs(layer, visVp.scale)) return false;
    const overlays = layer.spec?.overlays;
    if (!hasSpecOverlays(overlays)) return false;
    const topElev = getLevelRoofElevation(layer.level);
    const viewedBottom = getLevelBottomElevation(canvas.level);
    if (!layer.level.isView && viewedBottom >= topElev) return false;

    const lid = layer.level.id;
    const overlapsVis = (ovSpec) => {
      if (!ovSpec?.roof) return false;
      const halfDiag = Math.hypot(ovSpec.w || 0, ovSpec.h || 0) * 0.5;
      return ovSpec.cx + halfDiag >= visVp.x0 && ovSpec.cx - halfDiag <= visVp.x1 &&
             ovSpec.cy + halfDiag >= visVp.y0 && ovSpec.cy - halfDiag <= visVp.y1;
    };
    for (let i = 0; i < this.pendingOverlayMounts.length; i++) {
      const po = this.pendingOverlayMounts[i];
      if (po?.lid === lid && overlapsVis(po.ovSpec)) return true;
    }
    const prefix = `${lid}::`;
    for (const fullKey of this.overlayPending) {
      if (!fullKey.startsWith(prefix) || fullKey.endsWith(":w")) continue;
      const rawOid = fullKey.slice(prefix.length);
      if (overlapsVis(overlays[rawOid])) return true;
    }
    return false;
  },

  hasAnyReadyDesiredUnderneath(e) {
    const ch = e.channel || "bg";
    for (const [, other] of this.tilesByKey) {
      if (other.levelId === e.levelId && (other.channel || "bg") === ch && other.desired && other.ready && other.z < e.z && other.alpha >= 0.99 &&
          this.rectsOverlap(e.x0, e.y0, e.sizePx, other.x0, other.y0, other.sizePx)) {
        return true;
      }
    }
    return false;
  },

  _setNativeLevelTextureVisible(level, kind, visible) {
    const store = kind === "foreground" ? this._hiddenNativeLevelFg : this._hiddenNativeLevelBg;
    let lt = store.get(level.id);
    if (!lt || lt.destroyed) {
      const targetName = `Level.${level.index}.${kind}`;
      const list = canvas.primary?.levelTextures;
      if (!list?.length) return;
      for (let i = 0; i < list.length; i++) {
        if (list[i]?.name === targetName) { lt = list[i]; break; }
      }
      if (!lt) return;
    }
    if (!visible) {
      if (lt.visible) {
        lt.visible = false;
        store.set(level.id, lt);
      }
    } else if (store.has(level.id)) {
      lt.visible = true;
      store.delete(level.id);
    }
  },

  stepCrossfades(dtMs) {
    if (!this.active || !canvas?.ready) return;

    this.tokenStreamer.step(dtMs);
    this._stepDynamicLightFades?.(dtMs);

    // Keep CanvasDepthMask synced whenever any mounted roof fades in/out (hoverFade, ALT, token inside, or v14 Region Surface)
    // Also dynamically reveal interior z=6 tiles + wallsMesh on z=5 when a roof is occluded so ALT / tokens / Regions expose real interiors instead of baked pyramid roofs
    const occSurfaces = canvas.masks?.occlusion?.occludedSurfaces;
    let nextRevealSpecs = null;
    let occH1 = 2166136261 >>> 0;
    let occH2 = (occSurfaces?.size ?? 0) | 0;
    let occCount = 0;
    if (this.activeOverlays.size > 0) {
      let ovIdx = 0;
      for (const [k, ov] of this.activeOverlays) {
        ovIdx++;
        const rm = ov.roofMesh;
        if (!rm?.visible) continue;
        const fadeAmt = Math.round((rm._occlusionState?.fade ?? 0) * 10);
        const hoverAmt = Math.round((rm._hoverFadeState?.occlusion ?? 0) * 10);
        const revealed = this._isRoofRevealed(rm, occSurfaces);
        const v = ((ovIdx << 12) ^ ((rm.occluded ? 1 : 0) << 10) ^ (fadeAmt << 5) ^ (hoverAmt << 1) ^ (revealed ? 1 : 0)) | 0;
        occH1 = Math.imul(occH1 ^ v, 16777619) >>> 0;
        occH2 = ((occH2 << 5) - occH2 + v + 1) | 0;
        occCount++;

        const layer = this.levelLayers.get(ov.levelId);
        const localZ = layer ? (layer.lastTargetZ - layer.zOffset) : -1;
        const needRevealSubtile = Boolean(layer && ((localZ < 5) || (localZ === 5 && ov.srcWalls)));
        if (needRevealSubtile) {
          if (revealed) {
            if (ov.wallsMesh) {
              if (!ov.wallsMesh.visible) ov.wallsMesh.visible = true;
              if (ov.wallsMesh.unoccludedAlpha !== 1.0) ov.wallsMesh.unoccludedAlpha = 1.0;
            } else if (ov.ovSpec && ov.srcWalls) {
              this._ensureOverlayWallsMesh(k, layer, ov.ovSpec);
            }
            const revealZ = Math.min(layer.maxZoomZ, layer.zOffset + (ov.srcWalls ? 6 : 5));
            if (layer.hasPyramid && revealZ > layer.lastTargetZ && ov.ovSpec) {
              const { bounds } = layer;
              const { nx, ny } = this._getPyramidGridDims(layer, revealZ);
              const tileWorldSize = this._getPyramidTileSize(layer, revealZ);
              const w = ov.ovSpec.w || 0;
              const h = ov.ovSpec.h || 0;
              const rot = ov.ovSpec.rot || 0;
              let halfW = w * 0.55;
              let halfH = h * 0.55;
              if (rot) {
                const rad = (rot * Math.PI) / 180;
                const c = Math.abs(Math.cos(rad));
                const s = Math.abs(Math.sin(rad));
                halfW = (w * c + h * s) * 0.55;
                halfH = (w * s + h * c) * 0.55;
              }
              const rx0 = Math.max(bounds.x, ov.ovSpec.cx - halfW);
              const ry0 = Math.max(bounds.y, ov.ovSpec.cy - halfH);
              const rx1 = Math.min(bounds.x + bounds.w, ov.ovSpec.cx + halfW);
              const ry1 = Math.min(bounds.y + bounds.h, ov.ovSpec.cy + halfH);
              if (rx0 < rx1 && ry0 < ry1) {
                const tx0 = Math.max(0, Math.floor((rx0 - bounds.x) / tileWorldSize));
                const ty0 = Math.max(0, Math.floor((ry0 - bounds.y) / tileWorldSize));
                const tx1 = Math.min(nx - 1, Math.floor((rx1 - 0.001 - bounds.x) / tileWorldSize));
                const ty1 = Math.min(ny - 1, Math.floor((ry1 - 0.001 - bounds.y) / tileWorldSize));
                for (let ty = ty0; ty <= ty1; ty++) {
                  for (let tx = tx0; tx <= tx1; tx++) {
                    const spec = this.resolvePyramidTile(layer, revealZ, tx, ty);
                    if (!nextRevealSpecs) nextRevealSpecs = new Map();
                    nextRevealSpecs.set(spec.key, { layer, spec });
                  }
                }
              }
            }
          } else if (ov.wallsMesh?.visible) {
            ov.wallsMesh.visible = false;
          }
        }
      }
    }
    // Track light/weather-restricting virtual & native tiles with occlusion using 0-allocation integer hashing
    if (this.activeVirtualTiles.size > 0) {
      let vtIdx = 0;
      for (const vt of this.activeVirtualTiles.values()) {
        vtIdx++;
        const m = vt?.mesh;
        if (!m || m.destroyed || (!m.restrictsLight && !m.restrictsWeather) || m.occlusionMode === CONST.OCCLUSION_MODES.NONE) continue;
        const v = (0x100000 ^ (vtIdx << 8) ^ Math.round((m._occlusionState?.fade ?? m.alpha ?? 1) * 100)) | 0;
        occH1 = Math.imul(occH1 ^ v, 16777619) >>> 0;
        occH2 = ((occH2 << 5) - occH2 + v + 1) | 0;
        occCount++;
      }
    }
    const nativeTiles = canvas.tiles?.placeables;
    if (nativeTiles?.length) {
      for (let i = 0; i < nativeTiles.length; i++) {
        const m = nativeTiles[i]?.mesh;
        if (!m || m.destroyed || (!m.restrictsLight && !m.restrictsWeather) || m.occlusionMode === CONST.OCCLUSION_MODES.NONE) continue;
        const v = (0x200000 ^ (i << 8) ^ Math.round((m._occlusionState?.fade ?? m.alpha ?? 1) * 100)) | 0;
        occH1 = Math.imul(occH1 ^ v, 16777619) >>> 0;
        occH2 = ((occH2 << 5) - occH2 + v + 1) | 0;
        occCount++;
      }
    }
    if (this.visibleLevelLayers.length > 1 && this.tilesByKey.size > 0) {
      let ptIdx = 0;
      for (const e of this.tilesByKey.values()) {
        const m = e?.mesh;
        if (!e?.ready || !e.layer?.isUpper || !m || m.destroyed || !m.visible || (!m.restrictsLight && !m.restrictsWeather)) continue;
        ptIdx++;
        const v = (0x300000 ^ (ptIdx << 8) ^ Math.round((m._occlusionState?.fade ?? m.alpha ?? 1) * 100)) | 0;
        occH1 = Math.imul(occH1 ^ v, 16777619) >>> 0;
        occH2 = ((occH2 << 5) - occH2 + v + 1) | 0;
        occCount++;
      }
    }
    if (occH1 !== this._lastRoofOccH1 || occH2 !== this._lastRoofOccH2 || occCount !== this._lastRoofOccCount) {
      this._lastRoofOccH1 = occH1;
      this._lastRoofOccH2 = occH2;
      this._lastRoofOccCount = occCount;
      this._depthDirty = true;
      if (canvas.masks?.depth) canvas.masks.depth.renderDirty = true;
    }

    // Reconcile localized z=6 interior reveal tiles on z=5
    if ((nextRevealSpecs && nextRevealSpecs.size > 0) || this._revealTileKeys.size > 0) {
      for (const oldKey of this._revealTileKeys) {
        if (nextRevealSpecs?.has(oldKey)) continue;
        const e = this.tilesByKey.get(oldKey);
        if (e) {
          e.isReveal = false;
          if (e.layer && e.z !== e.layer.lastTargetZ) {
            // Preserve live z=6 blockFlags fallback tiles when currently viewing targetZ=7
            const isBlockFallback = Boolean(
              e.layer.spec?.blockFlags &&
              (e.layer.lastTargetZ - e.layer.zOffset) === 7 &&
              (e.z - e.layer.zOffset) === 6 &&
              this.resolvePyramidTile(e.layer, e.layer.lastTargetZ, e.x * 2, e.y * 2)?.key === e.key
            );
            if (!isBlockFallback) {
              e.desired = false;
              this._tilesDirty = true;
            }
          }
        }
        this._revealTileKeys.delete(oldKey);
      }
      if (nextRevealSpecs) {
        for (const [key, { layer, spec }] of nextRevealSpecs) {
          this._revealTileKeys.add(key);
          const existing = this.tilesByKey.get(key);
          if (existing) {
            existing.isReveal = true;
            existing.desired = true;
            existing.fadingOut = false;
            if (existing.ready && existing.alpha < 1.0) {
              existing.alpha = 1.0;
              if (existing.mesh) existing.mesh.unoccludedAlpha = 1.0;
            }
          } else {
            this.ensureTile(layer, spec, false);
            const created = this.tilesByKey.get(key);
            if (created) created.isReveal = true;
          }
        }
      }
    }

    const estimateFreshUploadBytes = (tex) => {
      const bt = tex?.baseTexture;
      if (!bt) return 0;
      if (bt._glTextures) {
        for (const _ in bt._glTextures) return 0;
      }
      return this.texMgr._estimateBytes(tex);
    };
    const tFrameStart = performance.now();
    const isMoving = this.isActivelyMoving();
    const stepBudgetMs = isMoving ? 1.8 : 3.0;
    const HEAVY_UPLOAD_BYTES = 2 * 1024 * 1024; // 1024px+ pyramid tiles & roofs; small prop sprites (<=2MB) use the byte + small-count budget
    const gpuUploadBudget = isMoving ? (5 * 1024 * 1024) : Math.min(9 * 1024 * 1024, MAX_GPU_UPLOAD_BYTES_PER_FRAME);
    const maxHeavyUploads = isMoving ? 1 : 2;
    const maxSmallUploads = isMoving ? 6 : 14;
    let frameGpuUploadBytes = 0;
    let frameHeavyUploads = 0;
    let frameSmallUploads = 0;

    const canUploadFresh = (estBytes) => {
      if (estBytes <= 0) return true;
      if (estBytes > HEAVY_UPLOAD_BYTES) {
        if (frameHeavyUploads >= maxHeavyUploads) return false;
      } else {
        if (frameSmallUploads >= maxSmallUploads) return false;
      }
      if (frameGpuUploadBytes > 0 && (frameGpuUploadBytes + estBytes) > gpuUploadBudget) return false;
      return true;
    };
    const recordFreshUpload = (estBytes) => {
      if (estBytes <= 0) return;
      frameGpuUploadBytes += estBytes;
      if (estBytes > HEAVY_UPLOAD_BYTES) frameHeavyUploads++;
      else frameSmallUploads++;
    };

    const bindTextureNow = (tex) => {
      const bt = tex?.baseTexture;
      if (bt && !bt.destroyed && canvas.app?.renderer?.texture?.bind) {
        try { canvas.app.renderer.texture.bind(bt); } catch {}
      }
    };

    // 1. Pyramid tiles FIRST so zoom/pan never starves background chunks behind heavy 4K roofs or hundreds of props!
    if (this.pendingTileMounts.length > 0) {
      const maxMounts = isMoving ? 6 : 16;
      let mounted = 0;
      while (this.pendingTileMounts.length > 0 && mounted < maxMounts) {
        if (mounted > 0 && (performance.now() - tFrameStart) >= stepBudgetMs) break;
        const peek = this.pendingTileMounts[0];
        const estBytes = estimateFreshUploadBytes(peek?.tex);
        if (!canUploadFresh(estBytes)) break;
        const item = this.pendingTileMounts.shift();
        const e = this.tilesByKey.get(item.key);
        if (!e || e !== item.entry || e.ready || e.fadingOut || (!e.desired && e.z > 0)) continue;
        const tex = isTextureUsable(item.tex) ? item.tex : this.texMgr.getSync(e.src);
        if (!isTextureUsable(tex)) {
          this.tilesByKey.delete(item.key);
          if (e.layer) {
            if (e.channel === "fg") e.layer.lastForegroundPyramidKey = "";
            else e.layer.lastPyramidKey = "";
          }
          continue;
        }
        if (this._mountTileMesh(e, tex, item.instant)) {
          mounted++;
          if (estBytes > 0) {
            // Pre-upload EVERY fresh tile (visible, awaitingSwap, AND offscreen-padded!) within this frame's budget
            // so zooming out into the 28% padding never bursts 8-11 deferred gl.texImage2D uploads in a single render frame!
            bindTextureNow(tex);
            recordFreshUpload(estBytes);
          }
        }
      }
      if (this.pendingTileMounts.length > 0) this._tilesDirty = true;
    }

    // 2. Frame-budgeted overlay mounting: cached GPU roofs mount instantly; fresh roofs cap at 1/frame
    //    (allow mounting even while pyramid tiles queue if visible z>=5 tiles are waiting on these roofs so interiors never flash!)
    if (this.pendingOverlayMounts.length > 0) {
      const maxCachedOvMounts = isMoving ? 6 : 12;
      let mountedOv = 0;
      let freshHeavyOv = 0;
      const curVp = this.getViewportWorldRect(0.35, null, { predictive: !this.isCameraFlying });
      const visNow = this.getViewportWorldRect(0.0);
      const roofsBlockingZ5 = this.visibleLevelLayers.some(l => this._hasPendingVisibleRoofs(l, visNow));
      while (this.pendingOverlayMounts.length > 0 && mountedOv < maxCachedOvMounts) {
        if ((mountedOv > 0 || frameGpuUploadBytes > 0) && (performance.now() - tFrameStart) >= stepBudgetMs) {
          if (!roofsBlockingZ5 || mountedOv > 0) break;
        }
        const peek = this.pendingOverlayMounts[0];
        const estBytes = estimateFreshUploadBytes(peek?.tRoof) + estimateFreshUploadBytes(peek?.tWalls);
        if (estBytes > 0) {
          if (!canUploadFresh(estBytes)) break;
          if (estBytes > HEAVY_UPLOAD_BYTES && (freshHeavyOv > 0 || (!roofsBlockingZ5 && isMoving && this.pendingTileMounts.length > 0))) break;
        }
        const item = this.pendingOverlayMounts.shift();
        if (item?.fullId) this._pendingOverlayKeys.delete(item.fullId);
        if (this._mountOverlayMeshes(item, curVp)) {
          mountedOv++;
          if (estBytes > 0) {
            if (estimateFreshUploadBytes(item.tRoof) > 0) bindTextureNow(item.tRoof);
            if (estimateFreshUploadBytes(item.tWalls) > 0) bindTextureNow(item.tWalls);
            recordFreshUpload(estBytes);
            if (estBytes > HEAVY_UPLOAD_BYTES) freshHeavyOv++;
          }
        }
      }
      if (mountedOv > 0) {
        canvas.primary.sortDirty = true;
        this._tilesDirty = true;
        this._occlusionDirty = true;
        this._markDepthDirty({ syncElev: true });
        this._roofTokenOccDirty = true;
        this.invalidateShowstopperSurfaces();
      }
      if (this.pendingOverlayMounts.length > 0) this._tilesDirty = true;
    }

    // 3. Frame-budgeted virtual tile mounting (small prop textures use byte + small-count budget so rooms never pop in 2 props/frame)
    if (this.pendingVirtualTileMounts.length > 0 && (performance.now() - tFrameStart) < stepBudgetMs) {
      const maxVtMounts = isMoving ? 14 : 32;
      let mountedVt = 0;
      let anyVtLight = false;
      let anyVtOcc = false;
      const curVp = this.getViewportWorldRect(0.28, null, { predictive: !this.isCameraFlying });
      while (this.pendingVirtualTileMounts.length > 0 && mountedVt < maxVtMounts) {
        if ((mountedVt > 0 || frameGpuUploadBytes > 0) && (performance.now() - tFrameStart) >= stepBudgetMs) break;
        const peek = this.pendingVirtualTileMounts[0];
        const estBytes = estimateFreshUploadBytes(peek?.tex);
        if (!canUploadFresh(estBytes)) break;
        const item = this.pendingVirtualTileMounts.shift();
        if (item?.fullId) this._pendingVirtualTileKeys.delete(item.fullId);
        const m = this._mountVirtualTileMesh(item, curVp);
        if (m) {
          mountedVt++;
          if (estBytes > 0) {
            bindTextureNow(item.tex);
            recordFreshUpload(estBytes);
          }
          if (m.restrictsLight || m.restrictsWeather) anyVtLight = true;
          if (m.occlusionMode !== CONST.OCCLUSION_MODES.NONE) anyVtOcc = true;
        }
      }
      if (mountedVt > 0) {
        canvas.primary.sortDirty = true;
        this.invalidateShowstopperSurfaces();
        if (anyVtOcc) {
          this._occlusionDirty = true;
          this._roofTokenOccDirty = true;
        }
        if (anyVtLight) {
          this._markDepthDirty({ syncElev: true });
        }
      }
      if (this.pendingVirtualTileMounts.length > 0) this._tilesDirty = true;
    } else if (this.pendingVirtualTileMounts.length > 0) {
      this._tilesDirty = true;
    }

    if (this._depthElevSyncNeeded) {
      this._depthElevSyncNeeded = false;
      this.lightBatch.syncDepthElevations(this._hasMultiElevationDepth());
      if (canvas.masks?.depth) canvas.masks.depth._elevationDirty = true;
      this._depthDirty = true;
      if (canvas.masks?.depth) canvas.masks.depth.renderDirty = true;
    }

    if (this._depthDirty || this._depthDeferred) {
      this._depthDirty = false;
      this._depthDeferred = false;
      this._lastDepthRenderMs = performance.now();
      if (canvas.masks?.depth) {
        canvas.masks.depth.renderDirty = true;
      }
    }

    if (this._occlusionDirty) {
      const nowOcc = performance.now();
      if (!isMoving || (nowOcc - this._lastOccRefreshMs) >= 120) {
        this._occlusionDirty = false;
        this._lastOccRefreshMs = nowOcc;
        canvas.perception.update({ refreshOcclusion: true, refreshOcclusionStates: true, refreshOcclusionMask: true });
      }
    }

    if (this._showstopperDirty && (!isMoving || (performance.now() - this._lastShowstopperMs) >= 200)) {
      this.invalidateShowstopperSurfaces(true);
    }

    if (this._waitingForRoofsBeforeIndoor) {
      this._syncIndoorLightVisibility();
    }

    if (this._roofTokenOccDirty) {
      this._roofTokenOccDirty = false;
      this.syncRoofTokenOcclusion();
    }

    // Once camera settles after zoom/pan, perform a single clean pass to trim far-offscreen virtual tiles & fill padding
    if (this._vtIdleCleanupNeeded && !isMoving && this.pendingTileMounts.length === 0) {
      this._vtIdleCleanupNeeded = false;
      const idleVp = this.getViewportWorldRect(0.28);
      for (const layer of this.visibleLevelLayers) {
        if (!layer.spec?.tiles?.length) continue;
        layer.lastTileKey = "";
        this.syncVirtualTiles(layer, layer.lastTargetZ >= 0 ? layer.lastTargetZ : this._computeTargetZ(layer, idleVp.scale), idleVp);
      }
    }

    // Incremental VRAM pruning strictly while camera is idle (max 4 textures/frame) to prevent D3D11/WebGL texture-delete pipeline stalls during zoom
    if (this._pruneNeeded && !isMoving && this.pendingTileMounts.length === 0) {
      if (!this.texMgr.needsPrune()) {
        this._pruneNeeded = false;
      } else {
        const evicted = this.texMgr.prune(this._collectInUseTextures(), 4);
        if (evicted === 0 || !this.texMgr.needsPrune()) {
          this._pruneNeeded = false;
        }
      }
    }

    if (!this._tilesDirty) return;

    const safeDt = (Number.isFinite(dtMs) && dtMs > 0) ? Math.min(dtMs, 250) : 16.6;
    const step = safeDt / CROSSFADE_MS;
    const vp = this.getViewportWorldRect(0.28);
    const visVp = this.getViewportWorldRect(0.0);
    const toDelete = [];
    let stillActive = false;
    let anyPyramidSwapped = false;
    let anyBgPyramidSwapped = false;

    const levelReadyState = new Map();
    const fgReadyState = new Map();
    for (const layer of this.visibleLevelLayers) {
      levelReadyState.set(layer.level.id, {
        allReadyOpaque: layer.lastTargetZ > 0,
        visDesiredReady: layer.lastTargetZ > 0,
        hasDesiredNonZero: false,
        hasVisDesiredNonZero: false,
        finestZ6Alpha: 0.0
      });
      if (layer.hasForegroundPyramid) {
        fgReadyState.set(layer.level.id, {
          allReadyOpaque: layer.lastForegroundTargetZ > 0,
          visDesiredReady: layer.lastForegroundTargetZ > 0,
          hasDesiredNonZero: false,
          hasVisDesiredNonZero: false
        });
      }
    }

    // Pass 1: inspect readiness of desired tiles per level and channel (background & optional foreground)
    for (const [, e] of this.tilesByKey) {
      if (e.z === 0 || !e.desired || e.isReveal) continue;
      const isFg = e.channel === "fg";
      const st = isFg ? fgReadyState.get(e.levelId) : levelReadyState.get(e.levelId);
      if (!st) continue;
      st.hasDesiredNonZero = true;
      const inVis = !(e.x0 + e.sizePx < visVp.x0 || e.x0 > visVp.x1 || e.y0 + e.sizePx < visVp.y0 || e.y0 > visVp.y1);
      if (inVis) {
        st.hasVisDesiredNonZero = true;
        if (!e.ready) st.visDesiredReady = false;
      }
      if (!e.ready || e.alpha < 0.99 || e.awaitingSwap) {
        st.allReadyOpaque = false;
        stillActive = true;
      }
    }

    // Hold z>=5 interior-cutout swap until all visible roofs for that level are mounted so bare interiors never flash on zoom-in!
    for (const layer of this.visibleLevelLayers) {
      const st = levelReadyState.get(layer.level.id);
      if (st && st.visDesiredReady && this._hasPendingVisibleRoofs(layer, visVp)) {
        st.visDesiredReady = false;
        stillActive = true;
      }
    }

    // Pre-bucket ready tiles by (levelId, channel) in O(M) to avoid O(M^2) inner scans in Pass 2
    const readyVisBuckets = new Map();
    const readyDesBuckets = new Map();
    for (const e of this.tilesByKey.values()) {
      if (!e.ready || e.awaitingSwap || e.z <= 0 || !e.mesh?.visible) continue;
      const bk = `${e.levelId}::${e.channel || "bg"}`;
      if (e.alpha >= 0.9) {
        let arr = readyVisBuckets.get(bk);
        if (!arr) { arr = []; readyVisBuckets.set(bk, arr); }
        arr.push(e);
      }
      if (e.desired && e.alpha >= 0.98) {
        let arr = readyDesBuckets.get(bk);
        if (!arr) { arr = []; readyDesBuckets.set(bk, arr); }
        arr.push(e);
      }
    }

    // Pass 2: atomic 1-frame LOD swap once all visible desired tiles are ready (zero double-alpha blending & zero depth flicker!)
    for (const [k, e] of this.tilesByKey) {
      const isFg = e.channel === "fg";
      const st = isFg ? fgReadyState.get(e.levelId) : levelReadyState.get(e.levelId);
      if (e.z === 0) continue;
      const bk = `${e.levelId}::${e.channel || "bg"}`;

      if (e.desired) {
        if (e.ready && e.awaitingSwap) {
          const canSwapNow = Boolean(st?.visDesiredReady)
            || !this.hasReadyOtherZCovering(e, readyVisBuckets.get(bk) || EMPTY_ARRAY);
          if (canSwapNow) {
            e.awaitingSwap = false;
            e.alpha = 1.0;
            if (e.mesh) {
              e.mesh.unoccludedAlpha = 1.0;
              e.mesh.visible = true;
              this._syncShowstopperMeshDof(e.mesh);
            }
            let visArr = readyVisBuckets.get(bk);
            if (!visArr) { visArr = []; readyVisBuckets.set(bk, visArr); }
            visArr.push(e);
            let desArr = readyDesBuckets.get(bk);
            if (!desArr) { desArr = []; readyDesBuckets.set(bk, desArr); }
            desArr.push(e);
            anyPyramidSwapped = true;
            if (!isFg) anyBgPyramidSwapped = true;
          } else {
            stillActive = true;
          }
        } else if (e.ready && e.alpha < 1.0) {
          e.alpha = Math.min(1.0, e.alpha + step);
          if (e.mesh) e.mesh.unoccludedAlpha = e.alpha;
          if (e.alpha < 1.0) stillActive = true;
        }
        if (!isFg && st && e.layer && (e.z - e.layer.zOffset) >= 6 && !e.isReveal && e.ready && !e.awaitingSwap && e.alpha > st.finestZ6Alpha) {
          st.finestZ6Alpha = e.alpha;
        }
      } else {
        stillActive = true;
        const onScreen = !(e.x0 + e.sizePx < vp.x0 || e.x0 > vp.x1 || e.y0 + e.sizePx < vp.y0 || e.y0 > vp.y1);
        if (!onScreen || !e.ready) {
          toDelete.push(k);
          continue;
        }
        const curTargetZ = isFg ? e.layer.lastForegroundTargetZ : e.layer.lastTargetZ;
        const baseKey = isFg ? `${e.levelId}::fg::0_0_0` : `${e.levelId}::0_0_0`;
        const baseReady = Boolean(this.tilesByKey.get(baseKey)?.ready) || (isFg && !this.hasForegroundTile(e.layer, 0, 0, 0));
        const inVis = !(e.x0 + e.sizePx < visVp.x0 || e.x0 > visVp.x1 || e.y0 + e.sizePx < visVp.y0 || e.y0 > visVp.y1);
        const replacedByDesired = (!isFg && e.z < curTargetZ && inVis)
          ? this.isTileFullyReplacedByDesired(e, visVp, readyDesBuckets.get(bk) || EMPTY_ARRAY)
          : true;
        const canDropOld = (curTargetZ === 0 && baseReady)
          || (isFg
              ? Boolean(st?.visDesiredReady && curTargetZ > 0)
              : Boolean(st?.visDesiredReady && st?.hasVisDesiredNonZero && replacedByDesired));
        if (canDropOld || !inVis || (st?.visDesiredReady && !st.hasVisDesiredNonZero && e.z > curTargetZ)) {
          toDelete.push(k);
          anyPyramidSwapped = true;
          if (!isFg) anyBgPyramidSwapped = true;
        } else if (e.z < curTargetZ) {
          if (this.isTileFullyReplacedByDesired(e, vp, readyDesBuckets.get(bk) || EMPTY_ARRAY)) {
            toDelete.push(k);
            anyPyramidSwapped = true;
            if (!isFg) anyBgPyramidSwapped = true;
          }
        } else if (e.fadingOut) {
          e.alpha = Math.max(0.0, e.alpha - step);
          if (e.mesh) e.mesh.unoccludedAlpha = e.alpha;
          if (e.alpha <= 0.01) toDelete.push(k);
        }
      }
    }

    // Hide z=0 base meshes & native Foundry level textures whenever sharper tiles (z > 0) cover the screen
    if (this._syncBaseLayerVisibility(visVp, levelReadyState, fgReadyState)) {
      anyPyramidSwapped = true;
    }

    if (anyPyramidSwapped) {
      canvas.primary.sortDirty = true;
    }
    if (anyBgPyramidSwapped && canvas.masks?.depth) {
      canvas.masks.depth._elevationDirty = true;
      canvas.masks.depth.renderDirty = true;
    }

    const retiringOvKeys = [];
    for (const [ovKey, ov] of this.activeOverlays) {
      const layer = this.levelLayers.get(ov.levelId);
      const localZ = layer ? (layer.lastTargetZ - layer.zOffset) : -1;
      const roofsMounted = this._shouldMountRoofs(layer, vp.scale);
      const st = levelReadyState.get(ov.levelId);
      if (ov.retiring) {
        const z4Ready = !layer?.hasPyramid || Boolean(st?.visDesiredReady && st?.hasVisDesiredNonZero) || Boolean(st?.allReadyOpaque) || layer.lastTargetZ <= 0;
        const spec = ov.ovSpec;
        const halfDiag = spec ? Math.hypot(spec.w || 0, spec.h || 0) * 0.5 : 0;
        const offScreen = !spec || (spec.cx + halfDiag < vp.x0 || spec.cx - halfDiag > vp.x1 || spec.cy + halfDiag < vp.y0 || spec.cy - halfDiag > vp.y1);
        if (!roofsMounted && (z4Ready || offScreen)) {
          retiringOvKeys.push(ovKey);
        } else if (!roofsMounted) {
          stillActive = true;
        }
        continue;
      }
      const isZ6 = localZ >= 6;
      const canReveal = roofsMounted;
      const revealOnLowerZ = Boolean(!isZ6 && ov.roofMesh && this._isRoofRevealed(ov.roofMesh, occSurfaces));
      const a = isZ6 ? (st ? st.finestZ6Alpha : 1.0) : (revealOnLowerZ ? 1.0 : 0.0);
      if (ov.wallsMesh) {
        ov.wallsMesh.visible = a > 0.02;
        if (Math.abs(ov.wallsMesh.unoccludedAlpha - a) > 0.001) {
          ov.wallsMesh.unoccludedAlpha = a;
        }
      }
      if (ov.roofMesh) {
        const wantOcc = canReveal
          ? (CONST.OCCLUSION_MODES.FADE | CONST.OCCLUSION_MODES.RADIAL | CONST.OCCLUSION_MODES.SURFACE)
          : CONST.OCCLUSION_MODES.NONE;
        if (ov.roofMesh.occlusionMode !== wantOcc) {
          ov.roofMesh.occlusionMode = wantOcc;
          if (!canReveal) {
            ov.roofMesh.debounceSetOcclusion?.cancel?.();
            ov.roofMesh.occluded = false;
          }
          this._occlusionDirty = true;
        }
        ov.roofMesh.hoverFade = canReveal;
        if (ov.roofMesh.unoccludedAlpha !== 1.0) ov.roofMesh.unoccludedAlpha = 1.0;
      }
    }

    if (retiringOvKeys.length > 0) {
      let retiredRoof = false;
      for (const ovKey of retiringOvKeys) {
        const ov = this.activeOverlays.get(ovKey);
        if (!ov) continue;
        if (ov.roofMesh) this._emit("overlayRetire", { key: ovKey, ov, mesh: ov.roofMesh });
        if (ov.wallsMesh) this.retireMesh(ov.wallsMesh);
        if (ov.roofMesh) {
          this.retireMesh(ov.roofMesh);
          retiredRoof = true;
        }
        this.activeOverlays.delete(ovKey);
      }
      if (retiredRoof) {
        this._markDepthDirty({ syncElev: true });
        this.syncRoofTokenOcclusion();
        this.invalidateShowstopperSurfaces();
      }
    }

    for (const k of toDelete) {
      const e = this.tilesByKey.get(k);
      if (e?.mesh) this.retireMesh(e.mesh);
      this.tilesByKey.delete(k);
    }

    this._tilesDirty = stillActive;
  }
};
