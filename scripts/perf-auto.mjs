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
let _lightCullRaf = null;
let _vramTimer = null;
let _prewarmTimer = null;
let _prewarmGen = 0;
let _hasStandardCulling = false;
let _tileShadersSynced = false;
const _hintedScenes = new Set();

function isStandardSceneActive() {
  if (!globalThis.canvas?.ready || !globalThis.canvas?.scene) return false;
  if (_controllerRef?.active || _controllerRef?._mounting) return false;
  const lvlCfg = globalThis.canvas.level?.flags?.[MODULE_ID];
  if (lvlCfg?.enabled === true) return false;
  if (globalThis.canvas.scene.flags?.[MODULE_ID]?.enabled && lvlCfg?.enabled !== false) return false;
  return true;
}

// ---------------------------------------------------------------------------
// 1. Viewport Frustum Culling for Standard Scenes
// ---------------------------------------------------------------------------

export function computeExpandedViewport(stage, screen, marginFactor = 0.45, minPadPx = 420) {
  if (!stage?.worldTransform || !screen) return null;
  const wt = stage.worldTransform;
  const a = wt.a ?? 1;
  const b = wt.b ?? 0;
  const c = wt.c ?? 0;
  const d = wt.d ?? 1;
  const tx = wt.tx ?? 0;
  const ty = wt.ty ?? 0;
  const det = a * d - b * c;
  if (!Number.isFinite(det) || Math.abs(det) < 1e-10) return null;

  const invDet = 1 / det;
  const sx0 = screen.x ?? 0;
  const sy0 = screen.y ?? 0;
  const sx1 = sx0 + (screen.width ?? 0);
  const sy1 = sy0 + (screen.height ?? 0);

  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  const corners = [
    [sx0, sy0],
    [sx1, sy0],
    [sx0, sy1],
    [sx1, sy1]
  ];
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
  if (!Number.isFinite(minX) || !Number.isFinite(maxX) || !Number.isFinite(minY) || !Number.isFinite(maxY)) return null;

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

const applyStdCull = (obj, inView) => {
  if (!obj || obj.destroyed) return false;
  if (!inView) {
    if (obj.renderable) {
      obj.renderable = false;
      obj._blStdCulled = true;
    }
    return true;
  }
  if (obj._blStdCulled) {
    obj.renderable = true;
    obj._blStdCulled = false;
  }
  return false;
};

const restoreStdCull = (obj) => {
  if (obj && !obj.destroyed && obj._blStdCulled) {
    obj.renderable = true;
    obj._blStdCulled = false;
  }
};

export function restoreAllStandardCulling() {
  const c = globalThis.canvas;
  if (!c) return;
  if (_hasFastBatchTiles || _tileShadersSynced) syncDecorativeTileShaders(false);
  if (!_hasStandardCulling) return;
  _hasStandardCulling = false;
  for (const tile of c.tiles?.placeables ?? []) restoreStdCull(tile.mesh);
  for (const al of c.lighting?.placeables ?? []) restoreStdCull(al.controls ?? al.controlIcon);
  for (const as of c.sounds?.placeables ?? []) restoreStdCull(as.controls ?? as.controlIcon);
  for (const note of c.notes?.placeables ?? []) restoreStdCull(note.controlIcon ?? note.controls);
  for (const door of c.controls?.doors?.children ?? []) restoreStdCull(door);
  for (const wall of c.walls?.placeables ?? []) restoreStdCull(wall);
  for (const ls of c.effects?.lightSources ?? []) {
    restoreStdCull(ls.layers?.background?.mesh);
    restoreStdCull(ls.layers?.illumination?.mesh);
    restoreStdCull(ls.layers?.coloration?.mesh);
  }
  for (const ds of c.effects?.darknessSources ?? []) {
    restoreStdCull(ds.layers?.darkness?.mesh);
  }
}

export function updateStandardSceneCulling() {
  if (!PERF_CONFIG.perfEnabled || !PERF_CONFIG.perfAutoCulling) {
    restoreAllStandardCulling();
    return;
  }
  if (!isStandardSceneActive()) return;
  if (!_tileShadersSynced) syncDecorativeTileShaders(true);
  _hasStandardCulling = true;

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
        if (mesh._blStdCulled) {
          mesh.renderable = true;
          mesh._blStdCulled = false;
        }
        continue;
      }
      const cb = mesh.canvasBounds;
      let inView;
      if (cb && Number.isFinite(cb.x) && Number.isFinite(cb.y) && cb.width > 0 && cb.height > 0) {
        inView = rectsIntersect(cb.x, cb.y, cb.x + cb.width, cb.y + cb.height, vp);
      } else {
        const doc = t.document;
        const rawW = Number(doc.width) || 0;
        const rawH = Number(doc.height) || 0;
        const absW = Math.abs(rawW);
        const absH = Math.abs(rawH);
        const scaleX = Math.max(1, Math.abs(Number(doc.texture?.scaleX) || 1));
        const scaleY = Math.max(1, Math.abs(Number(doc.texture?.scaleY) || 1));
        const x0 = rawW >= 0 ? (doc.x ?? 0) : (doc.x ?? 0) + rawW;
        const y0 = rawH >= 0 ? (doc.y ?? 0) : (doc.y ?? 0) + rawH;
        const cx = x0 + absW * 0.5;
        const cy = y0 + absH * 0.5;
        const halfW = absW * scaleX * 0.5;
        const halfH = absH * scaleY * 0.5;
        // Generous padding for rotated/scaled/flipped tiles
        const diagPad = doc.rotation ? Math.max(halfW, halfH) : 0;
        inView = rectsIntersect(cx - halfW - diagPad, cy - halfH - diagPad, cx + halfW + diagPad, cy + halfH + diagPad, vp);
      }
      if (!inView) {
        // Only cull meshes currently renderable so third-party hides (fa-nexus previews, burn-living-map machines) stay untouched
        if (mesh.renderable) {
          mesh.renderable = false;
          mesh._blStdCulled = true;
        }
        culledTiles++;
      } else if (mesh._blStdCulled) {
        mesh.renderable = true;
        mesh._blStdCulled = false;
      }
    }
  } else {
    for (let i = 0; i < tiles.length; i++) {
      const mesh = tiles[i].mesh;
      if (mesh && !mesh.destroyed && mesh._blStdCulled) {
        mesh.renderable = true;
        mesh._blStdCulled = false;
      }
    }
  }

  // Light control icons: skip when LightingLayer container is hidden (e.g. on TokensLayer)
  const lights = c.lighting?.placeables ?? [];
  const lightsVisible = c.lighting?.objects?.visible !== false && c.lighting?.visible !== false;
  const lightsHi = Boolean(c.lighting?.highlightObjects);
  if (lightsVisible && lights.length >= 20) {
    for (let i = 0; i < lights.length; i++) {
      const al = lights[i];
      const icon = al.controls ?? al.controlIcon;
      if (!icon || icon.destroyed) continue;
      if (lightsHi || al.controlled || al.hover || al.isPreview) {
        restoreStdCull(icon);
        continue;
      }
      const x = al.document?.x ?? 0;
      const y = al.document?.y ?? 0;
      const r = al.radius || 0;
      const inView = (x + r >= vp.minX) && (x - r <= vp.maxX) && (y + r >= vp.minY) && (y - r <= vp.maxY);
      if (applyStdCull(icon, inView)) culledLights++;
    }
  } else if (lightsVisible) {
    for (let i = 0; i < lights.length; i++) restoreStdCull(lights[i].controls ?? lights[i].controlIcon);
  }

  // Sound control icons: skip when SoundsLayer container is hidden
  const sounds = c.sounds?.placeables ?? [];
  const soundsVisible = c.sounds?.objects?.visible !== false && c.sounds?.visible !== false;
  const soundsHi = Boolean(c.sounds?.highlightObjects);
  if (soundsVisible && sounds.length >= 20) {
    for (let i = 0; i < sounds.length; i++) {
      const as = sounds[i];
      const icon = as.controls ?? as.controlIcon;
      if (!icon || icon.destroyed) continue;
      if (soundsHi || as.controlled || as.hover || as.isPreview) {
        restoreStdCull(icon);
        continue;
      }
      const x = as.document?.x ?? 0;
      const y = as.document?.y ?? 0;
      const r = as.radius || 0;
      const inView = (x + r >= vp.minX) && (x - r <= vp.maxX) && (y + r >= vp.minY) && (y - r <= vp.maxY);
      if (applyStdCull(icon, inView)) culledSounds++;
    }
  } else if (soundsVisible) {
    for (let i = 0; i < sounds.length; i++) restoreStdCull(sounds[i].controls ?? sounds[i].controlIcon);
  }

  // Note control icons: skip when NotesLayer is hidden
  const notes = c.notes?.placeables ?? [];
  const notesVisible = c.notes?.visible !== false && c.notes?.objects?.visible !== false;
  const notesHi = Boolean(c.notes?.highlightObjects);
  if (notesVisible && notes.length >= 8) {
    for (let i = 0; i < notes.length; i++) {
      const n = notes[i];
      const icon = n.controlIcon ?? n.controls;
      if (!icon || icon.destroyed) continue;
      if (notesHi || n.controlled || n.hover || n.isPreview) {
        restoreStdCull(icon);
        continue;
      }
      const x = n.document?.x ?? 0;
      const y = n.document?.y ?? 0;
      applyStdCull(icon, x >= vp.minX && x <= vp.maxX && y >= vp.minY && y <= vp.maxY);
    }
  } else if (notesVisible) {
    for (let i = 0; i < notes.length; i++) restoreStdCull(notes[i].controlIcon ?? notes[i].controls);
  }

  // DoorControl icons: engage when scene has >= 12 doors
  let culledDoors = 0;
  const doors = c.controls?.doors?.children ?? [];
  if (doors.length >= 12) {
    for (let i = 0; i < doors.length; i++) {
      const d = doors[i];
      if (!d || d.destroyed) continue;
      const inView = d.x >= vp.minX && d.x <= vp.maxX && d.y >= vp.minY && d.y <= vp.maxY;
      if (applyStdCull(d, inView)) culledDoors++;
    }
  } else {
    for (let i = 0; i < doors.length; i++) restoreStdCull(doors[i]);
  }

  // WallsLayer frustum culling: skip when WallsLayer is hidden (saves O(N) walk of 1000+ walls on every gameplay pan!)
  const walls = c.walls?.placeables ?? [];
  const wallsVisible = c.walls?.objects?.visible !== false && c.walls?.visible !== false;
  const wallsHi = Boolean(c.walls?.highlightObjects);
  if (wallsVisible && walls.length >= 100) {
    for (let i = 0; i < walls.length; i++) {
      const w = walls[i];
      if (!w || w.destroyed) continue;
      if (wallsHi || w.controlled || w.hover || w.isPreview) {
        restoreStdCull(w);
        continue;
      }
      const coords = w.document?.c;
      if (!coords || coords.length < 4) continue;
      const minX = coords[0] < coords[2] ? coords[0] : coords[2];
      const maxX = coords[0] > coords[2] ? coords[0] : coords[2];
      const minY = coords[1] < coords[3] ? coords[1] : coords[3];
      const maxY = coords[1] > coords[3] ? coords[1] : coords[3];
      applyStdCull(w, rectsIntersect(minX, minY, maxX, maxY, vp));
    }
  } else if (wallsVisible) {
    for (let i = 0; i < walls.length; i++) restoreStdCull(walls[i]);
  }

  // Offscreen PointLightSource / PointDarknessSource mesh culling (skips offscreen light shader passes!)
  const culledLightMeshes = updateStandardLightMeshCulling(vp);

  perfStats.autoCulledTiles = culledTiles;
  perfStats.autoCulledLights = culledLights;
  perfStats.autoCulledLightMeshes = culledLightMeshes;
  perfStats.autoCulledDoors = culledDoors;
  perfStats.autoCulledSounds = culledSounds;
}

