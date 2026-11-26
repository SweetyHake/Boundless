import {
  MODULE_ID,
  getEffectiveScale,
  getExistingSheet,
  getLevelBaseElevation,
  isSheetActiveOrRendering,
  makeVirtualWallId,
  attachVirtualCollectionProxy
} from "./utils.mjs";

const NATIVE_WALLS_MIN_SCALE = 0.22; // Stream all native Wall placeables when WallsLayer is active
const NATIVE_DOORS_ENTER_SCALE = 0.055; // Hysteresis enter threshold for native door Walls
const NATIVE_DOORS_EXIT_SCALE = 0.042;  // Hysteresis exit threshold prevents thrashing during zoom
const DOOR_CONTROL_MIN_SCALE = 0.12; // Hide tiny DoorControl icons only at far orbital zoom while DoorMesh stays visible
const MAX_NATIVE_WALLS_IN_VIEW = 420;
const MAX_NATIVE_DOORS_IN_VIEW = 220;
const WALL_MOUNT_BUDGET_MS = 1.6;    // Keep wall/door mounting strictly inside 120 FPS frame budget

function getMacroWallColor(seg) {
  if (seg.door) {
    if (seg.door === 2) return 0xaa66ff;
    if (seg.ds === 2) return 0xff5555;
    return 0x44ccff;
  }
  if (seg.sight === 10 || seg.light === 10) return 0x66e07a;
  if (seg.move === 0 && seg.sight > 0) return 0xff77dd;
  if (seg.sight === 0 && seg.move > 0) return 0x99aaff;
  return 0xffc855;
}

function terminateWallDoorAnimations(wall) {
  const AnimCls = foundry.canvas?.animation?.CanvasAnimation || globalThis.CanvasAnimation;
  if (!AnimCls?.terminateAnimation || !wall?.id) return;
  for (const style of ["single", "doubleL", "doubleR"]) {
    AnimCls.terminateAnimation(`Door.${wall.id}.${style}`);
  }
}

export class VirtualWallEditor {
  controller = null;
  active = false; // True when WallsLayer is active (all walls visible & editable); false = doors-only streaming

  // Currently mounted real Foundry Wall placeables: wKey -> { id, wKey, dKey, levelId, kind, sk, idx, isDoor, wall, doc }
  mountedByKey = new Map();
  mountedById = new Map();
  mountedByDoorKey = new Map();

  // Lightweight macro overview graphics when zoomed way out (< 0.22) on the Walls layer
  macroGfx = null;
  _lastKey = "";
  _patches = null;
  _clearGen = 0;
  _doorsZoomActive = false;
  _pendingMounts = [];
  _pendingMountKeys = new Set();
  _mountRafId = null;

  constructor(controller) {
    this.controller = controller;
  }

  mount() {
    this.unmount();
    if (!canvas?.walls) return;

    this.macroGfx = new PIXI.Graphics();
    this.macroGfx.name = "BoundlessVirtualWallsMacro";
    this.macroGfx.eventMode = "none";
    this.macroGfx.zIndex = -10;
    this.macroGfx.visible = false;
    canvas.walls.sortableChildren = true;
    canvas.walls.addChildAt(this.macroGfx, 0);

    this._installPatches();
    this.active = Boolean(canvas.walls.active && game.user?.isGM);
    this._lastKey = "";
    this.syncViewport(true);
  }

  _installPatches() {
    if (this._patches || !canvas?.scene || !canvas?.walls) return;
    const scene = canvas.scene;
    const wallsLayer = canvas.walls;

    const origUpdateEmbedded = scene.updateEmbeddedDocuments;
    const origDeleteEmbedded = scene.deleteEmbeddedDocuments;
    const origWallsGet = wallsLayer.get;
    const hadOwnUpdate = Object.prototype.hasOwnProperty.call(scene, "updateEmbeddedDocuments");
    const hadOwnDelete = Object.prototype.hasOwnProperty.call(scene, "deleteEmbeddedDocuments");
    const hadOwnWallsGet = Object.prototype.hasOwnProperty.call(wallsLayer, "get");
    const state = { active: true };

    const wrappedWallsGet = (objectId) => {
      if (state.active) {
        const virt = this.mountedById.get(objectId);
        if (virt) return virt.wall;
      }
      return origWallsGet.call(wallsLayer, objectId);
    };

    const wrappedUpdateEmbedded = async (embeddedName, updates = [], operation = {}) => {
      if (!state.active || embeddedName !== "Wall" || !this.mountedById.size || !Array.isArray(updates) || !updates.length) {
        return origUpdateEmbedded.call(scene, embeddedName, updates, operation);
      }

      const realUpdates = [];
      const virtUpdates = [];
      for (const u of updates) {
        const id = u?._id ?? u?.id;
        if (id && this.mountedById.has(id)) virtUpdates.push(u);
        else realUpdates.push(u);
      }

      const results = [];
      if (realUpdates.length) {
        const r = await origUpdateEmbedded.call(scene, embeddedName, realUpdates, operation);
        if (Array.isArray(r)) results.push(...r);
      }
      if (virtUpdates.length) {
        const v = await this._commitVirtualUpdates(virtUpdates, operation);
        results.push(...v);
      }
      return results;
    };

    const wrappedDeleteEmbedded = async (embeddedName, ids = [], operation = {}) => {
      if (!state.active || embeddedName !== "Wall" || !this.mountedById.size || !Array.isArray(ids) || !ids.length) {
        return origDeleteEmbedded.call(scene, embeddedName, ids, operation);
      }

      const realIds = [];
      const virtIds = [];
      for (const id of ids) {
        if (this.mountedById.has(id)) virtIds.push(id);
        else realIds.push(id);
      }

      const results = [];
      if (realIds.length) {
        const r = await origDeleteEmbedded.call(scene, embeddedName, realIds, operation);
        if (Array.isArray(r)) results.push(...r);
      }
      if (virtIds.length) {
        const v = await this._commitVirtualDeletes(virtIds);
        results.push(...v);
      }
      return results;
    };

    wallsLayer.get = wrappedWallsGet;
    scene.updateEmbeddedDocuments = wrappedUpdateEmbedded;
    scene.deleteEmbeddedDocuments = wrappedDeleteEmbedded;

    this._patches = {
      state,
      scene,
      wallsLayer,
      origUpdateEmbedded,
      origDeleteEmbedded,
      origWallsGet,
      hadOwnUpdate,
      hadOwnDelete,
      hadOwnWallsGet,
      wrappedUpdateEmbedded,
      wrappedDeleteEmbedded,
      wrappedWallsGet
    };
  }

