import { extractLightStyle } from "./light-batch.mjs";
import { bakeSceneToBoundless, bakeSceneEditsToManifest, unbakeSceneFromBoundless } from "./scene-baker.mjs";
import {
  MODULE_ID,
  getLevelBaseElevation
} from "./utils.mjs";

export const editsMethods = {
  _loadWallEdits(scene) {
    this.wallEdits.clear();
    const raw = scene?.flags?.[MODULE_ID]?.wallEdits;
    if (raw && typeof raw === "object") {
      for (const [lid, mapObj] of Object.entries(raw)) {
        if (!mapObj || typeof mapObj !== "object") continue;
        const levelMap = new Map();
        for (const [wKey, val] of Object.entries(mapObj)) {
          if (val === null) {
            levelMap.set(wKey, null);
          } else if (
            val && typeof val === "object" &&
            Array.isArray(val.c) && val.c.length === 4 && val.c.every(Number.isFinite)
          ) {
            levelMap.set(wKey, val);
          }
        }
        if (levelMap.size) this.wallEdits.set(lid, levelMap);
      }
    }
    this.wallEditsRev++;
  },

  resolveVirtualWall(levelId, kind, sk, idx, raw) {
    const wKey = `${sk}:${kind}:${idx}`;
    const levelMap = this.wallEdits.get(levelId);
    if (levelMap && levelMap.has(wKey)) {
      const ov = levelMap.get(wKey);
      if (ov === null) return null; // Deleted by GM
      return {
        kind,
        levelId,
        sk,
        idx,
        wKey,
        c: ov.c,
        move: ov.move ?? 20,
        sight: ov.sight ?? 20,
        light: ov.light ?? 20,
        sound: ov.sound ?? 20,
        dir: ov.dir || 0,
        door: ov.door || 0,
        ds: ov.ds || 0,
        doorSound: ov.doorSound || "",
        threshold: ov.threshold || null,
        animation: (ov.animation?.type && ov.animation?.texture) ? ov.animation : null
      };
    }
    if (!raw) return null;
    if (kind === "d") {
      const [x1, y1, x2, y2, doorType, defaultDs, extra] = raw;
      return {
        kind: "d",
        levelId,
        sk,
        idx,
        wKey,
        c: [x1, y1, x2, y2],
        move: extra?.move ?? 20,
        sight: extra?.sight ?? 20,
        light: extra?.light ?? 20,
        sound: extra?.sound ?? 20,
        dir: extra?.dir || 0,
        door: doorType || 1,
        ds: defaultDs || 0,
        doorSound: extra?.doorSound || "",
        threshold: extra?.threshold || null,
        animation: (extra?.animation?.type && extra?.animation?.texture) ? extra.animation : null
      };
    }
    const [x1, y1, x2, y2, move, sight, light, sound, dir, extra] = raw;
    return {
      kind: "w",
      levelId,
      sk,
      idx,
      wKey,
      c: [x1, y1, x2, y2],
      move: move ?? 20,
      sight: sight ?? 20,
      light: light ?? 20,
      sound: sound ?? 20,
      dir: dir || 0,
      door: 0,
      ds: 0,
      doorSound: "",
      threshold: extra?.threshold || null,
      animation: null
    };
  },

  setVirtualWallEditLocal(levelId, wKey, value) {
    let levelMap = this.wallEdits.get(levelId);
    if (!levelMap) {
      levelMap = new Map();
      this.wallEdits.set(levelId, levelMap);
    }
    levelMap.set(wKey, value);
    this.wallEditsRev++;
  },

  applyVirtualWallChangesLocal() {
    for (const [, data] of this.simSectors) {
      if (data.level?.edges) {
        for (const eid of data.edgeIds) data.level.edges.delete(eid);
      }
    }
    this.simSectors.clear();
    this.lastSimKey = "";

    // Revalidate tracked doors in openDoors & doorStates after wall/door edits (removals, wall conversions, coordinate moves).
    // Preserve doorStates for doors on non-visible levels or currently unloaded chunks so LRU eviction never wipes persisted state!
    for (const dKey of Array.from(new Set([...this.openDoors.keys(), ...this.doorStates.keys()]))) {
      const info = this._resolveDoorByKey(dKey);
      if (!info) {
        let sectorLoaded = false;
        if (typeof dKey === "string") {
          const sep = dKey.indexOf("::");
          if (sep > 0) {
            const lid = dKey.slice(0, sep);
            const parts = dKey.slice(sep + 2).split("_");
            const layer = this.levelLayers.get(lid);
            if (layer && parts.length === 3 && layer.spec?.sectors?.[`${parts[0]}_${parts[1]}`]) {
              sectorLoaded = true;
            }
          }
        }
        this._clearClosingDoorTimer?.(dKey);
        this.openDoors.delete(dKey);
        if (sectorLoaded) this.doorStates.delete(dKey);
        continue;
      }
      const curDs = this.getCurrentDoorState(dKey, info.defaultDs);
      if ((curDs === 1) !== (info.defaultDs === 1)) {
        const dx = (info.ptA.x + info.ptB.x) * 0.5;
        const dy = (info.ptA.y + info.ptB.y) * 0.5;
        this.openDoors.set(dKey, { levelId: info.levelId, x: dx, y: dy, sx: info.sx, sy: info.sy, eid: info.eid });
      } else {
        this.openDoors.delete(dKey);
      }
    }

    this.updateSimAndLightBubbles(true);
    this.wallEditor.syncViewport(true);
    this.scheduleLightBatchRebuild();
  },

  _loadGenericEdits(scene, flagName, targetMap) {
    targetMap.clear();
    const raw = scene?.flags?.[MODULE_ID]?.[flagName];
    const isTile = flagName === "tileEdits";
    if (raw && typeof raw === "object") {
      for (const [lid, mapObj] of Object.entries(raw)) {
        if (!mapObj || typeof mapObj !== "object") continue;
        const levelMap = new Map();
        for (const [k, val] of Object.entries(mapObj)) {
          if (val === null) {
            levelMap.set(k, null);
          } else if (val && typeof val === "object") {
            if (!Number.isFinite(val.x) || !Number.isFinite(val.y)) continue;
            if (isTile && (!Number.isFinite(val.w) || val.w <= 0 || !Number.isFinite(val.h) || val.h <= 0)) continue;
            levelMap.set(k, val);
          }
        }
        if (levelMap.size) targetMap.set(lid, levelMap);
      }
    }
  },

  _loadLightEdits(scene) {
    this._loadGenericEdits(scene, "lightEdits", this.lightEdits);
    this.lightEditsRev++;
  },

  _loadSoundEdits(scene) {
    this._loadGenericEdits(scene, "soundEdits", this.soundEdits);
    this.soundEditsRev++;
  },

  _loadTileEdits(scene) {
    this._loadGenericEdits(scene, "tileEdits", this.tileEdits);
    this.tileEditsRev++;
  },

  resolveVirtualLight(levelId, sk, idx, raw, level = null) {
    const lKey = `${sk}:l:${idx}`;
    const defaultElev = getLevelBaseElevation(level) + 6;
    const levelMap = this.lightEdits.get(levelId);
    if (levelMap && levelMap.has(lKey)) {
      const ov = levelMap.get(lKey);
      if (ov === null) return null;
      return {
        levelId, sk, idx, lKey,
        x: ov.x, y: ov.y,
        dim: ov.dim ?? 0, bright: ov.bright ?? 0,
        color: ov.color ?? null, alpha: ov.alpha ?? 0.5,
        anim: ov.anim || "",
        elevation: Number.isFinite(ov.elevation) ? ov.elevation : defaultElev,
        hidden: Boolean(ov.hidden),
        walls: ov.walls !== false,
        angle: ov.angle ?? 360,
        rotation: ov.rotation ?? 0,
        darkMin: ov.darkMin ?? 0,
        darkMax: ov.darkMax ?? 1,
        ...extractLightStyle(ov)
      };
    }
    if (!raw) return null;
    const [x, y, dim, bright, color, alpha, anim, customElev, extra] = raw;
    const ex = extra && typeof extra === "object" ? extra : null;
    if (!ex) {
      return {
        levelId, sk, idx, lKey,
        x, y, dim: dim || 0, bright: bright || 0,
        color: color ?? null, alpha: alpha ?? 0.5, anim: anim || "",
        elevation: Number.isFinite(customElev) ? customElev : defaultElev,
        hidden: false, walls: true, angle: 360, rotation: 0, darkMin: 0, darkMax: 1,
        speed: 3, intensity: 3, attenuation: 0.5, luminosity: 0.5, coloration: null
      };
    }
    return {
      levelId, sk, idx, lKey,
      x, y, dim: dim || 0, bright: bright || 0,
      color: color ?? null, alpha: alpha ?? 0.5, anim: anim || "",
      elevation: Number.isFinite(customElev) ? customElev : defaultElev,
      hidden: Boolean(ex.hidden),
      walls: ex.walls !== false,
      angle: ex.angle ?? 360,
      rotation: ex.rotation ?? 0,
      darkMin: ex.darkMin ?? 0,
      darkMax: ex.darkMax ?? 1,
      ...extractLightStyle(ex)
    };
  },

  setVirtualLightEditLocal(levelId, lKey, value) {
    let m = this.lightEdits.get(levelId);
    if (!m) { m = new Map(); this.lightEdits.set(levelId, m); }
    m.set(lKey, value);
    this.lightEditsRev++;
  },

  applyVirtualLightChangesLocal() {
    for (const [lid, ls] of this.dynamicLights) {
      this._emit("dynamicLightRetire", { id: lid, light: ls, meta: this.lightBatch.lightMetaById.get(lid) || null });
      if (ls && !ls.destroyed) {
        try { ls.destroy(); } catch {}
      }
    }
    this.dynamicLights.clear();
    this.lastDynLightKey = "";
    // scheduleLightBatchRebuild runs updateSimAndLightBubbles(true) strictly AFTER rebuilding lightMetaById
    this.scheduleLightBatchRebuild();
    this.layerEditors.syncLighting(true);
  },

  resolveVirtualSound(levelId, sk, idx, raw, level = null) {
    const sKey = `${sk}:s:${idx}`;
    const defaultElev = getLevelBaseElevation(level) + 5;
    const levelMap = this.soundEdits.get(levelId);
    if (levelMap && levelMap.has(sKey)) {
      const ov = levelMap.get(sKey);
      if (ov === null) return null;
      return {
        levelId, sk, idx, sKey,
        x: ov.x, y: ov.y, radius: ov.radius ?? 20, path: ov.path || "",
        volume: ov.volume ?? 0.6, walls: ov.walls !== false, easing: ov.easing !== false,
        darkMin: ov.darkMin ?? 0, darkMax: ov.darkMax ?? 1,
        elevation: Number.isFinite(ov.elevation) ? ov.elevation : defaultElev,
        hidden: Boolean(ov.hidden)
      };
    }
    if (!raw) return null;
    const [x, y, radius, path, volume, walls, easing, darkMin, darkMax, customElev, extra] = raw;
    const ex = extra && typeof extra === "object" ? extra : null;
    return {
      levelId, sk, idx, sKey,
      x, y, radius: Number.isFinite(radius) ? radius : 20, path: path || "",
      volume: volume ?? 0.6, walls: walls !== false, easing: easing !== false,
      darkMin: darkMin ?? 0, darkMax: darkMax ?? 1,
      elevation: Number.isFinite(customElev) ? customElev : defaultElev,
      hidden: Boolean(ex?.hidden)
    };
  },

  setVirtualSoundEditLocal(levelId, sKey, value) {
    let m = this.soundEdits.get(levelId);
    if (!m) { m = new Map(); this.soundEdits.set(levelId, m); }
    m.set(sKey, value);
    this.soundEditsRev++;
  },

  applyVirtualSoundChangesLocal() {
    this.audioStreamer.lastKey = null;
    this.audioStreamer.update(
      this.visibleLevelLayers,
      this.getViewportWorldRect(0.28),
      (lid, sk, idx, raw, lvl) => this.resolveVirtualSound(lid, sk, idx, raw, lvl)
    );
    this.layerEditors.syncSounds(true);
  },

  resolveVirtualTile(levelId, tid, raw, level = null) {
    const tKey = `t:${tid}`;
    const defaultElev = getLevelBaseElevation(level);
    const levelMap = this.tileEdits.get(levelId);
    if (levelMap && levelMap.has(tKey)) {
      const ov = levelMap.get(tKey);
      if (ov === null) return null;
      // Preserve non-editable Boundless tile metadata from raw spec (without re-injecting raw.anchorX/anchorY)
      const preserved = {};
      if (raw && typeof raw === "object") {
        for (const k of ["minZ", "maxZ", "sortLayer", "hoverFade", "surfaceMode", "walkable", "gid"]) {
          if (raw[k] !== undefined) preserved[k] = raw[k];
        }
      }
      return { levelId, tid, tKey, ...preserved, ...ov, elevation: Number.isFinite(ov.elevation) ? ov.elevation : defaultElev };
    }
    if (!raw) return null;
    return { levelId, tid, tKey, ...raw, elevation: Number.isFinite(raw.elevation) ? raw.elevation : defaultElev };
  },

  setVirtualTileEditLocal(levelId, tKey, value) {
    let m = this.tileEdits.get(levelId);
    if (!m) { m = new Map(); this.tileEdits.set(levelId, m); }
    m.set(tKey, value);
    this.tileEditsRev++;
  },

  setVirtualTilesVisible(visible) {
    const v = Boolean(visible);
    for (const vt of this.activeVirtualTiles.values()) {
      if (vt?.mesh && !vt.mesh.destroyed) vt.mesh.visible = v;
    }
  },

  applyVirtualTileChangesLocal() {
    for (const [fullId, vt] of this.activeVirtualTiles) {
      this._emit("virtualTileRetire", { key: fullId, vt, mesh: vt.mesh });
      if (vt.mesh) this.retireMesh(vt.mesh);
    }
    this.activeVirtualTiles.clear();
    this._trackedOccVirtualTiles?.clear();
    this.virtualTilePending.clear();
    this.pendingVirtualTileMounts = [];
    this._pendingVirtualTileKeys.clear();
    for (const layer of this.visibleLevelLayers) layer.lastTileKey = "";
    this.updatePyramid();
    this.layerEditors.syncTiles(true);
    this._occlusionDirty = true;
    this._markDepthDirty({ syncElev: true });
  },

  onSceneUpdate(scene, changes, userId = null) {
    if (scene?.id && this._suppressAutoMountCounts?.get?.(scene.id) > 0) return;
    if (!globalThis.canvas?.ready || scene?.id !== globalThis.canvas.scene?.id) return;

    const isForcedDel = (v) => Boolean(globalThis.foundry?.data?.operators?.ForcedDeletion && v instanceof foundry.data.operators.ForcedDeletion);
    const flagChanges = changes?.flags?.[MODULE_ID];
    const flagDeleted = Boolean(
      (changes?.flags && (`-=${MODULE_ID}` in changes.flags)) ||
      flagChanges === null ||
      isForcedDel(flagChanges)
    );

    const hasManifestRev = Boolean(flagChanges && typeof flagChanges === "object" && "manifestRev" in flagChanges);
    // Handle enabling/disabling or manifest changes even when controller is currently inactive
    if (flagDeleted || (flagChanges && typeof flagChanges === "object" && (
      "enabled" in flagChanges || "-=enabled" in flagChanges ||
      "manifestUrl" in flagChanges || "-=manifestUrl" in flagChanges ||
      "levelId" in flagChanges || "-=levelId" in flagChanges ||
      hasManifestRev
    ))) {
      if (hasManifestRev) {
        const sceneUrl = scene?.flags?.[MODULE_ID]?.manifestUrl;
        if (sceneUrl) this.manifestCache?.delete?.(sceneUrl);
        for (const l of scene?.levels || []) {
          const lu = l?.flags?.[MODULE_ID]?.manifestUrl;
          if (lu) this.manifestCache?.delete?.(lu);
        }
        this.lightBatch?.clearPolyCacheDB?.(scene.id, game.world?.id)?.catch?.(() => {});
      }
      this.mount(scene);
      return;
    }

    if (this._mounting) {
      this._pendingSceneUpdates ??= [];
      if (this._pendingSceneUpdates.length < 32) {
        this._pendingSceneUpdates.push({ changes, userId });
      }
      return;
    }

    if (!this.active) return;

    // React to native Foundry v14 Scene fog mode (DISABLED / INDIVIDUAL / SHARED) & tokenVision changes
    if (changes?.fog || "tokenVision" in (changes || {})) {
      this.fogManager.mount(scene);
      this.tokenStreamer.onVisibilityChanged();
    }

    if (!flagChanges || typeof flagChanges !== "object") return;

    if ("wallEdits" in flagChanges || "-=wallEdits" in flagChanges) {
      this._loadWallEdits(scene);
      this.applyVirtualWallChangesLocal();
    }

    if ("lightEdits" in flagChanges || "-=lightEdits" in flagChanges) {
      this._loadLightEdits(scene);
      this.applyVirtualLightChangesLocal();
    }

    if ("soundEdits" in flagChanges || "-=soundEdits" in flagChanges) {
      this._loadSoundEdits(scene);
      this.applyVirtualSoundChangesLocal();
    }

    if ("tileEdits" in flagChanges || "-=tileEdits" in flagChanges) {
      this._loadTileEdits(scene);
      this.applyVirtualTileChangesLocal();
    }

    if ("-=doorStates" in flagChanges || flagChanges.doorStates === null || isForcedDel(flagChanges.doorStates)) {
      const prevKeys = Array.from(this.doorStates.keys());
      let anyDoorChanged = false;
      // Keep this.doorStates intact while reverting so _applyDoorStateLocal sees curDs !== defaultDs
      for (const dKey of prevKeys) {
        this._clearClosingDoorTimer?.(dKey);
        const info = this._resolveDoorByKey(dKey);
        if (info && this._applyDoorStateLocal(info, info.defaultDs, { playSound: false, deferRefresh: true, skipDeferRebake: true })) {
          anyDoorChanged = true;
        }
        this._clearClosingDoorTimer?.(dKey);
      }
      this.doorStates.clear();
      this.openDoors.clear();
      this._restoreDoorStates(scene);
      if (anyDoorChanged) {
        this.updateSimAndLightBubbles(false);
        canvas.perception?.update({
          initializeVision: true,
          initializeLighting: true,
          initializeSounds: true,
          refreshLightSources: true,
          refreshLighting: true,
          refreshVision: true
        });
      }
    } else if (flagChanges.doorStates && typeof flagChanges.doorStates === "object") {
      const entries = Object.entries(flagChanges.doorStates);
      const batchMode = entries.length > 1;
      let anyDoorChanged = false;
      for (const [rawKey, rawVal] of entries) {
        if (rawKey.startsWith("-=") || rawVal === null || isForcedDel(rawVal)) {
          const dKey = rawKey.startsWith("-=") ? rawKey.slice(2) : rawKey;
          this._clearClosingDoorTimer?.(dKey);
          const info = this._resolveDoorByKey(dKey);
          if (info && this._applyDoorStateLocal(info, info.defaultDs, { playSound: false, deferRefresh: batchMode, skipDeferRebake: true })) {
            anyDoorChanged = true;
          }
          this._clearClosingDoorTimer?.(dKey);
          this.doorStates.delete(dKey);
          this.openDoors.delete(dKey);
          if (!batchMode && anyDoorChanged) this.updateSimAndLightBubbles(false);
        } else {
          // Ignore stale server echoes from an earlier rapid toggle while a newer local GM commit is still in flight
          if (this._pendingDoorCommits?.has?.(rawKey)) continue;
          const info = this._resolveDoorByKey(rawKey);
          if (info) {
            if (this._applyDoorStateLocal(info, rawVal, { playSound: !batchMode, deferRefresh: batchMode })) {
              anyDoorChanged = true;
            }
          } else {
            this.doorStates.set(rawKey, this._normalizeDoorState(rawVal, 0));
          }
        }
      }
      if (batchMode && anyDoorChanged) {
        this.updateSimAndLightBubbles(false);
        canvas.perception?.update({
          initializeVision: true,
          initializeLighting: true,
          initializeSounds: true,
          refreshLightSources: true,
          refreshLighting: true,
          refreshVision: true
        });
      }
    }

    if ("pois" in flagChanges || "-=pois" in flagChanges || "showPois" in flagChanges || "-=showPois" in flagChanges || "showSubPois" in flagChanges || "-=showSubPois" in flagChanges) {
      const showPois = scene?.flags?.[MODULE_ID]?.showPois !== false;
      if (showPois && !this.poiManager.container) {
        this.poiManager.mount(scene, this.manifest);
      } else {
        this.poiManager.rebuild(scene, this.manifest);
      }
    }

    if ("showCharacterPins" in flagChanges || "-=showCharacterPins" in flagChanges) {
      const showPins = scene?.flags?.[MODULE_ID]?.showCharacterPins !== false;
      if (showPins && !this.charPins.container) {
        this.charPins.mount(scene);
      } else {
        this.charPins.rebuild(scene);
      }
    }

    if ("chunkedFog" in flagChanges || "-=chunkedFog" in flagChanges) {
      this.fogManager.mount(scene);
    } else {
      if ("sharedFog" in flagChanges || "-=sharedFog" in flagChanges) {
        this.fogManager.onSceneFogFlagsChanged(scene, isForcedDel(flagChanges.sharedFog) ? null : (flagChanges.sharedFog ?? null), userId);
      }
      if (flagChanges.fogResetAt && typeof flagChanges.fogResetAt === "object" && !isForcedDel(flagChanges.fogResetAt)) {
        this.fogManager.onSceneFogResetChanged(scene, flagChanges.fogResetAt);
      }
      if (flagChanges.fogBrush && typeof flagChanges.fogBrush === "object" && !isForcedDel(flagChanges.fogBrush)) {
        this.fogManager.onSceneFogBrushChanged(scene, flagChanges.fogBrush);
      }
    }

    if ("virtualizeTokens" in flagChanges || "-=virtualizeTokens" in flagChanges) {
      this.tokenStreamer.mount(scene);
      this.tokenStreamer.scheduleSync(this.getViewportWorldRect(0.28), true);
    }
  },

  // ===== Public Level, POI & Virtual Tile API =====

  getEffectivePOIs(scene = canvas.scene) {
    if (!scene) return [];
    const mUrl = scene.flags?.[MODULE_ID]?.manifestUrl;
    const manifest = scene.id === canvas.scene?.id
      ? this.manifest
      : (mUrl ? (this.manifestCache?.get?.(mUrl) ?? null) : null);
    const resolved = this.poiManager.resolvePois(scene, manifest);
    return foundry.utils.deepClone(resolved || []);
  },

  _sanitizePoisForSave(pois) {
    return (pois || []).map(p => {
      const clean = { ...p };
      if (clean._origKind !== undefined) clean.kind = clean._origKind;
      delete clean._origKind;
      delete clean._isSecondaryProvince;
      delete clean._virtualSub;
      return clean;
    });
  },

  async addPOI(poiSpec = {}, scene = canvas.scene) {
    if (!scene || !game.user?.isGM) return null;
    const spec = poiSpec && typeof poiSpec === "object" ? poiSpec : {};
    const existing = this._sanitizePoisForSave(this.getEffectivePOIs(scene));
    const kind = spec.kind === "detail" ? "detail" : (spec.kind === "minor" ? "minor" : "major");
    const dims = scene.getDimensions?.();
    const defaultCx = (dims?.sceneX ?? 0) + (dims?.sceneWidth ?? scene.width ?? 100000) * 0.5;
    const defaultCy = (dims?.sceneY ?? 0) + (dims?.sceneHeight ?? scene.height ?? 100000) * 0.5;
    const toFiniteCoord = (v) => (v !== null && v !== undefined && v !== "" && typeof v !== "boolean" && Number.isFinite(Number(v))) ? Number(v) : NaN;
    const rawX = toFiniteCoord(spec.x);
    const rawY = toFiniteCoord(spec.y);
    const entry = {
      id: spec.id || foundry.utils.randomID(),
      name: spec.name || game.i18n.localize("BOUNDLESS.Config.PoiDefaultName"),
      subtitle: spec.subtitle || "",
      x: Math.round(Number.isFinite(rawX) ? rawX : defaultCx),
      y: Math.round(Number.isFinite(rawY) ? rawY : defaultCy),
      levelId: spec.levelId || null,
      targetScale: Number(spec.targetScale ?? spec.scale) || (kind === "major" ? 0.085 : (kind === "detail" ? 0.68 : 0.26)),
      color: spec.color || "#f5c96b",
      kind,
      icon: spec.icon || "",
      journalUuid: spec.journalUuid || "",
      hidden: Boolean(spec.hidden)
    };
    existing.push(entry);
    await scene.update({ [`flags.${MODULE_ID}.pois`]: existing });
    return entry;
  },

  async updatePOI(poiId, patch, scene = canvas.scene) {
    if (!scene || !poiId || !patch || typeof patch !== "object" || !game.user?.isGM) return null;
    const existing = this._sanitizePoisForSave(this.getEffectivePOIs(scene));
    const idx = existing.findIndex(p => p.id === poiId);
    if (idx < 0) return null;
    const updated = { ...existing[idx], ...patch, id: poiId };
    delete updated._origKind;
    delete updated._isSecondaryProvince;
    delete updated._virtualSub;
    const toFiniteCoord = (v) => (v !== null && v !== undefined && v !== "" && typeof v !== "boolean" && Number.isFinite(Number(v))) ? Number(v) : NaN;
    if ("x" in patch) {
      const nx = toFiniteCoord(patch.x);
      if (Number.isFinite(nx)) updated.x = Math.round(nx);
      else updated.x = existing[idx].x;
    }
    if ("y" in patch) {
      const ny = toFiniteCoord(patch.y);
      if (Number.isFinite(ny)) updated.y = Math.round(ny);
      else updated.y = existing[idx].y;
    }
    if ("targetScale" in patch) {
      updated.targetScale = Number(patch.targetScale) || 0.45;
      delete updated.scale;
    }
    existing[idx] = updated;
    await scene.update({ [`flags.${MODULE_ID}.pois`]: existing });
    return updated;
  },

  async removePOI(poiId, scene = canvas.scene) {
    if (!scene || !poiId || !game.user?.isGM) return false;
    const existing = this._sanitizePoisForSave(this.getEffectivePOIs(scene)).filter(p => p.id !== poiId);
    await scene.update({ [`flags.${MODULE_ID}.pois`]: existing });
    return true;
  },

  async resetPOIs(scene = canvas.scene) {
    if (!scene || !game.user?.isGM) return false;
    await scene.update({ [`flags.${MODULE_ID}.-=pois`]: null });
    return true;
  },

  async flyToCharacter(userOrActorId = null, options = {}) {
    if (!this.active || this._mounting || !canvas?.ready) return false;
    return this.charPins.focusCharacter(userOrActorId, options);
  },

  async flyTo(target, options = {}) {
    if (!this.active || this._mounting || !canvas?.ready) return false;
    let poi = target;
    if (typeof target === "string") {
      const needle = target.trim().toLowerCase();
      const isGM = Boolean(game.user?.isGM);
      const all = (this.poiManager.resolvePois(canvas.scene, this.manifest) || []).filter(p => isGM || !p?.hidden);
      poi = all.find(p => p.id === target || p.name?.toLowerCase() === needle)
        || all.find(p => p.name?.toLowerCase().includes(needle));
    }
    if (!poi || (poi.hidden && !game.user?.isGM)) return false;
    return this.poiManager.flyTo(poi, options);
  },

  getVisibleLevels() {
    return this.visibleLevelLayers.map(l => ({
      id: l.level.id,
      name: l.level.name,
      isView: l.level.isView,
      isUpper: l.isUpper,
      elevation: { ...l.level.elevation },
      hasPyramid: l.hasPyramid,
      tilesCount: l.spec?.tiles?.length || 0,
      overlaysCount: l.spec?.overlays?.length || 0
    }));
  },

  async configureLevel(levelId, config = {}) {
    if (!game.user?.isGM) return null;
    const level = canvas.scene?.levels?.get(levelId);
    if (!level) throw new Error(`Level "${levelId}" not found on active scene.`);
    await level.update({ [`flags.${MODULE_ID}`]: config });
    await this.mount(canvas.scene);
  },

  /**
   * Collect and serialize native Foundry TileDocuments, WallDocuments, AmbientLightDocuments (non-negative),
   * and AmbientSoundDocuments belonging to a Level into Boundless spatial sectors.
   */
  collectLevelSpatialData(scene, level, { simGrid = null } = {}) {
    const levelId = level.id;
    const dims = scene.getDimensions?.();
    const worldPx = Math.max(dims?.width || scene.width || 100000, dims?.height || scene.height || 100000);
    const resolvedSimGrid = simGrid || Math.max(4, Math.min(40, Math.ceil(worldPx / 2500)));
    const simSectorPx = Math.ceil(worldPx / resolvedSimGrid);
    const sectors = {};
    const ensureSec = (sx, sy) => {
      const k = `${Math.max(0, Math.min(resolvedSimGrid - 1, sx))}_${Math.max(0, Math.min(resolvedSimGrid - 1, sy))}`;
      return (sectors[k] ??= { w: [], d: [], l: [], t: [], o: [], s: [] });
    };

    const tiles = [];
    const tileIdsToDelete = [];
    for (const t of scene.tiles) {
      if (t.levels?.size && !t.levels.has(levelId)) continue;
      if (!t.texture?.src) continue;
      // Leave video tiles native so Foundry preserves game.video playback, looping, and audio
      if (/\.(webm|mp4|m4v|ogv)([?#]|$)/i.test(t.texture.src) || globalThis.foundry?.helpers?.media?.VideoHelper?.hasVideoExtension?.(t.texture.src)) continue;
      const tid = tiles.length;
      const occModes = Array.from(t.occlusion?.modes || []);
      const rot = t.rotation || 0;
      const ax = Number.isFinite(t.texture.anchorX) ? t.texture.anchorX : 0.5;
      const ay = Number.isFinite(t.texture.anchorY) ? t.texture.anchorY : 0.5;
      const tileSpec = {
        src: t.texture.src,
        x: t.x, y: t.y, w: t.width, h: t.height,
        anchorX: ax,
        anchorY: ay,
        rot,
        elevation: t.elevation,
        sort: t.sort || 0,
        alpha: t.alpha ?? 1,
        hidden: Boolean(t.hidden),
        tint: (() => {
          if (t.texture.tint === undefined || t.texture.tint === null || t.texture.tint === "") return null;
          const c = foundry.utils.Color.from(t.texture.tint);
          return c?.valid ? c.css : null;
        })(),
        alphaThreshold: t.texture.alphaThreshold ?? 0.75,
        occlusionMode: occModes.length ? occModes : CONST.OCCLUSION_MODES.NONE,
        occludedAlpha: t.occlusion?.alpha ?? 0.2,
        restrictsLight: Boolean(t.restrictions?.light),
        restrictsWeather: Boolean(t.restrictions?.weather)
      };
      if (Number.isFinite(t.texture.scaleX) && t.texture.scaleX !== 1) tileSpec.scaleX = t.texture.scaleX;
      if (Number.isFinite(t.texture.scaleY) && t.texture.scaleY !== 1) tileSpec.scaleY = t.texture.scaleY;
      if (t.texture.fit && t.texture.fit !== "fill") tileSpec.fit = t.texture.fit;
      const isMultiLevelTile = (t.levels?.size > 1) || (!t.levels?.size && (scene.levels?.size || 0) > 1);
      if (isMultiLevelTile && t.id) tileSpec.gid = t.id;
      tiles.push(tileSpec);
      tileIdsToDelete.push(t.id);

      // Compute rotated AABB around Foundry v14 Tile pivot (t.x, t.y) with anchor (ax, ay) & scaleX/scaleY (including negative mirror flips)
      const sxVal = Number.isFinite(t.texture.scaleX) && t.texture.scaleX !== 0 ? t.texture.scaleX : 1;
      const syVal = Number.isFinite(t.texture.scaleY) && t.texture.scaleY !== 0 ? t.texture.scaleY : 1;
      const effW = Math.abs(t.width) * Math.abs(sxVal);
      const effH = Math.abs(t.height) * Math.abs(syVal);
      const effAx = sxVal < 0 ? (1 - ax) : ax;
      const effAy = syVal < 0 ? (1 - ay) : ay;
      const rad = (rot * Math.PI) / 180;
      const cos = Math.cos(rad);
      const sin = Math.sin(rad);
      const dx = (0.5 - effAx) * effW;
      const dy = (0.5 - effAy) * effH;
      const cx = t.x + (cos * dx - sin * dy);
      const cy = t.y + (sin * dx + cos * dy);
      const rx = (effW * Math.abs(cos) + effH * Math.abs(sin)) * 0.5;
      const ry = (effW * Math.abs(sin) + effH * Math.abs(cos)) * 0.5;
      const minX = cx - rx, maxX = cx + rx, minY = cy - ry, maxY = cy + ry;
      const sx0 = Math.max(0, Math.min(resolvedSimGrid - 1, Math.floor(minX / simSectorPx)));
      const sy0 = Math.max(0, Math.min(resolvedSimGrid - 1, Math.floor(minY / simSectorPx)));
      const sx1 = Math.max(0, Math.min(resolvedSimGrid - 1, Math.floor(maxX / simSectorPx)));
      const sy1 = Math.max(0, Math.min(resolvedSimGrid - 1, Math.floor(maxY / simSectorPx)));
      for (let sy = sy0; sy <= sy1; sy++) {
        for (let sx = sx0; sx <= sx1; sx++) {
          ensureSec(sx, sy).t.push(tid);
        }
      }
    }

    const wallIdsToDelete = [];
    for (const w of scene.walls) {
      if (w.levels?.size && !w.levels.has(levelId)) continue;
      const isMultiLevelWall = (w.levels?.size > 1) || (!w.levels?.size && (scene.levels?.size || 0) > 1);
      const [x1, y1, x2, y2] = w.c;
      if (w.door) {
        const cx = (x1 + x2) * 0.5, cy = (y1 + y2) * 0.5;
        const sec = ensureSec(Math.floor(cx / simSectorPx), Math.floor(cy / simSectorPx));
        const extra = {};
        if (w.move !== undefined && w.move !== 20) extra.move = w.move;
        if (w.sight !== undefined && w.sight !== 20) extra.sight = w.sight;
        if (w.light !== undefined && w.light !== 20) extra.light = w.light;
        if (w.sound !== undefined && w.sound !== 20) extra.sound = w.sound;
        if (w.dir) extra.dir = w.dir;
        if (w.doorSound) extra.doorSound = w.doorSound;
        if (isMultiLevelWall && w.id) extra.gid = w.id;
        if (w.animation?.type && w.animation?.texture) {
          extra.animation = {
            type: w.animation.type,
            texture: w.animation.texture,
            flip: Boolean(w.animation.flip),
            double: Boolean(w.animation.double),
            direction: w.animation.direction ?? 1,
            duration: w.animation.duration ?? 750,
            strength: w.animation.strength ?? 1
          };
        }
        if (w.threshold && (w.threshold.light || w.threshold.sight || w.threshold.sound)) {
          extra.threshold = {
            light: w.threshold.light ?? null,
            sight: w.threshold.sight ?? null,
            sound: w.threshold.sound ?? null,
            attenuation: Boolean(w.threshold.attenuation)
          };
        }
        sec.d.push(Object.keys(extra).length
          ? [x1, y1, x2, y2, w.door, w.ds || 0, extra]
          : [x1, y1, x2, y2, w.door, w.ds || 0]);
      } else {
        // Subdivide long non-door walls (> simSectorPx) so endpoints never fall outside 3x3 neighbor sector queries
        const segLen = Math.hypot(x2 - x1, y2 - y1);
        const parts = segLen > simSectorPx ? Math.ceil(segLen / simSectorPx) : 1;
        const thresholdVal = (w.threshold && (w.threshold.light || w.threshold.sight || w.threshold.sound))
          ? {
              light: w.threshold.light ?? null,
              sight: w.threshold.sight ?? null,
              sound: w.threshold.sound ?? null,
              attenuation: Boolean(w.threshold.attenuation)
            }
          : null;
        for (let pi = 0; pi < parts; pi++) {
          const t0 = pi / parts;
          const t1 = (pi + 1) / parts;
          const ax = pi === 0 ? x1 : Math.round(x1 + (x2 - x1) * t0);
          const ay = pi === 0 ? y1 : Math.round(y1 + (y2 - y1) * t0);
          const bx = pi === parts - 1 ? x2 : Math.round(x1 + (x2 - x1) * t1);
          const by = pi === parts - 1 ? y2 : Math.round(y1 + (y2 - y1) * t1);
          const sec = ensureSec(Math.floor(((ax + bx) * 0.5) / simSectorPx), Math.floor(((ay + by) * 0.5) / simSectorPx));
          const row = [ax, ay, bx, by, w.move, w.sight, w.light, w.sound, w.dir || 0];
          const wExtra = {};
          if (thresholdVal) wExtra.threshold = thresholdVal;
          if (isMultiLevelWall && w.id) wExtra.gid = parts > 1 ? `${w.id}:${pi}` : w.id;
          if (Object.keys(wExtra).length) row.push(wExtra);
          sec.w.push(row);
        }
      }
      wallIdsToDelete.push(w.id);
    }

    const lightIdsToDelete = [];
    for (const l of scene.lights) {
      if (l.levels?.size && !l.levels.has(levelId)) continue;
      // Keep negative (darkness), vision-providing, and priority (> 0, e.g. Daylight) sources as native AmbientLightDocuments
      if (l.config?.negative || l.vision || (l.config?.priority ?? 0) > 0) continue;
      const sec = ensureSec(Math.floor(l.x / simSectorPx), Math.floor(l.y / simSectorPx));
      const rawColor = l.config?.color;
      const colorCss = (() => {
        if (rawColor === undefined || rawColor === null || rawColor === "") return null;
        const c = foundry.utils.Color.from(rawColor);
        return c?.valid ? c.css : null;
      })();
      const extra = {};
      if (l.hidden) extra.hidden = true;
      if (l.walls === false) extra.walls = false;
      if ((l.config?.angle ?? 360) < 360) {
        extra.angle = l.config.angle;
        if (l.rotation) extra.rotation = l.rotation;
      }
      if ((l.config?.darkness?.min ?? 0) > 0) extra.darkMin = l.config.darkness.min;
      if ((l.config?.darkness?.max ?? 1) < 1) extra.darkMax = l.config.darkness.max;
      const animSpeed = l.config?.animation?.speed;
      if (Number.isFinite(animSpeed) && animSpeed !== 3) extra.speed = animSpeed;
      const animIntensity = l.config?.animation?.intensity;
      if (Number.isFinite(animIntensity) && animIntensity !== 3) extra.intensity = animIntensity;
      const coloration = l.config?.coloration;
      if (Number.isFinite(coloration) && coloration !== 1) extra.coloration = coloration;
      const attenuation = l.config?.attenuation;
      if (Number.isFinite(attenuation) && attenuation !== 0.5) extra.attenuation = attenuation;
      const luminosity = l.config?.luminosity;
      if (Number.isFinite(luminosity) && luminosity !== 0.5) extra.luminosity = luminosity;
      const isMultiLevelLight = (l.levels?.size > 1) || (!l.levels?.size && (scene.levels?.size || 0) > 1);
      if (isMultiLevelLight && l.id) extra.gid = l.id;
      const tuple = [
        l.x, l.y,
        l.config?.dim || 0,
        l.config?.bright || 0,
        colorCss,
        l.config?.alpha ?? 0.5,
        l.config?.animation?.type || "",
        l.elevation
      ];
      if (Object.keys(extra).length) tuple.push(extra);
      sec.l.push(tuple);
      lightIdsToDelete.push(l.id);
    }

    const soundIdsToDelete = [];
    for (const snd of (scene.sounds || [])) {
      if (snd.levels?.size && !snd.levels.has(levelId)) continue;
      if (!snd.path) continue;
      const sec = ensureSec(Math.floor(snd.x / simSectorPx), Math.floor(snd.y / simSectorPx));
      const row = [
        snd.x, snd.y,
        Number.isFinite(snd.radius) ? snd.radius : 20,
        snd.path,
        snd.volume ?? 0.6,
        snd.walls !== false,
        snd.easing !== false,
        snd.darkness?.min ?? 0,
        snd.darkness?.max ?? 1,
        snd.elevation
      ];
      const isMultiLevelSound = (snd.levels?.size > 1) || (!snd.levels?.size && (scene.levels?.size || 0) > 1);
      const sExtra = {};
      if (snd.hidden) sExtra.hidden = true;
      if (isMultiLevelSound && snd.id) sExtra.gid = snd.id;
      if (Object.keys(sExtra).length) row.push(sExtra);
      sec.s.push(row);
      soundIdsToDelete.push(snd.id);
    }

    return {
      worldPx,
      simGrid: resolvedSimGrid,
      simSectorPx,
      tiles,
      sectors,
      tileIdsToDelete,
      wallIdsToDelete,
      lightIdsToDelete,
      soundIdsToDelete
    };
  },

  /**
   * Bake an existing Foundry Scene (background pyramid + walls/doors/lights/sounds/tiles) into WebP files
   * + `pyramid_manifest.json` in the world data folder directly from the browser.
   */
  bakeSceneToPyramid(scene = canvas.scene, options = {}) {
    return bakeSceneToBoundless(this, scene, options);
  },

  bakeEditsToManifest(scene = canvas.scene, options = {}) {
    return bakeSceneEditsToManifest(this, scene, options);
  },

  unbakeScene(scene = canvas.scene, options = {}) {
    return unbakeSceneFromBoundless(this, scene, options);
  },

  clearLightPolyCacheDB(sceneId = null) {
    return this.lightBatch.clearPolyCacheDB(sceneId);
  },

  /**
   * Bake native Foundry TileDocuments, WallDocuments, and AmbientLightDocuments on a Level
   * into an inline Boundless spatial sector manifest on `level.flags["boundless"]`.
   */
  async bakeNativeToLevel(levelId = canvas.level?.id, { removeOriginals = false, simGrid = null, scene = canvas.scene } = {}) {
    if (!game.user?.isGM) return null;
    const targetScene = scene || canvas.scene;
    const level = targetScene?.levels?.get(levelId);
    if (!targetScene || !level) throw new Error(`Level "${levelId}" not found.`);

    const {
      worldPx, simGrid: resolvedSimGrid, simSectorPx, tiles, sectors,
      tileIdsToDelete, wallIdsToDelete, lightIdsToDelete, soundIdsToDelete
    } = this.collectLevelSpatialData(targetScene, level, { simGrid });

    const inlineManifest = { worldPx, simGrid: resolvedSimGrid, simSectorPx, tiles, sectors };
    const existingCfg = foundry.utils.deepClone(level.flags?.[MODULE_ID] || {});
    delete existingCfg.inlineManifest;

    // Clear stale index-keyed edits & doorStates and remove originals BEFORE updating level so updateLevel mounts cleanly once
    const prevSceneFlags = targetScene.flags?.[MODULE_ID] || {};
    const stalePatch = {};
    for (const mapKey of ["wallEdits", "lightEdits", "soundEdits", "tileEdits"]) {
      if (prevSceneFlags[mapKey] && typeof prevSceneFlags[mapKey] === "object" && (levelId in prevSceneFlags[mapKey])) {
        stalePatch[`flags.${MODULE_ID}.${mapKey}.-=${levelId}`] = null;
      }
    }
    if (prevSceneFlags.doorStates && typeof prevSceneFlags.doorStates === "object") {
      const prefix = `${levelId}:`;
      for (const dKey of Object.keys(prevSceneFlags.doorStates)) {
        if (dKey.startsWith(prefix)) stalePatch[`flags.${MODULE_ID}.doorStates.-=${dKey}`] = null;
      }
    }
    if (Object.keys(stalePatch).length) {
      await targetScene.update(stalePatch);
    }

    if (removeOriginals) {
      const hasMultipleLevels = (targetScene.levels?.size || 0) > 1;
      const otherLevelIds = hasMultipleLevels
        ? Array.from(targetScene.levels || []).map(l => l.id).filter(lid => lid !== levelId)
        : [];
      const pruneOrDelete = async (docName, rawIds) => {
        const ids = Array.from(new Set(rawIds));
        if (!ids.length) return;
        if (!hasMultipleLevels) {
          await targetScene.deleteEmbeddedDocuments(docName, ids);
          return;
        }
        const collection = targetScene.getEmbeddedCollection?.(docName);
        const toDelete = [];
        const toUpdate = [];
        for (const id of ids) {
          const doc = collection?.get?.(id);
          if (!doc) continue;
          const docLevels = doc.levels ? Array.from(doc.levels) : [];
          if (!docLevels.length) {
            if (otherLevelIds.length === 0) toDelete.push(id);
            else toUpdate.push({ _id: id, levels: otherLevelIds });
            continue;
          }
          const remaining = docLevels.filter(lid => lid !== levelId);
          if (remaining.length === 0) toDelete.push(id);
          else if (remaining.length < docLevels.length) toUpdate.push({ _id: id, levels: remaining });
        }
        if (toUpdate.length) await targetScene.updateEmbeddedDocuments(docName, toUpdate);
        if (toDelete.length) await targetScene.deleteEmbeddedDocuments(docName, toDelete);
      };
      await pruneOrDelete("Tile", tileIdsToDelete);
      await pruneOrDelete("Wall", wallIdsToDelete);
      await pruneOrDelete("AmbientLight", lightIdsToDelete);
      await pruneOrDelete("AmbientSound", soundIdsToDelete);
    }

    await this.lightBatch?.clearPolyCacheDB?.(targetScene.id, game.world?.id)?.catch?.(() => {});
    await level.update({
      [`flags.${MODULE_ID}`]: { ...existingCfg, enabled: true },
      [`flags.${MODULE_ID}.==inlineManifest`]: inlineManifest
    });

    if (canvas.scene?.id === targetScene.id) {
      await this.mount(targetScene);
    }
    return {
      levelId,
      tiles: tiles.length,
      walls: wallIdsToDelete.length,
      lights: lightIdsToDelete.length,
      sounds: soundIdsToDelete.length
    };
  },

  /**
   * Create (or activate) a 6000x6000 cells (600,000 x 600,000 px) continental stress-test Scene:
   * 36 provinces, 160,668 walls, 12,888 doors, 22,860 shadowed GPU lights, 8,244 interactive buildings.
   * Usage in F12 console: `await Boundless.createStressTest6000({ tokens: 600 })`
   */
  async createStressTest6000({ name = "Континент 6000×6000 (Стресс-тест)", tokens = 600, activate = true, recreate = false } = {}) {
    if (!game?.user?.isGM) {
      ui.notifications?.warn("Только мастер может создать сцену стресс-теста.");
      return null;
    }
    const manifestUrl = `modules/${MODULE_ID}/assets/pyramid_6000/pyramid_manifest_6000.json`;
    let scene = game.scenes.find(s => s.flags?.[MODULE_ID]?.manifestUrl === manifestUrl);
    if (scene && recreate) {
      await scene.delete();
      scene = null;
    }
    if (!scene) {
      scene = await Scene.create({
        name,
        width: 600000,
        height: 600000,
        padding: 0,
        backgroundColor: "#0c1118",
        grid: {
          type: CONST.GRID_TYPES.SQUARE,
          size: 100,
          distance: 5,
          units: "ft",
          alpha: 0.15
        },
        tokenVision: true,
        fog: { mode: CONST.FOG_EXPLORATION_MODES?.SHARED ?? 2 },
        environment: { globalLight: { enabled: true } },
        initial: { x: 300000, y: 300000, scale: 0.002 },
        flags: {
          [MODULE_ID]: {
            enabled: true,
            manifestUrl,
            showPois: true,
            chunkedFog: true,
            virtualizeTokens: true
          }
        }
      });
    }

    if (tokens > 0 && scene && scene.tokens.size === 0) {
      await this.tokenStreamer.spawnNativePopulation(tokens, { scene });
    }

    if (activate && scene) {
      await scene.view();
    }
    return scene;
  },

  spawnNativePopulation(count = 600, options = {}) {
    return this.tokenStreamer.spawnNativePopulation(count, options);
  },

  restoreLegacyVirtualTokens(scene = canvas?.scene) {
    return this.tokenStreamer.restoreLegacyVirtualTokens(scene);
  },

  /**
   * Migrate any legacy `sh-megamap` scene flags, level flags, user fog flags, and localStorage entries
   * into `boundless` (rewriting `modules/sh-megamap/` asset paths recursively) and remount active scene.
   */
  async migrateLegacyScenes() {
    const LEGACY_ID = "sh-megamap";
    const rewritePaths = (val) => {
      if (typeof val === "string") {
        return val.includes(`modules/${LEGACY_ID}/`)
          ? val.replaceAll(`modules/${LEGACY_ID}/`, `modules/${MODULE_ID}/`)
          : val;
      }
      if (Array.isArray(val)) return val.map(rewritePaths);
      if (val && typeof val === "object") {
        const out = {};
        for (const [k, v] of Object.entries(val)) out[k] = rewritePaths(v);
        return out;
      }
      return val;
    };

    // 1. Migrate client-side localStorage (camera positions & individual fog)
    try {
      const toMove = [];
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (k && k.startsWith(`${LEGACY_ID}.`)) toMove.push(k);
      }
      for (const oldKey of toMove) {
        const newKey = `${MODULE_ID}.${oldKey.slice(LEGACY_ID.length + 1)}`;
        if (localStorage.getItem(newKey) === null) {
          localStorage.setItem(newKey, localStorage.getItem(oldKey));
        }
        localStorage.removeItem(oldKey);
      }
    } catch {}

    // 2. Migrate current user's personal fog flags
    try {
      const uLegacy = game.user?.flags?.[LEGACY_ID];
      if (uLegacy) {
        const merged = foundry.utils.mergeObject(
          rewritePaths(foundry.utils.deepClone(uLegacy)),
          foundry.utils.deepClone(game.user.flags?.[MODULE_ID] || {}),
          { inplace: false }
        );
        await game.user.update({
          [`flags.${MODULE_ID}`]: merged,
          [`flags.-=${LEGACY_ID}`]: null
        });
      }
    } catch {}

    if (!game.user?.isActiveGM) return { scenes: 0, levels: 0 };

    let migratedScenes = 0;
    let migratedLevels = 0;
    let activeSceneTouched = false;

    const legacyPrefix = `modules/${LEGACY_ID}/`;
    const hasLegacyPath = (val, depth = 0) => {
      if (!val || depth > 10) return false;
      if (typeof val === "string") return val.includes(legacyPrefix);
      if (typeof val !== "object") return false;
      if (Array.isArray(val)) {
        for (let i = 0; i < val.length; i++) if (hasLegacyPath(val[i], depth + 1)) return true;
        return false;
      }
      for (const k in val) {
        // Skip massive non-URL payloads while still scanning wallEdits & sectors (door textures, sound paths)
        if (k === "sharedFog" || k === "doorStates" || k === "bakedPolys") continue;
        if (hasLegacyPath(val[k], depth + 1)) return true;
      }
      return false;
    };

    for (const scene of game.scenes || []) {
      const legacyScene = scene.flags?.[LEGACY_ID];
      const curScene = scene.flags?.[MODULE_ID];
      const curHasOldPath = Boolean(curScene && hasLegacyPath(curScene));

      if (legacyScene || curHasOldPath) {
        const base = legacyScene ? rewritePaths(foundry.utils.deepClone(legacyScene)) : {};
        const cur = curScene ? rewritePaths(foundry.utils.deepClone(curScene)) : {};
        const merged = foundry.utils.mergeObject(base, cur, { inplace: false });
        const upd = { [`flags.${MODULE_ID}`]: merged };
        if (legacyScene) upd[`flags.-=${LEGACY_ID}`] = null;
        await scene.update(upd);
        migratedScenes++;
        if (canvas?.scene?.id === scene.id) activeSceneTouched = true;
      }

      // Migrate every Level on the scene (`level.flags["sh-megamap"]` or stale paths inside `inlineManifest`)
      for (const level of scene.levels || []) {
        const legacyLvl = level.flags?.[LEGACY_ID];
        const curLvl = level.flags?.[MODULE_ID];
        const lvlHasOldPath = Boolean(curLvl && hasLegacyPath(curLvl));
        if (!legacyLvl && !lvlHasOldPath) continue;

        const base = legacyLvl ? rewritePaths(foundry.utils.deepClone(legacyLvl)) : {};
        const cur = curLvl ? rewritePaths(foundry.utils.deepClone(curLvl)) : {};
        const merged = foundry.utils.mergeObject(base, cur, { inplace: false });
        const upd = { [`flags.${MODULE_ID}`]: merged };
        if (legacyLvl) upd[`flags.-=${LEGACY_ID}`] = null;
        await level.update(upd);
        migratedLevels++;
        if (canvas?.scene?.id === scene.id) activeSceneTouched = true;
      }
    }

    if (activeSceneTouched && canvas?.ready && canvas.scene) {
      await this.mount(canvas.scene);
    }

    if (migratedScenes > 0 || migratedLevels > 0) {
      console.log(`${MODULE_ID} | Migrated legacy sh-megamap data: ${migratedScenes} scene(s), ${migratedLevels} level(s).`);
    }
    return { scenes: migratedScenes, levels: migratedLevels };
  }
};
