const MODULE_ID = "boundless";
const NATIVE_WALLS_MIN_SCALE = 0.22; // Stream all native Wall placeables when WallsLayer is active
const NATIVE_DOORS_MIN_SCALE = 0.28; // Stream native door Walls (DoorControl + DoorMesh) during gameplay
const MAX_NATIVE_WALLS_IN_VIEW = 420;

function makeVirtualWallId(levelId, wKey) {
  // Deterministic 16-char alphanumeric ID passing Foundry's strict document ID validation
  const input = `${levelId}|${wKey}`;
  let h1 = 0x811c9dc5;
  let h2 = 0x9e3779b9;
  for (let i = 0; i < input.length; i++) {
    const ch = input.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 0x01000193);
    h2 = Math.imul(h2 ^ (ch + i), 0x85ebca6b);
  }
  const p1 = (h1 >>> 0).toString(36).padStart(7, "0").slice(0, 7);
  const p2 = (h2 >>> 0).toString(36).padStart(7, "0").slice(0, 7);
  return `mm${p1}${p2}`;
}

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

    this._patches = { scene, wallsLayer, origUpdateEmbedded, origDeleteEmbedded, origWallsGet };

    wallsLayer.get = (objectId) => {
      const virt = this.mountedById.get(objectId);
      if (virt) return virt.wall;
      return origWallsGet.call(wallsLayer, objectId);
    };

    scene.updateEmbeddedDocuments = async (embeddedName, updates = [], operation = {}) => {
      if (embeddedName !== "Wall" || !this.mountedById.size || !Array.isArray(updates) || !updates.length) {
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

    scene.deleteEmbeddedDocuments = async (embeddedName, ids = [], operation = {}) => {
      if (embeddedName !== "Wall" || !this.mountedById.size || !Array.isArray(ids) || !ids.length) {
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
  }

  _removePatches() {
    if (!this._patches) return;
    const { scene, wallsLayer, origUpdateEmbedded, origDeleteEmbedded, origWallsGet } = this._patches;
    try {
      scene.updateEmbeddedDocuments = origUpdateEmbedded;
      scene.deleteEmbeddedDocuments = origDeleteEmbedded;
      wallsLayer.get = origWallsGet;
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
        this._removeMountedEntry(entry);
      } else if (entry.wall && !entry.wall.destroyed) {
        if (entry.wall.controlled) entry.wall.release({ broadcast: false });
        entry.wall.visible = false;
      }
    }
    this.syncViewport(true);
  }

  refreshDoorVisibility() {
    for (const entry of this.mountedByDoorKey.values()) {
      const dc = entry.wall?.doorControl;
      if (dc && !dc.destroyed) {
        dc.visible = dc.isVisible;
      }
    }
  }

  applyDoorStateToMounted(dKey, ds, { playSound = true } = {}) {
    const entry = this.mountedByDoorKey.get(dKey);
    if (!entry?.wall || entry.wall.destroyed) return;
    if (entry.doc.ds === ds) return;
    entry.doc.updateSource({ ds });
    entry.wall._onUpdate({ ds }, { sound: playSound }, game.user?.id);
    if (!this.active) entry.wall.visible = false;
    const dc = entry.wall.doorControl;
    if (dc && !dc.destroyed) dc.visible = dc.isVisible;
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

  _collectViewportSegments(vp, { doorsOnly = false } = {}) {
    const layer = this._getViewedLayer();
    if (!layer?.spec?.sectors) return [];

    const { simGrid, simSectorPx, spec, level } = layer;
    const lid = level.id;
    const sx0 = Math.max(0, Math.floor(vp.x0 / simSectorPx));
    const sy0 = Math.max(0, Math.floor(vp.y0 / simSectorPx));
    const sx1 = Math.min(simGrid - 1, Math.floor(vp.x1 / simSectorPx));
    const sy1 = Math.min(simGrid - 1, Math.floor(vp.y1 / simSectorPx));

    const pad = 250;
    const vx0 = vp.x0 - pad, vy0 = vp.y0 - pad, vx1 = vp.x1 + pad, vy1 = vp.y1 + pad;
    const levelEdits = this.controller.wallEdits.get(lid);
    const segments = [];

    for (let sy = sy0; sy <= sy1; sy++) {
      for (let sx = sx0; sx <= sx1; sx++) {
        const sk = `${sx}_${sy}`;
        const sec = spec.sectors[sk];
        if (!sec) continue;

        if (sec.d) {
          for (let di = 0; di < sec.d.length; di++) {
            const resolved = this.controller.resolveVirtualWall(lid, "d", sk, di, sec.d[di]);
            if (!resolved) continue;
            if (doorsOnly && !resolved.door) continue;
            const [x1, y1, x2, y2] = resolved.c;
            if ((x1 < vx0 && x2 < vx0) || (x1 > vx1 && x2 > vx1) ||
                (y1 < vy0 && y2 < vy0) || (y1 > vy1 && y2 > vy1)) continue;
            segments.push(resolved);
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
            if (doorsOnly && !resolved.door) continue;
            const [x1, y1, x2, y2] = resolved.c;
            if ((x1 < vx0 && x2 < vx0) || (x1 > vx1 && x2 > vx1) ||
                (y1 < vy0 && y2 < vy0) || (y1 > vy1 && y2 > vy1)) continue;
            segments.push(resolved);
          }
        }
      }
    }
    return segments;
  }

  _removeMountedEntry(entry) {
    if (!entry) return;
    const wallsLayer = canvas?.walls;
    const w = entry.wall;
    this.mountedByKey.delete(entry.wKey);
    this.mountedById.delete(entry.id);
    if (entry.dKey) this.mountedByDoorKey.delete(entry.dKey);
    if (!w) return;
    try {
      terminateWallDoorAnimations(w);
      if (w.controlled) w.release({ broadcast: false });
      wallsLayer?.quadtree?.remove(w);
      w.parent?.removeChild(w);
      if (!w.destroyed) w.destroy({ children: true });
    } catch {}
  }

  _clearMountedWalls() {
    this._clearGen++;
    for (const entry of Array.from(this.mountedByKey.values())) {
      this._removeMountedEntry(entry);
    }
    this.mountedByKey.clear();
    this.mountedById.clear();
    this.mountedByDoorKey.clear();
  }

  async _mountNativeWall(seg, gen) {
    if (gen !== this._clearGen || !canvas?.walls?.objects || !canvas.scene) return;
    if (this.mountedByKey.has(seg.wKey)) return;

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
      levels: [seg.levelId]
    };
    if (seg.doorSound) initData.doorSound = seg.doorSound;
    if (seg.threshold) initData.threshold = foundry.utils.deepClone(seg.threshold);
    if (seg.animation?.texture) initData.animation = foundry.utils.deepClone(seg.animation);

    const doc = new WallDocCls(initData, { parent: canvas.scene });
    doc._mmVirtualMeta = { id, wKey: seg.wKey, dKey, levelId: seg.levelId, kind: seg.kind, sk: seg.sk, idx: seg.idx };

    // Route direct DoorControl `doc.update({ ds })`, WallConfig `doc.update(...)`, and `doc.delete()`
    doc.update = async (data = {}, options = {}) => {
      const res = await this._commitVirtualUpdates([{ ...data, _id: id }], options);
      return res[0] || doc;
    };
    doc.delete = async () => {
      const res = await this._commitVirtualDeletes([id]);
      return res[0] || doc;
    };

    const wall = canvas.walls.createObject(doc);
    // Bypass v14 ui.placeables sidebar filter so streamed native walls & doors render cleanly
    Object.defineProperty(wall, "isFilteredOut", { value: false, configurable: true });

    const entry = {
      id,
      wKey: seg.wKey,
      dKey,
      levelId: seg.levelId,
      kind: seg.kind,
      sk: seg.sk,
      idx: seg.idx,
      isDoor: Boolean(seg.door > 0),
      wall,
      doc
    };
    this.mountedByKey.set(seg.wKey, entry);
    this.mountedById.set(id, entry);
    if (dKey) this.mountedByDoorKey.set(dKey, entry);

    canvas.walls.objects.addChild(wall);
    wall.renderFlags.clear();
    await wall.draw();

    if (gen !== this._clearGen || !this.mountedById.has(id)) {
      this._removeMountedEntry(entry);
      return;
    }

    wall.renderFlags.set({ refresh: true });
    wall.applyRenderFlags();
    // When WallsLayer is inactive, hide wall edit lines (DoorControl & DoorMesh live on their own layers!)
    if (!this.active) wall.visible = false;
    if (wall.doorControl && !wall.doorControl.destroyed) {
      wall.doorControl.visible = wall.doorControl.isVisible;
    }
    canvas.walls.quadtree?.insert({ r: wall.bounds, t: wall });
  }

  _drawMacroOverview(segments, scale) {
    if (!this.macroGfx) return;
    const g = this.macroGfx;
    g.clear();
    g.visible = true;
    if (!segments.length) return;

    const lw = Math.max(2, Math.min(28, 2.6 / Math.max(0.01, scale)));
    const byColor = new Map();
    for (const seg of segments) {
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
      for (const seg of list) {
        const [x1, y1, x2, y2] = seg.c;
        g.moveTo(x1, y1);
        g.lineTo(x2, y2);
      }
    }
  }

  syncViewport(force = false, vp = null) {
    if (!this.controller?.active || !canvas?.walls) return;
    if (force) this._lastKey = "";

    const curVp = vp || this.controller.getViewportWorldRect(0.18);
    const layer = this._getViewedLayer();
    if (!layer?.spec?.sectors) {
      this._clearMountedWalls();
      if (this.macroGfx) { this.macroGfx.clear(); this.macroGfx.visible = false; }
      return;
    }

    const isWallsEditMode = this.active && Boolean(game.user?.isGM);
    const minScale = isWallsEditMode ? NATIVE_WALLS_MIN_SCALE : NATIVE_DOORS_MIN_SCALE;
    const inNativeZoom = curVp.scale >= minScale;

    const { simGrid, simSectorPx } = layer;
    const sx0 = Math.max(0, Math.floor(curVp.x0 / simSectorPx));
    const sy0 = Math.max(0, Math.floor(curVp.y0 / simSectorPx));
    const sx1 = Math.min(simGrid - 1, Math.floor(curVp.x1 / simSectorPx));
    const sy1 = Math.min(simGrid - 1, Math.floor(curVp.y1 / simSectorPx));

    const rev = this.controller.wallEditsRev || 0;
    const key = `${layer.level.id}:${sx0}_${sy0}_${sx1}_${sy1}:m${isWallsEditMode ? 1 : 0}:n${inNativeZoom ? 1 : 0}:r${rev}`;
    if (key === this._lastKey) return;
    this._lastKey = key;

    // Gameplay mode zoomed out (< 0.28): unmount all doors for 0 overhead on macro map
    if (!isWallsEditMode && !inNativeZoom) {
      this._clearMountedWalls();
      if (this.macroGfx) { this.macroGfx.clear(); this.macroGfx.visible = false; }
      return;
    }

    const segments = this._collectViewportSegments(curVp, { doorsOnly: !isWallsEditMode });

    // WallsLayer zoomed way out or ultra-dense block: show lightweight macro overview
    if (isWallsEditMode && (!inNativeZoom || segments.length > MAX_NATIVE_WALLS_IN_VIEW)) {
      this._clearMountedWalls();
      this._drawMacroOverview(segments, curVp.scale);
      return;
    }

    if (this.macroGfx) {
      this.macroGfx.clear();
      this.macroGfx.visible = false;
    }

    const needed = new Map();
    for (const seg of segments) needed.set(seg.wKey, seg);

    // Unmount walls/doors that panned out of view (keep controlled walls alive during a drag!)
    for (const entry of Array.from(this.mountedByKey.values())) {
      if (!needed.has(entry.wKey) && !entry.wall?.controlled) {
        this._removeMountedEntry(entry);
      }
    }

    const gen = this._clearGen;
    for (const seg of needed.values()) {
      if (!this.mountedByKey.has(seg.wKey)) {
        this._mountNativeWall(seg, gen);
      }
    }
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

      // Fast-path: DoorControl click (left-click open/close or right-click lock/unlock)
      if (isDoorStateOnly) {
        const targetDs = Number(patch.ds);
        const playSound = operation?.sound !== false;
        this.controller.requestDoorState(entry.dKey, targetDs, { playSound });
        updatedDocs.push(entry.doc);
        continue;
      }

      // GM-only wall geometry / configuration edit via WallsLayer or WallConfig
      if (!game.user?.isGM) continue;
      hasGeometryOrConfigEdit = true;

      entry.doc.updateSource(patch);
      const anim = entry.doc.animation;
      const animOut = anim?.texture ? {
        type: anim.type || "swing",
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

      const nextState = {
        c: entry.doc.c.map(v => Math.round(v)),
        move: entry.doc.move,
        sight: entry.doc.sight,
        light: entry.doc.light,
        sound: entry.doc.sound,
        dir: entry.doc.dir || 0,
        door: entry.doc.door || 0,
        ds: entry.doc.ds || 0,
        doorSound: entry.doc.doorSound || "",
        threshold: threshOut,
        animation: animOut
      };

      // Update door-key index if wall was converted to/from a door
      const prevDKey = entry.dKey;
      const nextIsDoor = Boolean(nextState.door > 0);
      const nextDKey = nextIsDoor
        ? (entry.kind === "w" ? `${entry.levelId}::${entry.sk}_w${entry.idx}` : `${entry.levelId}::${entry.sk}_${entry.idx}`)
        : null;
      if (prevDKey && prevDKey !== nextDKey) this.mountedByDoorKey.delete(prevDKey);
      entry.isDoor = nextIsDoor;
      entry.dKey = nextDKey;
      if (nextDKey) this.mountedByDoorKey.set(nextDKey, entry);

      flagUpdate[`flags.${MODULE_ID}.wallEdits.${entry.levelId}.${entry.wKey}`] = nextState;
      this.controller.setVirtualWallEditLocal(entry.levelId, entry.wKey, nextState);

      if (entry.wall && !entry.wall.destroyed) {
        entry.wall._onUpdate(patch, operation, game.user?.id);
        entry.wall.renderFlags.set({ refresh: true });
        entry.wall.applyRenderFlags();
        if (!this.active) entry.wall.visible = false;
        canvas.walls?.quadtree?.remove(entry.wall);
        canvas.walls?.quadtree?.insert({ r: entry.wall.bounds, t: entry.wall });
      }
      updatedDocs.push(entry.doc);
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
      this.controller.setVirtualWallEditLocal(entry.levelId, entry.wKey, null);
      deletedDocs.push(entry.doc);
      this._removeMountedEntry(entry);
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
    this._clearMountedWalls();
    this._removePatches();
    if (this.macroGfx) {
      this.macroGfx.parent?.removeChild(this.macroGfx);
      this.macroGfx.destroy();
      this.macroGfx = null;
    }
  }
}

export function registerWallEditorControls(controller) {
  Hooks.on("activateWallsLayer", () => {
    if (!controller.active) return;
    controller.wallEditor.activate();
  });

  Hooks.on("deactivateWallsLayer", () => {
    controller.wallEditor.deactivate();
  });
}
