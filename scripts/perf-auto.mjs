import { MODULE_ID, loc } from "./utils.mjs";
import { PERF_CONFIG, perfStats } from "./perf-patcher.mjs";

/**
 * Boundless Standard Scene Auto-Optimizer (Foundry VTT v14+).
 * Runs automatically on standard (non-Boundless) scenes with zero setup:
 *  1. Viewport frustum culling for dense tiles, light/sound/note control icons.
 *  2. Smart idle VRAM disposal of stale large textures (>= 1024x1024) from previous scenes.
 *  3. Quiet idle pre-warming of sibling level backgrounds on multi-level v14 scenes.
 *  4. One-time gentle GM hint to 1-click optimize genuinely giant/heavy scenes.
 */

let _autoInstalled = false;
let _controllerRef = null;
let _cullTimer = null;
let _vramTimer = null;
let _prewarmTimer = null;
let _prewarmGen = 0;
const _hintedScenes = new Set();

function isStandardSceneActive() {
  if (!globalThis.canvas?.ready || !globalThis.canvas?.scene) return false;
  if (_controllerRef?.active) return false;
  if (globalThis.canvas.scene.flags?.[MODULE_ID]?.enabled) return false;
  return true;
}

// ---------------------------------------------------------------------------
// 1. Viewport Frustum Culling for Standard Scenes
// ---------------------------------------------------------------------------

export function computeExpandedViewport(stage, screen, marginFactor = 0.45, minPadPx = 420) {
  if (!stage?.worldTransform || !screen) return null;
  const wt = stage.worldTransform;
  const a = wt.a || 1;
  const d = wt.d || 1;
  if (Math.abs(a) < 1e-6 || Math.abs(d) < 1e-6) return null;

  const x0 = (screen.x - wt.tx) / a;
  const x1 = (screen.x + screen.width - wt.tx) / a;
  const y0 = (screen.y - wt.ty) / d;
  const y1 = (screen.y + screen.height - wt.ty) / d;

  const minX = Math.min(x0, x1);
  const maxX = Math.max(x0, x1);
  const minY = Math.min(y0, y1);
  const maxY = Math.max(y0, y1);

  const padX = Math.max(minPadPx, (maxX - minX) * marginFactor);
  const padY = Math.max(minPadPx, (maxY - minY) * marginFactor);
  return {
    minX: minX - padX,
    maxX: maxX + padX,
    minY: minY - padY,
    maxY: maxY + padY
  };
}

export function rectsIntersect(ax0, ay0, ax1, ay1, vp) {
  return ax1 >= vp.minX && ax0 <= vp.maxX && ay1 >= vp.minY && ay0 <= vp.maxY;
}

export function restoreAllStandardCulling() {
  const c = globalThis.canvas;
  if (!c) return;
  syncDecorativeTileShaders(false);
  for (const tile of c.tiles?.placeables ?? []) {
    if (tile.mesh && !tile.mesh.destroyed) tile.mesh.renderable = true;
  }
  for (const al of c.lighting?.placeables ?? []) {
    const icon = al.controls ?? al.controlIcon;
    if (icon && !icon.destroyed) icon.renderable = true;
  }
  for (const as of c.sounds?.placeables ?? []) {
    const icon = as.controls ?? as.controlIcon;
    if (icon && !icon.destroyed) icon.renderable = true;
  }
  for (const note of c.notes?.placeables ?? []) {
    const icon = note.controlIcon ?? note.controls;
    if (icon && !icon.destroyed) icon.renderable = true;
  }
  for (const door of c.controls?.doors?.children ?? []) {
    if (door && !door.destroyed) door.renderable = true;
  }
  for (const wall of c.walls?.placeables ?? []) {
    if (wall && !wall.destroyed) wall.renderable = true;
  }
  for (const ls of c.effects?.lightSources ?? []) {
    const bg = ls.layers?.background?.mesh;
    const il = ls.layers?.illumination?.mesh;
    const co = ls.layers?.coloration?.mesh;
    if (bg && !bg.destroyed) bg.renderable = true;
    if (il && !il.destroyed) il.renderable = true;
    if (co && !co.destroyed) co.renderable = true;
  }
  for (const ds of c.effects?.darknessSources ?? []) {
    const dk = ds.layers?.darkness?.mesh;
    if (dk && !dk.destroyed) dk.renderable = true;
  }
}