  _removePatches() {
    if (!this._patches) return;
    const {
      state, scene, wallsLayer,
      origUpdateEmbedded, origDeleteEmbedded, origWallsGet,
      hadOwnUpdate, hadOwnDelete, hadOwnWallsGet,
      wrappedUpdateEmbedded, wrappedDeleteEmbedded, wrappedWallsGet
    } = this._patches;
    state.active = false;
    try {
      if (scene.updateEmbeddedDocuments === wrappedUpdateEmbedded) {
        if (hadOwnUpdate) scene.updateEmbeddedDocuments = origUpdateEmbedded;
        else delete scene.updateEmbeddedDocuments;
      }
      if (scene.deleteEmbeddedDocuments === wrappedDeleteEmbedded) {
        if (hadOwnDelete) scene.deleteEmbeddedDocuments = origDeleteEmbedded;
        else delete scene.deleteEmbeddedDocuments;
      }
      if (wallsLayer.get === wrappedWallsGet) {
        if (hadOwnWallsGet) wallsLayer.get = origWallsGet;
        else delete wallsLayer.get;
      }
    } catch {}
    this._patches = null;
  }

  activate() {
    if (!this.controller?.active || !game.user?.isGM) return;
    this.active = true;
    this._lastKey = "";
    // Refresh visibility of any already-mounted native door walls so their edit lines appear immediately
    for (const entry of this.mountedByKey.values()) {
      if (entry.wall && !entry.wall.destroyed) {
        entry.wall.renderFlags.set({ refreshVisibility: true, refreshLine: true });
        entry.wall.applyRenderFlags();
      }
    }
    this.syncViewport(true);
  }

  deactivate() {
    this.active = false;
    this._lastKey = "";
    if (this.macroGfx) {
      this.macroGfx.clear();
      this.macroGfx.visible = false;
    }
    // Unmount non-door walls immediately; keep visible doors mounted with their lines hidden (DoorControl & DoorMesh stay!)
    for (const entry of Array.from(this.mountedByKey.values())) {
      if (!entry.isDoor) {
        this._removeMountedEntry(entry, { closeSheet: true });
      } else if (entry.wall && !entry.wall.destroyed) {
        if (entry.wall.controlled) entry.wall.release({ broadcast: false });
        entry.wall.visible = false;
      }
    }
    this.syncViewport(true);
  }

  refreshDoorVisibility() {
    const showCtrl = this._showDoorControls !== false;
    const viewedLvlId = canvas?.level?.id;
    for (const entry of this.mountedByDoorKey.values()) {
      const dc = entry.wall?.doorControl;
      if (dc && !dc.destroyed) {
        const onViewedLevel = !viewedLvlId || !entry.levelId || entry.levelId === viewedLvlId;
        dc.visible = onViewedLevel && showCtrl && dc.isVisible;
      }
    }
  }

  applyDoorStateToMounted(dKey, ds, { playSound = true } = {}) {
    const entry = this.mountedByDoorKey.get(dKey);
    if (!entry?.wall || entry.wall.destroyed) return false;
    if (entry.doc.ds === ds) return false;
    entry.doc.updateSource({ ds });
    entry.liveDs = ds;
    entry.sig = this._wallSig({
      levelId: entry.levelId,
      c: entry.doc.c, move: entry.doc.move, sight: entry.doc.sight, light: entry.doc.light, sound: entry.doc.sound,
      dir: entry.doc.dir || 0, door: entry.doc.door || 0, doorSound: entry.doc.doorSound || "",
      threshold: entry.doc.threshold && (entry.doc.threshold.light || entry.doc.threshold.sight || entry.doc.threshold.sound)
        ? { light: entry.doc.threshold.light ?? null, sight: entry.doc.threshold.sight ?? null, sound: entry.doc.threshold.sound ?? null, attenuation: Boolean(entry.doc.threshold.attenuation) }
        : null,
      animation: (entry.doc.animation?.type && entry.doc.animation?.texture) ? {
        type: entry.doc.animation.type, texture: entry.doc.animation.texture,
        flip: Boolean(entry.doc.animation.flip), double: Boolean(entry.doc.animation.double),
        direction: entry.doc.animation.direction ?? 1, duration: entry.doc.animation.duration ?? 750, strength: entry.doc.animation.strength ?? 1
      } : null
    }, ds);
    entry.wall._onUpdate({ ds }, { sound: playSound }, game.user?.id);
    this._syncDoorMeshesElevation(entry.wall, entry.levelId);
    if (!this.active) entry.wall.visible = false;
    const dc = entry.wall.doorControl;
    const viewedLvlId = canvas?.level?.id;
    const onViewedLevel = !viewedLvlId || !entry.levelId || entry.levelId === viewedLvlId;
    if (dc && !dc.destroyed) dc.visible = onViewedLevel && (this._showDoorControls !== false) && dc.isVisible;
    this._syncOpenWallSheet(entry, { ds }, { syncDoorControl: true });
    return true;
  }

  _syncDoorMeshesElevation(wall, levelId) {
    if (!wall?.doorMeshes?.size || !canvas?.primary) return;
    const lvl = canvas.scene?.levels?.get?.(levelId);
    if (!lvl) return;
    const baseElev = getLevelBaseElevation(lvl);
    const viewedLvlId = canvas.level?.id;
    const isOtherLevel = Boolean(viewedLvlId && levelId && levelId !== viewedLvlId);
    const topRaw = lvl.elevation?.top;
    const roofElev = Number.isFinite(topRaw) ? topRaw : (baseElev + 20);
    let dirty = false;
    for (const m of wall.doorMeshes) {
      let targetElev = m.elevation;
      if (isOtherLevel) {
        // Clamp other-level DoorMesh cleanly within its own level band so lower-floor doors never draw above upper floors
        targetElev = Math.max(baseElev, roofElev - 0.05);
      } else if (baseElev !== 0 && m.elevation < baseElev) {
        targetElev = baseElev;
      }
      if (m.elevation !== targetElev) {
        m.elevation = targetElev;
        if (m._closedPosition) m._closedPosition.elevation = targetElev;
        if (m._animatedPosition) m._animatedPosition.elevation = targetElev;
        dirty = true;
      }
    }
    if (dirty) canvas.primary.sortDirty = true;
  }

  _syncPreviewDoorControl(previewWall) {
    if (!previewWall || previewWall.destroyed) return;
    const dt = previewWall.document?.door;
    const hasCtrl = (dt === CONST.WALL_DOOR_TYPES?.DOOR || dt === 1)
      || ((dt === CONST.WALL_DOOR_TYPES?.SECRET || dt === 2) && game.user?.isGM);
    if (hasCtrl) {
      if (previewWall.doorControl && !previewWall.doorControl.destroyed) previewWall.doorControl.draw();
      else previewWall.createDoorControl?.();
    } else {
      previewWall.clearDoorControl?.();
    }
  }

  _syncOpenWallSheet(entry, patch, { syncDoorControl = false } = {}) {
    const sheet = getExistingSheet(entry?.doc);
    if (!sheet || !isSheetActiveOrRendering(sheet, entry?.wall)) return;
    try {
      if (sheet._preview) {
        if (typeof sheet._previewChanges === "function") sheet._previewChanges(patch);
        else sheet._preview.updateSource?.(patch);
        if (syncDoorControl) this._syncPreviewDoorControl(sheet._preview.object);
      } else if (entry.wall?._preview?.previewType === "config") {
        entry.wall._preview.document?.updateSource?.(patch);
        if (syncDoorControl) this._syncPreviewDoorControl(entry.wall._preview);
      }
      sheet.render(false);
    } catch {}
  }

