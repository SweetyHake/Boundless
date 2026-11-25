import {
  MODULE_ID,
  getEffectiveScale,
  getExistingSheet,
  isSheetActiveOrRendering,
  makeVirtualId,
  attachVirtualCollectionProxy
} from "./utils.mjs";

const LIGHT_STREAM_MIN_SCALE = 0.22;
const SOUND_STREAM_MIN_SCALE = 0.18;
const TILE_STREAM_MIN_SCALE = 0.18;
const MAX_LIGHTS_IN_VIEW = 260;
const MAX_SOUNDS_IN_VIEW = 200;
const MAX_TILES_IN_VIEW = 160;
const MAX_MACRO_MARKERS = 1500;
const LAYER_MOUNT_BUDGET_MS = 2.5;
const LAYER_SYNC_MOUNTS_PER_PASS = 4;

let _validOcclusionModesCache = null;
function getValidOcclusionModes() {
  if (_validOcclusionModesCache) return _validOcclusionModesCache;
  const set = new Set(
    Object.values(CONST.OCCLUSION_MODES || {}).filter(v => typeof v === "number" && v > 0)
  );
  if (set.size > 0) _validOcclusionModesCache = set;
  return set;
}

function resolveOcclusionModeArray(modeSpec) {
  const validValues = getValidOcclusionModes();
  if (Array.isArray(modeSpec)) {
    const out = new Set();
    for (const m of modeSpec) {
      if (typeof m === "string" && m in (CONST.OCCLUSION_MODES || {})) {
        const v = CONST.OCCLUSION_MODES[m];
        if (validValues.has(v)) out.add(v);
      } else if (typeof m === "number" && validValues.has(m)) {
        out.add(m);
      }
    }
    return Array.from(out);
  }
  if (typeof modeSpec === "number") {
    const out = [];
    for (const bit of validValues) {
      if ((modeSpec & bit) === bit) out.push(bit);
    }
    return out;
  }
  if (typeof modeSpec === "string" && modeSpec in (CONST.OCCLUSION_MODES || {})) {
    const v = CONST.OCCLUSION_MODES[modeSpec];
    return validValues.has(v) ? [v] : [];
  }
  return [];
}

function drawShapeDataOutline(gfx, shape, lineColor = 0xEEEEEE, lineAlpha = 0.4) {
  if (!gfx || !shape) return;
  const s = canvas.dimensions?.uiScale || 1;
  gfx.lineStyle(2 * s, lineColor, lineAlpha);
  if (Array.isArray(shape.polygons) && shape.polygons.length > 0) {
    for (const poly of shape.polygons) {
      gfx.drawShape(poly);
    }
  } else if (typeof shape.radius === "number" && shape.radius > 0) {
    gfx.drawCircle(shape.x || 0, shape.y || 0, shape.radius);
  } else if (typeof shape.type === "number") {
    gfx.drawShape(shape);
  }
}

export class VirtualLayerEditors {
  controller = null;

  lightActive = false;
  soundActive = false;
  tileActive = false;

  // Mounted native Placeables per layer: key -> entry, id -> entry
  lightsByKey = new Map();
  lightsById = new Map();
  soundsByKey = new Map();
  soundsById = new Map();
  tilesByKey = new Map();
  tilesById = new Map();

  lightMacroGfx = null;
  soundMacroGfx = null;

  _lastLightKey = "";
  _lastSoundKey = "";
  _lastTileKey = "";
  _lightGen = 0;
  _soundGen = 0;
  _tileGen = 0;
  _patches = null;
  _mountQueue = [];
  _mountQueuedKeys = new Set();
  _mountRafId = null;

  constructor(controller) {
    this.controller = controller;
  }

  _enqueueMount(kind, key, item, gen, editsRev) {
    const qk = `${kind}:${key}`;
    if (this._mountQueuedKeys.has(qk)) return;
    this._mountQueuedKeys.add(qk);
    this._mountQueue.push({ kind, key, qk, item, gen, editsRev });
    if (this._mountRafId === null) {
      const sched = typeof requestAnimationFrame === "function" ? requestAnimationFrame : (fn => setTimeout(fn, 16));
      this._mountRafId = sched(() => this._pumpMountQueue());
    }
  }

  _purgeMountQueue(kind = null) {
    if (!kind) {
      this._mountQueue = [];
      this._mountQueuedKeys.clear();
      if (this._mountRafId !== null) {
        if (typeof cancelAnimationFrame === "function") {
          try { cancelAnimationFrame(this._mountRafId); } catch {}
        } else {
          clearTimeout(this._mountRafId);
        }
        this._mountRafId = null;
      }
      return;
    }
    if (!this._mountQueue.length) return;
    const kept = [];
    for (let i = 0; i < this._mountQueue.length; i++) {
      const job = this._mountQueue[i];
      if (job.kind === kind) this._mountQueuedKeys.delete(job.qk);
      else kept.push(job);
    }
    this._mountQueue = kept;
  }

  _pumpMountQueue() {
    this._mountRafId = null;
    if (!this.controller?.active || !this._mountQueue.length) return;
    const t0 = performance.now();
    let mounted = 0;
    while (this._mountQueue.length > 0 && mounted < 6 && (mounted === 0 || (performance.now() - t0) < LAYER_MOUNT_BUDGET_MS)) {
      const job = this._mountQueue.shift();
      this._mountQueuedKeys.delete(job.qk);
      if (job.kind === "light") {
        if (!this.lightActive || job.gen !== this._lightGen || this.lightsByKey.has(job.key)) continue;
        this._mountNativeLight(job.item, job.gen, job.editsRev);
        mounted++;
      } else if (job.kind === "sound") {
        if (!this.soundActive || job.gen !== this._soundGen || this.soundsByKey.has(job.key)) continue;
        this._mountNativeSound(job.item, job.gen, job.editsRev);
        mounted++;
      } else if (job.kind === "tile") {
        if (!this.tileActive || job.gen !== this._tileGen || this.tilesByKey.has(job.key)) continue;
        this._mountNativeTile(job.item, job.gen, job.editsRev);
        mounted++;
      }
    }
    if (this._mountQueue.length > 0 && this._mountRafId === null) {
      const sched = typeof requestAnimationFrame === "function" ? requestAnimationFrame : (fn => setTimeout(fn, 16));
      this._mountRafId = sched(() => this._pumpMountQueue());
    }
  }

  mount() {
    this.unmount();
    if (!game.user?.isGM || !canvas?.scene) return;

    if (canvas.lighting) {
      this.lightMacroGfx = new PIXI.Graphics();
      this.lightMacroGfx.name = "BoundlessVirtualLightsMacro";
      this.lightMacroGfx.eventMode = "none";
      this.lightMacroGfx.zIndex = -10;
      this.lightMacroGfx.visible = false;
      canvas.lighting.sortableChildren = true;
      canvas.lighting.addChildAt(this.lightMacroGfx, 0);
    }

    if (canvas.sounds) {
      this.soundMacroGfx = new PIXI.Graphics();
      this.soundMacroGfx.name = "BoundlessVirtualSoundsMacro";
      this.soundMacroGfx.eventMode = "none";
      this.soundMacroGfx.zIndex = -10;
      this.soundMacroGfx.visible = false;
      canvas.sounds.sortableChildren = true;
      canvas.sounds.addChildAt(this.soundMacroGfx, 0);
    }

    this._installPatches();

    if (canvas.lighting?.active) this.activateLighting();
    if (canvas.sounds?.active) this.activateSounds();
    if (canvas.tiles?.active) this.activateTiles();
  }