export function updateStandardSceneCulling() {
  if (!PERF_CONFIG.perfEnabled || !PERF_CONFIG.perfAutoCulling) {
    restoreAllStandardCulling();
    return;
  }
  if (!isStandardSceneActive()) return;
  syncDecorativeTileShaders(true);

  const c = globalThis.canvas;
  const vp = computeExpandedViewport(c.stage, c.app?.renderer?.screen, 0.45, 420);
  if (!vp) return;

  let culledTiles = 0;
  let culledLights = 0;
  let culledSounds = 0;

  // Tiles: only engage when scene has >= 12 tiles
  const tiles = c.tiles?.placeables ?? [];
  const tilesHi = Boolean(c.tiles?.highlightObjects);
  if (tiles.length >= 12) {
    for (let i = 0; i < tiles.length; i++) {
      const t = tiles[i];
      const mesh = t.mesh;
      if (!mesh || mesh.destroyed) continue;
      if (tilesHi || t.controlled || t.hover || t.isPreview) {
        mesh.renderable = true;
        continue;
      }
      const doc = t.document;
      const x = doc.x ?? 0;
      const y = doc.y ?? 0;
      const w = doc.width ?? 0;
      const h = doc.height ?? 0;
      // Generous padding for rotated tiles
      const diagPad = doc.rotation ? Math.max(w, h) * 0.5 : 0;
      const inView = rectsIntersect(x - diagPad, y - diagPad, x + w + diagPad, y + h + diagPad, vp);
      mesh.renderable = inView;
      if (!inView) culledTiles++;
    }
  } else {
    for (let i = 0; i < tiles.length; i++) {
      if (tiles[i].mesh && !tiles[i].mesh.destroyed) tiles[i].mesh.renderable = true;
    }
  }

  // Light control icons: only engage when scene has >= 20 lights (use full radius for v14 ShapeControls border)
  const lights = c.lighting?.placeables ?? [];
  const lightsHi = Boolean(c.lighting?.highlightObjects);
  if (lights.length >= 20) {
    for (let i = 0; i < lights.length; i++) {
      const al = lights[i];
      const icon = al.controls ?? al.controlIcon;
      if (!icon || icon.destroyed) continue;
      if (lightsHi || al.controlled || al.hover || al.isPreview) {
        icon.renderable = true;
        continue;
      }
      const x = al.document?.x ?? 0;
      const y = al.document?.y ?? 0;
      const r = al.radius || 0;
      const inView = (x + r >= vp.minX) && (x - r <= vp.maxX) && (y + r >= vp.minY) && (y - r <= vp.maxY);
      icon.renderable = inView;
      if (!inView) culledLights++;
    }
  } else {
    for (let i = 0; i < lights.length; i++) {
      const icon = lights[i].controls ?? lights[i].controlIcon;
      if (icon && !icon.destroyed) icon.renderable = true;
    }
  }

  // Sound control icons: only engage when scene has >= 20 sounds (use full radius for v14 ShapeControls border)
  const sounds = c.sounds?.placeables ?? [];
  const soundsHi = Boolean(c.sounds?.highlightObjects);
  if (sounds.length >= 20) {
    for (let i = 0; i < sounds.length; i++) {
      const as = sounds[i];
      const icon = as.controls ?? as.controlIcon;
      if (!icon || icon.destroyed) continue;
      if (soundsHi || as.controlled || as.hover || as.isPreview) {
        icon.renderable = true;
        continue;
      }
      const x = as.document?.x ?? 0;
      const y = as.document?.y ?? 0;
      const r = as.radius || 0;
      const inView = (x + r >= vp.minX) && (x - r <= vp.maxX) && (y + r >= vp.minY) && (y - r <= vp.maxY);
      icon.renderable = inView;
      if (!inView) culledSounds++;
    }
  } else {
    for (let i = 0; i < sounds.length; i++) {
      const icon = sounds[i].controls ?? sounds[i].controlIcon;
      if (icon && !icon.destroyed) icon.renderable = true;
    }
  }

  // Note control icons: engage when scene has >= 8 notes
  const notes = c.notes?.placeables ?? [];
  const notesHi = Boolean(c.notes?.highlightObjects);
  if (notes.length >= 8) {
    for (let i = 0; i < notes.length; i++) {
      const n = notes[i];
      const icon = n.controlIcon ?? n.controls;
      if (!icon || icon.destroyed) continue;
      if (notesHi || n.controlled || n.hover || n.isPreview) {
        icon.renderable = true;
        continue;
      }
      const x = n.document?.x ?? 0;
      const y = n.document?.y ?? 0;
      icon.renderable = (x >= vp.minX && x <= vp.maxX && y >= vp.minY && y <= vp.maxY);
    }
  } else {
    for (let i = 0; i < notes.length; i++) {
      const icon = notes[i].controlIcon ?? notes[i].controls;
      if (icon && !icon.destroyed) icon.renderable = true;
    }
  }

  // DoorControl icons: engage when scene has >= 12 doors
  let culledDoors = 0;
  const doors = c.controls?.doors?.children ?? [];
  if (doors.length >= 12) {
    for (let i = 0; i < doors.length; i++) {
      const d = doors[i];
      if (!d || d.destroyed) continue;
      const inView = d.x >= vp.minX && d.x <= vp.maxX && d.y >= vp.minY && d.y <= vp.maxY;
      d.renderable = inView;
      if (!inView) culledDoors++;
    }
  } else {
    for (let i = 0; i < doors.length; i++) {
      if (doors[i] && !doors[i].destroyed) doors[i].renderable = true;
    }
  }

  // WallsLayer frustum culling: engage when scene has >= 100 walls
  const walls = c.walls?.placeables ?? [];
  const wallsHi = Boolean(c.walls?.highlightObjects);
  if (walls.length >= 100) {
    for (let i = 0; i < walls.length; i++) {
      const w = walls[i];
      if (!w || w.destroyed) continue;
      if (wallsHi || w.controlled || w.hover || w.isPreview) {
        w.renderable = true;
        continue;
      }
      const coords = w.document?.c;
      if (!coords || coords.length < 4) continue;
      const minX = coords[0] < coords[2] ? coords[0] : coords[2];
      const maxX = coords[0] > coords[2] ? coords[0] : coords[2];
      const minY = coords[1] < coords[3] ? coords[1] : coords[3];
      const maxY = coords[1] > coords[3] ? coords[1] : coords[3];
      w.renderable = rectsIntersect(minX, minY, maxX, maxY, vp);
    }
  } else {
    for (let i = 0; i < walls.length; i++) {
      if (walls[i] && !walls[i].destroyed) walls[i].renderable = true;
    }
  }

  // Offscreen PointLightSource / PointDarknessSource mesh culling (skips offscreen light shader passes!)
  let culledLightMeshes = 0;
  const lightSources = c.effects?.lightSources;
  const globalLs = c.environment?.globalLightSource;
  if (lightSources) {
    const cullLs = lightSources.size >= 16;
    for (const ls of lightSources) {
      if (!ls || ls === globalLs || ls.isPreview) continue;
      const bg = ls.layers?.background?.mesh;
      const il = ls.layers?.illumination?.mesh;
      const co = ls.layers?.coloration?.mesh;
      if (!cullLs) {
        if (bg && !bg.destroyed) bg.renderable = true;
        if (il && !il.destroyed) il.renderable = true;
        if (co && !co.destroyed) co.renderable = true;
        continue;
      }
      const r = ls.radius ?? ls.data?.radius;
      if (!Number.isFinite(r) || r <= 0) continue;
      const lx = ls.x ?? ls.data?.x;
      const ly = ls.y ?? ls.data?.y;
      if (!Number.isFinite(lx) || !Number.isFinite(ly)) continue;
      const inView = (lx + r >= vp.minX) && (lx - r <= vp.maxX) && (ly + r >= vp.minY) && (ly - r <= vp.maxY);
      if (bg && !bg.destroyed) bg.renderable = inView;
      if (il && !il.destroyed) il.renderable = inView;
      if (co && !co.destroyed) co.renderable = inView;
      if (!inView) culledLightMeshes++;
    }
  }
  const darkSources = c.effects?.darknessSources;
  if (darkSources) {
    const cullDs = darkSources.size >= 8;
    for (const ds of darkSources) {
      if (!ds || ds.isPreview) continue;
      const dk = ds.layers?.darkness?.mesh;
      if (!dk || dk.destroyed) continue;
      if (!cullDs) {
        dk.renderable = true;
        continue;
      }
      const r = ds.radius ?? ds.data?.radius;
      if (!Number.isFinite(r) || r <= 0) continue;
      const lx = ds.x ?? ds.data?.x;
      const ly = ds.y ?? ds.data?.y;
      if (!Number.isFinite(lx) || !Number.isFinite(ly)) continue;
      const inView = (lx + r >= vp.minX) && (lx - r <= vp.maxX) && (ly + r >= vp.minY) && (ly - r <= vp.maxY);
      dk.renderable = inView;
      if (!inView) culledLightMeshes++;
    }
  }

  perfStats.autoCulledTiles = culledTiles;
  perfStats.autoCulledLights = culledLights;
  perfStats.autoCulledLightMeshes = culledLightMeshes;
  perfStats.autoCulledDoors = culledDoors;
  perfStats.autoCulledSounds = culledSounds;
}

