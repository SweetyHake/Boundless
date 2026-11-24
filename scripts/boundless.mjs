import { PoiManager, registerPoiControls } from "./poi.mjs";
import { CharacterPinManager } from "./character-pins.mjs";
import { ChunkedFogManager, registerFogControls } from "./chunked-fog.mjs";
import { MegaAudioStreamer } from "./audio-streamer.mjs";
import { VirtualWallEditor, registerWallEditorControls } from "./wall-editor.mjs";
import { VirtualLayerEditors, registerLayerEditorControls } from "./layer-editors.mjs";
import { TokenStreamer, installLazyTokenLayerPatch } from "./token-streamer.mjs";
import { ChunkStreamer } from "./chunk-streamer.mjs";
import { LRUTextureManager } from "./texture-manager.mjs";
import { MegaLightBatch } from "./light-batch.mjs";
import { registerConfigUI } from "./config-ui.mjs";
import { PERF_CONFIG, perfStats, resetPerfStats, getPerfStatus } from "./perf-patcher.mjs";
import { invalidateCpuGeometry } from "./perf-cpu.mjs";
import { runPerfBenchmark } from "./perf-benchmark.mjs";
import { WORLD_MIN_SCALE, pyramidMethods } from "./boundless-pyramid.mjs";
import { overlayMethods } from "./boundless-overlays.mjs";
import { lightingMethods } from "./boundless-lighting.mjs";
import { editsMethods } from "./boundless-edits.mjs";
import { MacroSelectionOverlay } from "./boundless-selection.mjs";
import {
  installLosHorizonPatch,
  installBulkSelectionPatch,
  installHoverFadeHitTestPatch,
  registerBoundlessHooks
} from "./boundless-hooks.mjs";
import {
  MODULE_ID,
  getLevelBaseElevation,
  getLevelBottomElevation
} from "./utils.mjs";

/**
 * Parse an optional sparse pyramid tile index (`foregroundTiles`) into a `Set<"z/x_y">`.
 * Supports:
 *  - Object keyed by zoom level: `{ "0": ["0_0"], "3": ["1_2", "2_2"] }`
 *  - Flat array of strings: `["0/0_0", "3/1_2"]` or `["0_0_0", "3_1_2"]`
 * Returns `null` when omitted (meaning all grid tiles are assumed present).
 */
export function parseSparseTileSet(raw) {
  if (!raw || typeof raw !== "object") return null;
  const set = new Set();
  if (Array.isArray(raw)) {
    for (const item of raw) {
      if (typeof item !== "string") continue;
      const clean = item.trim().replace(/\.webp$/i, "");
      if (!clean) continue;
      if (clean.includes("/")) {
        set.add(clean);
      } else {
        const m = /^(\d+)_(\d+)_(\d+)$/.exec(clean);
        if (m) set.add(`${m[1]}/${m[2]}_${m[3]}`);
      }
    }
    return set;
  }
  for (const [zKey, coords] of Object.entries(raw)) {
    const z = Number(zKey);
    if (!Number.isInteger(z) || z < 0 || !Array.isArray(coords)) continue;
    for (const c of coords) {
      if (typeof c === "string" && c.trim()) {
        set.add(`${z}/${c.trim().replace(/\.webp$/i, "")}`);
      } else if (Array.isArray(c) && c.length >= 2) {
        set.add(`${z}/${c[0]}_${c[1]}`);
      }
    }
  }
  return set;
}

class MegaWorld1000 {
  active = false;
  _mountedSceneId = null;
  _cachedSceneId = null;
  manifest = null;            // Legacy/primary manifest reference (for backwards compatibility)
  manifestCache = new Map();  // manifestUrl -> parsed manifest JSON
  levelLayers = new Map();    // levelId -> { level, spec, hasPyramid, pyramidBaseUrl, maxZoomZ, worldPx, tilePx, simGrid, simSectorPx, bounds, isUpper, lastPyramidKey, lastOverlayKey, lastTileKey, lastTargetZ }
  visibleLevelLayers = [];    // Sorted ascending by level.elevation.bottom

  texMgr = new LRUTextureManager();

  // Multi-Level Quadtree Pyramid Streamer
  tilesByKey = new Map(); // "${levelId}::${z}_${x}_${y}" -> entry
  meshPool = [];
  tickerFn = null;
  lastTargetZ = -1;
  _tilesDirty = true;
  _lastOverlayAlpha = -1;
  _occlusionDirty = false;
  _depthDirty = true;
  _depthElevSyncNeeded = false;
  _lastDepthRenderMs = 0;
  _depthDeferred = false;
  _origDepthAutoRender = null;
  pendingTileMounts = []; // Frame-budgeted queue (max 4 tile GPU uploads/frame)
  pendingOverlayMounts = []; // Frame-budgeted queue for building roofs/walls on zoom-in
  _pendingOverlayKeys = new Set();
  pendingVirtualTileMounts = []; // Frame-budgeted queue for virtual tile GPU uploads
  _pendingVirtualTileKeys = new Set();
  _mountGen = 0;
  _mountPromise = null;
  _mounting = false;
  _inUpdatePyramid = false;
  _roofTokenOccDirty = false;
  _waitingForRoofsBeforeIndoor = false;
  _roofMaskBaking = false;
  _roofMaskGen = 0;

  // Interactive House & Anchor Overlays (per level: "${levelId}::${oid}")
  activeOverlays = new Map();
  overlayPending = new Set();
  _roofHiddenTokens = new Set();
  _lastRoofOccSig = "";
  _revealTileKeys = new Set();

  // Virtual Streamed Tiles (per level: "${levelId}::${tid}", supports all Foundry v14 Tile properties)
  activeVirtualTiles = new Map();
  virtualTilePending = new Set();

  // Lightweight public event bus for third-party integrations (e.g. burn-living-map) — avoids per-frame polling
  _eventListeners = new Map();

  // Physics Sim-Bubble (Walls in per-level `level.edges`: ONLY around active tokens & open doors)
  simSectors = new Map(); // "${levelId}::${sx}_${sy}" -> { level, edgeIds }
  doorStates = new Map(); // dKey -> ds (0: closed, 1: open, 2: locked)
  openDoors = new Map();  // dKey -> { levelId, x, y, sx, sy, eid }
  closingDoorTimers = new Map(); // dKey -> timeoutId (keeps dynamic lights alive until DoorMesh animation ends)
  lastSimKey = "";

  // Hybrid Multi-Level Lighting: GPU MegaLightBatch (2 draw calls) + dynamic PointLightSources ONLY near open doors / active visionSources
  lightBatch = new MegaLightBatch();
  dynamicLights = new Map(); // "${levelId}::${sk}_${li}" -> PointLightSource
  _lightFades = new Map();   // "${levelId}::${sk}_${li}" -> { dir: "in"|"out", t, dur, ls, baseColorAlpha, baseBgAlpha }
  lastDynLightKey = "";
  _lastActorSimKey = "";
  _updatingBubbles = false;
  _patchedFilters = new Map();
  _origSmaaEnabled = null;
  _origIfVoidEnabled = null;
  _origTextureGcMode = null;
  _hiddenNativeLevelBg = new Map(); // levelId -> PrimarySpriteMesh
  _hiddenNativeLevelFg = new Map(); // levelId -> PrimarySpriteMesh