  _installPatches() {
    if (this._patches || !canvas?.scene) return;
    const scene = canvas.scene;
    const lighting = canvas.lighting;
    const sounds = canvas.sounds;
    const tiles = canvas.tiles;

    const origUpdateEmbedded = scene.updateEmbeddedDocuments;
    const origDeleteEmbedded = scene.deleteEmbeddedDocuments;
    const origLightGet = lighting?.get;
    const origSoundGet = sounds?.get;
    const origTileGet = tiles?.get;
    const state = { active: true };

    const wrappedLightGet = (lighting && origLightGet)
      ? (id) => (state.active ? this.lightsById.get(id)?.placeable : null) || origLightGet.call(lighting, id)
      : null;
    const wrappedSoundGet = (sounds && origSoundGet)
      ? (id) => (state.active ? this.soundsById.get(id)?.placeable : null) || origSoundGet.call(sounds, id)
      : null;
    const wrappedTileGet = (tiles && origTileGet)
      ? (id) => (state.active ? this.tilesById.get(id)?.placeable : null) || origTileGet.call(tiles, id)
      : null;

    if (wrappedLightGet) lighting.get = wrappedLightGet;
    if (wrappedSoundGet) sounds.get = wrappedSoundGet;
    if (wrappedTileGet) tiles.get = wrappedTileGet;

    const wrappedUpdateEmbedded = async (embeddedName, updates = [], operation = {}) => {
      if (!state.active) return origUpdateEmbedded.call(scene, embeddedName, updates, operation);
      const mapById = embeddedName === "AmbientLight" ? this.lightsById
        : embeddedName === "AmbientSound" ? this.soundsById
        : embeddedName === "Tile" ? this.tilesById
        : null;

      if (!mapById || !mapById.size || !Array.isArray(updates) || !updates.length) {
        return origUpdateEmbedded.call(scene, embeddedName, updates, operation);
      }

      const realUpdates = [];
      const virtUpdates = [];
      for (const u of updates) {
        const id = u?._id ?? u?.id;
        if (id && mapById.has(id)) virtUpdates.push(u);
        else realUpdates.push(u);
      }

      const results = [];
      if (realUpdates.length) {
        const r = await origUpdateEmbedded.call(scene, embeddedName, realUpdates, operation);
        if (Array.isArray(r)) results.push(...r);
      }
      if (virtUpdates.length) {
        const v = embeddedName === "AmbientLight" ? await this._commitLightUpdates(virtUpdates)
          : embeddedName === "AmbientSound" ? await this._commitSoundUpdates(virtUpdates)
          : await this._commitTileUpdates(virtUpdates);
        results.push(...v);
      }
      return results;
    };

    const wrappedDeleteEmbedded = async (embeddedName, ids = [], operation = {}) => {
      if (!state.active) return origDeleteEmbedded.call(scene, embeddedName, ids, operation);
      const mapById = embeddedName === "AmbientLight" ? this.lightsById
        : embeddedName === "AmbientSound" ? this.soundsById
        : embeddedName === "Tile" ? this.tilesById
        : null;

      if (!mapById || !mapById.size || !Array.isArray(ids) || !ids.length) {
        return origDeleteEmbedded.call(scene, embeddedName, ids, operation);
      }

      const realIds = [];
      const virtIds = [];
      for (const id of ids) {
        if (mapById.has(id)) virtIds.push(id);
        else realIds.push(id);
      }

      const results = [];
      if (realIds.length) {
        const r = await origDeleteEmbedded.call(scene, embeddedName, realIds, operation);
        if (Array.isArray(r)) results.push(...r);
      }
      if (virtIds.length) {
        const v = embeddedName === "AmbientLight" ? await this._commitLightDeletes(virtIds)
          : embeddedName === "AmbientSound" ? await this._commitSoundDeletes(virtIds)
          : await this._commitTileDeletes(virtIds);
        results.push(...v);
      }
      return results;
    };

    scene.updateEmbeddedDocuments = wrappedUpdateEmbedded;
    scene.deleteEmbeddedDocuments = wrappedDeleteEmbedded;

    this._patches = {
      state,
      scene, lighting, sounds, tiles,
      origUpdateEmbedded, origDeleteEmbedded,
      origLightGet, origSoundGet, origTileGet,
      wrappedUpdateEmbedded, wrappedDeleteEmbedded,
      wrappedLightGet, wrappedSoundGet, wrappedTileGet
    };
  }

  _removePatches() {
    if (!this._patches) return;
    const {
      state, scene, lighting, sounds, tiles,
      origUpdateEmbedded, origDeleteEmbedded,
      origLightGet, origSoundGet, origTileGet,
      wrappedUpdateEmbedded, wrappedDeleteEmbedded,
      wrappedLightGet, wrappedSoundGet, wrappedTileGet
    } = this._patches;
    state.active = false;
    try {
      if (scene.updateEmbeddedDocuments === wrappedUpdateEmbedded) scene.updateEmbeddedDocuments = origUpdateEmbedded;
      if (scene.deleteEmbeddedDocuments === wrappedDeleteEmbedded) scene.deleteEmbeddedDocuments = origDeleteEmbedded;
      if (lighting && wrappedLightGet && lighting.get === wrappedLightGet) lighting.get = origLightGet;
      if (sounds && wrappedSoundGet && sounds.get === wrappedSoundGet) sounds.get = origSoundGet;
      if (tiles && wrappedTileGet && tiles.get === wrappedTileGet) tiles.get = origTileGet;
    } catch {}
    this._patches = null;
  }

  _getViewedLayer() {
    const lid = canvas.level?.id;
    return lid ? this.controller?.levelLayers?.get(lid) || null : null;
  }

  _destroyPlaceable(layer, entry, byKey, byId, { closeSheet = false } = {}) {
    if (!entry) return;
    if (byKey.get(entry.key) === entry) byKey.delete(entry.key);
    if (byId.get(entry.id) === entry) byId.delete(entry.id);
    const sheet = getExistingSheet(entry.doc);
    if (closeSheet && sheet) {
      try { sheet.close(); } catch {}
    }
    const obj = entry.placeable;
    if (!obj) return;
    try {
      if (obj.controlled) obj.release({ broadcast: false });
      layer?.quadtree?.remove(obj);
      obj.parent?.removeChild(obj);
      if (!obj.destroyed) obj.destroy({ children: true });
    } catch {}
  }

  // ===== LIGHTING LAYER (AmbientLight) =====

  activateLighting() {
    if (!this.controller?.active || !game.user?.isGM) return;
    this.lightActive = true;
    this._lastLightKey = "";
    this.syncLighting(true);
  }

  deactivateLighting() {
    this.lightActive = false;
    this._lastLightKey = "";
    this._clearLights();
    if (this.lightMacroGfx) {
      this.lightMacroGfx.clear();
      this.lightMacroGfx.visible = false;
    }
  }

  _clearLights() {
    this._lightGen++;
    this._purgeMountQueue("light");
    for (const entry of Array.from(this.lightsByKey.values())) {
      this._destroyPlaceable(canvas?.lighting, entry, this.lightsByKey, this.lightsById, { closeSheet: true });
    }
    this.lightsByKey.clear();
    this.lightsById.clear();
  }