/**
 * Switch purely decorative native tiles (no occlusion, no light/weather restriction, non-video)
 * onto PIXI's lightweight `"batch"` shader instead of Foundry's heavier `"batchOcclusion"` shader.
 * Always resets to `null` (never `"batchOcclusion"`) so CanvasDepthMask's `"batchDepth"` stays intact.
 */
let _hasFastBatchTiles = false;

function syncSingleDecorativeTile(t, allow) {
  const m = t?.mesh;
  if (!m || m.destroyed || m._boundlessMesh) return;
  if (!allow) {
    if (m._blFastBatch) {
      m.pluginName = null;
      m._blFastBatch = false;
    }
    return;
  }
  const doc = t.document;
  // Check both document & mesh fields: PIXI "batch" shader ignores unoccludedAlpha (Tile opacity < 1),
  // occlusion modes, and light/weather depth restrictions.
  const docAlpha = doc?.alpha ?? 1;
  const unoccAlpha = m.unoccludedAlpha ?? 1;
  const hasDocOcc = Boolean(doc?.occlusion?.modes?.size || doc?.occlusion?.mode);
  const hasDocRestrict = Boolean(doc?.restrictions?.light || doc?.restrictions?.weather);
  const isDecorative =
    docAlpha >= 0.999 &&
    unoccAlpha >= 0.999 &&
    !hasDocOcc &&
    !hasDocRestrict &&
    !m.occlusionMode &&
    !m.restrictsLight &&
    !m.restrictsWeather &&
    !t.isVideo;
  if (isDecorative) {
    if (m.pluginName !== "batch") {
      m.pluginName = "batch";
      m._blFastBatch = true;
      _hasFastBatchTiles = true;
    }
  } else if (m._blFastBatch) {
    m.pluginName = null;
    m._blFastBatch = false;
  }
}