  _getViewedLayer() {
    const lid = canvas.level?.id;
    return lid ? this.controller?.levelLayers?.get(lid) || null : null;
  }

  _buildDoorKey(seg) {
    if (!seg.door) return null;
    return seg.kind === "w"
      ? `${seg.levelId}::${seg.sk}_w${seg.idx}`
      : `${seg.levelId}::${seg.sk}_${seg.idx}`;
  }

  _entryKey(seg) {
    return `${seg.levelId}::${seg.wKey}`;
  }

  _getDoorLayers(doorsOnly = false) {
    const viewed = this._getViewedLayer();
    if (doorsOnly && this.controller?.visibleLevelLayers?.length) {
      const valid = this.controller.visibleLevelLayers.filter(l => l?.spec?.sectors);
      if (viewed?.spec?.sectors) {
        // Always prioritize the currently viewed level first so dense lower floors never exhaust doorCap
        return [viewed, ...valid.filter(l => l !== viewed)];
      }
      return valid;
    }
    return viewed?.spec?.sectors ? [viewed] : [];
  }

  _collectViewportSegments(vp, { doorsOnly = false, limit = Infinity } = {}) {
    const layers = this._getDoorLayers(doorsOnly);
    if (!layers.length) return [];

    const pad = 250;
    const vx0 = vp.x0 - pad, vy0 = vp.y0 - pad, vx1 = vp.x1 + pad, vy1 = vp.y1 + pad;
    const segments = [];

    for (const layer of layers) {
      const { simGrid, simSectorPx, spec, level } = layer;
      const lid = level.id;
      const sx0 = Math.max(0, Math.floor(vx0 / simSectorPx));
      const sy0 = Math.max(0, Math.floor(vy0 / simSectorPx));
      const sx1 = Math.min(simGrid - 1, Math.floor(vx1 / simSectorPx));
      const sy1 = Math.min(simGrid - 1, Math.floor(vy1 / simSectorPx));
      const levelEdits = this.controller.wallEdits.get(lid);
      const seenKeys = new Set();

      for (let sy = sy0; sy <= sy1; sy++) {
        for (let sx = sx0; sx <= sx1; sx++) {
          const sk = `${sx}_${sy}`;
          const sec = spec.sectors[sk];
          if (!sec) continue;

          if (sec.d) {
            for (let di = 0; di < sec.d.length; di++) {
              const resolved = this.controller.resolveVirtualWall(lid, "d", sk, di, sec.d[di]);
              if (!resolved) continue;
              seenKeys.add(resolved.wKey);
              if (doorsOnly && !resolved.door) continue;
              const [x1, y1, x2, y2] = resolved.c;
              if ((x1 < vx0 && x2 < vx0) || (x1 > vx1 && x2 > vx1) ||
                  (y1 < vy0 && y2 < vy0) || (y1 > vy1 && y2 > vy1)) continue;
              segments.push(resolved);
              if (segments.length >= limit) return segments;
            }
          }

          if (sec.w) {
            if (doorsOnly && !levelEdits?.size) continue;
            for (let wi = 0; wi < sec.w.length; wi++) {
              if (doorsOnly) {
                const ov = levelEdits.get(`${sk}:w:${wi}`);
                if (!ov || !ov.door) continue;
              }
              const resolved = this.controller.resolveVirtualWall(lid, "w", sk, wi, sec.w[wi]);
              if (!resolved) continue;
              seenKeys.add(resolved.wKey);
              if (doorsOnly && !resolved.door) continue;
              const [x1, y1, x2, y2] = resolved.c;
              if ((x1 < vx0 && x2 < vx0) || (x1 > vx1 && x2 > vx1) ||
                  (y1 < vy0 && y2 < vy0) || (y1 > vy1 && y2 > vy1)) continue;
              segments.push(resolved);
              if (segments.length >= limit) return segments;
            }
          }
        }
      }

      // Also include walls/doors edited and dragged outside their original home sector
      if (levelEdits?.size) {
        for (const [wKey, ov] of levelEdits) {
          if (!ov || seenKeys.has(wKey)) continue;
          const parts = wKey.split(":");
          if (parts.length !== 3) continue;
          const [sk, kind, idxStr] = parts;
          const idx = Number(idxStr);
          const raw = spec.sectors[sk]?.[kind]?.[idx];
          if (!raw) continue;
          const resolved = this.controller.resolveVirtualWall(lid, kind, sk, idx, raw);
          if (!resolved) continue;
          if (doorsOnly && !resolved.door) continue;
          const [x1, y1, x2, y2] = resolved.c;
          if ((x1 < vx0 && x2 < vx0) || (x1 > vx1 && x2 > vx1) ||
              (y1 < vy0 && y2 < vy0) || (y1 > vy1 && y2 > vy1)) continue;
          segments.push(resolved);
          if (segments.length >= limit) return segments;
        }
      }
    }
    return segments;
  }

  _removeMountedEntry(entry, { closeSheet = false } = {}) {
    if (!entry) return;
    const wallsLayer = canvas?.walls;
    const w = entry.wall;
    const mKey = entry.mKey || `${entry.levelId}::${entry.wKey}`;
    if (this.mountedByKey.get(mKey) === entry) this.mountedByKey.delete(mKey);
    if (this.mountedById.get(entry.id) === entry) this.mountedById.delete(entry.id);
    if (entry.dKey && this.mountedByDoorKey.get(entry.dKey) === entry) this.mountedByDoorKey.delete(entry.dKey);
    const sheet = getExistingSheet(entry.doc);
    if (closeSheet && sheet) {
      try { sheet.close(); } catch {}
    }
    if (!w) return;
    try {
      terminateWallDoorAnimations(w);
      if (w.controlled) w.release({ broadcast: false });
      if (wallsLayer?.clipboard?.cut && wallsLayer.clipboard.objects?.length) {
        wallsLayer.clipboard.objects = wallsLayer.clipboard.objects.filter(o => o !== w);
      }
      if (w._preview && !w._preview.destroyed) {
        try {
          w._preview.parent?.removeChild(w._preview);
          w._preview.destroy({ children: true });
        } catch {}
        w._preview = null;
      }
      wallsLayer?.quadtree?.remove(w);
      w.parent?.removeChild(w);
      if (!w.destroyed) w.destroy({ children: true });
    } catch {}
  }

  _cancelPendingMounts() {
    this._pendingMounts = [];
    this._pendingMountKeys.clear();
    if (this._mountRafId !== null) {
      if (typeof cancelAnimationFrame === "function") {
        try { cancelAnimationFrame(this._mountRafId); } catch {}
      } else {
        clearTimeout(this._mountRafId);
      }
      this._mountRafId = null;
    }
  }

  _scheduleMountPump() {
    if (this._mountRafId !== null || this._pendingMounts.length === 0) return;
    const sched = typeof requestAnimationFrame === "function" ? requestAnimationFrame : (fn) => setTimeout(fn, 16);
    this._mountRafId = sched(() => {
      this._mountRafId = null;
      this._pumpPendingMounts();
    });
  }