  async _mountNativeLight(item, gen, editsRev = this.controller?.lightEditsRev || 0) {
    if (!this.lightActive || gen !== this._lightGen || !canvas?.lighting?.objects || !canvas.scene) return;
    if (this.lightsByKey.has(item.lKey)) return;

    const id = makeVirtualId("ml", item.levelId, item.lKey);
    const DocCls = CONFIG.AmbientLight.documentClass;
    const doc = new DocCls({
      _id: id,
      x: item.x,
      y: item.y,
      elevation: item.elevation,
      rotation: item.rotation || 0,
      hidden: Boolean(item.hidden),
      walls: item.walls !== false,
      levels: [item.levelId],
      config: {
        dim: item.dim,
        bright: item.bright,
        angle: item.angle ?? 360,
        color: item.color || null,
        alpha: item.alpha ?? 0.5,
        attenuation: item.attenuation ?? 0.5,
        luminosity: item.luminosity ?? 0.5,
        ...(Number.isFinite(item.coloration) ? { coloration: item.coloration } : {}),
        darkness: { min: item.darkMin ?? 0, max: item.darkMax ?? 1 },
        animation: { type: item.anim || null, speed: item.speed ?? 3, intensity: item.intensity ?? 3 }
      }
    }, { parent: canvas.scene });

    doc._mmVirtualLight = item;
    attachVirtualCollectionProxy(doc, id, canvas.scene.lights);
    doc.update = async (data = {}) => (await this._commitLightUpdates([{ ...data, _id: id }]))[0] || doc;
    doc.delete = async () => (await this._commitLightDeletes([id]))[0] || doc;

    const placeable = canvas.lighting.createObject(doc);
    const patchVirtualLight = (obj) => {
      Object.defineProperty(obj, "isFilteredOut", { value: false, configurable: true });
      // Prevent virtual editor placeables (and config/drag clones) from spawning duplicate native PointLightSources
      // (which would double-brighten lights and shine through virtual walls outside the active sim-bubble!).
      obj.initializeLightSource = () => {};
      obj._refreshField = function () {
        if (!this.field) return;
        this.field.clear();
        drawShapeDataOutline(this.field, this.document?.shape, 0xEEEEEE, 0.4);
      };
      obj.clone = function () {
        const cloned = Object.getPrototypeOf(this).clone.call(this);
        if (cloned) patchVirtualLight(cloned);
        return cloned;
      };
    };
    patchVirtualLight(placeable);

    const entry = { id, key: item.lKey, levelId: item.levelId, sk: item.sk, idx: item.idx, editsRev, sig: JSON.stringify(item), placeable, doc };
    this.lightsByKey.set(item.lKey, entry);
    this.lightsById.set(id, entry);

    canvas.lighting.objects.addChild(placeable);
    placeable.renderFlags.clear();
    let drawFailed = false;
    try { await placeable.draw(); } catch { drawFailed = true; }

    if (drawFailed || !this.lightActive || gen !== this._lightGen || this.lightsById.get(id) !== entry || placeable.destroyed) {
      this._destroyPlaceable(canvas.lighting, entry, this.lightsByKey, this.lightsById);
      return;
    }

    placeable.renderFlags.set({ refresh: true });
    placeable.applyRenderFlags();
    placeable._updateQuadtree?.();
  }

  syncLighting(force = false, vp = null) {
    if (!this.lightActive || !this.controller?.active || !canvas?.lighting) return;
    if (force) this._lastLightKey = "";

    const curVp = vp || this.controller.getViewportWorldRect(0.2);
    const layer = this._getViewedLayer();
    if (!layer?.spec?.sectors) {
      this._clearLights();
      if (this.lightMacroGfx) { this.lightMacroGfx.clear(); this.lightMacroGfx.visible = false; }
      return;
    }

    const { simGrid, simSectorPx, spec, level } = layer;
    const lid = level.id;
    const pad = 350;
    const qStep = Math.max(250, Math.round(70 / Math.max(0.01, curVp.scale)));
    const qx0 = Math.floor(curVp.x0 / qStep);
    const qy0 = Math.floor(curVp.y0 / qStep);
    const qx1 = Math.floor(curVp.x1 / qStep);
    const qy1 = Math.floor(curVp.y1 / qStep);
    const effScale = getEffectiveScale(curVp.scale);
    const inZoom = effScale >= LIGHT_STREAM_MIN_SCALE;
    const curRev = this.controller.lightEditsRev || 0;
    const key = `${lid}:${qx0}_${qy0}_${qx1}_${qy1}:q${qStep}:${inZoom ? 1 : 0}:r${curRev}`;
    if (key === this._lastLightKey) return;
    this._lastLightKey = key;

    const sx0 = Math.max(0, Math.floor((curVp.x0 - pad) / simSectorPx));
    const sy0 = Math.max(0, Math.floor((curVp.y0 - pad) / simSectorPx));
    const sx1 = Math.min(simGrid - 1, Math.floor((curVp.x1 + pad) / simSectorPx));
    const sy1 = Math.min(simGrid - 1, Math.floor((curVp.y1 + pad) / simSectorPx));
    const items = [];
    const seenKeys = new Set();
    for (let sy = sy0; sy <= sy1; sy++) {
      for (let sx = sx0; sx <= sx1; sx++) {
        const sk = `${sx}_${sy}`;
        const list = spec.sectors[sk]?.l;
        if (!list?.length) continue;
        for (let li = 0; li < list.length; li++) {
          const item = this.controller.resolveVirtualLight(lid, sk, li, list[li], level);
          if (!item) continue;
          seenKeys.add(item.lKey);
          if (item.x < curVp.x0 - pad || item.x > curVp.x1 + pad ||
              item.y < curVp.y0 - pad || item.y > curVp.y1 + pad) continue;
          items.push(item);
        }
      }
    }
    const lvlLightEdits = this.controller.lightEdits?.get(lid);
    if (lvlLightEdits?.size) {
      for (const [lKey, ov] of lvlLightEdits) {
        if (!ov || seenKeys.has(lKey)) continue;
        const parts = lKey.split(":");
        if (parts.length !== 3) continue;
        const [sk, , idxStr] = parts;
        const idx = Number(idxStr);
        const raw = spec.sectors[sk]?.l?.[idx];
        if (!raw) continue;
        const item = this.controller.resolveVirtualLight(lid, sk, idx, raw, level);
        if (!item) continue;
        if (item.x < curVp.x0 - pad || item.x > curVp.x1 + pad ||
            item.y < curVp.y0 - pad || item.y > curVp.y1 + pad) continue;
        items.push(item);
      }
    }

    if (!inZoom || items.length > MAX_LIGHTS_IN_VIEW) {
      this._clearLights();
      if (this.lightMacroGfx) {
        const g = this.lightMacroGfx;
        g.clear();
        g.visible = true;
        const r = Math.max(12, Math.min(180, 6 / Math.max(0.01, curVp.scale)));
        const step = items.length > MAX_MACRO_MARKERS ? Math.ceil(items.length / MAX_MACRO_MARKERS) : 1;
        g.lineStyle(Math.max(2, r * 0.2), 0x000000, 0.8);
        g.beginFill(0xffcc44, 0.85);
        for (let i = 0; i < items.length; i += step) g.drawCircle(items[i].x, items[i].y, r);
        g.endFill();
      }
      return;
    }

    if (this.lightMacroGfx) { this.lightMacroGfx.clear(); this.lightMacroGfx.visible = false; }

    const needed = new Map();
    for (const it of items) needed.set(it.lKey, it);
    const lvlEdits = this.controller.lightEdits?.get(lid);

    for (const entry of Array.from(this.lightsByKey.values())) {
      const wrongLevel = entry.levelId !== lid;
      const isDeleted = !wrongLevel && lvlEdits?.get(entry.key) === null;
      const sheet = getExistingSheet(entry.doc);
      if (wrongLevel || isDeleted) {
        this._destroyPlaceable(canvas.lighting, entry, this.lightsByKey, this.lightsById, { closeSheet: true });
      } else if (!needed.has(entry.key) && !entry.placeable?.controlled && !isSheetActiveOrRendering(sheet, entry.placeable)) {
        this._destroyPlaceable(canvas.lighting, entry, this.lightsByKey, this.lightsById);
      }
    }

    const gen = this._lightGen;
    const tMountStart = performance.now();
    let syncMounted = 0;
    for (const it of needed.values()) {
      const existing = this.lightsByKey.get(it.lKey);
      if (!existing) {
        if (syncMounted < LAYER_SYNC_MOUNTS_PER_PASS && (syncMounted === 0 || (performance.now() - tMountStart) < LAYER_MOUNT_BUDGET_MS)) {
          this._mountNativeLight(it, gen, curRev);
          syncMounted++;
        } else {
          this._enqueueMount("light", it.lKey, it, gen, curRev);
        }
        continue;
      }
      if (existing.editsRev === curRev) continue;
      const nextSig = JSON.stringify(it);
      if (existing.sig === nextSig) {
        existing.editsRev = curRev;
        continue;
      }
      const sheet = getExistingSheet(existing.doc);
      if (sheet?.rendered) {
        const prevAngle = existing.doc.config?.angle ?? 360;
        const patch = {
          x: it.x, y: it.y, elevation: it.elevation, rotation: it.rotation || 0,
          hidden: Boolean(it.hidden), walls: it.walls !== false,
          config: {
            dim: it.dim, bright: it.bright, angle: it.angle ?? 360,
            color: it.color || null, alpha: it.alpha ?? 0.5,
            attenuation: it.attenuation ?? 0.5,
            luminosity: it.luminosity ?? 0.5,
            ...(Number.isFinite(it.coloration) ? { coloration: it.coloration } : {}),
            darkness: { min: it.darkMin ?? 0, max: it.darkMax ?? 1 },
            animation: { type: it.anim || null, speed: it.speed ?? 3, intensity: it.intensity ?? 3 }
          }
        };
        existing.doc.updateSource(patch);
        existing.sig = nextSig;
        existing.editsRev = curRev;
        const shapeChanged = (prevAngle >= 360) !== ((it.angle ?? 360) >= 360);
        if (existing.placeable && !existing.placeable.destroyed) {
          Promise.resolve(shapeChanged ? existing.placeable.draw() : null).then(() => {
            if (!existing.placeable.destroyed) {
              existing.placeable.renderFlags.set({ refresh: true });
              existing.placeable.applyRenderFlags();
              existing.placeable._updateQuadtree?.();
            }
          }).catch(() => {});
        }
        try {
          if (sheet._preview && typeof sheet._previewChanges === "function") {
            sheet._previewChanges(patch);
          } else {
            sheet._preview?.updateSource?.(patch);
          }
          sheet.render(false);
        } catch {}
      } else {
        this._destroyPlaceable(canvas.lighting, existing, this.lightsByKey, this.lightsById, { closeSheet: isSheetActiveOrRendering(sheet, existing.placeable) });
        this._mountNativeLight(it, gen, curRev);
      }
    }
  }