export function syncDecorativeTileShaders(enable) {
  const tiles = globalThis.canvas?.tiles?.placeables;
  if (!tiles?.length) return;
  const allow = Boolean(enable && PERF_CONFIG.perfEnabled && PERF_CONFIG.perfAutoCulling && isStandardSceneActive());
  if (!allow && !_hasFastBatchTiles) return;
  for (let i = 0; i < tiles.length; i++) {
    syncSingleDecorativeTile(tiles[i], allow);
  }
  if (!allow) _hasFastBatchTiles = false;
}

function scheduleStandardCulling() {
  if (_cullTimer) return;
  _cullTimer = setTimeout(() => {
    _cullTimer = null;
    updateStandardSceneCulling();
  }, 40);
}

// ---------------------------------------------------------------------------
// 2. Smart Cross-Scene Idle VRAM Cleanup
// ---------------------------------------------------------------------------

function normalizeAssetKey(url) {
  if (typeof url !== "string" || !url) return "";
  try {
    const clean = url.split("?")[0].split("#")[0];
    const origin = globalThis.location?.origin;
    if (origin && clean.startsWith(origin)) {
      return decodeURIComponent(clean.slice(origin.length).replace(/^\/+/, ""));
    }
    return decodeURIComponent(clean.replace(/^\/+/, ""));
  } catch {
    return url;
  }
}