  _pumpPendingMounts() {
    if (!this.controller?.active || !canvas?.walls?.objects || this._pendingMounts.length === 0) return;
    const gen = this._clearGen;
    const maxPerFrame = this.active ? 10 : 4;
    const t0 = performance.now();
    let count = 0;
    while (this._pendingMounts.length > 0 && count < maxPerFrame) {
      if (count > 0 && (performance.now() - t0) >= WALL_MOUNT_BUDGET_MS) break;
      const seg = this._pendingMounts.shift();
      const mKey = this._entryKey(seg);
      this._pendingMountKeys.delete(mKey);
      if (this.mountedByKey.has(mKey)) continue;
      if (this._lastNeededKeys && !this._lastNeededKeys.has(mKey)) continue;
      this._mountNativeWall(seg, gen);
      count++;
    }
    if (this._pendingMounts.length > 0) this._scheduleMountPump();
  }

  _clearMountedWalls({ keepProtected = false } = {}) {
    this._clearGen++;
    this._cancelPendingMounts();
    const keptKeys = keepProtected ? new Set() : null;
    const viewedLvlId = keepProtected ? this._getViewedLayer()?.level?.id : null;
    for (const entry of Array.from(this.mountedByKey.values())) {
      if (keepProtected) {
        const wrongLevel = Boolean(viewedLvlId && entry.levelId !== viewedLvlId);
        const isDeleted = !wrongLevel && this.controller?.wallEdits?.get?.(entry.levelId)?.get?.(entry.wKey) === null;
        const sheet = getExistingSheet(entry.doc);
        if (!wrongLevel && !isDeleted && (entry.wall?.controlled || isSheetActiveOrRendering(sheet, entry.wall))) {
          keptKeys.add(entry.mKey || `${entry.levelId}::${entry.wKey}`);
          continue;
        }
      }
      this._removeMountedEntry(entry, { closeSheet: true });
    }
    if (!keepProtected) {
      this.mountedByKey.clear();
      this.mountedById.clear();
      this.mountedByDoorKey.clear();
      this._lastNeededKeys = null;
    } else {
      this._lastNeededKeys = keptKeys;
    }
  }

  async _mountNativeWall(seg, gen) {
    const mKey = this._entryKey(seg);
    if (gen !== this._clearGen || !canvas?.walls?.objects || !canvas.scene) return;
    if (this.mountedByKey.has(mKey)) return;

    // Preload animated door texture before creating Wall so Foundry's fire-and-forget createDoorMeshes()
    // cannot leak an orphaned DoorMesh into canvas.primary if this wall is unmounted mid-load.
    const editRev = this.controller.wallEditsRev || 0;
    if (seg.animation?.type && seg.animation?.texture && typeof foundry.canvas?.loadTexture === "function") {
      try { await foundry.canvas.loadTexture(seg.animation.texture); } catch {}
      if (gen !== this._clearGen || (this.controller.wallEditsRev || 0) !== editRev || !canvas?.walls?.objects || !canvas.scene) return;
      const isAllowedLevel = this.active
        ? (this._getViewedLayer()?.level?.id === seg.levelId)
        : this._getDoorLayers(true).some(l => l.level?.id === seg.levelId);
      if (!isAllowedLevel) return;
      if ((this._lastNeededKeys && !this._lastNeededKeys.has(mKey)) || this.mountedByKey.has(mKey)) return;
    }

    const id = makeVirtualWallId(seg.levelId, seg.wKey);
    const dKey = this._buildDoorKey(seg);
    const liveDs = dKey ? this.controller.getCurrentDoorState(dKey, seg.ds) : (seg.ds || 0);

    const WallDocCls = CONFIG.Wall.documentClass;
    const initData = {
      _id: id,
      c: seg.c.slice(),
      move: seg.move,
      sight: seg.sight,
      light: seg.light,
      sound: seg.sound,
      dir: seg.dir || 0,
      door: seg.door || 0,
      ds: liveDs,
      doorSound: seg.doorSound || "",
      levels: [seg.levelId]
    };
    if (seg.threshold) initData.threshold = foundry.utils.deepClone(seg.threshold);
    if (seg.animation?.type && seg.animation?.texture) initData.animation = foundry.utils.deepClone(seg.animation);

    let doc;
    try {
      doc = new WallDocCls(initData, { parent: canvas.scene });
    } catch (err) {
      console.warn(`${MODULE_ID} | Failed to construct virtual WallDocument ${seg.wKey}:`, err);
      return;
    }
    doc._mmVirtualMeta = { id, wKey: seg.wKey, dKey, levelId: seg.levelId, kind: seg.kind, sk: seg.sk, idx: seg.idx };
    // Virtual WallDocuments are not added to scene.walls so WallDocument#initializeEdge never runs;
    // expose a live `edge` getter so Foundry v14 DoorMesh.animateSlide() and WallsLayer helpers never see `null`.
    Object.defineProperty(doc, "edge", {
      get() {
        const c = this.c;
        return Array.isArray(c) && c.length >= 4
          ? { a: { x: c[0], y: c[1] }, b: { x: c[2], y: c[3] }, intersections: {} }
          : null;
      },
      configurable: true
    });

    // Foundry v14 DocumentSheetV2#_processSubmitData checks `document.collection.has(document.id)` before calling `document.update()`;
    // expose a lightweight proxy over `scene.walls` so WallConfig saves via `doc.update()` instead of throwing!
    attachVirtualCollectionProxy(doc, id, canvas.scene.walls);

    // Route direct DoorControl `doc.update({ ds })`, WallConfig `doc.update(...)`, and `doc.delete()`
    doc.update = async (data = {}, options = {}) => {
      const res = await this._commitVirtualUpdates([{ ...data, _id: id }], options);
      return res[0] || doc;
    };
    doc.delete = async () => {
      const res = await this._commitVirtualDeletes([id]);
      return res[0] || doc;
    };
    // Ensure PlaceableConfig preview clones (`keepId: true` on same scene) inherit virtual update/delete
    // so clicking the preview's DoorControl while WallConfig is open routes through VirtualWallEditor instead of ClientDatabaseBackend.
    if (typeof doc.clone === "function") {
      const origClone = doc.clone.bind(doc);
      doc.clone = (data = {}, context = {}) => {
        const cloned = origClone(data, context);
        if (!context?.save && context?.keepId && cloned && cloned.id === id && cloned.parent === doc.parent) {
          cloned.update = doc.update;
          cloned.delete = doc.delete;
          attachVirtualCollectionProxy(cloned, id, canvas.scene.walls);
          Object.defineProperty(cloned, "edge", {
            get() {
              const c = this.c;
              return Array.isArray(c) && c.length >= 4
                ? { a: { x: c[0], y: c[1] }, b: { x: c[2], y: c[3] }, intersections: {} }
                : null;
            },
            configurable: true
          });
        }
        return cloned;
      };
    }

    const selfEditor = this;
    const wall = canvas.walls.createObject(doc);
    // Bypass v14 ui.placeables sidebar filter so streamed native walls & doors render cleanly
    Object.defineProperty(wall, "isFilteredOut", { value: false, configurable: true });
    // Serialize & guard Foundry's fire-and-forget Wall#createDoorMeshes() so destroying a wall mid-load never leaks an orphaned DoorMesh into canvas.primary
    if (typeof wall.createDoorMeshes === "function") {
      const origCreateDoorMeshes = wall.createDoorMeshes.bind(wall);
      let doorMeshChain = Promise.resolve();
      wall.createDoorMeshes = function () {
        doorMeshChain = doorMeshChain.then(async () => {
          if (this.destroyed || !canvas?.primary) return;
          await origCreateDoorMeshes();
          if (this.destroyed || !canvas?.primary) {
            try { this.destroyDoorMeshes?.(); } catch {}
            return;
          }
          selfEditor._syncDoorMeshesElevation(this, seg.levelId);
        }).catch(() => {});
        return doorMeshChain;
      };
    }

    const sig = this._wallSig(seg, liveDs);
    const entry = {
      id,
      mKey,
      wKey: seg.wKey,
      dKey,
      levelId: seg.levelId,
      kind: seg.kind,
      sk: seg.sk,
      idx: seg.idx,
      isDoor: Boolean(seg.door > 0),
      defaultDs: seg.ds || 0,
      editsRev: this.controller?.wallEditsRev || 0,
      liveDs,
      sig,
      wall,
      doc
    };
    this.mountedByKey.set(mKey, entry);
    this.mountedById.set(id, entry);
    if (dKey) this.mountedByDoorKey.set(dKey, entry);

    canvas.walls.objects.addChild(wall);
    wall.renderFlags.clear();
    let drawFailed = false;
    try {
      await wall.draw();
    } catch (err) {
      drawFailed = true;
      console.warn(`${MODULE_ID} | Wall#draw failed for virtual wall ${seg.wKey}:`, err);
    }

    if (drawFailed || gen !== this._clearGen || this.mountedById.get(id) !== entry || wall.destroyed) {
      this._removeMountedEntry(entry);
      return;
    }

    wall.renderFlags.set({ refresh: true });
    wall.applyRenderFlags();
    // When WallsLayer is inactive, hide wall edit lines (DoorControl & DoorMesh live on their own layers!)
    if (!this.active) wall.visible = false;
    if (wall.doorControl && !wall.doorControl.destroyed) {
      const viewedLvlId = canvas?.level?.id;
      const onViewedLevel = !viewedLvlId || !seg.levelId || seg.levelId === viewedLvlId;
      wall.doorControl.visible = onViewedLevel && (this._showDoorControls !== false) && wall.doorControl.isVisible;
    }
    wall._updateQuadtree?.();
  }

