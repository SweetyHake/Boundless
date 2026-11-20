const MODULE_ID = "boundless";
const LIGHT_STREAM_MIN_SCALE = 0.22;
const SOUND_STREAM_MIN_SCALE = 0.18;
const TILE_STREAM_MIN_SCALE = 0.18;
const MAX_LIGHTS_IN_VIEW = 260;
const MAX_SOUNDS_IN_VIEW = 200;
const MAX_TILES_IN_VIEW = 160;

function makeVirtualId(prefix, levelId, key) {
  const input = `${prefix}|${levelId}|${key}`;
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

function resolveOcclusionModeArray(modeSpec) {
  if (Array.isArray(modeSpec)) return modeSpec.slice();
  if (typeof modeSpec === "number") {
    const out = [];
    for (const bit of Object.values(CONST.OCCLUSION_MODES || {})) {
      if (typeof bit === "number" && bit > 0 && (modeSpec & bit) === bit) out.push(bit);
    }
    return out;
  }
  if (typeof modeSpec === "string" && modeSpec in (CONST.OCCLUSION_MODES || {})) {
    const v = CONST.OCCLUSION_MODES[modeSpec];
    return v ? [v] : [];
  }
  return [];
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

  constructor(controller) {
    this.controller = controller;
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

    this._patches = {
      scene, lighting, sounds, tiles,
      origUpdateEmbedded, origDeleteEmbedded,
      origLightGet, origSoundGet, origTileGet
    };

    if (lighting && origLightGet) {
      lighting.get = (id) => this.lightsById.get(id)?.placeable || origLightGet.call(lighting, id);
    }
    if (sounds && origSoundGet) {
      sounds.get = (id) => this.soundsById.get(id)?.placeable || origSoundGet.call(sounds, id);
    }
    if (tiles && origTileGet) {
      tiles.get = (id) => this.tilesById.get(id)?.placeable || origTileGet.call(tiles, id);
    }

    scene.updateEmbeddedDocuments = async (embeddedName, updates = [], operation = {}) => {
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

    scene.deleteEmbeddedDocuments = async (embeddedName, ids = [], operation = {}) => {
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
  }

  _removePatches() {
    if (!this._patches) return;
    const {
      scene, lighting, sounds, tiles,
      origUpdateEmbedded, origDeleteEmbedded,
      origLightGet, origSoundGet, origTileGet
    } = this._patches;
    try {
      scene.updateEmbeddedDocuments = origUpdateEmbedded;
      scene.deleteEmbeddedDocuments = origDeleteEmbedded;
      if (lighting && origLightGet) lighting.get = origLightGet;
      if (sounds && origSoundGet) sounds.get = origSoundGet;
      if (tiles && origTileGet) tiles.get = origTileGet;
    } catch {}
    this._patches = null;
  }

  _getViewedLayer() {
    const lid = canvas.level?.id;
    return lid ? this.controller?.levelLayers?.get(lid) || null : null;
  }

  _destroyPlaceable(layer, entry, byKey, byId) {
    if (!entry) return;
    byKey.delete(entry.key);
    byId.delete(entry.id);
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
    for (const entry of Array.from(this.lightsByKey.values())) {
      this._destroyPlaceable(canvas?.lighting, entry, this.lightsByKey, this.lightsById);
    }
    this.lightsByKey.clear();
    this.lightsById.clear();
  }

  async _mountNativeLight(item, gen) {
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
        darkness: { min: item.darkMin ?? 0, max: item.darkMax ?? 1 },
        animation: { type: item.anim || null, speed: 3, intensity: 3 }
      }
    }, { parent: canvas.scene });

    doc._mmVirtualLight = item;
    doc.update = async (data = {}) => (await this._commitLightUpdates([{ ...data, _id: id }]))[0] || doc;
    doc.delete = async () => (await this._commitLightDeletes([id]))[0] || doc;

    const placeable = canvas.lighting.createObject(doc);
    Object.defineProperty(placeable, "isFilteredOut", { value: false, configurable: true });
    // Prevent virtual editor placeables from spawning duplicate native PointLightSources (which would
    // double-brighten lights and shine through virtual walls outside the active sim-bubble!).
    // MegaLightBatch + dynamicLights already render the exact wall-shadowed light.
    placeable.initializeLightSource = () => {};
    placeable._refreshField = function () {
      if (!this.field) return;
      this.field.clear();
      const shape = this.document?.shape;
      if (!shape) return;
      const s = canvas.dimensions?.uiScale || 1;
      this.field.lineStyle(2 * s, 0xEEEEEE, 0.4).drawShape(shape);
    };

    const entry = { id, key: item.lKey, levelId: item.levelId, sk: item.sk, idx: item.idx, placeable, doc };
    this.lightsByKey.set(item.lKey, entry);
    this.lightsById.set(id, entry);

    canvas.lighting.objects.addChild(placeable);
    placeable.renderFlags.clear();
    await placeable.draw();

    if (!this.lightActive || gen !== this._lightGen || !this.lightsById.has(id)) {
      this._destroyPlaceable(canvas.lighting, entry, this.lightsByKey, this.lightsById);
      return;
    }

    placeable.renderFlags.set({ refresh: true });
    placeable.applyRenderFlags();
    canvas.lighting.quadtree?.insert({ r: placeable.bounds, t: placeable });
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
    const sx0 = Math.max(0, Math.floor(curVp.x0 / simSectorPx));
    const sy0 = Math.max(0, Math.floor(curVp.y0 / simSectorPx));
    const sx1 = Math.min(simGrid - 1, Math.floor(curVp.x1 / simSectorPx));
    const sy1 = Math.min(simGrid - 1, Math.floor(curVp.y1 / simSectorPx));
    const inZoom = curVp.scale >= LIGHT_STREAM_MIN_SCALE;
    const key = `${lid}:${sx0}_${sy0}_${sx1}_${sy1}:${inZoom ? 1 : 0}:r${this.controller.lightEditsRev || 0}`;
    if (key === this._lastLightKey) return;
    this._lastLightKey = key;

    const pad = 350;
    const items = [];
    for (let sy = sy0; sy <= sy1; sy++) {
      for (let sx = sx0; sx <= sx1; sx++) {
        const sk = `${sx}_${sy}`;
        const list = spec.sectors[sk]?.l;
        if (!list?.length) continue;
        for (let li = 0; li < list.length; li++) {
          const item = this.controller.resolveVirtualLight(lid, sk, li, list[li], level);
          if (!item) continue;
          if (item.x < curVp.x0 - pad || item.x > curVp.x1 + pad ||
              item.y < curVp.y0 - pad || item.y > curVp.y1 + pad) continue;
          items.push(item);
        }
      }
    }

    if (!inZoom || items.length > MAX_LIGHTS_IN_VIEW) {
      this._clearLights();
      if (this.lightMacroGfx) {
        const g = this.lightMacroGfx;
        g.clear();
        g.visible = true;
        const r = Math.max(12, Math.min(180, 6 / Math.max(0.01, curVp.scale)));
        g.lineStyle(Math.max(2, r * 0.2), 0x000000, 0.8);
        g.beginFill(0xffcc44, 0.85);
        for (const it of items) g.drawCircle(it.x, it.y, r);
        g.endFill();
      }
      return;
    }

    if (this.lightMacroGfx) { this.lightMacroGfx.clear(); this.lightMacroGfx.visible = false; }

    const needed = new Map();
    for (const it of items) needed.set(it.lKey, it);

    for (const entry of Array.from(this.lightsByKey.values())) {
      if (!needed.has(entry.key) && !entry.placeable?.controlled) {
        this._destroyPlaceable(canvas.lighting, entry, this.lightsByKey, this.lightsById);
      }
    }

    const gen = this._lightGen;
    for (const it of needed.values()) {
      if (!this.lightsByKey.has(it.lKey)) {
        this._mountNativeLight(it, gen);
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
      entry.doc.updateSource(patch);

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
        darkMax: cfg.darkness?.max ?? 1
      };
      flagUpdate[`flags.${MODULE_ID}.lightEdits.${entry.levelId}.${entry.key}`] = nextState;
      this.controller.setVirtualLightEditLocal(entry.levelId, entry.key, nextState);

      if (entry.placeable && !entry.placeable.destroyed) {
        entry.placeable.renderFlags.set({ refresh: true });
        entry.placeable.applyRenderFlags();
        canvas.lighting?.quadtree?.remove(entry.placeable);
        canvas.lighting?.quadtree?.insert({ r: entry.placeable.bounds, t: entry.placeable });
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
      this._destroyPlaceable(canvas.lighting, entry, this.lightsByKey, this.lightsById);
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
    for (const entry of Array.from(this.soundsByKey.values())) {
      this._destroyPlaceable(canvas?.sounds, entry, this.soundsByKey, this.soundsById);
    }
    this.soundsByKey.clear();
    this.soundsById.clear();
  }

  async _mountNativeSound(item, gen) {
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
      darkness: { min: item.darkMin, max: item.darkMax },
      levels: [item.levelId]
    }, { parent: canvas.scene });

    doc._mmVirtualSound = item;
    doc.update = async (data = {}) => (await this._commitSoundUpdates([{ ...data, _id: id }]))[0] || doc;
    doc.delete = async () => (await this._commitSoundDeletes([id]))[0] || doc;

    const placeable = canvas.sounds.createObject(doc);
    Object.defineProperty(placeable, "isFilteredOut", { value: false, configurable: true });
    // Link active PointSoundSource so Foundry draws the live wall-constrained sound radius
    const liveSrc = this.controller.audioStreamer?.activeSources?.get(`${item.levelId}::${item.sk}_${item.idx}`);
    if (liveSrc) placeable.source = liveSrc;

    const entry = { id, key: item.sKey, levelId: item.levelId, sk: item.sk, idx: item.idx, placeable, doc };
    this.soundsByKey.set(item.sKey, entry);
    this.soundsById.set(id, entry);

    canvas.sounds.objects.addChild(placeable);
    placeable.renderFlags.clear();
    await placeable.draw();

    if (!this.soundActive || gen !== this._soundGen || !this.soundsById.has(id)) {
      this._destroyPlaceable(canvas.sounds, entry, this.soundsByKey, this.soundsById);
      return;
    }

    placeable.renderFlags.set({ refresh: true });
    placeable.applyRenderFlags();
    canvas.sounds.quadtree?.insert({ r: placeable.bounds, t: placeable });
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
    const sx0 = Math.max(0, Math.floor(curVp.x0 / simSectorPx));
    const sy0 = Math.max(0, Math.floor(curVp.y0 / simSectorPx));
    const sx1 = Math.min(simGrid - 1, Math.floor(curVp.x1 / simSectorPx));
    const sy1 = Math.min(simGrid - 1, Math.floor(curVp.y1 / simSectorPx));
    const inZoom = curVp.scale >= SOUND_STREAM_MIN_SCALE;
    const key = `${lid}:${sx0}_${sy0}_${sx1}_${sy1}:${inZoom ? 1 : 0}:r${this.controller.soundEditsRev || 0}`;
    if (key === this._lastSoundKey) return;
    this._lastSoundKey = key;

    const pad = 400;
    const items = [];
    for (let sy = sy0; sy <= sy1; sy++) {
      for (let sx = sx0; sx <= sx1; sx++) {
        const sk = `${sx}_${sy}`;
        const list = spec.sectors[sk]?.s;
        if (!list?.length) continue;
        for (let si = 0; si < list.length; si++) {
          const item = this.controller.resolveVirtualSound(lid, sk, si, list[si], level);
          if (!item) continue;
          if (item.x < curVp.x0 - pad || item.x > curVp.x1 + pad ||
              item.y < curVp.y0 - pad || item.y > curVp.y1 + pad) continue;
          items.push(item);
        }
      }
    }

    if (!inZoom || items.length > MAX_SOUNDS_IN_VIEW) {
      this._clearSounds();
      if (this.soundMacroGfx) {
        const g = this.soundMacroGfx;
        g.clear();
        g.visible = true;
        const r = Math.max(14, Math.min(180, 7 / Math.max(0.01, curVp.scale)));
        g.lineStyle(Math.max(2, r * 0.2), 0x000000, 0.8);
        g.beginFill(0x66ccff, 0.85);
        for (const it of items) g.drawCircle(it.x, it.y, r);
        g.endFill();
      }
      return;
    }

    if (this.soundMacroGfx) { this.soundMacroGfx.clear(); this.soundMacroGfx.visible = false; }

    const needed = new Map();
    for (const it of items) needed.set(it.sKey, it);

    for (const entry of Array.from(this.soundsByKey.values())) {
      if (!needed.has(entry.key) && !entry.placeable?.controlled) {
        this._destroyPlaceable(canvas.sounds, entry, this.soundsByKey, this.soundsById);
      }
    }

    const gen = this._soundGen;
    for (const it of needed.values()) {
      if (!this.soundsByKey.has(it.sKey)) {
        this._mountNativeSound(it, gen);
      }
    }
  }

  async _commitSoundUpdates(updates) {
    const scene = canvas.scene;
    if (!scene || !updates.length) return [];
    const flagUpdate = {};
    const docs = [];

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
        elevation: entry.doc.elevation ?? 0
      };
      flagUpdate[`flags.${MODULE_ID}.soundEdits.${entry.levelId}.${entry.key}`] = nextState;
      this.controller.setVirtualSoundEditLocal(entry.levelId, entry.key, nextState);

      if (entry.placeable && !entry.placeable.destroyed) {
        entry.placeable.renderFlags.set({ refresh: true });
        entry.placeable.applyRenderFlags();
        canvas.sounds?.quadtree?.remove(entry.placeable);
        canvas.sounds?.quadtree?.insert({ r: entry.placeable.bounds, t: entry.placeable });
      }
      docs.push(entry.doc);
    }

    if (Object.keys(flagUpdate).length) {
      this.controller.applyVirtualSoundChangesLocal();
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
      this._destroyPlaceable(canvas.sounds, entry, this.soundsByKey, this.soundsById);
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
    for (const entry of Array.from(this.tilesByKey.values())) {
      this._setRawVirtualTileVisible(entry.fullId, true);
      this._destroyPlaceable(canvas?.tiles, entry, this.tilesByKey, this.tilesById);
    }
    this.tilesByKey.clear();
    this.tilesById.clear();
  }

  _setRawVirtualTileVisible(fullId, visible) {
    const vt = this.controller?.activeVirtualTiles?.get(fullId);
    if (vt?.mesh && !vt.mesh.destroyed) {
      vt.mesh.visible = visible;
    }
  }

  async _mountNativeTile(item, gen) {
    if (!this.tileActive || gen !== this._tileGen || !canvas?.tiles?.objects || !canvas.scene) return;
    if (this.tilesByKey.has(item.tKey)) return;

    const id = makeVirtualId("mt", item.levelId, item.tKey);
    const DocCls = CONFIG.Tile.documentClass;
    const occModes = resolveOcclusionModeArray(item.occlusionMode);
    const doc = new DocCls({
      _id: id,
      x: item.x,
      y: item.y,
      width: item.w,
      height: item.h,
      rotation: item.rot || 0,
      elevation: item.elevation,
      sort: item.sort || 0,
      alpha: item.alpha ?? 1,
      levels: [item.levelId],
      texture: {
        src: item.src,
        tint: item.tint || "#ffffff",
        alphaThreshold: item.alphaThreshold ?? 0.75
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
    doc.update = async (data = {}) => (await this._commitTileUpdates([{ ...data, _id: id }]))[0] || doc;
    doc.delete = async () => (await this._commitTileDeletes([id]))[0] || doc;

    const placeable = canvas.tiles.createObject(doc);
    Object.defineProperty(placeable, "isFilteredOut", { value: false, configurable: true });

    const fullId = `${item.levelId}::${item.tid}`;
    const entry = { id, key: item.tKey, fullId, levelId: item.levelId, tid: item.tid, placeable, doc };
    this.tilesByKey.set(item.tKey, entry);
    this.tilesById.set(id, entry);

    canvas.tiles.objects.addChild(placeable);
    placeable.renderFlags.clear();
    await placeable.draw();

    if (!this.tileActive || gen !== this._tileGen || !this.tilesById.has(id)) {
      this._destroyPlaceable(canvas.tiles, entry, this.tilesByKey, this.tilesById);
      return;
    }

    placeable.renderFlags.set({ refresh: true });
    placeable.applyRenderFlags();
    // Hide raw streamed PrimarySpriteMesh while native Tile renders its own mesh
    this._setRawVirtualTileVisible(fullId, false);
    canvas.tiles.quadtree?.insert({ r: placeable.bounds, t: placeable });
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
    const sx0 = Math.max(0, Math.floor(curVp.x0 / simSectorPx));
    const sy0 = Math.max(0, Math.floor(curVp.y0 / simSectorPx));
    const sx1 = Math.min(simGrid - 1, Math.floor(curVp.x1 / simSectorPx));
    const sy1 = Math.min(simGrid - 1, Math.floor(curVp.y1 / simSectorPx));
    const inZoom = curVp.scale >= TILE_STREAM_MIN_SCALE;
    const key = `${lid}:${sx0}_${sy0}_${sx1}_${sy1}:${inZoom ? 1 : 0}:r${this.controller.tileEditsRev || 0}`;
    if (key === this._lastTileKey) return;
    this._lastTileKey = key;

    if (!inZoom) {
      this._clearTiles();
      return;
    }

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

    const items = [];
    for (const tid of tids) {
      const item = this.controller.resolveVirtualTile(lid, tid, specTiles[tid], level);
      if (!item || !item.src) continue;
      if (item.x + item.w < curVp.x0 || item.x > curVp.x1 || item.y + item.h < curVp.y0 || item.y > curVp.y1) continue;
      items.push(item);
      if (items.length >= MAX_TILES_IN_VIEW) break;
    }

    const needed = new Map();
    for (const it of items) needed.set(it.tKey, it);

    for (const entry of Array.from(this.tilesByKey.values())) {
      if (!needed.has(entry.key) && !entry.placeable?.controlled) {
        this._setRawVirtualTileVisible(entry.fullId, true);
        this._destroyPlaceable(canvas.tiles, entry, this.tilesByKey, this.tilesById);
      }
    }

    const gen = this._tileGen;
    for (const it of needed.values()) {
      if (!this.tilesByKey.has(it.tKey)) {
        this._mountNativeTile(it, gen);
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
      entry.doc.updateSource(patch);

      const d = entry.doc;
      const occModes = Array.from(d.occlusion?.modes || []);
      const nextState = {
        src: d.texture?.src || "",
        x: Math.round(d.x),
        y: Math.round(d.y),
        w: Math.round(d.width),
        h: Math.round(d.height),
        rot: d.rotation || 0,
        elevation: d.elevation ?? 0,
        sort: d.sort || 0,
        alpha: d.alpha ?? 1,
        tint: d.texture?.tint ? foundry.utils.Color.from(d.texture.tint).css : null,
        alphaThreshold: d.texture?.alphaThreshold ?? 0.75,
        occlusionMode: occModes,
        occludedAlpha: d.occlusion?.alpha ?? 0.2,
        restrictsLight: Boolean(d.restrictions?.light),
        restrictsWeather: Boolean(d.restrictions?.weather)
      };

      flagUpdate[`flags.${MODULE_ID}.tileEdits.${entry.levelId}.${entry.key}`] = nextState;
      this.controller.setVirtualTileEditLocal(entry.levelId, entry.key, nextState);

      if (entry.placeable && !entry.placeable.destroyed) {
        entry.placeable.renderFlags.set({ refresh: true });
        entry.placeable.applyRenderFlags();
        canvas.tiles?.quadtree?.remove(entry.placeable);
        canvas.tiles?.quadtree?.insert({ r: entry.placeable.bounds, t: entry.placeable });
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
      this._destroyPlaceable(canvas.tiles, entry, this.tilesByKey, this.tilesById);
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
    this.deactivateLighting();
    this.deactivateSounds();
    this.deactivateTiles();
    this._removePatches();
    if (this.lightMacroGfx) {
      this.lightMacroGfx.parent?.removeChild(this.lightMacroGfx);
      this.lightMacroGfx.destroy();
      this.lightMacroGfx = null;
    }
    if (this.soundMacroGfx) {
      this.soundMacroGfx.parent?.removeChild(this.soundMacroGfx);
      this.soundMacroGfx.destroy();
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