  async _commitLightUpdates(updates) {
    const scene = canvas.scene;
    if (!scene || !updates.length) return [];
    const flagUpdate = {};
    const docs = [];

    for (const u of updates) {
      const id = u._id ?? u.id;
      const entry = this.lightsById.get(id);
      if (!entry) continue;
      const patch = foundry.utils.deepClone(u);
      delete patch._id;
      delete patch.id;
      const prevAngle = entry.doc.config?.angle ?? 360;
      entry.doc.updateSource(patch);
      const nextAngle = entry.doc.config?.angle ?? 360;
      const shapeTypeChanged = (prevAngle >= 360) !== (nextAngle >= 360);

      const cfg = entry.doc.config || {};
      const colorCss = cfg.color ? foundry.utils.Color.from(cfg.color).css : null;
      const nextState = {
        x: Math.round(entry.doc.x),
        y: Math.round(entry.doc.y),
        dim: cfg.dim ?? 0,
        bright: cfg.bright ?? 0,
        color: colorCss,
        alpha: cfg.alpha ?? 0.5,
        anim: cfg.animation?.type || "",
        elevation: entry.doc.elevation ?? 0,
        hidden: Boolean(entry.doc.hidden),
        walls: entry.doc.walls !== false,
        angle: cfg.angle ?? 360,
        rotation: entry.doc.rotation ?? 0,
        darkMin: cfg.darkness?.min ?? 0,
        darkMax: cfg.darkness?.max ?? 1,
        speed: cfg.animation?.speed ?? 3,
        intensity: cfg.animation?.intensity ?? 3,
        attenuation: cfg.attenuation ?? 0.5,
        luminosity: cfg.luminosity ?? 0.5,
        ...(Number.isFinite(cfg.coloration) ? { coloration: cfg.coloration } : {})
      };
      flagUpdate[`flags.${MODULE_ID}.lightEdits.${entry.levelId}.${entry.key}`] = nextState;
      this.controller.setVirtualLightEditLocal(entry.levelId, entry.key, nextState);
      entry.sig = JSON.stringify({ levelId: entry.levelId, sk: entry.sk, idx: entry.idx, lKey: entry.key, ...nextState });

      if (entry.placeable && !entry.placeable.destroyed) {
        if (shapeTypeChanged) {
          try { await entry.placeable.draw(); } catch {}
        }
        if (!entry.placeable.destroyed) {
          entry.placeable.renderFlags.set({ refresh: true });
          entry.placeable.applyRenderFlags();
          entry.placeable._updateQuadtree?.();
        }
      }
      docs.push(entry.doc);
    }

    if (Object.keys(flagUpdate).length) {
      this.controller.applyVirtualLightChangesLocal();
      await scene.update(flagUpdate);
    }
    return docs;
  }

  async _commitLightDeletes(ids) {
    const scene = canvas.scene;
    if (!scene || !ids.length) return [];
    const flagUpdate = {};
    const docs = [];

    for (const id of ids) {
      const entry = this.lightsById.get(id);
      if (!entry) continue;
      flagUpdate[`flags.${MODULE_ID}.lightEdits.${entry.levelId}.${entry.key}`] = null;
      this.controller.setVirtualLightEditLocal(entry.levelId, entry.key, null);
      docs.push(entry.doc);
      this._destroyPlaceable(canvas.lighting, entry, this.lightsByKey, this.lightsById, { closeSheet: true });
    }

    if (Object.keys(flagUpdate).length) {
      this.controller.applyVirtualLightChangesLocal();
      await scene.update(flagUpdate);
    }
    return docs;
  }

  // ===== SOUNDS LAYER (AmbientSound) =====

  activateSounds() {
    if (!this.controller?.active || !game.user?.isGM) return;
    this.soundActive = true;
    this._lastSoundKey = "";
    this.syncSounds(true);
  }

  deactivateSounds() {
    this.soundActive = false;
    this._lastSoundKey = "";
    this._clearSounds();
    if (this.soundMacroGfx) {
      this.soundMacroGfx.clear();
      this.soundMacroGfx.visible = false;
    }
  }

  _clearSounds() {
    this._soundGen++;
    this._purgeMountQueue("sound");
    for (const entry of Array.from(this.soundsByKey.values())) {
      this._destroyPlaceable(canvas?.sounds, entry, this.soundsByKey, this.soundsById, { closeSheet: true });
    }
    this.soundsByKey.clear();
    this.soundsById.clear();
  }