export function updateStandardLightMeshCulling(vp = null) {
  if (!PERF_CONFIG.perfEnabled || !PERF_CONFIG.perfAutoCulling) return 0;
  if (!isStandardSceneActive()) return 0;
  const c = globalThis.canvas;
  const bounds = vp ?? computeExpandedViewport(c.stage, c.app?.renderer?.screen, 0.45, 420);
  if (!bounds) return 0;
  _hasStandardCulling = true;

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
      const animating = Boolean(ls.object?.movementAnimationPromise || ls.object?.animationContexts?.size > 0);
      if (!cullLs || animating) {
        restoreStdCull(bg);
        restoreStdCull(il);
        restoreStdCull(co);
        continue;
      }
      const r = ls.radius ?? ls.data?.radius;
      if (!Number.isFinite(r) || r <= 0) {
        restoreStdCull(bg);
        restoreStdCull(il);
        restoreStdCull(co);
        continue;
      }
      const lx = ls.x ?? ls.data?.x;
      const ly = ls.y ?? ls.data?.y;
      if (!Number.isFinite(lx) || !Number.isFinite(ly)) continue;
      const inView = (lx + r >= bounds.minX) && (lx - r <= bounds.maxX) && (ly + r >= bounds.minY) && (ly - r <= bounds.maxY);
      applyStdCull(bg, inView);
      applyStdCull(il, inView);
      applyStdCull(co, inView);
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
      const animating = Boolean(ds.object?.movementAnimationPromise || ds.object?.animationContexts?.size > 0);
      if (!cullDs || animating) {
        restoreStdCull(dk);
        continue;
      }
      const r = ds._visualShape?.config?.radius ?? ((ds.radius ?? ds.data?.radius ?? 0) + (ds._padding ?? 0));
      if (!Number.isFinite(r) || r <= 0) {
        restoreStdCull(dk);
        continue;
      }
      const lx = ds.x ?? ds.data?.x;
      const ly = ds.y ?? ds.data?.y;
      if (!Number.isFinite(lx) || !Number.isFinite(ly)) continue;
      const inView = (lx + r >= bounds.minX) && (lx - r <= bounds.maxX) && (ly + r >= bounds.minY) && (ly - r <= bounds.maxY);
      if (applyStdCull(dk, inView)) culledLightMeshes++;
    }
  }
  perfStats.autoCulledLightMeshes = culledLightMeshes;
  return culledLightMeshes;
}