  // Subsystems: POI fast-travel pins, character avatar tracker, high-res chunked Fog of War, spatial ambient audio, door socket sync
  poiManager = new PoiManager(this);
  charPins = new CharacterPinManager(this);
  fogManager = new ChunkedFogManager();
  audioStreamer = new MegaAudioStreamer();
  wallEditor = new VirtualWallEditor(this);
  layerEditors = new VirtualLayerEditors(this);
  tokenStreamer = new TokenStreamer(this);
  chunkStreamer = new ChunkStreamer(this);
  selectionOverlay = new MacroSelectionOverlay(this);
  wallEdits = new Map();  // levelId -> Map<wKey, null | wallData>
  wallEditsRev = 0;
  lightEdits = new Map(); // levelId -> Map<lKey, null | lightData>
  lightEditsRev = 0;
  soundEdits = new Map(); // levelId -> Map<sKey, null | soundData>
  soundEditsRev = 0;
  tileEdits = new Map();  // levelId -> Map<tKey, null | tileData>
  tileEditsRev = 0;
  _socketRegistered = false;

  // Camera persistence (F5), cinematic POI flight & controlled-token zoom clamp
  _worldMinScale = WORLD_MIN_SCALE;
  _camSaveTimer = null;
  _beforeUnloadFn = null;
  _restoringCamera = false;
  _zoomSyncQueued = false;
  isCameraFlying = false;
  _lastPanMs = 0;
  _camPrevX = null;
  _camPrevY = null;
  _camPrevMs = 0;
  _camVelX = 0;
  _camVelY = 0;
  _webglContextLostFn = null;
  _webglContextLostView = null;
  _pruneNeeded = false;
  _lastOccRefreshMs = 0;
  _showstopperDirty = false;
  _lastShowstopperMs = 0;
  _vtIdleCleanupNeeded = false;
  _prewarmGen = 0;
  _idleLevelPrewarmTimer = null;
  _idleLevelPrewarmGen = 0;
  _prewarmedLevels = new Set();
  _sightBubbleTimer = null;
  _lastSightBubbleMs = 0;
  _hadVisionSources = false;

  async _expandSuperGridManifest(raw) {
    const sg = raw?.superGrid;
    if (!sg?.baseManifestUrl) return raw;
    const base = await this._fetchManifest(sg.baseManifestUrl);
    if (!base) return raw;

    const cols = sg.cols || 6;
    const rows = sg.rows || 6;
    const regionPx = sg.regionPx || base.worldPx || 100000;
    const baseSimGrid = base.simGrid || 40;
    const baseSimSectorPx = base.simSectorPx || Math.ceil(regionPx / baseSimGrid);
    const baseOverlays = base.overlays || [];
    const baseSectors = base.sectors || {};
    const parsedTints = Array.isArray(sg.tints)
      ? sg.tints.map(row => row.map(hex => (typeof hex === "number" ? hex : parseInt(String(hex).replace("#", ""), 16) || 0xffffff)))
      : null;

    const overlays = [];
    const sectors = {};
    let totalWalls = 0, totalDoors = 0, totalLights = 0;

    for (let gy = 0; gy < rows; gy++) {
      const offY = gy * regionPx;
      const secOffY = gy * baseSimGrid;
      for (let gx = 0; gx < cols; gx++) {
        const offX = gx * regionPx;
        const secOffX = gx * baseSimGrid;
        const ovOffset = overlays.length;
        const tint = parsedTints?.[gy]?.[gx] ?? 0xffffff;

        for (let oi = 0; oi < baseOverlays.length; oi++) {
          const bo = baseOverlays[oi];
          overlays.push({
            ...bo,
            cx: bo.cx + offX,
            cy: bo.cy + offY,
            tint
          });
        }

        for (const [bsk, bsec] of Object.entries(baseSectors)) {
          const [bsx, bsy] = bsk.split("_").map(Number);
          const sk = `${secOffX + bsx}_${secOffY + bsy}`;
          const sec = { w: [], d: [], l: [], o: [] };
          if (bsec.w?.length) {
            for (let i = 0; i < bsec.w.length; i++) {
              const w = bsec.w[i];
              const row = [w[0] + offX, w[1] + offY, w[2] + offX, w[3] + offY, w[4], w[5], w[6], w[7], w[8]];
              if (w[9] !== undefined) row.push(w[9]);
              sec.w.push(row);
            }
            totalWalls += sec.w.length;
          }
          if (bsec.d?.length) {
            for (let i = 0; i < bsec.d.length; i++) {
              const d = bsec.d[i];
              const row = [d[0] + offX, d[1] + offY, d[2] + offX, d[3] + offY, d[4], d[5]];
              if (d[6] !== undefined) row.push(d[6]);
              sec.d.push(row);
            }
            totalDoors += sec.d.length;
          }
          if (bsec.l?.length) {
            for (let i = 0; i < bsec.l.length; i++) {
              const l = bsec.l[i];
              const row = [l[0] + offX, l[1] + offY, l[2], l[3], l[4], l[5], l[6], l[7]];
              if (l[8] !== undefined) row.push(l[8]);
              sec.l.push(row);
            }
            totalLights += sec.l.length;
          }
          if (bsec.o?.length) {
            for (let i = 0; i < bsec.o.length; i++) {
              sec.o.push(bsec.o[i] + ovOffset);
            }
          }
          sectors[sk] = sec;
        }
      }
    }

    return {
      ...raw,
      worldPx: raw.worldPx || regionPx * Math.max(cols, rows),
      worldCells: raw.worldCells || Math.round((regionPx * Math.max(cols, rows)) / 100),
      tilePx: raw.tilePx || base.tilePx || 1024,
      simGrid: baseSimGrid * Math.max(cols, rows),
      simSectorPx: baseSimSectorPx,
      blockFlags: base.blockFlags,
      overlays,
      sectors,
      superGrid: { ...sg, parsedTints },
      _superGridBase: base,
      stats: {
        totalWalls,
        totalDoors,
        totalLights,
        overlays: overlays.length,
        provinces: cols * rows
      }
    };
  }