  _wallSig(seg, liveDs) {
    return JSON.stringify([
      seg.levelId || "",
      seg.c, seg.move, seg.sight, seg.light, seg.sound, seg.dir || 0,
      seg.door || 0, liveDs, seg.doorSound || "", seg.threshold || null, seg.animation || null
    ]);
  }

  _syncMountedEntryInPlace(entry, seg, dKey, liveDs, nextSig) {
    const patch = {
      c: seg.c.slice(), move: seg.move, sight: seg.sight, light: seg.light, sound: seg.sound,
      dir: seg.dir || 0, door: seg.door || 0, ds: liveDs,
      doorSound: seg.doorSound || "",
      threshold: seg.threshold ? foundry.utils.deepClone(seg.threshold) : { light: null, sight: null, sound: null, attenuation: false },
      animation: (seg.animation?.type && seg.animation?.texture) ? foundry.utils.deepClone(seg.animation) : null
    };
    const diff = entry.doc.updateSource(patch);
    entry.sig = nextSig;
    entry.isDoor = Boolean(seg.door > 0);
    entry.defaultDs = seg.ds || 0;
    if (entry.dKey && entry.dKey !== dKey) {
      if (this.mountedByDoorKey.get(entry.dKey) === entry) this.mountedByDoorKey.delete(entry.dKey);
    }
    entry.dKey = dKey;
    if (dKey) this.mountedByDoorKey.set(dKey, entry);
    if (diff && !foundry.utils.isEmpty(diff)) {
      if (entry.wall && !entry.wall.destroyed) {
        try { entry.wall._onUpdate(diff, { sound: false }, game.user?.id); } catch {}
        this._syncDoorMeshesElevation(entry.wall, entry.levelId);
        if (!this.active) entry.wall.visible = false;
        if (entry.wall.doorControl && !entry.wall.doorControl.destroyed) {
          const viewedLvlId = canvas?.level?.id;
          const onViewedLevel = !viewedLvlId || !entry.levelId || entry.levelId === viewedLvlId;
          entry.wall.doorControl.visible = onViewedLevel && (this._showDoorControls !== false) && entry.wall.doorControl.isVisible;
        }
        entry.wall._updateQuadtree?.();
      }
      this._syncOpenWallSheet(entry, diff, { syncDoorControl: ("door" in diff) || ("ds" in diff) });
    }
  }

  _drawMacroOverview(segments, scale) {
    if (!this.macroGfx) return;
    const g = this.macroGfx;
    g.clear();
    g.visible = true;
    if (!segments.length) return;

    const lw = Math.max(2, Math.min(28, 2.6 / Math.max(0.01, scale)));
    const maxDraw = 2500;
    const step = segments.length > maxDraw ? Math.ceil(segments.length / maxDraw) : 1;
    const byColor = new Map();
    for (let i = 0; i < segments.length; i += step) {
      const seg = segments[i];
      const col = getMacroWallColor(seg);
      let list = byColor.get(col);
      if (!list) {
        list = [];
        byColor.set(col, list);
      }
      list.push(seg);
    }

    for (const [col, list] of byColor) {
      g.lineStyle(lw, col, 0.72);
      for (let i = 0; i < list.length; i++) {
        const [x1, y1, x2, y2] = list[i].c;
        g.moveTo(x1, y1);
        g.lineTo(x2, y2);
      }
    }
  }