export function collectSceneActiveAssetUrls(scene) {
  const used = new Set();
  const add = (src) => {
    const norm = normalizeAssetKey(src);
    if (norm) used.add(norm);
  };
  if (!scene) return used;

  // Read _source first on v14 Scene documents to avoid triggering deprecated scene.background/foreground getters
  const srcBg = scene._source ? scene._source.background?.src : scene.background?.src;
  const srcFg = scene._source ? (scene._source.foreground?.src ?? scene._source.foreground) : (scene.foreground?.src ?? scene.foreground);
  add(srcBg);
  add(srcFg);

  if (scene.levels) {
    for (const lvl of scene.levels) {
      add(lvl.background?.src);
      add(lvl.foreground?.src ?? lvl.foreground);
      add(lvl.fog?.src);
    }
  }
  for (const t of scene.tiles ?? []) add(t.texture?.src);
  for (const tok of scene.tokens ?? []) {
    add(tok.texture?.src);
    add(tok.ring?.subject?.texture);
    add(tok.turnMarker?.src);
  }
  for (const d of scene.drawings ?? []) add(d.texture);
  for (const tpl of scene.templates ?? []) add(tpl.texture);
  for (const n of scene.notes ?? []) add(n.texture?.src);
  add(globalThis.CONFIG?.Combat?.settings?.turnMarker?.src);
  return used;
}

export function disposeStaleSceneVramTextures() {
  if (!PERF_CONFIG.perfEnabled || !PERF_CONFIG.perfVramCleanup) return { disposed: 0, bytes: 0 };
  // Boundless scenes manage their own byte-budgeted LRUTextureManager; never evict their streamed assets here
  if (!isStandardSceneActive()) return { disposed: 0, bytes: 0 };
  const renderer = globalThis.canvas?.app?.renderer;
  const scene = globalThis.canvas?.scene;
  const managed = renderer?.texture?.managedTextures;
  if (!scene || !Array.isArray(managed) || managed.length === 0) return { disposed: 0, bytes: 0 };

  const activeUrls = collectSceneActiveAssetUrls(scene);
  const protectedBts = new Set();
  const ringBt = globalThis.CONFIG?.Token?.ring?.ringClass?.baseTexture;
  if (ringBt) protectedBts.add(ringBt);
  const ringSheetBt = globalThis.CONFIG?.Token?.ring?.spritesheet?.baseTexture;
  if (ringSheetBt) protectedBts.add(ringSheetBt);

  let disposed = 0;
  let bytes = 0;

  // Snapshot because dispose() mutates managedTextures
  const list = managed.slice();
  for (let i = 0; i < list.length; i++) {
    const bt = list[i];
    if (!bt || bt.destroyed || bt.isRenderTexture) continue;
    if (bt._boundlessManaged || protectedBts.has(bt)) continue;
    // Only target large textures (>= 1024x1024, >= ~4 MB uncompressed RGBA)
    const w = bt.realWidth || bt.width || 0;
    const h = bt.realHeight || bt.height || 0;
    if (w * h < 1024 * 1024) continue;

    // Require a real URL-backed resource so CanvasResource / dynamic spritesheets are never evicted
    const rawUrl = bt.resource?.url;
    if (!rawUrl || typeof rawUrl !== "string") continue;
    if (/\.(webm|mp4|m4v|ogg|ogv)$/i.test(rawUrl)) continue;
    // Never evict global Foundry or module spritesheets (token rings, VFX, weather, UI atlases)
    if (/(^|\/)(canvas\/tokens\/|multiple-rings\/|more-dynamic-token-rings\/|cs-rings\/|showstopper\/|fxmaster\/|jb2a|rings-[^/]+\.(webp|png))/i.test(rawUrl)) continue;

    const norm = normalizeAssetKey(rawUrl);
    if (!norm || activeUrls.has(norm)) continue;

    // Dispose GPU texture handle only (keeps BaseTexture & JS cache intact)
    try {
      bt.dispose();
      const est = Math.round(w * h * 4 * (bt.mipmap ? 1.33 : 1));
      disposed++;
      bytes += est;
    } catch {}
  }

  if (disposed > 0) {
    perfStats.vramTexturesDisposed += disposed;
    perfStats.vramBytesFreed += bytes;
    console.info(`${MODULE_ID} | Freed ${disposed} stale scene texture(s) from VRAM (~${(bytes / (1024 * 1024)).toFixed(1)} MB).`);
  }
  return { disposed, bytes };
}