  async _fetchManifest(url) {
    if (!url) return null;
    url = String(url).replaceAll("modules/sh-megamap/", `modules/${MODULE_ID}/`);
    if (this.manifestCache.has(url)) {
      const cached = this.manifestCache.get(url);
      if (cached?.chunks?.baseUrl) {
        return { ...cached, sectors: {}, overlays: {} };
      }
      return cached;
    }
    const sep = url.includes("?") ? "&" : "?";
    const resp = await fetch(`${url}${sep}v=${Date.now()}`);
    if (!resp.ok) throw new Error(`HTTP ${resp.status} loading manifest ${url}`);
    let data = await resp.json();
    // Chunked world manifests (`boundless-chunked-v1`) stream sectors/overlays lazily per-chunk; never expand all 36 provinces into RAM upfront!
    if (data?.chunks?.baseUrl) {
      if (Array.isArray(data.superGrid?.tints) && !data.superGrid.parsedTints) {
        data.superGrid.parsedTints = data.superGrid.tints.map(row =>
          row.map(hex => (typeof hex === "number" ? hex : parseInt(String(hex).replace("#", ""), 16) || 0xffffff))
        );
      }
      if (!data.sectors) data.sectors = {};
      if (!data.overlays) data.overlays = {};
      this.manifestCache.set(url, data);
      return { ...data, sectors: {}, overlays: {} };
    } else if (data?.superGrid?.baseManifestUrl) {
      data = await this._expandSuperGridManifest(data);
    }
    this.manifestCache.set(url, data);
    return data;
  }

  _normalizeLevelSpec(rawSpec, level, levelCfg = {}) {
    if (!rawSpec) return null;
    const superGrid = rawSpec.superGrid || null;
    const sgRegionPx = superGrid?.regionPx || 100000;
    const sgW = superGrid ? (superGrid.cols || 6) * sgRegionPx : 0;
    const sgH = superGrid ? (superGrid.rows || 6) * sgRegionPx : 0;
    const worldPx = rawSpec.worldPx || Math.max(sgW, sgH, canvas.dimensions?.width || 100000, canvas.dimensions?.height || 100000);
    const tilePx = rawSpec.tilePx || 1024;
    const simGrid = rawSpec.simGrid || 40;
    const simSectorPx = rawSpec.simSectorPx || Math.ceil(worldPx / simGrid);
    const zOffset = superGrid ? ((superGrid.macroMaxZ ?? 2) + 1) : 0;
    const cfgBaseUrl = typeof levelCfg.pyramidBaseUrl === "string" ? levelCfg.pyramidBaseUrl.trim() : levelCfg.pyramidBaseUrl;
    const pyramidBaseUrl = cfgBaseUrl
      ? cfgBaseUrl
      : (rawSpec.pyramidBaseUrl !== undefined
          ? rawSpec.pyramidBaseUrl
          : (rawSpec.blockFlags || rawSpec.maxZoomZ !== undefined ? `modules/${MODULE_ID}/assets/pyramid` : null));

    const hasPyramid = Boolean(pyramidBaseUrl);
    const maxZoomZ = rawSpec.maxZoomZ ?? (hasPyramid ? (7 + zOffset) : 0);

    const cfgFgBaseUrl = typeof levelCfg.foregroundPyramidBaseUrl === "string"
      ? levelCfg.foregroundPyramidBaseUrl.trim()
      : levelCfg.foregroundPyramidBaseUrl;
    const rawFgBaseUrl = typeof rawSpec.foregroundPyramidBaseUrl === "string"
      ? rawSpec.foregroundPyramidBaseUrl.trim()
      : rawSpec.foregroundPyramidBaseUrl;
    const foregroundPyramidBaseUrl = cfgFgBaseUrl || rawFgBaseUrl || null;
    const hasForegroundPyramid = Boolean(foregroundPyramidBaseUrl);
    const foregroundMaxZoomZ = rawSpec.foregroundMaxZoomZ ?? (hasForegroundPyramid ? (rawSpec.maxZoomZ ?? (7 + zOffset)) : 0);
    const cfgFgElev = levelCfg.foregroundElevation;
    const rawFgElev = rawSpec.foregroundElevation;
    const foregroundElevation = (cfgFgElev !== undefined && cfgFgElev !== null && Number.isFinite(Number(cfgFgElev)))
      ? Number(cfgFgElev)
      : ((rawFgElev !== undefined && rawFgElev !== null && Number.isFinite(Number(rawFgElev)))
          ? Number(rawFgElev)
          : null);
    const foregroundTileSet = parseSparseTileSet(rawSpec.foregroundTiles);

    const defaultBounds = superGrid
      ? { x: 0, y: 0, w: sgW || worldPx, h: sgH || worldPx }
      : { x: 0, y: 0, w: worldPx, h: worldPx };
    const bounds = levelCfg.bounds || rawSpec.bounds || defaultBounds;

    return {
      level,
      spec: rawSpec,
      hasPyramid,
      pyramidBaseUrl,
      hasForegroundPyramid,
      foregroundPyramidBaseUrl,
      foregroundMaxZoomZ,
      foregroundElevation,
      foregroundTileSet,
      superGrid,
      zOffset,
      maxZoomZ,
      worldPx,
      tilePx,
      simGrid,
      simSectorPx,
      bounds,
      isUpper: !level.isView && (getLevelBottomElevation(level) > getLevelBottomElevation(canvas.level)),
      lastPyramidKey: "",
      lastForegroundPyramidKey: "",
      lastOverlayKey: "",
      lastTileKey: "",
      lastTargetZ: -1,
      lastForegroundTargetZ: -1
    };
  }

  async _resolveSingleLevelLayer(level, sceneManifest, defaultLevelId) {
    if (!level) return null;
    const lCfg = level.flags?.[MODULE_ID] || {};
    if (lCfg.enabled === false) return null;

    let rawSpec = null;
    if (lCfg.inlineManifest) {
      rawSpec = lCfg.inlineManifest;
    } else if (lCfg.manifestUrl) {
      try {
        rawSpec = await this._fetchManifest(lCfg.manifestUrl);
      } catch (err) {
        console.warn(`${MODULE_ID} | Could not load level manifest ${lCfg.manifestUrl}:`, err);
      }
    } else if (sceneManifest?.levels && sceneManifest.levels[level.id]) {
      rawSpec = sceneManifest.levels[level.id];
    } else if (sceneManifest && !sceneManifest.levels && level.id === defaultLevelId) {
      rawSpec = sceneManifest;
    }

    return rawSpec ? this._normalizeLevelSpec(rawSpec, level, lCfg) : null;
  }

