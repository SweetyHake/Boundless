import { MegaLightBatch, LIGHT_PAD_WORLD_PX } from "./light-batch.mjs";
import {
  MODULE_ID,
  getEffectiveScale,
  buildEdgeThresholdPx
} from "./utils.mjs";

export const SOCKET_NAME = `module.${MODULE_ID}`;
export const MAX_LOS_RADIUS_PX = 4500; // 45 cells (225 ft) horizon prevents 100kpx full-world raycasts

/**
 * In Foundry v14, BaseEffectSource/PointLightSource has no `.destroyed` property:
 * destruction sets `#attached = false` and destroys layer meshes. Support both live v14 and mock `.destroyed`.
 */
function isLightSourceDead(ls) {
  if (!ls || ls.destroyed) return true;
  if (ls.attached === false) return true;
  const il = ls.layers?.illumination?.mesh;
  const co = ls.layers?.coloration?.mesh;
  if (il?.destroyed || co?.destroyed) return true;
  return false;
}

export const lightingMethods = {
  _getLightBatchBuildOpts() {
    return {
      isSuppressedFn: (lid) => this.dynamicLights.has(lid),
      hasLevelEditsFn: (levelId) =>
        Boolean(this.wallEdits.get(levelId)?.size) || Boolean(this.lightEdits.get(levelId)?.size),
      getLevelCacheSigFn: (levelId) => {
        const wMap = this.wallEdits.get(levelId);
        let wallSig = "0";
        if (wMap?.size) {
          wallSig = JSON.stringify(Array.from(wMap.entries()).sort((a, b) => (a[0] < b[0] ? -1 : 1)));
        }
        const prefix = `${levelId}::`;
        let openList = "";
        if (this.openDoors.size > 0) {
          const matched = [];
          for (const dKey of this.openDoors.keys()) {
            const k = String(dKey);
            if (k.startsWith(prefix)) matched.push(k.slice(prefix.length));
          }
          if (matched.length > 0) openList = matched.sort().join(",");
        }
        return `we:${wallSig}|od:${openList}`;
      },
      onBatchChanged: () => {
        if (this.active && canvas?.effects) this._optimizeEffectsLayers(canvas.effects);
      },
      onChunkBaked: () => {
        if (this.active) this.updateSimAndLightBubbles(false);
      }
    };
  },

  onLightingRefresh(effects) {
    if (!this.active) return;
    this._capFilterResolution(effects?.coloration?.filter, 1.0);
    this._capFilterResolution(effects?.illumination?.filter, 1.0);
    const darkness = canvas.environment?.darknessLevel ?? 0;
    const rangedChanged = this.lightBatch.syncDarknessLevel(darkness);
    this.lightBatch.attachTo(effects);
    this._optimizeEffectsLayers(effects);
    this.tokenStreamer.onVisibilityChanged();
    if (rangedChanged) {
      this._depthDirty = true;
      if (canvas.masks?.depth) canvas.masks.depth.renderDirty = true;
      queueMicrotask(() => {
        if (this.active) this.updateSimAndLightBubbles(false);
      });
    }
    if (this.visibleLevelLayers.length) {
      const now = performance.now();
      const elapsed = now - (this._lastLightRefreshAudioMs || 0);
      if (rangedChanged || elapsed >= 120) {
        if (this._lightRefreshAudioTimer) {
          clearTimeout(this._lightRefreshAudioTimer);
          this._lightRefreshAudioTimer = null;
        }
        this._lastLightRefreshAudioMs = now;
        this.audioStreamer.update(
          this.visibleLevelLayers,
          this.getViewportWorldRect(0.28),
          (lid, sk, idx, raw, lvl) => this.resolveVirtualSound(lid, sk, idx, raw, lvl)
        );
      } else if (!this._lightRefreshAudioTimer) {
        const delay = Math.max(16, Math.ceil(120 - elapsed));
        this._lightRefreshAudioTimer = setTimeout(() => {
          this._lightRefreshAudioTimer = null;
          if (!this.active || !this.visibleLevelLayers.length) return;
          this._lastLightRefreshAudioMs = performance.now();
          this.audioStreamer.update(
            this.visibleLevelLayers,
            this.getViewportWorldRect(0.28),
            (lid, sk, idx, raw, lvl) => this.resolveVirtualSound(lid, sk, idx, raw, lvl)
          );
        }, delay);
      }
    }
  },

  scheduleViewportLightSync(delayMs = 320) {
    if (this._vpLightSyncTimer) clearTimeout(this._vpLightSyncTimer);
    this._vpLightSyncTimer = setTimeout(() => {
      this._vpLightSyncTimer = null;
      if (this.active && !this._mounting) {
        this.updateSimAndLightBubbles(false);
      }
    }, delayMs);
  },

  // Multi-Level Physics Sim-Bubble & Dynamic Lights: strictly driven by tokens (on their own level!), active visionSources, and open doors
  updateSimAndLightBubbles(force = false) {
    if (!this.active || !this.visibleLevelLayers.length || !canvas?.ready || this._updatingBubbles) return;
    this._updatingBubbles = true;
    try {
      const EdgeCls = foundry.canvas.geometry.edges.Edge;
      const LightCls = CONFIG.Canvas.lightSourceClass;
      const pxPerFt = canvas.dimensions.size / canvas.dimensions.distance;
      const darkness = canvas.environment?.darknessLevel ?? 0;

      // 1. Collect Dynamic PointLightSources FIRST so we guarantee their full light radius has wall edges in `level.edges`.
      //    Outdoor lights (`!meta.isIndoor`) ALWAYS stay eligible at all zoom levels so controlled/viewed tokens with sightRange=0
      //    never lose vision on zoom-out! When macro bakedRoofMask is active (roofs unloaded from CanvasDepthMask), only suppress
      //    indoor lights that are NOT directly inside an active visionSource's LOS polygon so they don't bleed through baked roofs.
      const neededDynLights = new Set();
      const suppressUnseenIndoorForMacroRoof = Boolean(this.lightBatch.useBakedRoofMask);
      const suppressIndoorDyn = Boolean(this.lightBatch.hideIndoorLights);

      const isMetaEligibleDyn = (meta, visionSource = null) => {
        if (!meta) return false;
        if (suppressIndoorDyn && meta.isIndoor) return false;
        if (suppressUnseenIndoorForMacroRoof && meta.isIndoor) {
          const canSeeIndoor = Boolean(visionSource?.los?.contains?.(meta.lx, meta.ly));
          if (!canSeeIndoor) return false;
        }
        if (darkness < (meta.darkMin ?? 0) || darkness > (meta.darkMax ?? 1)) return false;
        return true;
      };

      // 1a. Open-door lights (always included, never starved by vision light cap)
      for (const door of this.openDoors.values()) {
        const layer = this.levelLayers.get(door.levelId);
        if (!layer?.spec?.sectors) continue;
        const { simGrid, simSectorPx, spec } = layer;
        const sx0 = Math.max(0, Math.floor((door.x - LIGHT_PAD_WORLD_PX) / simSectorPx));
        const sy0 = Math.max(0, Math.floor((door.y - LIGHT_PAD_WORLD_PX) / simSectorPx));
        const sx1 = Math.min(simGrid - 1, Math.floor((door.x + LIGHT_PAD_WORLD_PX) / simSectorPx));
        const sy1 = Math.min(simGrid - 1, Math.floor((door.y + LIGHT_PAD_WORLD_PX) / simSectorPx));
        for (let sy = sy0; sy <= sy1; sy++) {
          for (let sx = sx0; sx <= sx1; sx++) {
            const sk = `${sx}_${sy}`;
            const sec = spec.sectors[sk];
            if (!sec?.l?.length) continue;
            for (let li = 0; li < sec.l.length; li++) {
              const lid = `${door.levelId}::${sk}_${li}`;
              const meta = this.lightBatch.lightMetaById.get(lid);
              if (isMetaEligibleDyn(meta) && Math.hypot(meta.lx - door.x, meta.ly - door.y) <= meta.dimPx + 150) {
                neededDynLights.add(lid);
              }
            }
          }
        }
      }

      // 1b. Nearest lights to active visionSources (skip when box-selecting a crowd > 6 visionSources)
      const MAX_VISION_DYN_LIGHTS = 24;
      if (canvas.effects?.visionSources?.size && canvas.effects.visionSources.size <= 6) {
        const visionCandidates = new Map(); // lid -> minDistSq
        for (const vs of canvas.effects.visionSources) {
          if (!vs?.active) continue;
          const vsLevelId = vs.data?.level || canvas.level?.id;
          const layer = this.levelLayers.get(vsLevelId);
          if (!layer?.spec?.sectors) continue;
          const { simGrid, simSectorPx, spec } = layer;
          const vRad = Math.min(MAX_LOS_RADIUS_PX, Math.max(vs.radius || 0, 60 * pxPerFt));
          const sx0 = Math.max(0, Math.floor((vs.x - vRad - LIGHT_PAD_WORLD_PX) / simSectorPx));
          const sy0 = Math.max(0, Math.floor((vs.y - vRad - LIGHT_PAD_WORLD_PX) / simSectorPx));
          const sx1 = Math.min(simGrid - 1, Math.floor((vs.x + vRad + LIGHT_PAD_WORLD_PX) / simSectorPx));
          const sy1 = Math.min(simGrid - 1, Math.floor((vs.y + vRad + LIGHT_PAD_WORLD_PX) / simSectorPx));
          for (let sy = sy0; sy <= sy1; sy++) {
            for (let sx = sx0; sx <= sx1; sx++) {
              const sk = `${sx}_${sy}`;
              const sec = spec.sectors[sk];
              if (!sec?.l?.length) continue;
              for (let li = 0; li < sec.l.length; li++) {
                const lid = `${vsLevelId}::${sk}_${li}`;
                if (neededDynLights.has(lid)) continue;
                const meta = this.lightBatch.lightMetaById.get(lid);
                if (!isMetaEligibleDyn(meta, vs)) continue;
                const dx = meta.lx - vs.x;
                const dy = meta.ly - vs.y;
                const maxD = vRad + meta.dimPx;
                const distSq = dx * dx + dy * dy;
                if (distSq <= maxD * maxD) {
                  const prev = visionCandidates.get(lid);
                  if (prev === undefined || distSq < prev) visionCandidates.set(lid, distSq);
                }
              }
            }
          }
        }
        if (visionCandidates.size > 0) {
          const sorted = Array.from(visionCandidates.entries()).sort((a, b) => a[1] - b[1]);
          const take = Math.min(MAX_VISION_DYN_LIGHTS, sorted.length);
          for (let i = 0; i < take; i++) neededDynLights.add(sorted[i][0]);
        }
      }

      // 1c. Viewport animated lights with zoom hysteresis (enter >= 0.28, exit < 0.18 in 100-PPI equivalent scale)
      //     and sticky selection so zooming/panning never churns or flickers lights.
      const MAX_VIEWPORT_ANIM_LIGHTS = 18;
      const MAX_TOTAL_DYN_LIGHTS = 28;
      const lightAnimEnabled = canvas.effects?.animateLightSources !== false;
      const effScale = getEffectiveScale(canvas.stage?.scale?.x || 1);
      if (!lightAnimEnabled) {
        this._vpAnimLightsActive = false;
      } else if (this._vpAnimLightsActive) {
        if (effScale < 0.18) this._vpAnimLightsActive = false;
      } else if (effScale >= 0.28) {
        this._vpAnimLightsActive = true;
      }
      const vpAnimOnlyIds = new Set();
      const vpAnimBudget = Math.min(MAX_VIEWPORT_ANIM_LIGHTS, Math.max(0, MAX_TOTAL_DYN_LIGHTS - neededDynLights.size));
      if (this._vpAnimLightsActive && vpAnimBudget > 0) {
        const vp = this.getViewportWorldRect(0.2);
        const vpSticky = this.getViewportWorldRect(0.55);
        if (vp && vpSticky && Number.isFinite(vp.x0) && Number.isFinite(vp.x1)) {
          const cx = (vp.x0 + vp.x1) * 0.5;
          const cy = (vp.y0 + vp.y1) * 0.5;
          const vpCandidates = [];
          for (let li = 0; li < this.visibleLevelLayers.length; li++) {
            const layer = this.visibleLevelLayers[li];
            const levelId = layer?.level?.id;
            if (!levelId || !layer?.spec?.sectors) continue;
            const viewPrio = layer.level.isView ? 0 : 1;
            const { simGrid, simSectorPx, spec } = layer;
            const sx0 = Math.max(0, Math.floor((vpSticky.x0 - LIGHT_PAD_WORLD_PX) / simSectorPx));
            const sy0 = Math.max(0, Math.floor((vpSticky.y0 - LIGHT_PAD_WORLD_PX) / simSectorPx));
            const sx1 = Math.min(simGrid - 1, Math.floor((vpSticky.x1 + LIGHT_PAD_WORLD_PX) / simSectorPx));
            const sy1 = Math.min(simGrid - 1, Math.floor((vpSticky.y1 + LIGHT_PAD_WORLD_PX) / simSectorPx));
            for (let sy = sy0; sy <= sy1; sy++) {
              for (let sx = sx0; sx <= sx1; sx++) {
                const sk = `${sx}_${sy}`;
                const sec = spec.sectors[sk];
                if (!sec?.l?.length) continue;
                for (let idx = 0; idx < sec.l.length; idx++) {
                  const lid = `${levelId}::${sk}_${idx}`;
                  if (neededDynLights.has(lid)) continue;
                  const meta = this.lightBatch.lightMetaById.get(lid);
                  if (!meta || !meta.raw?.[6] || !isMetaEligibleDyn(meta)) continue;
                  const r = meta.dimPx || 0;
                  const alreadyDyn = this.dynamicLights.has(lid);
                  const box = alreadyDyn ? vpSticky : vp;
                  if (meta.lx + r < box.x0 || meta.lx - r > box.x1 || meta.ly + r < box.y0 || meta.ly - r > box.y1) continue;
                  const dx = meta.lx - cx;
                  const dy = meta.ly - cy;
                  const animType = String(meta.raw[6]).toLowerCase();
                  const isPattern = animType !== "torch" && animType !== "flame" && animType !== "pulse";
                  vpCandidates.push({
                    lid,
                    stickyPrio: alreadyDyn ? 0 : 1,
                    viewPrio,
                    prio: isPattern ? 0 : 1,
                    distSq: dx * dx + dy * dy
                  });
                }
              }
            }
          }
          if (vpCandidates.length > 0) {
            vpCandidates.sort((a, b) =>
              (a.stickyPrio - b.stickyPrio) ||
              (a.viewPrio - b.viewPrio) ||
              (a.prio - b.prio) ||
              (a.distSq - b.distSq)
            );
            const take = Math.min(vpAnimBudget, vpCandidates.length);
            for (let i = 0; i < take; i++) {
              const lid = vpCandidates[i].lid;
              neededDynLights.add(lid);
              vpAnimOnlyIds.add(lid);
            }
          }
        }
      }

      // 2. Physics Wall Edges per Level (`level.edges`): around active tokens (controlled, player-owned,
      //    light-emitting, active visionSources), open doors, and every active dynamic PointLightSource
      const neededSim = new Map(); // "${levelId}::${sx}_${sy}" -> { layer, sk }
      const addSimBubble = (levelId, wx, wy, radiusPx = 0) => {
        const layer = this.levelLayers.get(levelId);
        if (!layer?.spec?.sectors) return;
        const { simGrid, simSectorPx, spec } = layer;
        const effRad = Math.max(simSectorPx, radiusPx || 0);
        const sx0 = Math.max(0, Math.floor((wx - effRad) / simSectorPx));
        const sy0 = Math.max(0, Math.floor((wy - effRad) / simSectorPx));
        const sx1 = Math.min(simGrid - 1, Math.floor((wx + effRad) / simSectorPx));
        const sy1 = Math.min(simGrid - 1, Math.floor((wy + effRad) / simSectorPx));
        for (let y = sy0; y <= sy1; y++) {
          for (let x = sx0; x <= sx1; x++) {
            const sk = `${x}_${y}`;
            if (spec.sectors[sk]) {
              neededSim.set(`${levelId}::${sk}`, { layer, sk });
            }
          }
        }
      };

      const controlledCount = canvas.tokens?.controlled?.length || 0;
      const isBulkSelection = controlledCount > 8;
      let bulkControlledAdded = 0;

      for (const tok of canvas.tokens.placeables) {
        if (!tok || tok.destroyed || tok.isPreview || !tok.center) continue;
        const doc = tok.document;
        const lightRadPx = Math.max(doc?.light?.dim || 0, doc?.light?.bright || 0) * pxPerFt;
        const isCoreActor = Boolean(doc?.hasPlayerOwner)
          || Boolean(tok.vision?.active)
          || lightRadPx > 0;
        let isActiveActor = isCoreActor;
        if (!isActiveActor && tok.controlled) {
          if (!isBulkSelection || bulkControlledAdded < 8) {
            isActiveActor = true;
            bulkControlledAdded++;
          }
        }
        if (!isActiveActor) continue;
        const visRadPx = tok.vision?.active ? Math.min(MAX_LOS_RADIUS_PX, tok.vision.radius || 0) : 0;
        addSimBubble(doc?.level || canvas.level?.id, tok.center.x, tok.center.y, Math.max(lightRadPx, visRadPx));
      }

      if (canvas.effects?.visionSources?.size) {
        for (const vs of canvas.effects.visionSources) {
          if (!vs?.active) continue;
          const vRad = Math.min(MAX_LOS_RADIUS_PX, vs.radius || 0);
          addSimBubble(vs.data?.level || canvas.level?.id, vs.x, vs.y, vRad);
        }
      }

      // Ensure native negative darkness sources & native AmbientLights (e.g. vision-providing lights) have virtual wall edges
      if (canvas.effects?.darknessSources?.size) {
        for (const ds of canvas.effects.darknessSources) {
          if (!ds?.active || ds.data?.walls === false) continue;
          const r = Math.min(MAX_LOS_RADIUS_PX, Number(ds.radius || ds.data?.radius) || 0);
          if (r > 0) addSimBubble(ds.level?.id ?? ds.data?.level ?? canvas.level?.id, ds.x, ds.y, r + 100);
        }
      }
      if (canvas.effects?.lightSources?.size) {
        const globalLs = canvas.environment?.globalLightSource;
        for (const ls of canvas.effects.lightSources) {
          if (!ls?.active || ls === globalLs || ls.data?.walls === false) continue;
          if (typeof ls.sourceId === "string" && ls.sourceId.startsWith("MegaLight.")) continue;
          const r = Math.min(MAX_LOS_RADIUS_PX, Number(ls.radius || ls.data?.dim || ls.data?.bright) || 0);
          if (r > 0) addSimBubble(ls.level?.id ?? ls.data?.level ?? canvas.level?.id, ls.x, ls.y, r + 100);
        }
      }

      for (const door of this.openDoors.values()) {
        addSimBubble(door.levelId, door.x, door.y, LIGHT_PAD_WORLD_PX);
      }

      const actorSimKey = Array.from(neededSim.keys()).sort().join("|");

      // Guarantee every active dynamic PointLightSource has all wall sectors within its full radius
      for (const lid of neededDynLights) {
        const meta = this.lightBatch.lightMetaById.get(lid);
        if (meta && meta.walls !== false) {
          addSimBubble(meta.levelId, meta.lx, meta.ly, meta.dimPx + 100);
        }
      }

      const simKey = Array.from(neededSim.keys()).sort().join("|");
      let edgesChanged = false;
      const changedSectors = new Set();

      if (force || simKey !== this.lastSimKey) {
        this.lastSimKey = simKey;

        for (const [fullKey, data] of this.simSectors) {
          if (!neededSim.has(fullKey)) {
            for (const eid of data.edgeIds) data.level.edges.delete(eid);
            this.simSectors.delete(fullKey);
            changedSectors.add(fullKey);
            edgesChanged = true;
          }
        }

        for (const [fullKey, { layer, sk }] of neededSim) {
          if (this.simSectors.has(fullKey)) continue;
          const sec = layer.spec.sectors[sk];
          if (!sec) continue;
          const level = layer.level;
          const lid = level.id;
          const edgeIds = [];

          if (sec.w) {
            for (let wi = 0; wi < sec.w.length; wi++) {
              const seg = this.resolveVirtualWall(lid, "w", sk, wi, sec.w[wi]);
              if (!seg) continue;
              const dKey = seg.door ? `${lid}::${sk}_w${wi}` : null;
              const isOpen = dKey ? (this.getCurrentDoorState(dKey, seg.ds) === 1) : false;
              const eid = `mw_${lid}_${sk}_${wi}`;
              if (!isOpen) {
                const [x1, y1, x2, y2] = seg.c;
                const threshold = buildEdgeThresholdPx(seg.threshold, pxPerFt);
                const edge = new EdgeCls({ x: x1, y: y1 }, { x: x2, y: y2 }, {
                  id: eid, type: "wall",
                  move: seg.move, sight: seg.sight, light: seg.light, darkness: seg.darkness ?? seg.light, sound: seg.sound, direction: seg.dir || 0,
                  ...(threshold ? { threshold } : {})
                });
                level.edges.set(eid, edge);
              }
              edgeIds.push(eid);
            }
          }

          if (sec.d) {
            for (let di = 0; di < sec.d.length; di++) {
              const seg = this.resolveVirtualWall(lid, "d", sk, di, sec.d[di]);
              if (!seg) continue;
              const [x1, y1, x2, y2] = seg.c;
              const dKey = `${lid}::${sk}_${di}`;
              const eid = `md_${dKey}`;
              const isOpen = seg.door ? (this.getCurrentDoorState(dKey, seg.ds) === 1) : false;
              if (!isOpen) {
                const threshold = buildEdgeThresholdPx(seg.threshold, pxPerFt);
                const edge = new EdgeCls({ x: x1, y: y1 }, { x: x2, y: y2 }, {
                  id: eid, type: "wall",
                  move: seg.move, sight: seg.sight, light: seg.light, darkness: seg.darkness ?? seg.light, sound: seg.sound, direction: seg.dir || 0,
                  ...(threshold ? { threshold } : {})
                });
                level.edges.set(eid, edge);
              }
              edgeIds.push(eid);
            }
          }

          this.simSectors.set(fullKey, { level, edgeIds });
          changedSectors.add(fullKey);
          edgesChanged = true;
        }
      }

      const actorEdgesChanged = Boolean(edgesChanged && (force || actorSimKey !== this._lastActorSimKey));
      if (actorEdgesChanged || !this._lastActorSimKey) this._lastActorSimKey = actorSimKey;

      const lightTouchesChangedSector = (meta) => {
        if (!meta || meta.walls === false || !changedSectors.size) return false;
        const layer = this.levelLayers.get(meta.levelId);
        if (!layer) return false;
        const { simGrid, simSectorPx } = layer;
        const r = (meta.dimPx || 0) + 100;
        const sx0 = Math.max(0, Math.floor((meta.lx - r) / simSectorPx));
        const sy0 = Math.max(0, Math.floor((meta.ly - r) / simSectorPx));
        const sx1 = Math.min(simGrid - 1, Math.floor((meta.lx + r) / simSectorPx));
        const sy1 = Math.min(simGrid - 1, Math.floor((meta.ly + r) / simSectorPx));
        for (let y = sy0; y <= sy1; y++) {
          for (let x = sx0; x <= sx1; x++) {
            if (changedSectors.has(`${meta.levelId}::${x}_${y}`)) return true;
          }
        }
        return false;
      };

      const dynKey = Array.from(neededDynLights).sort().join("|");
      let lightsChanged = false;
      let moreVpAnimPending = false;
      // Always time-slice viewport-only animated lights (even on force/levelSwitch) so 18 lights never stall a single frame!
      const MAX_NEW_VP_PROMOTES_PER_TICK = 2;
      const VP_PROMOTE_BUDGET_MS = 1.6;
      const tVpStart = performance.now();
      let newVpPromotes = 0;

      if (force || dynKey !== this.lastDynLightKey || edgesChanged || (dynKey === "" && this.dynamicLights.size > 0)) {
        for (const [lid, ls] of this.dynamicLights) {
          if (!neededDynLights.has(lid)) {
            const canSmoothRetire = Boolean(
              !force &&
              !this._mounting &&
              !isLightSourceDead(ls) &&
              ls._boundlessVpAnimOnly &&
              this.lightBatch.lightMetaById.has(lid) &&
              ls.layers?.coloration?.mesh?.shader?.uniforms
            );
            if (canSmoothRetire) {
              const existingFade = this._lightFades.get(lid);
              if (!existingFade || existingFade.dir !== "out") {
                const colU = ls.layers.coloration?.mesh?.shader?.uniforms;
                const bgU = ls.layers.background?.mesh?.shader?.uniforms;
                const baseColorAlpha = existingFade?.baseColorAlpha ?? (Number.isFinite(colU?.colorationAlpha) ? colU.colorationAlpha : null);
                const baseBgAlpha = existingFade?.baseBgAlpha ?? (Number.isFinite(bgU?.backgroundAlpha) ? bgU.backgroundAlpha : null);
                const startT = existingFade ? Math.max(0, 1 - existingFade.t) : 0;
                this._lightFades.set(lid, { dir: "out", t: startT, dur: 200, ls, baseColorAlpha, baseBgAlpha });
              }
              continue;
            }
            this._lightFades.delete(lid);
            this._emit("dynamicLightRetire", { id: lid, light: ls, meta: this.lightBatch.lightMetaById.get(lid) || null });
            if (ls && !ls.destroyed) { try { ls.destroy(); } catch {} }
            this.dynamicLights.delete(lid);
            this.lightBatch.setLightWeight(lid, 1.0);
            lightsChanged = true;
          }
        }

        for (const lid of neededDynLights) {
          const existingLs = this.dynamicLights.get(lid);
          if (existingLs && !isLightSourceDead(existingLs)) {
            const ls = existingLs;
            const isVpOnly = vpAnimOnlyIds.has(lid);
            ls._boundlessVpAnimOnly = isVpOnly;
            // Cancel any pending fade-out if the light came back into view or became door/vision driven
            const activeFade = this._lightFades.get(lid);
            if (activeFade && activeFade.dir === "out") {
              if (!isVpOnly || force) {
                this._finishLightFadeImmediate(lid, true);
              } else {
                activeFade.dir = "in";
                activeFade.t = Math.max(0, 1 - activeFade.t);
              }
            }
            // Only reinitialize existing lights if edges changed strictly for non-actor sectors touching THIS light
            // (when actorEdgesChanged is true, `initializeLighting: true` below reinitializes all sources once!)
            if (edgesChanged && !actorEdgesChanged) {
              const meta = this.lightBatch.lightMetaById.get(lid);
              if (lightTouchesChangedSector(meta)) {
                ls.initialize(ls.data);
                lightsChanged = true;
              }
            }
            continue;
          } else if (existingLs) {
            this._lightFades.delete(lid);
            this.dynamicLights.delete(lid);
          }
          // Spread viewport-only promotions across tiny slices (<= 2 lights & <= 1.6ms/tick) to eliminate zoom/levelSwitch spikes
          if (vpAnimOnlyIds.has(lid)) {
            if (newVpPromotes >= MAX_NEW_VP_PROMOTES_PER_TICK || (newVpPromotes > 0 && (performance.now() - tVpStart) >= VP_PROMOTE_BUDGET_MS)) {
              moreVpAnimPending = true;
              continue;
            }
          }
          const meta = this.lightBatch.lightMetaById.get(lid);
          if (!meta) continue;
          const [lx, ly, dimFt, brightFt, color, alpha, anim] = meta.raw;
          const ls = new LightCls({ sourceId: `MegaLight.${lid}` });
          const isVpOnly = vpAnimOnlyIds.has(lid);
          ls._boundlessVpAnimOnly = isVpOnly;
          const initData = {
            x: lx, y: ly, level: meta.levelId, elevation: meta.elevation,
            walls: meta.walls !== false, vision: false,
            angle: meta.angle ?? 360,
            rotation: meta.rotation ?? 0,
            dim: (dimFt || 0) * pxPerFt, bright: (brightFt || 0) * pxPerFt,
            color, alpha,
            attenuation: meta.attenuation ?? 0.5,
            luminosity: meta.luminosity ?? 0.5,
            darkness: { min: meta.darkMin ?? 0, max: meta.darkMax ?? 1 },
            animation: anim ? { type: anim, speed: meta.speed ?? 3, intensity: meta.intensity ?? 3 } : {}
          };
          if (Number.isFinite(meta.coloration)) initData.coloration = meta.coloration;
          ls.initialize(initData);
          ls.add();
          this.dynamicLights.set(lid, ls);
          if (isVpOnly && !this._mounting) {
            // Seamless 220ms coloration crossfade (illumination blends seamlessly via MAX_COLOR!)
            this.lightBatch.setLightWeight(lid, 1.0);
            this._lightFades.set(lid, { dir: "in", t: 0, dur: 220, ls, baseColorAlpha: null, baseBgAlpha: null });
          } else {
            this.lightBatch.setLightWeight(lid, 0.0);
          }
          this._emit("dynamicLightMount", { id: lid, light: ls, meta });
          lightsChanged = true;
          if (isVpOnly) newVpPromotes++;
        }

        this.lastDynLightKey = moreVpAnimPending ? null : dynKey;
      }

      this.lightBatch.flushWeights();

      if (actorEdgesChanged || lightsChanged) {
        canvas.perception.update({
          initializeVision: actorEdgesChanged,
          initializeLighting: actorEdgesChanged,
          initializeSounds: actorEdgesChanged,
          refreshLightSources: lightsChanged && !actorEdgesChanged,
          refreshLighting: true,
          refreshVision: actorEdgesChanged
        });
        // Flush perception synchronously so MegaLightBatch weight changes and native PointLightSource meshes
        // swap atomically within the exact same frame (eliminates 1-frame dark flicker during handoff!).
        if (!this._mounting && typeof canvas.perception.applyRenderFlags === "function") {
          canvas.perception.applyRenderFlags();
        }
        // Apply initial alpha=0 on newly fading-in viewport lights right after meshes are drawn
        if (this._lightFades.size > 0) {
          this._stepDynamicLightFades(0);
        }
      } else {
        this.lightBatch.attachTo(canvas.effects);
      }

      if (moreVpAnimPending && !this._mounting) {
        this.scheduleViewportLightSync(24);
      }
    } finally {
      this._updatingBubbles = false;
    }
  },

  _finishLightFadeImmediate(lid, keepLight = true) {
    const f = this._lightFades.get(lid);
    if (!f) return;
    this._lightFades.delete(lid);
    const colU = f.ls?.layers?.coloration?.mesh?.shader?.uniforms;
    const bgU = f.ls?.layers?.background?.mesh?.shader?.uniforms;
    if (colU && f.baseColorAlpha !== null) colU.colorationAlpha = f.baseColorAlpha;
    if (bgU && f.baseBgAlpha !== null) bgU.backgroundAlpha = f.baseBgAlpha;
    if (keepLight) {
      this.lightBatch.setLightWeight(lid, 0.0);
    }
  },

  _stepDynamicLightFades(dtMs) {
    if (!this._lightFades || this._lightFades.size === 0) return;
    const dt = dtMs > 0 ? Math.min(50, dtMs) : 0;
    let weightsDirty = false;
    let retiredAny = false;
    let retiresThisFrame = 0;

    for (const [lid, f] of Array.from(this._lightFades.entries())) {
      const ls = f.ls;
      if (isLightSourceDead(ls) || this.dynamicLights.get(lid) !== ls) {
        this._lightFades.delete(lid);
        if (this.dynamicLights.get(lid) === ls) {
          this.dynamicLights.delete(lid);
          this.lightBatch.setLightWeight(lid, 1.0);
          weightsDirty = true;
          this.lastDynLightKey = null;
        }
        continue;
      }

      const colU = ls.layers?.coloration?.mesh?.shader?.uniforms;
      const bgU = ls.layers?.background?.mesh?.shader?.uniforms;
      if (f.baseColorAlpha === null && colU && Number.isFinite(colU.colorationAlpha)) {
        f.baseColorAlpha = colU.colorationAlpha;
      }
      if (f.baseBgAlpha === null && bgU && Number.isFinite(bgU.backgroundAlpha)) {
        f.baseBgAlpha = bgU.backgroundAlpha;
      }

      if (dt > 0) {
        f.t = Math.min(1.0, f.t + dt / f.dur);
      }
      const ease = f.t * f.t * (3 - 2 * f.t); // smoothstep

      if (f.dir === "in") {
        const shaderFactor = ease;
        const batchWeight = 1.0 - ease;
        if (colU && f.baseColorAlpha !== null) colU.colorationAlpha = f.baseColorAlpha * shaderFactor;
        if (bgU && f.baseBgAlpha !== null) bgU.backgroundAlpha = f.baseBgAlpha * shaderFactor;
        this.lightBatch.setLightWeight(lid, batchWeight);
        weightsDirty = true;
        if (f.t >= 1.0) {
          if (colU && f.baseColorAlpha !== null) colU.colorationAlpha = f.baseColorAlpha;
          if (bgU && f.baseBgAlpha !== null) bgU.backgroundAlpha = f.baseBgAlpha;
          this.lightBatch.setLightWeight(lid, 0.0);
          this._lightFades.delete(lid);
        }
      } else {
        const shaderFactor = 1.0 - ease;
        const batchWeight = ease;
        if (colU && f.baseColorAlpha !== null) colU.colorationAlpha = f.baseColorAlpha * shaderFactor;
        if (bgU && f.baseBgAlpha !== null) bgU.backgroundAlpha = f.baseBgAlpha * shaderFactor;
        this.lightBatch.setLightWeight(lid, batchWeight);
        weightsDirty = true;
        if (f.t >= 1.0 && retiresThisFrame < 2) {
          this._lightFades.delete(lid);
          this._emit("dynamicLightRetire", { id: lid, light: ls, meta: this.lightBatch.lightMetaById.get(lid) || null });
          ls.destroy();
          this.dynamicLights.delete(lid);
          this.lightBatch.setLightWeight(lid, 1.0);
          retiredAny = true;
          retiresThisFrame++;
        }
      }
    }

    if (weightsDirty) this.lightBatch.flushWeights();
    if (retiredAny && canvas?.perception?.update) {
      canvas.perception.update({ refreshLightSources: true, refreshLighting: true });
    }
  },

  scheduleLightBatchRebuild() {
    if (this._lightRebuildScheduled) return;
    this._lightRebuildScheduled = true;
    const mountGen = this._mountGen;
    queueMicrotask(() => {
      this._lightRebuildScheduled = false;
      if (!this.active || this._mountGen !== mountGen || !this.visibleLevelLayers.length || !canvas?.ready) return;
      const pxPerFt = canvas.dimensions.size / canvas.dimensions.distance;
      const sceneId = canvas.scene?.id;
      const worldId = game.world?.id || "world";
      const visibleLevelIds = this.visibleLevelLayers.map(l => l.level.id);
      this.lightBatch.build(
        this.visibleLevelLayers,
        pxPerFt,
        (lid, kind, sk, idx, raw) => this.resolveVirtualWall(lid, kind, sk, idx, raw),
        (lid, sk, idx, raw, lvl) => this.resolveVirtualLight(lid, sk, idx, raw, lvl),
        {
          ...this._getLightBatchBuildOpts(),
          timeSliceThreshold: 80,
          syncBudgetMs: 12,
          deferredBudgetMs: 6,
          onDeferredPolysReady: () => {
            if (!this.active || this._mountGen !== mountGen || canvas.scene?.id !== sceneId) return;
            this.scheduleLightBatchRebuild();
            if (sceneId) this.lightBatch.persistPolyCacheToDB(worldId, sceneId, visibleLevelIds).catch(() => {});
          }
        }
      );
      if (this.lightBatch.lastPolyCacheMisses > 0 && this.lightBatch._deferredBakeRaf === null && sceneId) {
        this.lightBatch.persistPolyCacheToDB(worldId, sceneId, visibleLevelIds).catch(() => {});
      }
      // Re-queue GPU light baking for all resident chunks on chunked worlds so edits never wipe chunk lights
      this.chunkStreamer.requeueAllLoadedChunks();
      this._syncIndoorLightVisibility();
      this.lightBatch.syncDarknessLevel(canvas.environment?.darknessLevel ?? 0);
      // On chunked worlds wait for async chunk bakes (`onChunkBaked`) instead of wiping dynamicLights against empty lightMetaById
      if (!(this.chunkStreamer.states.size > 0 && this.lightBatch.totalLights === 0)) {
        this.updateSimAndLightBubbles(true);
      }
      this.lightBatch.attachTo(canvas.effects);
      this.lightBatch.updateViewport(this.getViewportWorldRect(0.28));
      this._depthElevSyncNeeded = true;
      this._optimizeEffectsLayers(canvas.effects);
    });
  },

  // ===== Networked & Persisted Door Synchronization =====

  _ensureSocket() {
    if (this._socketRegistered || !game.socket) return;
    this._socketRegistered = true;
    game.socket.on(SOCKET_NAME, (payload) => this._onSocketMessage(payload));
  },

  _clearClosingDoorTimer(dKey) {
    const t = this.closingDoorTimers?.get?.(dKey);
    if (t) {
      clearTimeout(t);
      this.closingDoorTimers.delete(dKey);
    }
  },

  _resolveDoorByKey(dKey) {
    if (typeof dKey !== "string" || !dKey.includes("::")) return null;
    const sep = dKey.indexOf("::");
    const levelId = dKey.slice(0, sep);
    const rest = dKey.slice(sep + 2);
    const parts = rest.split("_");
    if (parts.length !== 3) return null;
    const sx = Number(parts[0]), sy = Number(parts[1]);
    const isConvertedWall = parts[2].startsWith("w");
    const idx = Number(isConvertedWall ? parts[2].slice(1) : parts[2]);
    if (!Number.isInteger(sx) || !Number.isInteger(sy) || !Number.isInteger(idx) || sx < 0 || sy < 0 || idx < 0) return null;
    const sk = `${sx}_${sy}`;
    const layer = this.levelLayers.get(levelId);
    const sec = layer?.spec?.sectors?.[sk];
    const raw = isConvertedWall ? sec?.w?.[idx] : sec?.d?.[idx];
    if (!raw) return null;
    const seg = this.resolveVirtualWall(levelId, isConvertedWall ? "w" : "d", sk, idx, raw);
    if (!seg || !seg.door) return null;
    const [x1, y1, x2, y2] = seg.c;
    return {
      dKey,
      eid: isConvertedWall ? `mw_${levelId}_${sk}_${idx}` : `md_${dKey}`,
      levelId,
      sx,
      sy,
      ptA: { x: x1, y: y1 },
      ptB: { x: x2, y: y2 },
      move: seg.move ?? 20,
      sight: seg.sight ?? 20,
      light: seg.light ?? 20,
      darkness: seg.darkness ?? seg.light ?? 20,
      sound: seg.sound ?? 20,
      dir: seg.dir || 0,
      doorType: seg.door,
      defaultDs: seg.ds,
      doorSound: seg.doorSound || "",
      threshold: seg.threshold || null
    };
  },

  _normalizeDoorState(val, fallback = 0) {
    if (val === true) return 1;
    if (val === false) return 0;
    const n = Number(val);
    return (n === 0 || n === 1 || n === 2) ? n : fallback;
  },

  getCurrentDoorState(dKey, defaultDs = 0) {
    return this.doorStates.has(dKey) ? this.doorStates.get(dKey) : defaultDs;
  },

  _restoreDoorStates(scene) {
    this.doorStates.clear();
    this.openDoors.clear();
    const savedStates = scene?.flags?.[MODULE_ID]?.doorStates;
    if (!savedStates || typeof savedStates !== "object") return;
    for (const [dKey, rawVal] of Object.entries(savedStates)) {
      if (rawVal === null || rawVal === undefined) continue;
      const info = this._resolveDoorByKey(dKey);
      const ds = this._normalizeDoorState(rawVal, info?.defaultDs ?? 0);
      this.doorStates.set(dKey, ds);
      if (info && ((ds === 1) !== (info.defaultDs === 1))) {
        const dx = (info.ptA.x + info.ptB.x) * 0.5;
        const dy = (info.ptA.y + info.ptB.y) * 0.5;
        this.openDoors.set(dKey, { levelId: info.levelId, x: dx, y: dy, sx: info.sx, sy: info.sy, eid: info.eid });
      }
    }
  },

  _reconcileChunkDoorStates(layer, chunkData) {
    if (!layer || !chunkData?.sectors || !this.doorStates.size) return;
    const lid = layer.level.id;
    const prefix = `${lid}::`;
    for (const [dKey, ds] of this.doorStates) {
      if (!dKey.startsWith(prefix)) continue;
      const info = this._resolveDoorByKey(dKey);
      if (!info) continue;
      const sk = `${info.sx}_${info.sy}`;
      if (!chunkData.sectors[sk]) continue;
      const differsFromBaked = (ds === 1) !== (info.defaultDs === 1);
      if (differsFromBaked) {
        const dx = (info.ptA.x + info.ptB.x) * 0.5;
        const dy = (info.ptA.y + info.ptB.y) * 0.5;
        this.openDoors.set(dKey, { levelId: info.levelId, x: dx, y: dy, sx: info.sx, sy: info.sy, eid: info.eid });
      } else {
        this.openDoors.delete(dKey);
      }
    }
  },

  _applyDoorStateLocal(info, targetDs, { playSound = true, deferRefresh = false, skipDeferRebake = false } = {}) {
    const { dKey, eid, levelId, sx, sy, ptA, ptB, defaultDs } = info;
    const ds = this._normalizeDoorState(targetDs, defaultDs);
    const curDs = this.getCurrentDoorState(dKey, defaultDs);
    if (curDs === ds) return false;

    const EdgeCls = foundry.canvas.geometry.edges.Edge;
    const layer = this.levelLayers.get(levelId);
    const level = layer?.level || canvas.level;
    const dx = (ptA.x + ptB.x) * 0.5, dy = (ptA.y + ptB.y) * 0.5;

    this.doorStates.set(dKey, ds);
    const isOpen = ds === 1;
    const wasOpen = curDs === 1;
    const differsFromBaked = isOpen !== (defaultDs === 1);

    if (isOpen) {
      level?.edges?.delete(eid);
    } else if (this.simSectors.has(`${levelId}::${sx}_${sy}`)) {
      const pxPerFt = (canvas.dimensions?.size || 100) / Math.max(0.001, Number(canvas.dimensions?.distance) || 5);
      const threshold = buildEdgeThresholdPx(info.threshold, pxPerFt);
      level?.edges?.set(eid, new EdgeCls(ptA, ptB, {
        id: eid, type: "wall",
        move: info.move ?? 20,
        sight: info.sight ?? 20,
        light: info.light ?? 20,
        darkness: info.darkness ?? info.light ?? 20,
        sound: info.sound ?? 20,
        direction: info.dir || 0,
        ...(threshold ? { threshold } : {})
      }));
    }

    const prevCloseTimer = this.closingDoorTimers.get(dKey);
    if (prevCloseTimer) {
      clearTimeout(prevCloseTimer);
      this.closingDoorTimers.delete(dKey);
    }

    const mountedWall = this.wallEditor?.mountedByDoorKey?.get(dKey)?.wall;
    const deferRebakeMs = (!skipDeferRebake && !differsFromBaked && isOpen !== wasOpen
      && mountedWall && !mountedWall.destroyed && mountedWall.hasDoorMesh && mountedWall.doorMeshes?.size
      && globalThis.showstopper?.doorLighting?.isEnabled?.())
      ? (Number(mountedWall.document?.animation?.duration) || 750)
      : 0;

    if (differsFromBaked || deferRebakeMs > 0) {
      this.openDoors.set(dKey, { levelId, x: dx, y: dy, sx, sy, eid });
    } else {
      this.openDoors.delete(dKey);
    }

    // Drive native Wall._onUpdate (DoorControl icon, DoorMesh animation, native door sound)
    const mountedUpdated = Boolean(this.wallEditor.applyDoorStateToMounted(dKey, ds, { playSound }));

    if (deferRebakeMs > 0) {
      let deferRetries = 0;
      const runCloseRebake = () => {
        this.closingDoorTimers.delete(dKey);
        if (!this.active) return;
        const nowOpen = this.getCurrentDoorState(dKey, defaultDs) === 1;
        if (nowOpen !== (defaultDs === 1)) return;
        // Wait if Showstopper / DoorMesh CanvasAnimation is still in progress (e.g. tab was backgrounded)
        const anims = foundry.canvas?.animation?.CanvasAnimation?.animations ?? globalThis.CanvasAnimation?.animations;
        const wallId = mountedWall?.id;
        let stillAnimating = false;
        if (anims && wallId && deferRetries < 20) {
          const prefix = `Door.${wallId}.`;
          for (const k in anims) {
            if (k.startsWith(prefix)) { stillAnimating = true; break; }
          }
        }
        if (stillAnimating) {
          deferRetries++;
          this.closingDoorTimers.set(dKey, setTimeout(runCloseRebake, 100));
          return;
        }
        this.openDoors.delete(dKey);
        this.updateSimAndLightBubbles(false);
        let needDarknessRebuild = false;
        const reinitSeen = new Set();
        for (const [, ls] of this.dynamicLights) {
          if (isLightSourceDead(ls) || ls.data?.level !== levelId) continue;
          const r = (ls.radius || ls.data?.dim || 600) + 150;
          if (Math.hypot(ls.x - dx, ls.y - dy) <= r) {
            ls.initialize();
            reinitSeen.add(ls);
          }
        }
        for (const ls of canvas.effects?.lightSources ?? []) {
          if (!ls?.active || reinitSeen.has(ls) || ls.data?.walls === false) continue;
          const lsLvl = ls.level?.id ?? ls.data?.level;
          if (lsLvl && lsLvl !== levelId) continue;
          const r = (ls.radius || ls.data?.dim || 600) + 150;
          if (Math.hypot(ls.x - dx, ls.y - dy) <= r) ls.initialize();
        }
        for (const dsSrc of canvas.effects?.darknessSources ?? []) {
          if (!dsSrc?.active || dsSrc.data?.walls === false) continue;
          const dsLvl = dsSrc.level?.id ?? dsSrc.data?.level;
          if (dsLvl && dsLvl !== levelId) continue;
          const r = (dsSrc.radius || 600) + 150;
          if (Math.hypot(dsSrc.x - dx, dsSrc.y - dy) <= r) {
            needDarknessRebuild = true;
            break;
          }
        }
        canvas.perception?.update({
          initializeLighting: needDarknessRebuild,
          refreshLightSources: true,
          refreshLighting: true,
          refreshVision: true
        });
      };
      this.closingDoorTimers.set(dKey, setTimeout(runCloseRebake, deferRebakeMs + 60));
    }

    if (isOpen !== wasOpen && !deferRefresh) {
      const hasAnimatedDoorLighting = Boolean(
        mountedUpdated && mountedWall && !mountedWall.destroyed && mountedWall.hasDoorMesh && mountedWall.doorMeshes?.size
        && globalThis.showstopper?.doorLighting?.isEnabled?.()
      );
      this.updateSimAndLightBubbles(false);
      if (!hasAnimatedDoorLighting) {
        let needDarknessRebuild = false;
        for (const ls of canvas.effects?.lightSources ?? []) {
          if (!ls?.active || ls.data?.walls === false) continue;
          const lsLvl = ls.level?.id ?? ls.data?.level;
          if (lsLvl && lsLvl !== levelId) continue;
          const r = (ls.radius || ls.data?.dim || 600) + 150;
          if (Math.hypot(ls.x - dx, ls.y - dy) <= r) ls.initialize();
        }
        for (const dsSrc of canvas.effects?.darknessSources ?? []) {
          if (!dsSrc?.active || dsSrc.data?.walls === false) continue;
          const dsLvl = dsSrc.level?.id ?? dsSrc.data?.level;
          if (dsLvl && dsLvl !== levelId) continue;
          const r = (dsSrc.radius || 600) + 150;
          if (Math.hypot(dsSrc.x - dx, dsSrc.y - dy) <= r) {
            needDarknessRebuild = true;
            break;
          }
        }
        canvas.perception.update({
          initializeVision: true,
          initializeLighting: needDarknessRebuild,
          initializeSounds: true,
          refreshLightSources: true,
          refreshLighting: true,
          refreshVision: true
        });
      } else {
        canvas.perception.update({
          initializeVision: true,
          initializeSounds: true,
          refreshLighting: true,
          refreshVision: true
        });
      }
    }
    return true;
  },

  async _onSocketMessage(payload) {
    if (!payload || typeof payload !== "object" || !this.active || payload.sceneId !== canvas.scene?.id) return;
    if (payload.senderId === game.user?.id) return;

    if (this.fogManager.handleSocketMessage(payload)) return;

    // Never mutate door state / level.edges from unauthenticated client `doorState` socket messages
    // (authoritative GM->client state propagates strictly via server-validated Scene flags in `onSceneUpdate`).
    if (payload.type !== "doorRequest") return;

    // Only the single active GM persists player door requests via authoritative `scene.update`
    if (game.users.activeGM?.id !== game.user?.id) return;
    const info = this._resolveDoorByKey(payload.dKey);
    if (!info) return;

    const targetDs = payload.ds !== undefined
      ? this._normalizeDoorState(payload.ds, info.defaultDs)
      : (payload.isOpen ? 1 : 0);

    const curDs = this.getCurrentDoorState(info.dKey, info.defaultDs);
    if (info.doorType === 2 || curDs === 2 || targetDs === 2) {
      return;
    }
    this._applyDoorStateLocal(info, targetDs, { playSound: true });
    await canvas.scene.update({ [`flags.${MODULE_ID}.doorStates.${info.dKey}`]: targetDs });
  },

  requestDoorState(dKey, targetDs, { playSound = true } = {}) {
    const info = this._resolveDoorByKey(dKey);
    if (!info) return;
    const ds = this._normalizeDoorState(targetDs, info.defaultDs);
    const curDs = this.getCurrentDoorState(dKey, info.defaultDs);

    if (!game.user.isGM) {
      if (info.doorType === 2 || curDs === 2 || ds === 2) return;
      if (!game.users?.activeGM) return;
    }

    if (game.user.isGM) {
      this._pendingDoorCommits ??= new Map();
      const seq = (this._pendingDoorCommits.get(dKey) || 0) + 1;
      this._pendingDoorCommits.set(dKey, seq);
      this._applyDoorStateLocal(info, ds, { playSound });
      canvas.scene?.update({ [`flags.${MODULE_ID}.doorStates.${dKey}`]: ds })
        .catch(err => {
          console.warn(`${MODULE_ID} | Failed to persist door state:`, err);
          if (this._pendingDoorCommits?.get(dKey) === seq && this.active) {
            const persisted = canvas.scene?.flags?.[MODULE_ID]?.doorStates?.[dKey];
            const revertDs = persisted !== undefined ? persisted : info.defaultDs;
            this._applyDoorStateLocal(info, revertDs, { playSound: false, skipDeferRebake: true });
          }
        })
        .finally(() => {
          if (this._pendingDoorCommits?.get(dKey) === seq) {
            this._pendingDoorCommits.delete(dKey);
          }
        });
    } else {
      game.socket?.emit(SOCKET_NAME, {
        type: "doorRequest",
        sceneId: canvas.scene?.id,
        dKey,
        ds,
        senderId: game.user.id
      });
    }
  },

  _scheduleChunkBatchRefresh({ needPyramid = true, roofBakeLayer = null, roofBakeChunkData = null } = {}) {
    if (needPyramid) this._chunkRefreshNeedPyramid = true;
    if (roofBakeLayer) {
      this._chunkRoofBakeLayer = roofBakeLayer;
      this._chunkRoofBakeChunkData = roofBakeChunkData;
    }
    if (this._chunkRefreshQueued) return;
    this._chunkRefreshQueued = true;
    const mountGen = this._mountGen;
    queueMicrotask(() => {
      const doPyramid = Boolean(this._chunkRefreshNeedPyramid);
      const bakeLayer = this._chunkRoofBakeLayer;
      const bakeChunkData = this._chunkRoofBakeChunkData;
      this._chunkRefreshQueued = false;
      this._chunkRefreshNeedPyramid = false;
      this._chunkRoofBakeLayer = null;
      this._chunkRoofBakeChunkData = null;
      if (!this.active || this._mountGen !== mountGen) return;

      if (bakeLayer && !bakeLayer.spec?.roofMaskUrl) {
        const isSuperGrid = Boolean(bakeLayer.spec?.superGrid);
        const regionPx = bakeLayer.spec?.superGrid?.regionPx || 100000;
        const b = bakeChunkData?.bounds || { x: 0, y: 0, w: regionPx, h: regionPx };
        const isFullSuperGridProvince = isSuperGrid && (b.w === regionPx && b.h === regionPx);
        if (isFullSuperGridProvince) {
          if (!this.lightBatch.bakedRoofMask && !this._roofMaskBaking && bakeChunkData?.overlays) {
            const ovList = Array.isArray(bakeChunkData.overlays) ? bakeChunkData.overlays : Object.values(bakeChunkData.overlays);
            this._bakeRoofMaskFromList(ovList, {
              originX: b.x || 0,
              originY: b.y || 0,
              regionW: b.w || regionPx,
              regionH: b.h || regionPx,
              repeat: true
            });
          }
        } else {
          const allOvs = Object.values(bakeLayer.spec.overlays || {});
          let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
          for (const ov of allOvs) {
            if (!ov?.roof || ov.walls?.includes("anchor_")) continue;
            const r = Math.hypot(ov.w || 0, ov.h || 0) * 0.5;
            if (ov.cx - r < minX) minX = ov.cx - r;
            if (ov.cy - r < minY) minY = ov.cy - r;
            if (ov.cx + r > maxX) maxX = ov.cx + r;
            if (ov.cy + r > maxY) maxY = ov.cy + r;
          }
          if (minX < maxX && minY < maxY) {
            this._bakeRoofMaskFromList(allOvs, {
              originX: minX,
              originY: minY,
              regionW: maxX - minX,
              regionH: maxY - minY,
              repeat: false
            });
          }
        }
      }

      if (doPyramid && !this._inUpdatePyramid) {
        this.updatePyramid();
      }
      this.updateSimAndLightBubbles(true);
      this.wallEditor.syncViewport(true);
      this.layerEditors.syncViewport(true);
    });
  },

  onChunkLoaded(layer, chunkKey, chunkData) {
    if (!this.active || !layer) return;
    // Queue non-blocking time-sliced GPU light baking for this chunk (<= 6ms/frame)
    this.lightBatch.queueChunkBake(layer, chunkKey, chunkData);

    // Reconcile persisted door states that belong to sectors in this newly loaded chunk
    this._reconcileChunkDoorStates(layer, chunkData);

    // Invalidate spatial caches so roofs, walls, doors, audio, editors, and sim-bubbles pick up newly loaded sectors
    layer.lastOverlayKey = "";
    layer.lastTileKey = "";
    this.lastSimKey = null;
    this.lastDynLightKey = null;
    this.audioStreamer.lastKey = null;
    this._roofTokenOccDirty = true;

    const needsRoofBake = Boolean(chunkData?.overlays && !layer.spec?.roofMaskUrl);
    this._scheduleChunkBatchRefresh({
      needPyramid: true,
      roofBakeLayer: needsRoofBake ? layer : null,
      roofBakeChunkData: needsRoofBake ? chunkData : null
    });
  },

  onChunkUnloaded(layer, chunkKey, { deferRefresh = false } = {}) {
    if (!layer) return;
    this.lightBatch.detachChunk(layer.level.id, chunkKey);
    // Drop openDoors entries whose sectors were unloaded with this chunk
    const lid = layer.level.id;
    const sectors = layer.spec?.sectors;
    for (const [dKey, door] of this.openDoors) {
      if (door.levelId === lid && !sectors?.[`${door.sx}_${door.sy}`]) {
        this._clearClosingDoorTimer(dKey);
        this.openDoors.delete(dKey);
      }
    }
    layer.lastOverlayKey = "";
    layer.lastTileKey = "";
    this.lastSimKey = null;
    this.lastDynLightKey = null;
    this.audioStreamer.lastKey = null;
    this._roofTokenOccDirty = true;
    if (this.active) {
      this._scheduleChunkBatchRefresh({ needPyramid: !deferRefresh && !this._inUpdatePyramid });
    }
  }
};