function scheduleVramCleanup() {
  if (_vramTimer) clearTimeout(_vramTimer);
  _vramTimer = setTimeout(() => {
    _vramTimer = null;
    disposeStaleSceneVramTextures();
  }, 3000);
}

// ---------------------------------------------------------------------------
// 3. Quiet Idle Pre-warming of Sibling Levels on Standard Multi-Level Scenes
// ---------------------------------------------------------------------------

function scheduleStandardLevelPrewarm() {
  if (_prewarmTimer) clearTimeout(_prewarmTimer);
  _prewarmGen++;
  const gen = _prewarmGen;

  if (!PERF_CONFIG.perfEnabled || !PERF_CONFIG.perfIdleLevelPrewarm) return;
  if (!isStandardSceneActive()) return;

  const profile = _controllerRef?.vramProfile;
  if (profile === "low") return;

  const scene = globalThis.canvas?.scene;
  const levels = scene?.levels ? Array.from(scene.levels) : [];
  if (levels.length <= 1 || levels.length > 8) return;

  const activeLevelId = globalThis.canvas?.level?.id;
  const urls = [];
  for (const lvl of levels) {
    if (lvl.id === activeLevelId) continue;
    const src = lvl.background?.src;
    if (src && !/\.(webm|mp4|m4v)$/i.test(src)) urls.push(src);
  }
  if (!urls.length) return;

  _prewarmTimer = setTimeout(async () => {
    _prewarmTimer = null;
    const loadTex = globalThis.foundry?.canvas?.loadTexture ?? globalThis.loadTexture;
    if (typeof loadTex !== "function") return;
    for (const src of urls) {
      if (gen !== _prewarmGen || !isStandardSceneActive() || !PERF_CONFIG.perfEnabled || !PERF_CONFIG.perfIdleLevelPrewarm) {
        return;
      }
      if (globalThis.PIXI?.utils?.TextureCache?.[src]) continue;
      await new Promise((resolve) => {
        if (typeof globalThis.requestIdleCallback === "function") {
          globalThis.requestIdleCallback(() => resolve(), { timeout: 1200 });
        } else {
          setTimeout(resolve, 120);
        }
      });
      if (gen !== _prewarmGen || !isStandardSceneActive()) return;
      try {
        await loadTex(src);
        perfStats.standardLevelsPrewarmed++;
      } catch {}
    }
  }, 2200);
}

// ---------------------------------------------------------------------------
// 4. One-Time Heavy Scene Optimize Hint for GMs
// ---------------------------------------------------------------------------