  syncViewport(force = false, vp = null) {
    if (!this.controller?.active || !canvas?.walls) return;
    if (force) this._lastKey = "";

    const curVp = vp || this.controller.getViewportWorldRect(0.18);
    const isWallsEditMode = this.active && Boolean(game.user?.isGM);
    const viewedLvlId = canvas.level?.id || "";
    const visLayers = this.controller.visibleLevelLayers;
    const visLen = visLayers?.length || 0;
    const visFirstId = visLen > 0 ? (visLayers[0]?.level?.id || "") : "";
    const visLastId = visLen > 1 ? (visLayers[visLen - 1]?.level?.id || "") : visFirstId;
    const cacheTag = `${isWallsEditMode ? 1 : 0}:${viewedLvlId}:${visLen}:${visFirstId}:${visLastId}:${this.controller._mountGen || 0}`;
    let activeLayers;
    let levelSig;
    if (this._doorLayersCacheTag === cacheTag && this._doorLayersCache) {
      activeLayers = this._doorLayersCache;
      levelSig = this._doorLevelSigCache;
    } else {
      activeLayers = this._getDoorLayers(!isWallsEditMode);
      levelSig = activeLayers.map(l => l.level.id).join(",");
      this._doorLayersCacheTag = cacheTag;
      this._doorLayersCache = activeLayers;
      this._doorLevelSigCache = levelSig;
    }
    if (!activeLayers.length) {
      this._clearMountedWalls();
      if (this.macroGfx) { this.macroGfx.clear(); this.macroGfx.visible = false; }
      return;
    }

    const effScale = getEffectiveScale(curVp.scale);
    if (effScale >= NATIVE_DOORS_ENTER_SCALE) this._doorsZoomActive = true;
    else if (effScale < NATIVE_DOORS_EXIT_SCALE) this._doorsZoomActive = false;
    const inNativeZoom = isWallsEditMode ? (effScale >= NATIVE_WALLS_MIN_SCALE) : this._doorsZoomActive;
    const showDoorControls = isWallsEditMode || effScale >= DOOR_CONTROL_MIN_SCALE;

    const qStep = isWallsEditMode
      ? Math.max(200, Math.round(60 / Math.max(0.01, curVp.scale)))
      : Math.max(400, Math.round(120 / Math.max(0.01, curVp.scale)));
    const qx0 = Math.floor(curVp.x0 / qStep);
    const qy0 = Math.floor(curVp.y0 / qStep);
    const qx1 = Math.floor(curVp.x1 / qStep);
    const qy1 = Math.floor(curVp.y1 / qStep);

    const rev = this.controller.wallEditsRev || 0;
    const prevShowDoorControls = this._showDoorControls;
    this._showDoorControls = showDoorControls;
    const key = `${levelSig}:${qx0}_${qy0}_${qx1}_${qy1}:q${qStep}:m${isWallsEditMode ? 1 : 0}:n${inNativeZoom ? 1 : 0}:c${showDoorControls ? 1 : 0}:r${rev}`;
    if (key === this._lastKey) return;
    this._lastKey = key;
    if (prevShowDoorControls !== showDoorControls) this.refreshDoorVisibility();

    // Gameplay mode at extreme orbital zoom (< 0.05): unmount doors for 0 overhead on continental maps
    if (!isWallsEditMode && !inNativeZoom) {
      this._clearMountedWalls();
      if (this.macroGfx) { this.macroGfx.clear(); this.macroGfx.visible = false; }
      return;
    }

    const doorCap = this._doorsCapped ? 200 : 260;
    const collectLimit = isWallsEditMode ? (inNativeZoom ? 6000 : 3000) : (doorCap + 1);
    const segments = this._collectViewportSegments(curVp, { doorsOnly: !isWallsEditMode, limit: collectLimit });

    // On massive continental maps with > 260 doors in viewport at far zoom, avoid mounting hundreds of native Wall objects (hysteresis exit at <= 200)
    if (!isWallsEditMode && segments.length > doorCap) {
      this._doorsCapped = true;
      this._clearMountedWalls();
      if (this.macroGfx) { this.macroGfx.clear(); this.macroGfx.visible = false; }
      return;
    }
    if (!isWallsEditMode) this._doorsCapped = false;

    // WallsLayer zoomed way out or ultra-dense block: show lightweight macro overview (keeping controlled/open-sheet walls intact & synced)
    if (isWallsEditMode && (!inNativeZoom || segments.length > MAX_NATIVE_WALLS_IN_VIEW)) {
      this._clearMountedWalls({ keepProtected: true });
      for (const entry of Array.from(this.mountedByKey.values())) {
        const entryLayer = this.controller?.levelLayers?.get?.(entry.levelId);
        const raw = entryLayer?.spec?.sectors?.[entry.sk]?.[entry.kind]?.[entry.idx];
        const resolved = raw ? this.controller.resolveVirtualWall(entry.levelId, entry.kind, entry.sk, entry.idx, raw) : null;
        if (!resolved) {
          this._removeMountedEntry(entry, { closeSheet: true });
          continue;
        }
        const dKey = this._buildDoorKey(resolved);
        const liveDs = dKey ? this.controller.getCurrentDoorState(dKey, resolved.ds) : (resolved.ds || 0);
        if (entry.editsRev === rev && entry.liveDs === liveDs) continue;
        const nextSig = this._wallSig(resolved, liveDs);
        entry.editsRev = rev;
        entry.liveDs = liveDs;
        if (entry.sig !== nextSig) {
          this._syncMountedEntryInPlace(entry, resolved, dKey, liveDs, nextSig);
        }
      }
      this._drawMacroOverview(segments, curVp.scale);
      return;
    }

    if (this.macroGfx) {
      this.macroGfx.clear();
      this.macroGfx.visible = false;
    }

    const activeLayersById = new Map();
    for (const l of activeLayers) activeLayersById.set(l.level.id, l);
    const needed = new Map();
    for (const seg of segments) needed.set(this._entryKey(seg), seg);
    this._lastNeededKeys = new Set(needed.keys());

    // Unmount walls from non-visible levels, deleted walls, or doors converted/reverted to plain walls in gameplay unconditionally (with closeSheet)
    for (const entry of Array.from(this.mountedByKey.values())) {
      const mKey = entry.mKey || `${entry.levelId}::${entry.wKey}`;
      const entryLayer = activeLayersById.get(entry.levelId);
      const wrongLevel = !entryLayer;
      const lvlWallEdits = !wrongLevel ? this.controller.wallEdits?.get(entry.levelId) : undefined;
      const ov = !wrongLevel ? lvlWallEdits?.get(entry.wKey) : undefined;
      const neededSeg = !wrongLevel ? needed.get(mKey) : null;
      const raw = (!wrongLevel && !neededSeg) ? entryLayer.spec.sectors?.[entry.sk]?.[entry.kind]?.[entry.idx] : null;
      const resolved = neededSeg || ((!wrongLevel && ov !== null && raw)
        ? this.controller.resolveVirtualWall(entry.levelId, entry.kind, entry.sk, entry.idx, raw)
        : null);
      const isDeleted = ov === null || (!wrongLevel && !resolved);
      const lostDoorInGameplay = !wrongLevel && !isWallsEditMode && Boolean(resolved && !resolved.door);
      const sheet = getExistingSheet(entry.doc);
      if (wrongLevel || isDeleted || lostDoorInGameplay) {
        this._removeMountedEntry(entry, { closeSheet: true });
      } else if (!neededSeg) {
        if (!entry.wall?.controlled && !isSheetActiveOrRendering(sheet, entry.wall)) {
          this._removeMountedEntry(entry);
        } else {
          this._lastNeededKeys.add(mKey);
          if (resolved) {
            const dKey = this._buildDoorKey(resolved);
            const liveDs = dKey ? this.controller.getCurrentDoorState(dKey, resolved.ds) : (resolved.ds || 0);
            const nextSig = this._wallSig(resolved, liveDs);
            if (entry.sig !== nextSig) {
              if (sheet?.rendered) {
                this._syncMountedEntryInPlace(entry, resolved, dKey, liveDs, nextSig);
              } else {
                this._removeMountedEntry(entry, { closeSheet: isSheetActiveOrRendering(sheet, entry.wall) });
              }
            }
          }
        }
      }
    }

    const gen = this._clearGen;
    const isMoving = Boolean(!force && this.controller?.isActivelyMoving?.());
    const maxSyncMounts = force ? (isWallsEditMode ? 24 : 8) : (isMoving ? 0 : (isWallsEditMode ? 8 : 3));
    const tMountStart = performance.now();
    let syncMounted = 0;
    for (const [mKey, seg] of needed) {
      const existing = this.mountedByKey.get(mKey);
      if (!existing) {
        if (syncMounted < maxSyncMounts && (syncMounted === 0 || (performance.now() - tMountStart) < WALL_MOUNT_BUDGET_MS)) {
          this._mountNativeWall(seg, gen);
          syncMounted++;
        } else if (!this._pendingMountKeys.has(mKey)) {
          this._pendingMountKeys.add(mKey);
          this._pendingMounts.push(seg);
        } else {
          for (let pi = 0; pi < this._pendingMounts.length; pi++) {
            if (this._entryKey(this._pendingMounts[pi]) === mKey) {
              this._pendingMounts[pi] = seg;
              break;
            }
          }
        }
      } else {
        const dKey = this._buildDoorKey(seg);
        const liveDs = dKey ? this.controller.getCurrentDoorState(dKey, seg.ds) : (seg.ds || 0);
        if (existing.editsRev === rev && existing.liveDs === liveDs) continue;
        const nextSig = this._wallSig(seg, liveDs);
        existing.editsRev = rev;
        existing.liveDs = liveDs;
        if (existing.sig !== nextSig) {
          const sheet = getExistingSheet(existing.doc);
          if (sheet?.rendered) {
            this._syncMountedEntryInPlace(existing, seg, dKey, liveDs, nextSig);
          } else {
            this._removeMountedEntry(existing, { closeSheet: isSheetActiveOrRendering(sheet, existing.wall) });
            if (syncMounted < maxSyncMounts && (performance.now() - tMountStart) < WALL_MOUNT_BUDGET_MS) {
              this._mountNativeWall(seg, gen);
              syncMounted++;
            } else if (!this._pendingMountKeys.has(mKey)) {
              this._pendingMountKeys.add(mKey);
              this._pendingMounts.push(seg);
            } else {
              for (let pi = 0; pi < this._pendingMounts.length; pi++) {
                if (this._entryKey(this._pendingMounts[pi]) === mKey) {
                  this._pendingMounts[pi] = seg;
                  break;
                }
              }
            }
          }
        }
      }
    }
    if (this._pendingMounts.length > 0) this._scheduleMountPump();
  }