  async _mountNativeSound(item, gen, editsRev = this.controller?.soundEditsRev || 0) {
    if (!this.soundActive || gen !== this._soundGen || !canvas?.sounds?.objects || !canvas.scene) return;
    if (this.soundsByKey.has(item.sKey)) return;

    const id = makeVirtualId("ms", item.levelId, item.sKey);
    const DocCls = CONFIG.AmbientSound.documentClass;
    const doc = new DocCls({
      _id: id,
      x: item.x,
      y: item.y,
      elevation: item.elevation,
      radius: item.radius,
      path: item.path,
      volume: item.volume,
      walls: item.walls,
      easing: item.easing,
      hidden: Boolean(item.hidden),
      darkness: { min: item.darkMin, max: item.darkMax },
      levels: [item.levelId]
    }, { parent: canvas.scene });

    doc._mmVirtualSound = item;
    attachVirtualCollectionProxy(doc, id, canvas.scene.sounds);
    doc.update = async (data = {}) => (await this._commitSoundUpdates([{ ...data, _id: id }]))[0] || doc;
    doc.delete = async () => (await this._commitSoundDeletes([id]))[0] || doc;

    const placeable = canvas.sounds.createObject(doc);
    // Prevent virtual editor placeables (and config/drag clones) from spawning duplicate PointSoundSources
    const soundSourceKey = `${item.levelId}::${item.sk}_${item.idx}`;
    const audioStreamer = this.controller.audioStreamer;
    const patchVirtualSound = (obj) => {
      Object.defineProperty(obj, "isFilteredOut", { value: false, configurable: true });
      obj.initializeSoundSource = () => {};
      obj._refreshField = function () {
        if (!this.field) return;
        this.field.clear();
        const liveSrc = !this.isPreview ? audioStreamer?.activeSources?.get(soundSourceKey) : null;
        if (liveSrc?.shape) {
          drawShapeDataOutline(this.field, liveSrc.shape, 0x66ccff, 0.45);
        } else {
          drawShapeDataOutline(this.field, this.document?.shape, 0x66ccff, 0.4);
        }
      };
      obj.clone = function () {
        const cloned = Object.getPrototypeOf(this).clone.call(this);
        if (cloned) patchVirtualSound(cloned);
        return cloned;
      };
    };
    patchVirtualSound(placeable);

    const entry = { id, key: item.sKey, levelId: item.levelId, sk: item.sk, idx: item.idx, editsRev, sig: JSON.stringify(item), placeable, doc };
    this.soundsByKey.set(item.sKey, entry);
    this.soundsById.set(id, entry);

    canvas.sounds.objects.addChild(placeable);
    placeable.renderFlags.clear();
    let drawFailed = false;
    try { await placeable.draw(); } catch { drawFailed = true; }

    if (drawFailed || !this.soundActive || gen !== this._soundGen || this.soundsById.get(id) !== entry || placeable.destroyed) {
      this._destroyPlaceable(canvas.sounds, entry, this.soundsByKey, this.soundsById);
      return;
    }

    placeable.renderFlags.set({ refresh: true });
    placeable.applyRenderFlags();
    placeable._updateQuadtree?.();
  }

  syncSounds(force = false, vp = null) {
    if (!this.soundActive || !this.controller?.active || !canvas?.sounds) return;
    if (force) this._lastSoundKey = "";

    const curVp = vp || this.controller.getViewportWorldRect(0.2);
    const layer = this._getViewedLayer();
    if (!layer?.spec?.sectors) {
      this._clearSounds();
      if (this.soundMacroGfx) { this.soundMacroGfx.clear(); this.soundMacroGfx.visible = false; }
      return;
    }

    const { simGrid, simSectorPx, spec, level } = layer;
    const lid = level.id;
    const pad = 400;
    const qStep = Math.max(300, Math.round(80 / Math.max(0.01, curVp.scale)));
    const qx0 = Math.floor(curVp.x0 / qStep);
    const qy0 = Math.floor(curVp.y0 / qStep);
    const qx1 = Math.floor(curVp.x1 / qStep);
    const qy1 = Math.floor(curVp.y1 / qStep);
    const effScale = getEffectiveScale(curVp.scale);
    const inZoom = effScale >= SOUND_STREAM_MIN_SCALE;
    const curRev = this.controller.soundEditsRev || 0;
    const key = `${lid}:${qx0}_${qy0}_${qx1}_${qy1}:q${qStep}:${inZoom ? 1 : 0}:r${curRev}`;
    if (key === this._lastSoundKey) return;
    this._lastSoundKey = key;

    const sx0 = Math.max(0, Math.floor((curVp.x0 - pad) / simSectorPx));
    const sy0 = Math.max(0, Math.floor((curVp.y0 - pad) / simSectorPx));
    const sx1 = Math.min(simGrid - 1, Math.floor((curVp.x1 + pad) / simSectorPx));
    const sy1 = Math.min(simGrid - 1, Math.floor((curVp.y1 + pad) / simSectorPx));
    const items = [];
    const seenKeys = new Set();
    for (let sy = sy0; sy <= sy1; sy++) {
      for (let sx = sx0; sx <= sx1; sx++) {
        const sk = `${sx}_${sy}`;
        const list = spec.sectors[sk]?.s;
        if (!list?.length) continue;
        for (let si = 0; si < list.length; si++) {
          const item = this.controller.resolveVirtualSound(lid, sk, si, list[si], level);
          if (!item) continue;
          seenKeys.add(item.sKey);
          if (item.x < curVp.x0 - pad || item.x > curVp.x1 + pad ||
              item.y < curVp.y0 - pad || item.y > curVp.y1 + pad) continue;
          items.push(item);
        }
      }
    }
    const lvlSoundEdits = this.controller.soundEdits?.get(lid);
    if (lvlSoundEdits?.size) {
      for (const [sKey, ov] of lvlSoundEdits) {
        if (!ov || seenKeys.has(sKey)) continue;
        const parts = sKey.split(":");
        if (parts.length !== 3) continue;
        const [sk, , idxStr] = parts;
        const idx = Number(idxStr);
        const raw = spec.sectors[sk]?.s?.[idx];
        if (!raw) continue;
        const item = this.controller.resolveVirtualSound(lid, sk, idx, raw, level);
        if (!item) continue;
        if (item.x < curVp.x0 - pad || item.x > curVp.x1 + pad ||
            item.y < curVp.y0 - pad || item.y > curVp.y1 + pad) continue;
        items.push(item);
      }
    }

    if (!inZoom || items.length > MAX_SOUNDS_IN_VIEW) {
      this._clearSounds();
      if (this.soundMacroGfx) {
        const g = this.soundMacroGfx;
        g.clear();
        g.visible = true;
        const r = Math.max(14, Math.min(180, 7 / Math.max(0.01, curVp.scale)));
        const step = items.length > MAX_MACRO_MARKERS ? Math.ceil(items.length / MAX_MACRO_MARKERS) : 1;
        g.lineStyle(Math.max(2, r * 0.2), 0x000000, 0.8);
        g.beginFill(0x66ccff, 0.85);
        for (let i = 0; i < items.length; i += step) g.drawCircle(items[i].x, items[i].y, r);
        g.endFill();
      }
      return;
    }

    if (this.soundMacroGfx) { this.soundMacroGfx.clear(); this.soundMacroGfx.visible = false; }

    const needed = new Map();
    for (const it of items) needed.set(it.sKey, it);
    const lvlEdits = this.controller.soundEdits?.get(lid);

    for (const entry of Array.from(this.soundsByKey.values())) {
      const wrongLevel = entry.levelId !== lid;
      const isDeleted = !wrongLevel && lvlEdits?.get(entry.key) === null;
      const sheet = getExistingSheet(entry.doc);
      if (wrongLevel || isDeleted) {
        this._destroyPlaceable(canvas.sounds, entry, this.soundsByKey, this.soundsById, { closeSheet: true });
      } else if (!needed.has(entry.key) && !entry.placeable?.controlled && !isSheetActiveOrRendering(sheet, entry.placeable)) {
        this._destroyPlaceable(canvas.sounds, entry, this.soundsByKey, this.soundsById);
      }
    }

    const gen = this._soundGen;
    const tMountStart = performance.now();
    let syncMounted = 0;
    for (const it of needed.values()) {
      const existing = this.soundsByKey.get(it.sKey);
      if (!existing) {
        if (syncMounted < LAYER_SYNC_MOUNTS_PER_PASS && (syncMounted === 0 || (performance.now() - tMountStart) < LAYER_MOUNT_BUDGET_MS)) {
          this._mountNativeSound(it, gen, curRev);
          syncMounted++;
        } else {
          this._enqueueMount("sound", it.sKey, it, gen, curRev);
        }
        continue;
      }
      if (existing.editsRev === curRev) continue;
      const nextSig = JSON.stringify(it);
      if (existing.sig === nextSig) {
        existing.editsRev = curRev;
        continue;
      }
      const sheet = getExistingSheet(existing.doc);
      if (sheet?.rendered) {
        const patch = {
          x: it.x, y: it.y, elevation: it.elevation, radius: it.radius,
          path: it.path, volume: it.volume, walls: it.walls, easing: it.easing,
          hidden: Boolean(it.hidden), darkness: { min: it.darkMin, max: it.darkMax }
        };
        existing.doc.updateSource(patch);
        existing.sig = nextSig;
        existing.editsRev = curRev;
        if (existing.placeable && !existing.placeable.destroyed) {
          existing.placeable.renderFlags.set({ refresh: true });
          existing.placeable.applyRenderFlags();
          existing.placeable._updateQuadtree?.();
        }
        try {
          if (sheet._preview && typeof sheet._previewChanges === "function") {
            sheet._previewChanges(patch);
          } else {
            sheet._preview?.updateSource?.(patch);
          }
          sheet.render(false);
        } catch {}
      } else {
        this._destroyPlaceable(canvas.sounds, existing, this.soundsByKey, this.soundsById, { closeSheet: isSheetActiveOrRendering(sheet, existing.placeable) });
        this._mountNativeSound(it, gen, curRev);
      }
    }
  }