  /**
   * Resolve which visible Foundry v14 Levels have Boundless layers attached.
   * Supports:
   *  1. Per-level flags: `level.flags["boundless"]` (`manifestUrl` or `inlineManifest`)
   *  2. Multi-level scene manifest: `manifest.levels[level.id]`
   *  3. Legacy single-level scene manifest: attached to `scene.flags["boundless"].levelId || scene.initialLevel || scene.firstLevel.id`
   */
  async _resolveVisibleLevelLayers(scene, sceneCfg) {
    const visibleLevels = (scene.levels?.sorted || (canvas.level ? [canvas.level] : []))
      .filter(l => l.isVisible);
    if (!visibleLevels.length && canvas.level) visibleLevels.push(canvas.level);

    const defaultLevelId = sceneCfg.levelId
      || (typeof scene.initialLevel === "string" ? scene.initialLevel : scene.initialLevel?.id)
      || scene.firstLevel?.id
      || visibleLevels[0]?.id;
    let sceneManifest = null;
    if (sceneCfg.manifestUrl || sceneCfg.enabled) {
      const mUrl = sceneCfg.manifestUrl || `modules/${MODULE_ID}/assets/pyramid/pyramid_manifest.json`;
      try {
        sceneManifest = await this._fetchManifest(mUrl);
      } catch (err) {
        console.warn(`${MODULE_ID} | Could not load scene manifest ${mUrl}:`, err);
      }
    }

    const layers = [];
    for (const level of visibleLevels) {
      const entry = await this._resolveSingleLevelLayer(level, sceneManifest, defaultLevelId);
      if (entry) layers.push(entry);
    }

    layers.sort((a, b) => {
      const ea = getLevelBottomElevation(a.level);
      const eb = getLevelBottomElevation(b.level);
      return ea < eb ? -1 : (ea > eb ? 1 : (a.level.index ?? 0) - (b.level.index ?? 0));
    });
    return { layers, sceneManifest };
  }

  _cancelIdleLevelPrewarm() {
    this._idleLevelPrewarmGen++;
    if (this._idleLevelPrewarmTimer !== null) {
      clearTimeout(this._idleLevelPrewarmTimer);
      this._idleLevelPrewarmTimer = null;
    }
  }

  _scheduleIdleLevelPrewarm(scene, sceneCfg, sceneManifest, mountGen) {
    this._cancelIdleLevelPrewarm();
    if (!PERF_CONFIG.perfEnabled || !PERF_CONFIG.perfIdleLevelPrewarm) return;
    const allLevels = Array.from(scene?.levels || []);
    if (allLevels.length <= 1) return;

    const prewarmGen = ++this._idleLevelPrewarmGen;
    const isStale = () =>
      !this.active ||
      this._mountGen !== mountGen ||
      this._idleLevelPrewarmGen !== prewarmGen ||
      canvas.scene?.id !== scene.id;

    const waitUntilQuiet = async () => {
      for (let attempt = 0; attempt < 30; attempt++) {
        if (isStale()) return false;
        const texStats = this.texMgr.getStats();
        const busy = this.isActivelyMoving()
          || (performance.now() - (this._lastPanMs || 0)) < 1200
          || this.pendingTileMounts.length > 0
          || this.pendingOverlayMounts.length > 0
          || this.pendingVirtualTileMounts.length > 0
          || texStats.inFlight > 0;
        if (!busy) return true;
        await new Promise(r => setTimeout(r, 400));
      }
      return false;
    };

    this._idleLevelPrewarmTimer = setTimeout(async () => {
      this._idleLevelPrewarmTimer = null;
      if (!(await waitUntilQuiet())) return;

      const curElev = getLevelBaseElevation(canvas.level);
      const defaultLevelId = sceneCfg.levelId
        || (typeof scene.initialLevel === "string" ? scene.initialLevel : scene.initialLevel?.id)
        || scene.firstLevel?.id
        || allLevels[0]?.id;
      const adjacentLevels = allLevels
        .filter(lvl => !this.levelLayers.has(lvl.id) && !this._prewarmedLevels.has(lvl.id) && lvl.flags?.[MODULE_ID]?.enabled !== false)
        .sort((a, b) => Math.abs(getLevelBaseElevation(a) - curElev) - Math.abs(getLevelBaseElevation(b) - curElev));

      const pxPerFt = (canvas.dimensions?.size || 100) / (canvas.dimensions?.distance || 5);
      const worldId = game.world?.id || "world";
      const buildOpts = this._getLightBatchBuildOpts();

      for (const lvl of adjacentLevels) {
        if (!(await waitUntilQuiet())) return;

        // 1. Pre-fetch & cache level manifest JSON in RAM
        const layer = await this._resolveSingleLevelLayer(lvl, sceneManifest, defaultLevelId);
        if (isStale() || !layer) continue;

        // 2. Hydrate from IndexedDB or silently time-slice bake shadow polygons (<= 4 ms/slice)
        await this.lightBatch.hydratePolyCacheFromDB(worldId, scene.id, [lvl.id]);
        if (isStale()) return;
        await this.lightBatch.prewarmLevelPolysTimeSliced(
          layer,
          pxPerFt,
          (lid, kind, sk, idx, raw) => this.resolveVirtualWall(lid, kind, sk, idx, raw),
          (lid, sk, idx, raw, lObj) => this.resolveVirtualLight(lid, sk, idx, raw, lObj),
          {
            worldId,
            sceneId: scene.id,
            budgetMs: 4,
            shouldAbort: () => isStale() || this.isActivelyMoving(),
            hasLevelEditsFn: buildOpts.hasLevelEditsFn,
            getLevelCacheSigFn: buildOpts.getLevelCacheSigFn
          }
        );
        if (isStale()) return;
        if (this.isActivelyMoving()) continue;

        // 3. Gently pre-decode only the base z=0 tile per adjacent level with pauses so GPU uploads never stutter zoom
        if (this.texMgr.effectiveProfile !== "low" && this.texMgr.totalBytes < this.texMgr.maxVramBytes * 0.72) {
          const urls = [];
          if (layer.hasPyramid) {
            const mBase = layer.superGrid?.macroPyramidUrl || layer.pyramidBaseUrl;
            urls.push(`${mBase}/0/0_0.webp`);
          }
          if (layer.hasForegroundPyramid && this.hasForegroundTile(layer, 0, 0, 0)) {
            urls.push(`${layer.foregroundPyramidBaseUrl}/0/0_0.webp`);
          }
          let completedTex = true;
          for (const url of urls) {
            if (isStale()) return;
            if (this.isActivelyMoving() || this.texMgr.totalBytes >= this.texMgr.maxVramBytes * 0.75) {
              completedTex = false;
              break;
            }
            if (!this.texMgr.getSync(url)) {
              await this.texMgr.load(url, { mipmap: true, priority: 2 }).catch(() => {});
              await new Promise(r => setTimeout(r, 120));
            }
          }
          if (completedTex) this._prewarmedLevels.add(lvl.id);
        } else {
          this._prewarmedLevels.add(lvl.id);
        }
      }
    }, 3000);
  }