  // Alias kept for convenience
  redraw(force = false, vp = null) {
    this.syncViewport(force, vp);
  }

  async _commitVirtualUpdates(virtUpdates, operation = {}) {
    const scene = canvas.scene;
    if (!scene || !virtUpdates.length) return [];

    const flagUpdate = {};
    const updatedDocs = [];
    const doorOnlyUpdates = [];
    let hasGeometryOrConfigEdit = false;

    for (const u of virtUpdates) {
      const id = u._id ?? u.id;
      const entry = this.mountedById.get(id);
      if (!entry) continue;

      const patch = foundry.utils.deepClone(u);
      delete patch._id;
      delete patch.id;

      const patchKeys = Object.keys(patch);
      const isDoorStateOnly = entry.isDoor && entry.dKey && patchKeys.length === 1 && patchKeys[0] === "ds";

      // Fast-path: DoorControl click (left-click open/close, right-click lock/unlock, or GM "Close All Doors" bulk toggle)
      if (isDoorStateOnly) {
        const targetDs = Number(patch.ds);
        const playSound = operation?.sound !== false;
        doorOnlyUpdates.push({ entry, targetDs, playSound });
        updatedDocs.push(entry.doc);
        continue;
      }

      // GM-only wall geometry / configuration edit via WallsLayer or WallConfig
      if (!game.user?.isGM) continue;
      hasGeometryOrConfigEdit = true;

      const diff = entry.doc.updateSource(patch);
      const anim = entry.doc.animation;
      const animOut = (anim?.type && anim?.texture) ? {
        type: anim.type,
        texture: anim.texture,
        flip: Boolean(anim.flip),
        double: Boolean(anim.double),
        direction: anim.direction ?? 1,
        duration: anim.duration ?? 750,
        strength: anim.strength ?? 1
      } : null;
      const thresh = entry.doc.threshold;
      const threshOut = (thresh && (thresh.light || thresh.sight || thresh.sound))
        ? { light: thresh.light ?? null, sight: thresh.sight ?? null, sound: thresh.sound ?? null, attenuation: Boolean(thresh.attenuation) }
        : null;

      const prevDKey = entry.dKey;
      const dsEditedInDiff = Boolean(diff && "ds" in diff);
      const nextDefaultDs = entry.doc.door
        ? ((dsEditedInDiff || !prevDKey) ? (entry.doc.ds || 0) : (entry.defaultDs ?? 0))
        : 0;
      const nextLiveDs = entry.doc.door ? (entry.doc.ds || 0) : 0;

      const nextState = {
        c: entry.doc.c.map(v => Math.round(v)),
        move: entry.doc.move,
        sight: entry.doc.sight,
        light: entry.doc.light,
        sound: entry.doc.sound,
        dir: entry.doc.dir || 0,
        door: entry.doc.door || 0,
        ds: nextDefaultDs,
        doorSound: entry.doc.doorSound || "",
        threshold: threshOut,
        animation: animOut
      };

      entry.defaultDs = nextDefaultDs;
      entry.liveDs = nextLiveDs;
      entry.sig = this._wallSig({ levelId: entry.levelId, ...nextState }, nextLiveDs);

      // Update door-key index and doorStates/openDoors if wall was converted to/from a door or ds changed in WallConfig
      const nextIsDoor = Boolean(nextState.door > 0);
      const nextDKey = nextIsDoor
        ? (entry.kind === "w" ? `${entry.levelId}::${entry.sk}_w${entry.idx}` : `${entry.levelId}::${entry.sk}_${entry.idx}`)
        : null;
      if (prevDKey && prevDKey !== nextDKey) {
        if (this.mountedByDoorKey.get(prevDKey) === entry) this.mountedByDoorKey.delete(prevDKey);
        this.controller.openDoors.delete(prevDKey);
        this.controller.doorStates.delete(prevDKey);
        flagUpdate[`flags.${MODULE_ID}.doorStates.-=${prevDKey}`] = null;
      }
      entry.isDoor = nextIsDoor;
      entry.dKey = nextDKey;
      if (nextDKey) {
        this.mountedByDoorKey.set(nextDKey, entry);
        if (dsEditedInDiff) {
          this.controller.doorStates.set(nextDKey, nextLiveDs);
          if (nextLiveDs === 1) {
            const skParts = String(entry.sk || "").split("_");
            const eidStr = entry.kind === "w"
              ? `mw_${entry.levelId}_${entry.sk}_${entry.idx}`
              : `md_${nextDKey}`;
            this.controller.openDoors.set(nextDKey, {
              levelId: entry.levelId,
              sx: Number(skParts[0]) || 0,
              sy: Number(skParts[1]) || 0,
              eid: eidStr,
              x: (nextState.c[0] + nextState.c[2]) * 0.5,
              y: (nextState.c[1] + nextState.c[3]) * 0.5
            });
          } else {
            this.controller.openDoors.delete(nextDKey);
          }
          flagUpdate[`flags.${MODULE_ID}.doorStates.${nextDKey}`] = nextLiveDs;
        }
      }

      flagUpdate[`flags.${MODULE_ID}.wallEdits.${entry.levelId}.${entry.wKey}`] = nextState;
      this.controller.setVirtualWallEditLocal(entry.levelId, entry.wKey, nextState);
      entry.editsRev = this.controller.wallEditsRev || 0;

      if (entry.wall && !entry.wall.destroyed) {
        if (diff && !foundry.utils.isEmpty(diff)) {
          try {
            entry.wall._onUpdate(diff, operation, game.user?.id);
          } catch (err) {
            console.warn(`${MODULE_ID} | Wall#_onUpdate failed for virtual wall ${entry.wKey}:`, err);
          }
        }
        entry.wall.renderFlags.set({ refresh: true });
        entry.wall.applyRenderFlags();
        this._syncDoorMeshesElevation(entry.wall, entry.levelId);
        if (!this.active) entry.wall.visible = false;
        if (entry.wall.doorControl && !entry.wall.doorControl.destroyed) {
          const viewedLvlId = canvas?.level?.id;
          const onViewedLevel = !viewedLvlId || !entry.levelId || entry.levelId === viewedLvlId;
          entry.wall.doorControl.visible = onViewedLevel && (this._showDoorControls !== false) && entry.wall.doorControl.isVisible;
        }
        entry.wall._updateQuadtree?.();
      }
      if (diff && !foundry.utils.isEmpty(diff)) {
        this._syncOpenWallSheet(entry, diff, { syncDoorControl: ("door" in diff) || ("ds" in diff) });
      }
      updatedDocs.push(entry.doc);
    }

    if (doorOnlyUpdates.length === 1 || (doorOnlyUpdates.length > 1 && !game.user?.isGM)) {
      for (const d of doorOnlyUpdates) {
        this.controller.requestDoorState(d.entry.dKey, d.targetDs, { playSound: d.playSound });
      }
    } else if (doorOnlyUpdates.length > 1 && game.user?.isGM) {
      const doorFlagUpdate = {};
      const pendingKeys = [];
      this.controller._pendingDoorCommits ??= new Map();
      for (const d of doorOnlyUpdates) {
        const dKey = d.entry.dKey;
        const info = this.controller._resolveDoorByKey(dKey);
        if (!info) continue;
        const ds = this.controller._normalizeDoorState(d.targetDs, info.defaultDs);
        const seq = (this.controller._pendingDoorCommits.get(dKey) || 0) + 1;
        this.controller._pendingDoorCommits.set(dKey, seq);
        this.controller._applyDoorStateLocal(info, ds, {
          playSound: d.playSound,
          deferRefresh: true,
          skipDeferRebake: true
        });
        doorFlagUpdate[`flags.${MODULE_ID}.doorStates.${dKey}`] = ds;
        pendingKeys.push({ dKey, seq });
      }
      if (pendingKeys.length) {
        this.controller.updateSimAndLightBubbles(false);
        canvas.perception?.update({
          initializeVision: true,
          initializeLighting: true,
          initializeSounds: true,
          refreshLightSources: true,
          refreshLighting: true,
          refreshVision: true
        });
        scene.update(doorFlagUpdate)
          .catch((err) => {
            console.warn(`${MODULE_ID} | Failed to persist batched door state:`, err);
            let revertedAny = false;
            for (const { dKey, seq } of pendingKeys) {
              if (this.controller._pendingDoorCommits?.get?.(dKey) !== seq || !this.controller.active) continue;
              const info = this.controller._resolveDoorByKey(dKey);
              if (!info) continue;
              const persisted = scene.flags?.[MODULE_ID]?.doorStates?.[dKey];
              const revertDs = persisted !== undefined ? persisted : info.defaultDs;
              if (this.controller._applyDoorStateLocal(info, revertDs, { playSound: false, deferRefresh: true, skipDeferRebake: true })) {
                revertedAny = true;
              }
            }
            if (revertedAny) {
              this.controller.updateSimAndLightBubbles(false);
              canvas.perception?.update({
                initializeVision: true,
                initializeLighting: true,
                initializeSounds: true,
                refreshLightSources: true,
                refreshLighting: true,
                refreshVision: true
              });
            }
          })
          .finally(() => {
            for (const { dKey, seq } of pendingKeys) {
              if (this.controller._pendingDoorCommits?.get?.(dKey) === seq) {
                this.controller._pendingDoorCommits.delete(dKey);
              }
            }
          });
      }
    }

    if (hasGeometryOrConfigEdit && Object.keys(flagUpdate).length) {
      this.controller.applyVirtualWallChangesLocal();
      await scene.update(flagUpdate);
    }
    return updatedDocs;
  }