  async _commitSoundUpdates(updates) {
    const scene = canvas.scene;
    if (!scene || !updates.length) return [];
    const flagUpdate = {};
    const docs = [];
    const updatedEntries = [];

    for (const u of updates) {
      const id = u._id ?? u.id;
      const entry = this.soundsById.get(id);
      if (!entry) continue;
      const patch = foundry.utils.deepClone(u);
      delete patch._id;
      delete patch.id;
      entry.doc.updateSource(patch);

      const nextState = {
        x: Math.round(entry.doc.x),
        y: Math.round(entry.doc.y),
        radius: entry.doc.radius ?? 20,
        path: entry.doc.path || "",
        volume: entry.doc.volume ?? 0.6,
        walls: entry.doc.walls !== false,
        easing: entry.doc.easing !== false,
        darkMin: entry.doc.darkness?.min ?? 0,
        darkMax: entry.doc.darkness?.max ?? 1,
        elevation: entry.doc.elevation ?? 0,
        hidden: Boolean(entry.doc.hidden)
      };
      flagUpdate[`flags.${MODULE_ID}.soundEdits.${entry.levelId}.${entry.key}`] = nextState;
      this.controller.setVirtualSoundEditLocal(entry.levelId, entry.key, nextState);
      entry.sig = JSON.stringify({ levelId: entry.levelId, sk: entry.sk, idx: entry.idx, sKey: entry.key, ...nextState });

      if (entry.placeable && !entry.placeable.destroyed) {
        entry.placeable.renderFlags.set({ refresh: true });
        entry.placeable.applyRenderFlags();
        entry.placeable._updateQuadtree?.();
      }
      updatedEntries.push(entry);
      docs.push(entry.doc);
    }

    if (Object.keys(flagUpdate).length) {
      this.controller.applyVirtualSoundChangesLocal();
      for (const entry of updatedEntries) {
        if (entry.placeable && !entry.placeable.destroyed) {
          entry.placeable.renderFlags.set({ refreshField: true });
          entry.placeable.applyRenderFlags();
        }
      }
      await scene.update(flagUpdate);
    }
    return docs;
  }

  async _commitSoundDeletes(ids) {
    const scene = canvas.scene;
    if (!scene || !ids.length) return [];
    const flagUpdate = {};
    const docs = [];

    for (const id of ids) {
      const entry = this.soundsById.get(id);
      if (!entry) continue;
      flagUpdate[`flags.${MODULE_ID}.soundEdits.${entry.levelId}.${entry.key}`] = null;
      this.controller.setVirtualSoundEditLocal(entry.levelId, entry.key, null);
      docs.push(entry.doc);
      this._destroyPlaceable(canvas.sounds, entry, this.soundsByKey, this.soundsById, { closeSheet: true });
    }

    if (Object.keys(flagUpdate).length) {
      this.controller.applyVirtualSoundChangesLocal();
      await scene.update(flagUpdate);
    }
    return docs;
  }

  // ===== TILES LAYER (Tile) =====

  activateTiles() {
    if (!this.controller?.active || !game.user?.isGM) return;
    this.tileActive = true;
    this._lastTileKey = "";
    this.syncTiles(true);
  }

  deactivateTiles() {
    this.tileActive = false;
    this._lastTileKey = "";
    this._clearTiles();
    this.controller?.setVirtualTilesVisible?.(true);
  }

  _clearTiles() {
    this._tileGen++;
    this._purgeMountQueue("tile");
    this._lastTileNeededKeys = null;
    for (const entry of Array.from(this.tilesByKey.values())) {
      this._setRawVirtualTileVisible(entry.fullId, true);
      this._destroyPlaceable(canvas?.tiles, entry, this.tilesByKey, this.tilesById, { closeSheet: true });
    }
    this.tilesByKey.clear();
    this.tilesById.clear();
  }

  _cleanupLeakedTileMesh(placeable) {
    if (!placeable?.mesh) return;
    try {
      if (canvas?.primary?.tiles?.get?.(placeable.objectId)?.object === placeable) {
        canvas.primary.removeTile(placeable);
      }
    } catch {}
  }

  _setRawVirtualTileVisible(fullId, visible) {
    const vt = this.controller?.activeVirtualTiles?.get(fullId);
    if (vt?.mesh && !vt.mesh.destroyed) {
      vt.mesh.visible = visible;
    }
  }

  async _mountNativeTile(item, gen, editsRev = this.controller?.tileEditsRev || 0) {
    if (!this.tileActive || gen !== this._tileGen || !canvas?.tiles?.objects || !canvas.scene) return;
    if (this.tilesByKey.has(item.tKey)) return;

    // Preload tile texture before creating native Tile so Tile#_draw cannot leak a PrimarySpriteMesh at (0,0)
    // if the user leaves TilesLayer, switches levels, or pans away while loadTexture is in flight.
    const editRev = this.controller.tileEditsRev || 0;
    if (item.src && typeof foundry.canvas?.loadTexture === "function") {
      try { await foundry.canvas.loadTexture(item.src, { fallback: "icons/svg/hazard.svg" }); } catch {}
      if (!this.tileActive || gen !== this._tileGen || (this.controller.tileEditsRev || 0) !== editRev || !canvas?.tiles?.objects || !canvas.scene) return;
      if (this._getViewedLayer()?.level?.id !== item.levelId) return;
      if ((this._lastTileNeededKeys && !this._lastTileNeededKeys.has(item.tKey)) || this.tilesByKey.has(item.tKey)) return;
    }

    const id = makeVirtualId("mt", item.levelId, item.tKey);
    const DocCls = CONFIG.Tile.documentClass;
    const occModes = resolveOcclusionModeArray(item.occlusionMode);
    // In Foundry v14, TileDocument (x, y) is the anchor/pivot position (matching PrimarySpriteMesh anchor).
    // Raw virtual tiles without anchorX/anchorY store top-left (x, y); convert to center pivot when anchor is omitted.
    const ax = item.anchorX ?? 0.5;
    const ay = item.anchorY ?? 0.5;
    const docX = item.anchorX === undefined ? (item.x + item.w * 0.5) : item.x;
    const docY = item.anchorY === undefined ? (item.y + item.h * 0.5) : item.y;
    const doc = new DocCls({
      _id: id,
      x: docX,
      y: docY,
      width: item.w,
      height: item.h,
      rotation: item.rot || 0,
      elevation: item.elevation,
      sort: item.sort || 0,
      alpha: item.alpha ?? 1,
      hidden: Boolean(item.hidden),
      levels: [item.levelId],
      texture: {
        src: item.src,
        tint: item.tint || "#ffffff",
        alphaThreshold: item.alphaThreshold ?? 0.75,
        anchorX: ax,
        anchorY: ay,
        scaleX: item.scaleX ?? 1,
        scaleY: item.scaleY ?? 1,
        fit: item.fit ?? "fill"
      },
      occlusion: {
        modes: occModes,
        alpha: item.occludedAlpha ?? 0.2
      },
      restrictions: {
        light: Boolean(item.restrictsLight),
        weather: Boolean(item.restrictsWeather)
      }
    }, { parent: canvas.scene });

    doc._mmVirtualTile = item;
    attachVirtualCollectionProxy(doc, id, canvas.scene.tiles);
    doc.update = async (data = {}) => (await this._commitTileUpdates([{ ...data, _id: id }]))[0] || doc;
    doc.delete = async () => (await this._commitTileDeletes([id]))[0] || doc;

    const placeable = canvas.tiles.createObject(doc);
    Object.defineProperty(placeable, "isFilteredOut", { value: false, configurable: true });

    const fullId = `${item.levelId}::${item.tid}`;
    const entry = { id, key: item.tKey, fullId, levelId: item.levelId, tid: item.tid, editsRev, sig: JSON.stringify(item), placeable, doc };
    this.tilesByKey.set(item.tKey, entry);
    this.tilesById.set(id, entry);

    canvas.tiles.objects.addChild(placeable);
    placeable.renderFlags.clear();
    let drawFailed = false;
    try { await placeable.draw(); } catch { drawFailed = true; }

    if (drawFailed || !this.tileActive || gen !== this._tileGen || this.tilesById.get(id) !== entry || placeable.destroyed) {
      if (this.tilesByKey.get(item.tKey) === entry) {
        this._setRawVirtualTileVisible(fullId, true);
      }
      this._cleanupLeakedTileMesh(placeable);
      this._destroyPlaceable(canvas.tiles, entry, this.tilesByKey, this.tilesById);
      return;
    }

    placeable.renderFlags.set({ refresh: true });
    placeable.applyRenderFlags();
    // Hide raw streamed PrimarySpriteMesh while native Tile renders its own mesh
    this._setRawVirtualTileVisible(fullId, false);
    placeable._updateQuadtree?.();
  }