  _capFilterResolution(filter, maxRes = 1.0) {
    if (!filter || filter.destroyed || this._patchedFilters.has(filter)) return;
    const rendererRes = canvas.app?.renderer?.resolution || 1;
    let effectiveRes = rendererRes;
    try { effectiveRes = filter.resolution ?? rendererRes; } catch { return; }
    if (effectiveRes <= maxRes) return;
    const desc = Object.getOwnPropertyDescriptor(filter, "resolution");
    this._patchedFilters.set(filter, desc || null);
    const origGet = desc?.get;
    Object.defineProperty(filter, "resolution", {
      configurable: true,
      get() {
        let raw = null;
        if (origGet) {
          try { raw = origGet.call(this); } catch {}
        }
        const v = raw ?? (canvas.app?.renderer?.resolution || 1);
        return Math.min(v, maxRes);
      },
      set() {}
    });
  }

  _syncInterfaceVoidFilter(forceEnable = false) {
    const ifVoid = canvas.interface?.filters?.find(f => f?.constructor?.name === "VoidFilter");
    if (!ifVoid) return;
    if (this._origIfVoidEnabled === null) this._origIfVoidEnabled = Boolean(ifVoid.enabled);
    const needVoid = Boolean(
      forceEnable
      || (canvas.tokens?.placeables?.length || 0) > 0
      || (canvas.tokens?.objects?.children?.length || 0) > 0
      || (canvas.scene?.tokens?.size || 0) > 0
    );
    ifVoid.enabled = needVoid ? (this._origIfVoidEnabled || true) : false;
  }

  _hasMultiElevationDepth() {
    const visibleLevels = (canvas.scene?.levels?.sorted || []).filter(l => l.isVisible);
    if (visibleLevels.length > 1) return true;
    const baseElev = getLevelBottomElevation(canvas.level);

    // Check native TileDocuments that restrict light above base elevation
    if (canvas.tiles?.placeables) {
      for (const t of canvas.tiles.placeables) {
        if (t.visible && t.document?.restrictions?.light && (t.document.elevation ?? 0) > baseElev) {
          return true;
        }
      }
    }
    // Check active streamed virtual tiles that restrict light above base elevation
    for (const [, vt] of this.activeVirtualTiles) {
      if (vt.mesh?.restrictsLight && (vt.mesh.elevation ?? 0) > baseElev) {
        return true;
      }
    }
    // Check active interactive building roofs that restrict indoor light above base elevation
    for (const [, ov] of this.activeOverlays) {
      if (ov.roofMesh?.visible && ov.roofMesh.restrictsLight && (ov.roofMesh.elevation ?? 0) > baseElev) {
        return true;
      }
    }
    return false;
  }

  _optimizeEffectsLayers(effects) {
    if (!effects) return;
    const lightingOpts = canvas.visibility?.visionModeData?.activeLightingOptions;

    if (effects.darkness) {
      effects.darkness.visible = effects.darkness.children.length > 0;
    }

    const bgLight = effects.background?.lighting;
    if (bgLight && bgLight.visible) {
      const hasPost = Boolean(lightingOpts?.background?.postProcessingModes?.length);
      if (!hasPost) {
        let hasEffect = false;
        for (const ch of bgLight.children) {
          const u = ch.shader?.uniforms;
          if (!u || u.luminosity || u.saturation || u.contrast || u.shadows) {
            hasEffect = true;
            break;
          }
        }
        if (!hasEffect) bgLight.visible = false;
      }
    }

    const col = effects.coloration;
    if (col) {
      const hasPost = Boolean(lightingOpts?.coloration?.postProcessingModes?.length);
      const ourMeshes = this.lightBatch.countAttachedColorMeshes(col);
      // Foundry's CanvasColorationEffects always keeps 1 internal #background child
      const hasOtherSources = col.children.length > (1 + ourMeshes);
      const hasBatchLights = this.lightBatch.hasVisibleLights();
      col.visible = hasBatchLights || hasOtherSources || hasPost;
    }
  }

  clearSceneCache() {
    this.texMgr.clear(true);
    this.lightBatch.clearPolyCache();
    this._prewarmedLevels.clear();
    this._cachedSceneId = null;
  }

  mount(scene) {
    const switchingScene = Boolean(this._cachedSceneId && scene?.id !== this._cachedSceneId);
    this.unmount({ clearTextures: switchingScene });
    const mountGen = ++this._mountGen;
    this._mounting = true;
    const p = this._mountImpl(scene, mountGen).finally(() => {
      if (this._mountGen === mountGen) this._mounting = false;
      if (this._mountPromise === p) this._mountPromise = null;
    });
    this._mountPromise = p;
    return p;
  }