  async _commitVirtualDeletes(virtIds) {
    const scene = canvas.scene;
    if (!scene || !virtIds.length || !game.user?.isGM) return [];

    const flagUpdate = {};
    const deletedDocs = [];

    for (const id of virtIds) {
      const entry = this.mountedById.get(id);
      if (!entry) continue;
      flagUpdate[`flags.${MODULE_ID}.wallEdits.${entry.levelId}.${entry.wKey}`] = null;
      if (entry.dKey) {
        this.controller.openDoors.delete(entry.dKey);
        this.controller.doorStates.delete(entry.dKey);
        flagUpdate[`flags.${MODULE_ID}.doorStates.-=${entry.dKey}`] = null;
      }
      this.controller.setVirtualWallEditLocal(entry.levelId, entry.wKey, null);
      deletedDocs.push(entry.doc);
      this._removeMountedEntry(entry, { closeSheet: true });
    }

    if (deletedDocs.length && canvas.walls?.clipboard?.cut && canvas.walls.clipboard.objects?.length) {
      const deletedIdSet = new Set(virtIds);
      canvas.walls.clipboard.objects = canvas.walls.clipboard.objects.filter(
        o => !deletedIdSet.has(o.document?.id)
      );
    }

    if (Object.keys(flagUpdate).length) {
      this.controller.applyVirtualWallChangesLocal();
      await scene.update(flagUpdate);
    }
    return deletedDocs;
  }

  unmount() {
    this.active = false;
    this._lastKey = "";
    this._doorLayersCache = null;
    this._doorLayersCacheTag = "";
    this._clearMountedWalls();
    this._removePatches();
    if (this.macroGfx) {
      try { this.macroGfx.parent?.removeChild(this.macroGfx); } catch {}
      if (!this.macroGfx.destroyed) {
        try { this.macroGfx.destroy(); } catch {}
      }
      this.macroGfx = null;
    }
  }
}

export function registerWallEditorControls(controller) {
  Hooks.on("activateWallsLayer", () => {
    if (!controller.active) return;
    if (!controller.wallEditor._patches) controller.wallEditor.mount();
    controller.wallEditor.activate();
  });

  Hooks.on("deactivateWallsLayer", () => {
    controller.wallEditor.deactivate();
  });
}