  syncTiles(force = false, vp = null) {
    if (!this.tileActive || !this.controller?.active || !canvas?.tiles) return;
    if (force) this._lastTileKey = "";

    const curVp = vp || this.controller.getViewportWorldRect(0.2);
    const layer = this._getViewedLayer();
    const specTiles = layer?.spec?.tiles;
    if (!specTiles?.length) {
      this._clearTiles();
      return;
    }

    const { simGrid, simSectorPx, spec, level } = layer;
    const lid = level.id;
    const pad = 300;
    const qStep = Math.max(200, Math.round(60 / Math.max(0.01, curVp.scale)));
    const qx0 = Math.floor(curVp.x0 / qStep);
    const qy0 = Math.floor(curVp.y0 / qStep);
    const qx1 = Math.floor(curVp.x1 / qStep);
    const qy1 = Math.floor(curVp.y1 / qStep);
    const effScale = getEffectiveScale(curVp.scale);
    const inZoom = effScale >= TILE_STREAM_MIN_SCALE;
    const curRev = this.controller.tileEditsRev || 0;
    const key = `${lid}:${qx0}_${qy0}_${qx1}_${qy1}:q${qStep}:${inZoom ? 1 : 0}:r${curRev}`;
    if (key === this._lastTileKey) return;
    this._lastTileKey = key;

    if (!inZoom) {
      this._clearTiles();
      return;
    }

    const sx0 = Math.max(0, Math.floor((curVp.x0 - pad) / simSectorPx));
    const sy0 = Math.max(0, Math.floor((curVp.y0 - pad) / simSectorPx));
    const sx1 = Math.min(simGrid - 1, Math.floor((curVp.x1 + pad) / simSectorPx));
    const sy1 = Math.min(simGrid - 1, Math.floor((curVp.y1 + pad) / simSectorPx));

    const tids = new Set();
    if (spec.sectors) {
      for (let sy = sy0; sy <= sy1; sy++) {
        for (let sx = sx0; sx <= sx1; sx++) {
          const list = spec.sectors[`${sx}_${sy}`]?.t;
          if (list) for (const tid of list) tids.add(tid);
        }
      }
    } else {
      for (let tid = 0; tid < specTiles.length; tid++) tids.add(tid);
    }

    // Also include tiles edited & dragged outside their original home sector
    const lvlTileEdits = this.controller.tileEdits?.get(lid);
    if (lvlTileEdits?.size) {
      for (const [tKey, ov] of lvlTileEdits) {
        if (!ov || !tKey.startsWith("t:")) continue;
        const tid = Number(tKey.slice(2));
        if (Number.isInteger(tid) && specTiles[tid]) tids.add(tid);
      }
    }

    const items = [];
    for (const tid of tids) {
      const item = this.controller.resolveVirtualTile(lid, tid, specTiles[tid], level);
      if (!item || !item.src) continue;
      const ax = item.anchorX ?? 0.5;
      const ay = item.anchorY ?? 0.5;
      const w = item.w || 0;
      const h = item.h || 0;
      const pivX = item.anchorX === undefined ? (item.x + w * 0.5) : item.x;
      const pivY = item.anchorY === undefined ? (item.y + h * 0.5) : item.y;
      const rad = ((item.rot || 0) * Math.PI) / 180;
      const cos = Math.cos(rad);
      const sin = Math.sin(rad);
      const dx = (0.5 - ax) * w;
      const dy = (0.5 - ay) * h;
      const cx = pivX + (cos * dx - sin * dy);
      const cy = pivY + (sin * dx + cos * dy);
      const halfDiag = Math.hypot(w, h) * 0.5;
      if (cx + halfDiag < curVp.x0 - pad || cx - halfDiag > curVp.x1 + pad || cy + halfDiag < curVp.y0 - pad || cy - halfDiag > curVp.y1 + pad) continue;
      items.push(item);
      if (items.length >= MAX_TILES_IN_VIEW) break;
    }

    const needed = new Map();
    for (const it of items) needed.set(it.tKey, it);
    this._lastTileNeededKeys = new Set(needed.keys());
    const lvlEdits = this.controller.tileEdits?.get(lid);

    for (const entry of Array.from(this.tilesByKey.values())) {
      const wrongLevel = entry.levelId !== lid;
      const isDeleted = !wrongLevel && lvlEdits?.get(entry.key) === null;
      const sheet = getExistingSheet(entry.doc);
      if (wrongLevel || isDeleted) {
        this._setRawVirtualTileVisible(entry.fullId, true);
        this._destroyPlaceable(canvas.tiles, entry, this.tilesByKey, this.tilesById, { closeSheet: true });
      } else if (!needed.has(entry.key) && !entry.placeable?.controlled && !isSheetActiveOrRendering(sheet, entry.placeable)) {
        this._setRawVirtualTileVisible(entry.fullId, true);
        this._destroyPlaceable(canvas.tiles, entry, this.tilesByKey, this.tilesById);
      }
    }

    const gen = this._tileGen;
    const tMountStart = performance.now();
    let syncMounted = 0;
    for (const it of needed.values()) {
      const existing = this.tilesByKey.get(it.tKey);
      if (!existing) {
        if (syncMounted < LAYER_SYNC_MOUNTS_PER_PASS && (syncMounted === 0 || (performance.now() - tMountStart) < LAYER_MOUNT_BUDGET_MS)) {
          this._mountNativeTile(it, gen, curRev);
          syncMounted++;
        } else {
          this._enqueueMount("tile", it.tKey, it, gen, curRev);
        }
        continue;
      }
      if (existing.editsRev === curRev) continue;
      const nextSig = JSON.stringify(it);
      if (existing.sig === nextSig) {
        existing.editsRev = curRev;
        continue;
      }
      const sheet = getExistingSheet(existing.doc);
      if (sheet?.rendered) {
        const prevSrc = existing.doc.texture?.src || "";
        const ax = it.anchorX ?? 0.5;
        const ay = it.anchorY ?? 0.5;
        const patch = {
          x: it.anchorX === undefined ? (it.x + it.w * 0.5) : it.x,
          y: it.anchorY === undefined ? (it.y + it.h * 0.5) : it.y,
          width: it.w, height: it.h, rotation: it.rot || 0, elevation: it.elevation,
          sort: it.sort || 0, alpha: it.alpha ?? 1, hidden: Boolean(it.hidden),
          texture: {
            src: it.src, tint: it.tint || "#ffffff", alphaThreshold: it.alphaThreshold ?? 0.75,
            anchorX: ax, anchorY: ay, scaleX: it.scaleX ?? 1, scaleY: it.scaleY ?? 1, fit: it.fit ?? "fill"
          },
          occlusion: { modes: resolveOcclusionModeArray(it.occlusionMode), alpha: it.occludedAlpha ?? 0.2 },
          restrictions: { light: Boolean(it.restrictsLight), weather: Boolean(it.restrictsWeather) }
        };
        existing.doc.updateSource(patch);
        existing.sig = nextSig;
        existing.editsRev = curRev;
        const srcChanged = (it.src || "") !== prevSrc;
        if (existing.placeable && !existing.placeable.destroyed) {
          Promise.resolve(srcChanged ? existing.placeable.draw() : null).then(() => {
            if (existing.placeable.destroyed) {
              this._cleanupLeakedTileMesh(existing.placeable);
            } else {
              existing.placeable.renderFlags.set({ refresh: true });
              existing.placeable.applyRenderFlags();
              existing.placeable._updateQuadtree?.();
              if (srcChanged && sheet?.rendered && sheet._preview?.rendered && sheet._preview.texture?.src === existing.doc.texture?.src) {
                sheet._preview.object?.renderFlags?.set?.({ redraw: true });
              }
            }
          }).catch(() => {
            if (existing.placeable?.destroyed) this._cleanupLeakedTileMesh(existing.placeable);
          });
        }
        try {
          if (sheet._preview && typeof sheet._previewChanges === "function") {
            sheet._previewChanges(patch);
          } else {
            sheet._preview?.updateSource?.(patch);
          }
          sheet.render(false);
        } catch {}
      } else {
        this._setRawVirtualTileVisible(existing.fullId, true);
        this._destroyPlaceable(canvas.tiles, existing, this.tilesByKey, this.tilesById, { closeSheet: isSheetActiveOrRendering(sheet, existing.placeable) });
        this._mountNativeTile(it, gen, curRev);
      }
    }
  }