  async _mountImpl(scene, mountGen) {
    const cfg = scene?.flags?.[MODULE_ID];
    const anyLevelFlag = scene?.levels?.some?.(l => l.flags?.[MODULE_ID]?.enabled);
    if (!cfg?.enabled && !anyLevelFlag) {
      if (this._cachedSceneId && scene?.id !== this._cachedSceneId) {
        this.clearSceneCache();
      }
      return;
    }

    installLosHorizonPatch();
    installBulkSelectionPatch(this);
    installHoverFadeHitTestPatch(this);
    installLazyTokenLayerPatch();
    this._ensureSocket();
    const mountedLevelId = canvas.level?.id;

    const { layers, sceneManifest } = await this._resolveVisibleLevelLayers(scene, cfg || {});
    if (this._mountGen !== mountGen) return;
    if (canvas.scene?.id !== scene.id || canvas.level?.id !== mountedLevelId) {
      this.unmount();
      return;
    }

    // If the currently viewed level (and its visible sub-levels) have NO Boundless layers, leave Foundry 100% native!
    if (layers.length === 0) {
      this.unmount();
      console.log(`${MODULE_ID} | Active level "${canvas.level?.name}" has no Boundless layers; running native Foundry rendering.`);
      return;
    }

    this.manifest = sceneManifest;
    this.active = true;
    this._mountedSceneId = scene.id;
    this._cachedSceneId = scene.id;
    this.visibleLevelLayers = layers;
    this.levelLayers.clear();
    for (const l of layers) this.levelLayers.set(l.level.id, l);

    // Allow full seamless zoom-out across giant worlds (including 6000x6000 continents) and deep 2.5x combat zoom-in
    if (canvas.dimensions?.scale) {
      const [sw = 1600, sh = 1000] = canvas.screenDimensions || [];
      const worldMax = Math.max(canvas.dimensions.width || 100000, canvas.dimensions.height || 100000);
      const fitScale = Math.min(sw, sh) / (worldMax * 1.25);
      this._worldMinScale = Math.min(canvas.dimensions.scale.min, WORLD_MIN_SCALE, fitScale);
      canvas.dimensions.scale.min = this._worldMinScale;
      canvas.dimensions.scale.max = Math.max(canvas.dimensions.scale.max, 2.5);
    }

    // Persist camera on F5 / tab close and restore last saved view immediately before tile streaming starts
    this._beforeUnloadFn = () => this._saveCameraNow();
    window.addEventListener("beforeunload", this._beforeUnloadFn);
    this.applyVramProfile();
    const glView = canvas.app?.view;
    if (glView && typeof glView.addEventListener === "function") {
      this._webglContextLostView = glView;
      this._webglContextLostFn = () => {
        console.warn(`${MODULE_ID} | WebGL context lost; releasing non-pinned texture cache.`);
        this.texMgr.clear(false);
      };
      glView.addEventListener("webglcontextlost", this._webglContextLostFn, false);
    }
    this._restoreCamera(scene);
    this.syncZoomLimits({ animate: false });

    // Soft lighting/coloration/fog blur does not need 2x HiDPI FBO fill-rate (4x fewer shaded pixels at 144Hz)
    this._capFilterResolution(canvas.effects?.coloration?.filter, 1.0);
    this._capFilterResolution(canvas.effects?.illumination?.filter, 1.0);
    for (const f of canvas.visibility?.filters || []) {
      this._capFilterResolution(f, 1.0);
    }

    // Disable heavy 3-pass fullscreen SMAAFilter on Boundless (mipmapped 2D tiles look sharper without it)
    const smaa = canvas.stage?.filters?.find(f => f?.constructor?.name === "SMAAFilter");
    if (smaa) {
      this._origSmaaEnabled = smaa.enabled;
      smaa.enabled = false;
    }
    this._syncInterfaceVoidFilter();

    // Pause redundant per-frame CanvasDepthMask full-scene re-renders while camera & tokens are idle
    if (canvas.masks?.depth) {
      this._origDepthAutoRender = canvas.masks.depth.autoRender;
      canvas.masks.depth.autoRender = false;
      this._depthDirty = true;
      canvas.masks.depth.renderDirty = true;
    }

    // Prevent PIXI TextureGCSystem from silently evicting _glTextures out from under our byte-budgeted LRUTextureManager every 60s
    if (canvas.app?.renderer?.textureGC && PIXI?.GC_MODES?.MANUAL !== undefined) {
      this._origTextureGcMode = canvas.app.renderer.textureGC.mode;
      canvas.app.renderer.textureGC.mode = PIXI.GC_MODES.MANUAL;
    }

    // Load virtual wall/light/sound/tile edits and persisted doorStates before mounting chunkStreamer & GPU light batch
    this._loadWallEdits(scene);
    this._loadLightEdits(scene);
    this._loadSoundEdits(scene);
    this._loadTileEdits(scene);
    this._restoreDoorStates(scene);

    // Mount chunked world streamer BEFORE lightBatch & first updateAll so active token/viewport chunks stream smoothly
    this.chunkStreamer.mount(layers);

    // Build unified GPU light batch across all visible Boundless levels (monolithic or chunked macroLights)
    const worldId = game.world?.id || "world";
    const visibleLevelIds = layers.map(l => l.level.id);
    await this.lightBatch.hydratePolyCacheFromDB(worldId, scene.id, visibleLevelIds);
    if (this._mountGen !== mountGen || !this.active || canvas.scene?.id !== scene.id || canvas.level?.id !== mountedLevelId) {
      if (this._mountGen === mountGen) this.unmount();
      return;
    }

    const pxPerFt = canvas.dimensions.size / canvas.dimensions.distance;
    const hasAnyOverlays = layers.some(l => l.spec?.overlays && (Array.isArray(l.spec.overlays) ? l.spec.overlays.length > 0 : Object.keys(l.spec.overlays).length > 0));
    // Keep indoor lights suppressed briefly until pixel-accurate bakedRoofMask finishes (or roofs mount in depthMask)
    this._waitingForRoofsBeforeIndoor = hasAnyOverlays;
    this.lightBatch.hideIndoorLights = hasAnyOverlays;
    this.lightBatch.build(
      layers,
      pxPerFt,
      (lid, kind, sk, idx, raw) => this.resolveVirtualWall(lid, kind, sk, idx, raw),
      (lid, sk, idx, raw, lvl) => this.resolveVirtualLight(lid, sk, idx, raw, lvl),
      {
        ...this._getLightBatchBuildOpts(),
        timeSliceThreshold: 80,
        syncBudgetMs: 14,
        deferredBudgetMs: 8,
        onDeferredPolysReady: () => {
          if (!this.active || this._mountGen !== mountGen || canvas.scene?.id !== scene.id) return;
          this.scheduleLightBatchRebuild();
          this.lightBatch.persistPolyCacheToDB(worldId, scene.id, visibleLevelIds).catch(() => {});
        }
      }
    );
    if (this.lightBatch.lastPolyCacheMisses > 0 && this.lightBatch._deferredBakeRaf === null) {
      this.lightBatch.persistPolyCacheToDB(worldId, scene.id, visibleLevelIds).catch(() => {});
    }
    this.lightBatch.attachTo(canvas.effects);

    // Asynchronously bake 2048x2048 pixel-accurate roof alpha mask so macro lighting (localZ < 5) matches depthMask 1:1
    this._bakeRoofMask(layers, scene.id, mountedLevelId);

    const preloadTasks = [];
    for (const layer of layers) {
      if (layer.hasPyramid) {
        const mBase = layer.superGrid?.macroPyramidUrl || layer.pyramidBaseUrl;
        preloadTasks.push(this.texMgr.load(`${mBase}/0/0_0.webp`, { mipmap: true, isPinned: true }));
      }
      if (layer.hasForegroundPyramid && this.hasForegroundTile(layer, 0, 0, 0)) {
        preloadTasks.push(this.texMgr.load(`${layer.foregroundPyramidBaseUrl}/0/0_0.webp`, { mipmap: true, isPinned: true }));
      }
    }
    await Promise.all(preloadTasks);
    if (this._mountGen !== mountGen) return;
    if (!this.active || canvas.scene?.id !== scene.id || canvas.level?.id !== mountedLevelId) {
      this.unmount();
      return;
    }

    // Warm z=1 tiles silently in background for every visible pyramid layer (clipped to actual bounds for non-square maps)
    for (const layer of layers) {
      const z1TileSz = this._getPyramidTileSize(layer, 1);
      const maxX1 = Math.min(1, Math.floor((Math.max(1, layer.bounds?.w || layer.worldPx) - 0.001) / z1TileSz));
      const maxY1 = Math.min(1, Math.floor((Math.max(1, layer.bounds?.h || layer.worldPx) - 0.001) / z1TileSz));
      if (layer.hasPyramid && layer.maxZoomZ >= 1) {
        const mBase = layer.superGrid?.macroPyramidUrl || layer.pyramidBaseUrl;
        for (let y = 0; y <= maxY1; y++) for (let x = 0; x <= maxX1; x++) {
          this.texMgr.load(`${mBase}/1/${x}_${y}.webp`, { mipmap: true, isPinned: true });
        }
      }
      if (layer.hasForegroundPyramid && layer.foregroundMaxZoomZ >= 1) {
        const fgBase = layer.foregroundPyramidBaseUrl;
        for (let y = 0; y <= maxY1; y++) for (let x = 0; x <= maxX1; x++) {
          if (this.hasForegroundTile(layer, 1, x, y)) {
            this.texMgr.load(`${fgBase}/1/${x}_${y}.webp`, { mipmap: true, isPinned: true });
          }
        }
      }
    }

    // Mount permanent z=0 base layer for every visible pyramid level (background and optional foreground walls)
    for (const layer of layers) {
      if (layer.hasPyramid) {
        const baseKey = `${layer.level.id}::0_0_0`;
        if (!this.tilesByKey.has(baseKey)) {
          const mBase = layer.superGrid?.macroPyramidUrl || layer.pyramidBaseUrl;
          this.ensureTile(layer, {
            key: baseKey,
            levelId: layer.level.id,
            channel: "bg",
            z: 0, x: 0, y: 0,
            src: `${mBase}/0/0_0.webp`
          }, true);
        }
      }
      if (layer.hasForegroundPyramid && this.hasForegroundTile(layer, 0, 0, 0)) {
        const fgBaseKey = `${layer.level.id}::fg::0_0_0`;
        if (!this.tilesByKey.has(fgBaseKey)) {
          this.ensureTile(layer, {
            key: fgBaseKey,
            levelId: layer.level.id,
            channel: "fg",
            z: 0, x: 0, y: 0,
            src: `${layer.foregroundPyramidBaseUrl}/0/0_0.webp`
          }, true);
        }
      }
    }

    // Ticker drives buttery-smooth 160ms alpha crossfades & lazy depth updates
    this.tickerFn = () => this.stepCrossfades(canvas.app.ticker.deltaMS || 16.6);
    canvas.app.ticker.add(this.tickerFn);

    // Mount POI fast-travel pins, character avatar tracker, high-res chunked Fog of War, native wall/door/layer editors, token virtualization streamer, and spatial ambient audio
    this.poiManager.mount(scene, this.manifest);
    this.charPins.mount(scene);
    this.fogManager.mount(scene);
    this.wallEditor.mount();
    this.layerEditors.mount();
    this.tokenStreamer.mount(scene);
    this.selectionOverlay.mount();

    this.updateAll(true);
    this.syncZoomLimits({ animate: false });
    this._depthElevSyncNeeded = true;

    const lvlSummary = layers.map(l => `${l.level.name}[${l.level.elevation?.bottom}..${l.level.elevation?.top}]`).join(", ");
    console.log(
      `${MODULE_ID} | Mounted level "${canvas.level?.name}" | Visible Boundless layers: ${lvlSummary} | ` +
      `GPU light batch: ${this.lightBatch.totalLights} lights (${this.lightBatch.totalVertices} verts).`
    );
    this._emit("mount", { scene });
    Hooks.callAll("boundlessMount", this);
    this._scheduleIdleLevelPrewarm(scene, cfg || {}, sceneManifest, mountGen);
  }