/**
 * Switch purely decorative native tiles (no occlusion, no light/weather restriction, non-video)
 * onto PIXI's lightweight `"batch"` shader instead of Foundry's heavier `"batchOcclusion"` shader.
 * Always resets to `null` (never `"batchOcclusion"`) so CanvasDepthMask's `"batchDepth"` stays intact.
 */
let _hasFastBatchTiles = false;

export function syncSingleDecorativeTile(t, allow) {
  const m = t?.mesh;
  if (!m || m.destroyed || m._boundlessMesh) return;
  if (!allow) {
    if (m._blFastBatch) {
      m.pluginName = null;
      m._blFastBatch = false;
    }
    return;
  }
  // If a third-party module replaced the tile's shader (setShaderClass, including custom direct shaders where pluginName === null), release our `"batch"` override
  if (m._blFastBatch && m._shader && m._shader.pluginName !== "batchOcclusion") {
    m.pluginName = null;
    m._blFastBatch = false;
    return;
  }
  const doc = t.document;
  // Check both document & mesh fields: PIXI "batch" shader ignores unoccludedAlpha (Tile opacity < 1),
  // occlusion modes, and light/weather depth restrictions.
  const docAlpha = doc?.alpha ?? 1;
  const unoccAlpha = m.unoccludedAlpha ?? 1;
  const hasDocOcc = doc?.occlusion?.modes ? doc.occlusion.modes.size > 0 : Boolean(doc?.occlusion?.mode);
  const hasDocRestrict = Boolean(doc?.restrictions?.light || doc?.restrictions?.weather);
  const isDecorative =
    docAlpha >= 0.999 &&
    unoccAlpha >= 0.999 &&
    !hasDocOcc &&
    !hasDocRestrict &&
    !m.occlusionMode &&
    !m.hoverFade &&
    !m.restrictsLight &&
    !m.restrictsWeather &&
    !t.isVideo;
  if (isDecorative) {
    // Only switch default Foundry batchOcclusion tiles; preserve any custom tile shader (FXMaster, Showstopper, TokenMagic)
    const shaderPlugin = m._shader?.pluginName ?? m.pluginName;
    if (shaderPlugin === "batchOcclusion" && !m._blFastBatch) {
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
  const allow = Boolean(enable && PERF_CONFIG.perfEnabled && PERF_CONFIG.perfAutoCulling && isStandardSceneActive());
  if (!allow) {
    _tileShadersSynced = false;
    if (!_hasFastBatchTiles || !tiles?.length) {
      _hasFastBatchTiles = false;
      return;
    }
  } else {
    _tileShadersSynced = true;
    if (!tiles?.length) return;
  }
  for (let i = 0; i < tiles.length; i++) {
    syncSingleDecorativeTile(tiles[i], allow);
  }
  if (!allow) _hasFastBatchTiles = false;
}

let _cullRaf = null;
function scheduleStandardCulling(immediateFrame = false) {
  if (!PERF_CONFIG.perfEnabled || !PERF_CONFIG.perfAutoCulling) return;
  if (immediateFrame && typeof globalThis.requestAnimationFrame === "function") {
    if (_cullTimer) { clearTimeout(_cullTimer); _cullTimer = null; }
    if (_cullRaf !== null) return;
    _cullRaf = globalThis.requestAnimationFrame(() => {
      _cullRaf = null;
      updateStandardSceneCulling();
    });
    return;
  }
  if (_cullTimer || _cullRaf !== null) return;
  _cullTimer = setTimeout(() => {
    _cullTimer = null;
    updateStandardSceneCulling();
  }, 16);
}

function scheduleLightMeshCulling() {
  if (!PERF_CONFIG.perfEnabled || !PERF_CONFIG.perfAutoCulling) return;
  if (_cullRaf !== null) return; // full pass already queued for this frame
  if (typeof globalThis.requestAnimationFrame === "function") {
    if (_lightCullRaf !== null) return;
    _lightCullRaf = globalThis.requestAnimationFrame(() => {
      _lightCullRaf = null;
      updateStandardLightMeshCulling();
    });
    return;
  }
  updateStandardLightMeshCulling();
}

// ---------------------------------------------------------------------------
// 2. Smart Cross-Scene Idle VRAM Cleanup
// ---------------------------------------------------------------------------

export function normalizeAssetKey(url) {
  if (typeof url !== "string" || !url) return "";
  let clean = url.split("?")[0].split("#")[0];
  const origin = globalThis.location?.origin;
  if (origin && clean.startsWith(origin)) {
    clean = clean.slice(origin.length);
  }
  // Strip Foundry server routePrefix (e.g. "/foundry/") when configured
  let routePrefix = "";
  try {
    const rawRoute = globalThis.foundry?.utils?.getRoute?.("") ?? globalThis.ROUTE_PREFIX ?? "";
    if (typeof rawRoute === "string") routePrefix = rawRoute.replace(/^\/+|\/+$/g, "");
  } catch {}
  clean = clean.replace(/^\/+/, "");
  if (routePrefix && (clean === routePrefix || clean.startsWith(`${routePrefix}/`))) {
    clean = clean.slice(routePrefix.length).replace(/^\/+/, "");
  }
  try {
    return decodeURIComponent(clean);
  } catch {
    return clean;
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
  add(scene._source?.fog?.overlay ?? scene.fog?.overlay);

  if (scene.levels) {
    for (const lvl of scene.levels) {
      add(lvl.background?.src);
      add(lvl.foreground?.src ?? lvl.foreground);
      add(lvl.fog?.overlay);
      add(lvl.fog?.src);
    }
  }
  for (const w of scene.walls ?? []) add(w.animation?.texture);
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
  const protectTex = (t) => {
    const bt = t?.baseTexture ?? (t?.realWidth !== undefined ? t : null);
    if (bt) protectedBts.add(bt);
  };
  const protectUniforms = (u) => {
    if (!u || typeof u !== "object") return;
    for (const k in u) {
      const v = u[k];
      if (v && typeof v === "object" && (v.baseTexture !== undefined || v.realWidth !== undefined)) {
        protectTex(v);
      }
    }
  };
  const walkDisplayTree = (node, depth = 0) => {
    if (!node || depth > 8) return;
    protectTex(node.texture);
    protectUniforms(node.shader?.uniforms);
    if (node.mask && typeof node.mask === "object") {
      protectTex(node.mask.texture);
      if (node.mask.maskObject) protectTex(node.mask.maskObject.texture);
    }
    const filters = node.filters;
    if (Array.isArray(filters)) {
      for (let i = 0; i < filters.length; i++) protectUniforms(filters[i]?.uniforms);
    }
    const kids = node.children;
    if (Array.isArray(kids)) {
      for (let i = 0; i < kids.length; i++) walkDisplayTree(kids[i], depth + 1);
    }
  };
  protectTex(globalThis.CONFIG?.Token?.ring?.ringClass?.baseTexture);
  protectTex(globalThis.CONFIG?.Token?.ring?.spritesheet?.baseTexture);
  // Recursively protect every live BaseTexture attached to active display trees (weatherEffects, fog, modules, doors, rings)
  const c = globalThis.canvas;
  protectTex(c?.primary?.background?.texture);
  protectTex(c?.primary?.foreground?.texture);
  protectTex(c?.fog?.sprite?.texture);
  for (const lt of c?.primary?.levelTextures ?? []) protectTex(lt?.texture);
  walkDisplayTree(c?.primary);
  walkDisplayTree(c?.weather);
  walkDisplayTree(c?.effects);
  walkDisplayTree(c?.interface);
  walkDisplayTree(c?.controls);
  walkDisplayTree(c?.environment);
  walkDisplayTree(c?.overlay);
  for (const t of c?.tiles?.placeables ?? []) protectTex(t?.mesh?.texture);
  for (const tok of c?.tokens?.placeables ?? []) {
    protectTex(tok?.mesh?.texture);
    protectTex(tok?.ring?.subjectTexture);
    protectTex(tok?.turnMarker?.mesh?.texture);
  }
  for (const d of c?.drawings?.placeables ?? []) protectTex(d?.shape?.texture);
  for (const tpl of c?.templates?.placeables ?? []) protectTex(tpl?.texture);
  protectTex(c?.visibility?.visibilityOverlay?.texture);

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
    if (/\.(webm|mp4|m4v|ogg|ogv|mov|ktx2|dds|basis)(?:[?#]|$)/i.test(rawUrl)) continue;
    if (bt.resource?.constructor?.name?.includes?.("Compressed")) continue;
    // Never evict global Foundry or module spritesheets / token packs (token rings, Hero in a Box, VFX, weather, UI atlases)
    if (/(^|\/)(canvas\/tokens\/|multiple-rings\/|more-dynamic-token-rings\/|cs-rings\/|cs-hero-box\/|sh-hero-box[^/]*\/|showstopper\/|showstopper-plus\/|sequencer\/|fxmaster\/|fxmaster-plus\/|burn-living-map\/|jb2a|rings-[^/]+\.(webp|png))/i.test(rawUrl)) continue;

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
    if (src && !/\.(webm|mp4|m4v|ogv|ogg|mov)(?:[?#]|$)/i.test(src)) urls.push(src);
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
  if (!scene) return false;
  const sceneEnabled = Boolean(scene.flags?.[MODULE_ID]?.enabled);
  const lvls = scene.levels ? Array.from(scene.levels) : [];
  if (lvls.length > 0) {
    const hasUnbaked = lvls.some((l) => {
      const lc = l.flags?.[MODULE_ID];
      return !(lc?.enabled === true || (sceneEnabled && lc?.enabled !== false));
    });
    if (!hasUnbaked) return false;
  } else if (sceneEnabled) {
    return false;
  }
  const w = Number(scene.width) || 0;
  const h = Number(scene.height) || 0;
  const pixels = w * h;
  const tiles = scene.tiles?.size ?? scene.tiles?.length ?? 0;
  const lights = scene.lights?.size ?? scene.lights?.length ?? 0;
  return pixels >= 36_000_000 || tiles >= 30 || lights >= 60;
}

let _hintTimer = null;

export function cancelAutoPerfTimers() {
  _prewarmGen++;
  if (_cullTimer) { clearTimeout(_cullTimer); _cullTimer = null; }
  if (_cullRaf !== null && typeof globalThis.cancelAnimationFrame === "function") {
    globalThis.cancelAnimationFrame(_cullRaf);
    _cullRaf = null;
  }
  if (_lightCullRaf !== null && typeof globalThis.cancelAnimationFrame === "function") {
    globalThis.cancelAnimationFrame(_lightCullRaf);
    _lightCullRaf = null;
  }
  if (_vramTimer) { clearTimeout(_vramTimer); _vramTimer = null; }
  if (_prewarmTimer) { clearTimeout(_prewarmTimer); _prewarmTimer = null; }
  if (_hintTimer) { clearTimeout(_hintTimer); _hintTimer = null; }
}

function maybeHintHeavyScene(scene) {
  if (!PERF_CONFIG.perfEnabled || !PERF_CONFIG.perfHeavySceneHint) return;
  if (!globalThis.game?.user?.isGM) return;
  if (!isStandardSceneActive() || !scene?.id || globalThis.canvas?.scene?.id !== scene.id) return;
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
  if (controller) {
    controller._restoreStandardCulling = restoreAllStandardCulling;
    controller._runStandardAutoPerf = () => {
      syncDecorativeTileShaders(true);
      updateStandardSceneCulling();
      scheduleVramCleanup();
      scheduleStandardLevelPrewarm();
    };
  }

  if (globalThis.game?.settings?.get?.("core", "noCanvas")) return;

  Hooks.on("canvasReady", (c) => {
    syncDecorativeTileShaders(true);
    updateStandardSceneCulling();
    scheduleVramCleanup();
    scheduleStandardLevelPrewarm();
    if (_hintTimer) clearTimeout(_hintTimer);
    const readyScene = c?.scene;
    _hintTimer = setTimeout(() => {
      _hintTimer = null;
      maybeHintHeavyScene(readyScene);
    }, 1500);
  });

  Hooks.on("canvasPan", () => {
    if (!isStandardSceneActive()) return;
    scheduleStandardCulling(true);
  });

  Hooks.on("canvasResize", () => {
    if (!isStandardSceneActive()) return;
    scheduleStandardCulling(true);
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
    "controlTile",
    "controlAmbientLight",
    "controlAmbientSound",
    "controlNote",
    "controlWall",
    "highlightObjects",
    "activateWallsLayer", "activateLightingLayer", "activateSoundsLayer", "activateNotesLayer", "activateTilesLayer"
  ]) {
    Hooks.on(h, () => {
      if (isStandardSceneActive()) scheduleStandardCulling(true);
    });
  }

  // O(1) hover un-cull without triggering a full O(N) scene culling pass on every mouseover
  for (const h of ["hoverTile", "hoverAmbientLight", "hoverAmbientSound", "hoverNote", "hoverWall"]) {
    Hooks.on(h, (obj, hovered) => {
      if (!hovered || !obj || obj.destroyed || !PERF_CONFIG.perfEnabled || !PERF_CONFIG.perfAutoCulling || !isStandardSceneActive()) return;
      if (obj.mesh && !obj.mesh.destroyed && obj.mesh._blStdCulled) {
        obj.mesh.renderable = true;
        obj.mesh._blStdCulled = false;
      }
      const icon = obj.controls ?? obj.controlIcon;
      if (icon && !icon.destroyed && icon._blStdCulled) {
        icon.renderable = true;
        icon._blStdCulled = false;
      }
      if (obj._blStdCulled) {
        obj.renderable = true;
        obj._blStdCulled = false;
      }
    });
  }

  Hooks.on("lightingRefresh", () => {
    if (isStandardSceneActive()) scheduleLightMeshCulling();
  });

  Hooks.on("updateToken", (doc, changes) => {
    if (!isStandardSceneActive()) return;
    if ((globalThis.canvas?.effects?.lightSources?.size ?? 0) < 16 && (globalThis.canvas?.effects?.darknessSources?.size ?? 0) < 8) return;
    if (changes && ("light" in changes || ((doc?.object?.light?.active || doc?.light?.negative) && ("x" in changes || "y" in changes || "level" in changes)))) {
      scheduleLightMeshCulling();
    }
  });

  Hooks.on("canvasTearDown", () => {
    cancelAutoPerfTimers();
    _hasFastBatchTiles = false;
    _hasStandardCulling = false;
    _tileShadersSynced = false;
  });
}