  async _commitTileUpdates(updates) {
    const scene = canvas.scene;
    if (!scene || !updates.length) return [];
    const flagUpdate = {};
    const docs = [];

    for (const u of updates) {
      const id = u._id ?? u.id;
      const entry = this.tilesById.get(id);
      if (!entry) continue;
      const patch = foundry.utils.deepClone(u);
      delete patch._id;
      delete patch.id;
      const prevSrc = entry.doc.texture?.src || "";
      entry.doc.updateSource(patch);

      const d = entry.doc;
      const nextSrc = d.texture?.src || "";
      const occModes = Array.from(d.occlusion?.modes || []);
      const nextState = {
        src: nextSrc,
        x: Math.round(d.x),
        y: Math.round(d.y),
        w: Math.round(d.width),
        h: Math.round(d.height),
        rot: d.rotation || 0,
        elevation: d.elevation ?? 0,
        sort: d.sort || 0,
        alpha: d.alpha ?? 1,
        hidden: Boolean(d.hidden),
        tint: d.texture?.tint ? foundry.utils.Color.from(d.texture.tint).css : null,
        alphaThreshold: d.texture?.alphaThreshold ?? 0.75,
        anchorX: d.texture?.anchorX ?? 0.5,
        anchorY: d.texture?.anchorY ?? 0.5,
        scaleX: d.texture?.scaleX ?? 1,
        scaleY: d.texture?.scaleY ?? 1,
        fit: d.texture?.fit ?? "fill",
        occlusionMode: occModes,
        occludedAlpha: d.occlusion?.alpha ?? 0.2,
        restrictsLight: Boolean(d.restrictions?.light),
        restrictsWeather: Boolean(d.restrictions?.weather)
      };

      flagUpdate[`flags.${MODULE_ID}.tileEdits.${entry.levelId}.${entry.key}`] = nextState;
      this.controller.setVirtualTileEditLocal(entry.levelId, entry.key, nextState);
      const entryLayer = this.controller.levelLayers?.get(entry.levelId) || this._getViewedLayer();
      const resolvedNow = this.controller.resolveVirtualTile(entry.levelId, entry.tid, entryLayer?.spec?.tiles?.[entry.tid], entryLayer?.level);
      entry.sig = JSON.stringify(resolvedNow || nextState);

      if (entry.placeable && !entry.placeable.destroyed) {
        if (nextSrc !== prevSrc) {
          try { await entry.placeable.draw(); } catch {}
        }
        if (entry.placeable.destroyed) {
          this._cleanupLeakedTileMesh(entry.placeable);
        } else {
          entry.placeable.renderFlags.set({ refresh: true });
          entry.placeable.applyRenderFlags();
          entry.placeable._updateQuadtree?.();
        }
      }
      docs.push(entry.doc);
    }

    if (Object.keys(flagUpdate).length) {
      this.controller.applyVirtualTileChangesLocal();
      await scene.update(flagUpdate);
    }
    return docs;
  }

  async _commitTileDeletes(ids) {
    const scene = canvas.scene;
    if (!scene || !ids.length) return [];
    const flagUpdate = {};
    const docs = [];

    for (const id of ids) {
      const entry = this.tilesById.get(id);
      if (!entry) continue;
      flagUpdate[`flags.${MODULE_ID}.tileEdits.${entry.levelId}.${entry.key}`] = null;
      this.controller.setVirtualTileEditLocal(entry.levelId, entry.key, null);
      docs.push(entry.doc);
      this._destroyPlaceable(canvas.tiles, entry, this.tilesByKey, this.tilesById, { closeSheet: true });
    }

    if (Object.keys(flagUpdate).length) {
      this.controller.applyVirtualTileChangesLocal();
      await scene.update(flagUpdate);
    }
    return docs;
  }

  // ===== SHARED VIEWPORT SYNC & UNMOUNT =====

  syncViewport(force = false, vp = null) {
    if (this.lightActive) this.syncLighting(force, vp);
    if (this.soundActive) this.syncSounds(force, vp);
    if (this.tileActive) this.syncTiles(force, vp);
  }

  unmount() {
    this._purgeMountQueue();
    this.deactivateLighting();
    this.deactivateSounds();
    this.deactivateTiles();
    this._removePatches();
    if (this.lightMacroGfx) {
      try { this.lightMacroGfx.parent?.removeChild(this.lightMacroGfx); } catch {}
      if (!this.lightMacroGfx.destroyed) {
        try { this.lightMacroGfx.destroy(); } catch {}
      }
      this.lightMacroGfx = null;
    }
    if (this.soundMacroGfx) {
      try { this.soundMacroGfx.parent?.removeChild(this.soundMacroGfx); } catch {}
      if (!this.soundMacroGfx.destroyed) {
        try { this.soundMacroGfx.destroy(); } catch {}
      }
      this.soundMacroGfx = null;
    }
  }
}

export function registerLayerEditorControls(controller) {
  Hooks.on("activateLightingLayer", () => {
    if (!controller.active) return;
    controller.layerEditors.activateLighting();
  });
  Hooks.on("deactivateLightingLayer", () => {
    controller.layerEditors.deactivateLighting();
  });

  Hooks.on("activateSoundsLayer", () => {
    if (!controller.active) return;
    controller.layerEditors.activateSounds();
  });
  Hooks.on("deactivateSoundsLayer", () => {
    controller.layerEditors.deactivateSounds();
  });

  Hooks.on("activateTilesLayer", () => {
    if (!controller.active) return;
    controller.layerEditors.activateTiles();
  });
  Hooks.on("deactivateTilesLayer", () => {
    controller.layerEditors.deactivateTiles();
  });
}