  /**
   * Subscribe to Boundless lifecycle events ("mount", "unmount", "virtualTileMount", "virtualTileRetire", "overlayMount", "overlayRetire", "dynamicLightMount", "dynamicLightRetire").
   * Returns an unsubscribe function.
   */
  on(event, fn) {
    if (typeof event !== "string" || typeof fn !== "function") return () => {};
    let set = this._eventListeners.get(event);
    if (!set) {
      set = new Set();
      this._eventListeners.set(event, set);
    }
    set.add(fn);
    return () => this.off(event, fn);
  }

  off(event, fn) {
    const set = this._eventListeners.get(event);
    if (!set) return;
    set.delete(fn);
    if (set.size === 0) this._eventListeners.delete(event);
  }

  _emit(event, payload) {
    const set = this._eventListeners.get(event);
    if (!set || set.size === 0) return;
    for (const fn of [...set]) {
      try {
        fn(payload);
      } catch (err) {
        console.error(`${MODULE_ID} | Event listener error (${event}):`, err);
      }
    }
  }

  updateAll(force = false) {
    this.updatePyramid();
    if (force) {
      this.updateSimAndLightBubbles(true);
    }
  }

  unmount({ clearTextures = false } = {}) {
    const wasActive = this.active;
    const prevSceneId = this._mountedSceneId;
    if (wasActive) {
      this._saveCameraNow(true);
      this._emit("unmount", {});
      Hooks.callAll("boundlessUnmount", this);
    }
    this.active = false;
    this._mountedSceneId = null;
    this._mounting = false;
    this._mountGen++;
    this._prewarmGen++;
    this._cancelIdleLevelPrewarm();
    if (this._vpLightSyncTimer) {
      clearTimeout(this._vpLightSyncTimer);
      this._vpLightSyncTimer = null;
    }
    this.manifest = null;
    if (this._camSaveTimer !== null) {
      clearTimeout(this._camSaveTimer);
      this._camSaveTimer = null;
    }
    if (this._beforeUnloadFn) {
      window.removeEventListener("beforeunload", this._beforeUnloadFn);
      this._beforeUnloadFn = null;
    }
    if (this._webglContextLostFn && this._webglContextLostView) {
      this._webglContextLostView.removeEventListener("webglcontextlost", this._webglContextLostFn, false);
    }
    this._webglContextLostFn = null;
    this._webglContextLostView = null;
    this._restoringCamera = false;
    this._zoomSyncQueued = false;
    this.isCameraFlying = false;
    this._lastPanMs = 0;
    this._camPrevX = null;
    this._camPrevY = null;
    this._camPrevMs = 0;
    this._camVelX = 0;
    this._camVelY = 0;
    this._pruneNeeded = false;
    this._lastOccRefreshMs = 0;
    this._showstopperDirty = false;
    this._lastShowstopperMs = 0;
    this._vtIdleCleanupNeeded = false;

    this.poiManager.unmount();
    this.charPins.unmount();
    this.fogManager.unmount();
    // Unmount in reverse patch order so scene.updateEmbeddedDocuments / deleteEmbeddedDocuments restore cleanly
    this.layerEditors.unmount();
    this.wallEditor.unmount();
    this.selectionOverlay.unmount();
    this.tokenStreamer.unmount();
    this.chunkStreamer.unmount();
    this.audioStreamer.unmount();
    this.wallEdits.clear();
    this.lightEdits.clear();
    this.soundEdits.clear();
    this.tileEdits.clear();
    this._lightRebuildScheduled = false;
    this._vpAnimLightsActive = false;
    if (this._vpLightSyncTimer) { clearTimeout(this._vpLightSyncTimer); this._vpLightSyncTimer = null; }
    if (this._lightRefreshAudioTimer) { clearTimeout(this._lightRefreshAudioTimer); this._lightRefreshAudioTimer = null; }
    this._lastLightRefreshAudioMs = 0;
    if (this._sightBubbleTimer) { clearTimeout(this._sightBubbleTimer); this._sightBubbleTimer = null; }
    this._lastSightBubbleMs = 0;
    this._hadVisionSources = false;

    if (this.tickerFn && canvas?.app?.ticker) {
      canvas.app.ticker.remove(this.tickerFn);
    }
    this.tickerFn = null;

    for (const [filter, origDesc] of this._patchedFilters) {
      if (origDesc) {
        Object.defineProperty(filter, "resolution", origDesc);
      } else {
        delete filter.resolution;
      }
    }
    this._patchedFilters.clear();

    if (this._origSmaaEnabled !== null) {
      const smaa = canvas.stage?.filters?.find(f => f?.constructor?.name === "SMAAFilter");
      if (smaa) smaa.enabled = this._origSmaaEnabled;
      this._origSmaaEnabled = null;
    }

    if (this._origIfVoidEnabled !== null) {
      const ifVoid = canvas.interface?.filters?.find(f => f?.constructor?.name === "VoidFilter");
      if (ifVoid) ifVoid.enabled = this._origIfVoidEnabled;
      this._origIfVoidEnabled = null;
    }

    if (canvas?.effects?.darkness) canvas.effects.darkness.visible = true;
    if (canvas?.effects?.background?.lighting) canvas.effects.background.lighting.visible = true;
    if (canvas?.effects?.coloration) canvas.effects.coloration.visible = true;

    if (this._origDepthAutoRender !== null) {
      if (canvas?.masks?.depth) {
        canvas.masks.depth.autoRender = this._origDepthAutoRender;
        canvas.masks.depth.renderDirty = true;
      }
      this._origDepthAutoRender = null;
    }

    if (this._origTextureGcMode !== null) {
      if (canvas?.app?.renderer?.textureGC) {
        canvas.app.renderer.textureGC.mode = this._origTextureGcMode;
      }
      this._origTextureGcMode = null;
    }

    for (const [, bgMesh] of this._hiddenNativeLevelBg) {
      if (bgMesh && !bgMesh.destroyed) bgMesh.visible = true;
    }
    this._hiddenNativeLevelBg.clear();
    for (const [, fgMesh] of this._hiddenNativeLevelFg) {
      if (fgMesh && !fgMesh.destroyed) fgMesh.visible = true;
    }
    this._hiddenNativeLevelFg.clear();

    this.pendingTileMounts = [];
    this.pendingOverlayMounts = [];
    this._pendingOverlayKeys.clear();
    this.pendingVirtualTileMounts = [];
    this._pendingVirtualTileKeys.clear();
    this._roofTokenOccDirty = false;
    this._waitingForRoofsBeforeIndoor = false;
    this._roofMaskBaking = false;
    this._roofMaskGen++;
    this._depthDirty = false;
    this._depthDeferred = false;
    this._depthElevSyncNeeded = false;

    for (const [, data] of this.simSectors) {
      if (data.level?.edges) {
        for (const eid of data.edgeIds) data.level.edges.delete(eid);
      }
    }
    for (const timerId of this.closingDoorTimers.values()) clearTimeout(timerId);
    this.closingDoorTimers.clear();
    this.simSectors.clear();
    this.doorStates.clear();
    this.openDoors.clear();

    for (const [lid, ls] of this.dynamicLights) {
      this._emit("dynamicLightRetire", { id: lid, light: ls, meta: this.lightBatch.lightMetaById.get(lid) || null });
      ls.destroy();
    }
    this.dynamicLights.clear();
    this._lightFades.clear();
    this._lastActorSimKey = "";
    this.lightBatch.destroy();
    this.lightBatch.disposeBakedRoofMask();
    this.lightBatch.hideIndoorLights = false;
    this._updatingBubbles = false;

    const destroyMeshSafe = (m) => {
      if (!m) return;
      m.debounceSetOcclusion?.cancel?.();
      try { m._ssDofBlurFilter?.destroy?.(); } catch {}
      m._ssDofBlurFilter = null;
      m.parent?.removeChild(m);
      if (!m.destroyed) m.destroy();
    };

    for (const [, e] of this.tilesByKey) {
      destroyMeshSafe(e.mesh);
    }
    this.tilesByKey.clear();

    for (const tok of this._roofHiddenTokens) {
      if (tok && !tok.destroyed) {
        tok.renderable = true;
        if (tok.mesh && !tok.mesh.destroyed) tok.mesh.renderable = true;
        if (tok._ssJumpShadow && !tok._ssJumpShadow.destroyed) tok._ssJumpShadow.renderable = true;
      }
    }
    this._roofHiddenTokens.clear();
    this._lastRoofOccSig = "";
    this._revealTileKeys.clear();

    for (const [, ov] of this.activeOverlays) {
      destroyMeshSafe(ov.wallsMesh);
      destroyMeshSafe(ov.roofMesh);
    }
    this.activeOverlays.clear();
    this.overlayPending.clear();

    for (const [, vt] of this.activeVirtualTiles) {
      destroyMeshSafe(vt.mesh);
    }
    this.activeVirtualTiles.clear();
    this.virtualTilePending.clear();

    for (const m of this.meshPool) destroyMeshSafe(m);
    this.meshPool = [];

    this.levelLayers.clear();
    this.visibleLevelLayers = [];
    if (clearTextures) {
      this.clearSceneCache();
    } else {
      // Keep decoded GPU textures & baked light shadow polygons warm across same-scene level switches;
      // mount() clears both immediately if the next scene has a different scene.id.
      if (prevSceneId) this._cachedSceneId = prevSceneId;
      this.texMgr.cancelInflight();
    }
    this.lastSimKey = "";
    this.lastDynLightKey = "";
    this.lastTargetZ = -1;
    this._tilesDirty = false;
    this._lastOverlayAlpha = -1;
    this._occlusionDirty = false;
  }
}

function installPrototypeMixins(proto, ...mixins) {
  for (const mixin of mixins) {
    for (const [key, fn] of Object.entries(mixin)) {
      if (Object.prototype.hasOwnProperty.call(proto, key)) {
        throw new Error(`Boundless prototype mixin collision: ${key}`);
      }
      Object.defineProperty(proto, key, {
        value: fn,
        writable: true,
        configurable: true,
        enumerable: false
      });
    }
  }
}

installPrototypeMixins(
  MegaWorld1000.prototype,
  pyramidMethods,
  overlayMethods,
  lightingMethods,
  editsMethods
);

const controller = new MegaWorld1000();
controller.perf = {
  config: PERF_CONFIG,
  stats: perfStats,
  resetStats: resetPerfStats,
  status: getPerfStatus,
  invalidateGeometry: invalidateCpuGeometry,
  benchmark: runPerfBenchmark
};
registerConfigUI(controller);
registerPoiControls(controller);
registerFogControls(controller);
registerWallEditorControls(controller);
registerLayerEditorControls(controller);
registerBoundlessHooks(controller);

globalThis.Boundless = controller;
export { controller as Boundless };