export function isHeavyStandardScene(scene) {
  if (!scene || scene.flags?.[MODULE_ID]?.enabled) return false;
  const w = Number(scene.width) || 0;
  const h = Number(scene.height) || 0;
  const pixels = w * h;
  const tiles = scene.tiles?.size ?? scene.tiles?.length ?? 0;
  const lights = scene.lights?.size ?? scene.lights?.length ?? 0;
  return pixels >= 36_000_000 || tiles >= 30 || lights >= 60;
}

function maybeHintHeavyScene(scene) {
  if (!PERF_CONFIG.perfEnabled || !PERF_CONFIG.perfHeavySceneHint) return;
  if (!globalThis.game?.user?.isGM) return;
  if (!isStandardSceneActive() || !scene?.id) return;
  if (_hintedScenes.has(scene.id)) return;
  if (!isHeavyStandardScene(scene)) return;

  _hintedScenes.add(scene.id);
  const msg = globalThis.game.i18n?.format?.("BOUNDLESS.Perf.HeavySceneHint", {
    scene: scene.name || scene.id
  }) || loc("BOUNDLESS.Perf.HeavySceneHint");
  globalThis.ui?.notifications?.info?.(msg, { permanent: false });
}

// ---------------------------------------------------------------------------
// Lifecycle Installer
// ---------------------------------------------------------------------------

export function installAutoPerfEngine(controller) {
  if (_autoInstalled) return;
  _autoInstalled = true;
  _controllerRef = controller;

  if (globalThis.game?.settings?.get?.("core", "noCanvas")) return;

  Hooks.on("canvasReady", (c) => {
    syncDecorativeTileShaders(true);
    updateStandardSceneCulling();
    scheduleVramCleanup();
    scheduleStandardLevelPrewarm();
    setTimeout(() => maybeHintHeavyScene(c?.scene), 1500);
  });

  Hooks.on("canvasPan", () => {
    if (!isStandardSceneActive()) return;
    scheduleStandardCulling();
  });

  Hooks.on("drawTile", (tile) => {
    if (!isStandardSceneActive()) return;
    if (PERF_CONFIG.perfEnabled && PERF_CONFIG.perfAutoCulling) {
      syncSingleDecorativeTile(tile, true);
      scheduleStandardCulling();
    }
  });

  Hooks.on("refreshTile", (tile, flags) => {
    if (!isStandardSceneActive()) return;
    if (!PERF_CONFIG.perfEnabled || !PERF_CONFIG.perfAutoCulling) return;
    // O(1) update strictly for the refreshed tile (avoids O(N^2) 300ms+ freeze on 200+ tile scenes when TilesLayer activates or Showstopper slices tiles!)
    if (!flags || flags.refreshMesh || flags.refreshShader || flags.refreshState || flags.refreshElevation) {
      syncSingleDecorativeTile(tile, true);
    }
    scheduleStandardCulling();
  });

  for (const h of ["createTile", "updateTile", "deleteTile"]) {
    Hooks.on(h, (doc) => {
      if (!isStandardSceneActive()) return;
      if (PERF_CONFIG.perfEnabled && PERF_CONFIG.perfAutoCulling) {
        if (doc?.object) syncSingleDecorativeTile(doc.object, true);
        scheduleStandardCulling();
      }
    });
  }

  for (const h of [
    "createAmbientLight", "updateAmbientLight", "deleteAmbientLight",
    "createAmbientSound", "updateAmbientSound", "deleteAmbientSound",
    "createNote", "updateNote", "deleteNote",
    "createWall", "updateWall", "deleteWall",
    "highlightObjects", "lightingRefresh"
  ]) {
    Hooks.on(h, () => {
      if (isStandardSceneActive()) scheduleStandardCulling();
    });
  }

  Hooks.on("canvasTearDown", () => {
    _prewarmGen++;
    _hasFastBatchTiles = false;
    if (_cullTimer) { clearTimeout(_cullTimer); _cullTimer = null; }
    if (_vramTimer) { clearTimeout(_vramTimer); _vramTimer = null; }
    if (_prewarmTimer) { clearTimeout(_prewarmTimer); _prewarmTimer = null; }
  });
}
