import { LRUTextureManager } from "./texture-manager.mjs";
import { NOOP_TRANSFORM } from "./boundless-pyramid.mjs";
import {
  MODULE_ID,
  isTextureUsable,
  getLevelBaseElevation,
  getLevelBottomElevation,
  getLevelRoofElevation,
  getVirtualTileBounds,
  hasSpecOverlays,
  isPointUnderRoofSpec
} from "./utils.mjs";

const SUPPORT_SOLE_KERNEL = [
  [0, 0, 4],
  [-0.7, -0.7, 1.5],
  [0.7, -0.7, 1.5],
  [0.7, 0.7, 1.5],
  [-0.7, 0.7, 1.5]
];

function meshSupportsSole(mesh, x, y, radius, alphaThreshold = 0.25) {
  let hitWeight = 0;
  for (let k = 0; k < SUPPORT_SOLE_KERNEL.length; k++) {
    const [kx, ky, w] = SUPPORT_SOLE_KERNEL[k];
    if (meshContainsPointPixelSafe(mesh, x + kx * radius, y + ky * radius, alphaThreshold)) {
      hitWeight += w;
      if (hitWeight >= 5) return true;
    }
  }
  return false;
}

function meshContainsPointPixelSafe(mesh, x, y, alphaThreshold = 0.25) {
  if (!mesh || mesh.destroyed) return false;
  if (typeof mesh.containsCanvasPoint === "function") {
    try {
      return Boolean(mesh.containsCanvasPoint({ x, y }, alphaThreshold));
    } catch {}
  }
  if (typeof mesh.containsPixel === "function") {
    try {
      return Boolean(mesh.containsPixel(x, y, alphaThreshold));
    } catch {}
  }
  const b = mesh.canvasBounds;
  if (b) {
    const minX = Number.isFinite(b.x) ? b.x : b.minX;
    const minY = Number.isFinite(b.y) ? b.y : b.minY;
    const maxX = Number.isFinite(b.x) && Number.isFinite(b.width) ? (b.x + b.width) : b.maxX;
    const maxY = Number.isFinite(b.y) && Number.isFinite(b.height) ? (b.y + b.height) : b.maxY;
    if (Number.isFinite(minX) && Number.isFinite(maxX)) {
      return x >= minX && x <= maxX && y >= minY && y <= maxY;
    }
  }
  return false;
}

function resolveSortLayer(value, fallback) {
  if (typeof value === "number") return value;
  const layers = foundry.canvas?.groups?.PrimaryCanvasGroup?.SORT_LAYERS;
  if (layers && typeof value === "string" && value in layers) return layers[value];
  return fallback;
}

function resolveOcclusionMode(modeSpec, fallback = CONST.OCCLUSION_MODES.NONE) {
  if (typeof modeSpec === "number") return modeSpec;
  if (Array.isArray(modeSpec)) {
    return modeSpec.reduce((acc, m) => {
      if (typeof m === "number") return acc | m;
      if (typeof m === "string" && m in CONST.OCCLUSION_MODES) return acc | CONST.OCCLUSION_MODES[m];
      return acc;
    }, CONST.OCCLUSION_MODES.NONE);
  }
  if (typeof modeSpec === "string" && modeSpec in CONST.OCCLUSION_MODES) {
    return CONST.OCCLUSION_MODES[modeSpec];
  }
  return fallback;
}

export const overlayMethods = {
  _isRoofRevealed(rm, occSurfaces) {
    if (!rm || !rm.visible || rm.occlusionMode === CONST.OCCLUSION_MODES.NONE) return false;
    if (rm.occluded) return true;
    if ((rm._occlusionState?.fade ?? 0) > 0.02) return true;
    if ((rm._hoverFadeState?.occlusion ?? 0) > 0.02) return true;
    if (occSurfaces?.size > 0 && rm.canvasBounds) {
      for (const s of occSurfaces) {
        if (s.elevation < rm.elevation && s.region?.bounds?.intersects(rm.canvasBounds)) return true;
      }
    }
    return false;
  },

  _ensureOverlayWallsMesh(fullId, layer, ovSpec) {
    const existing = this.activeOverlays.get(fullId);
    if (!existing || existing.wallsMesh || !existing.srcWalls || this.overlayPending.has(`${fullId}:w`)) return;
    const PrimaryCanvasGroup = foundry.canvas.groups.PrimaryCanvasGroup;
    const topElev = getLevelRoofElevation(layer.level);
    const lid = layer.level.id;
    const gen = this._mountGen;
    this.overlayPending.add(`${fullId}:w`);
    this.texMgr.load(existing.srcWalls, { mipmap: true, maxDim: 2048 }).then((tWalls) => {
      if (this._mountGen === gen && this.levelLayers.get(lid) === layer) {
        this.overlayPending.delete(`${fullId}:w`);
      }
      const cur = this.activeOverlays.get(fullId);
      if (!this.active || this._mountGen !== gen || this.levelLayers.get(lid) !== layer || !cur || cur.wallsMesh || !isTextureUsable(tWalls)) return;
      const wallsMesh = this.acquireMesh();
      wallsMesh.name = `Tile.BoundlessWalls.${fullId}`;
      wallsMesh.anchor.set(0.5, 0.5);
      wallsMesh.texture = tWalls;
      wallsMesh.tint = ovSpec.tint ?? 0xffffff;
      wallsMesh.position.set(ovSpec.cx, ovSpec.cy);
      wallsMesh.width = ovSpec.w;
      wallsMesh.height = ovSpec.h;
      wallsMesh.angle = ovSpec.rot || 0;
      wallsMesh.elevation = topElev;
      wallsMesh.sortLayer = PrimaryCanvasGroup.SORT_LAYERS.TILES;
      wallsMesh.sort = 15;
      wallsMesh.occlusionMode = CONST.OCCLUSION_MODES.NONE;
      wallsMesh.alpha = 1.0;
      wallsMesh.unoccludedAlpha = 1.0;
      wallsMesh.occludedAlpha = 1.0;
      wallsMesh.hoverFade = false;
      wallsMesh.restrictsLight = false;
      wallsMesh.restrictsWeather = false;
      const localZ = layer.lastTargetZ - layer.zOffset;
      const revealOnZ5 = localZ === 5 && this._isRoofRevealed(cur.roofMesh, canvas.masks?.occlusion?.occludedSurfaces);
      wallsMesh.visible = localZ >= 6 || revealOnZ5;
      canvas.primary.addChild(wallsMesh);
      wallsMesh.updateCanvasTransform?.();
      this._syncShowstopperMeshDof(wallsMesh);
      cur.wallsMesh = wallsMesh;
      canvas.primary.sortDirty = true;
      this._tilesDirty = true;
    });
  },

  async _bakeRoofMask(layers, sceneId, mountedLevelId) {
    const renderer = canvas?.app?.renderer;
    if (!renderer || !layers?.length) return;

    // Pick the primary layer carrying visible baked building roofs (prefer currently viewed level; skip lower roofs hidden under upper view)
    const viewedBottom = getLevelBottomElevation(canvas.level);
    const ordered = layers.length > 1
      ? layers.slice().sort((a, b) => (b.level?.isView ? 1 : 0) - (a.level?.isView ? 1 : 0))
      : layers;
    let targetLayer = null;
    let ovList = null;
    for (const l of ordered) {
      const topElev = getLevelRoofElevation(l.level);
      if (!l.level?.isView && viewedBottom >= topElev) continue;
      if (l.spec?.roofMaskUrl) {
        targetLayer = l;
        const rawOvs = l.spec?._superGridBase?.overlays || l.spec?.overlays;
        ovList = rawOvs ? (Array.isArray(rawOvs) ? rawOvs : Object.values(rawOvs)) : [];
        break;
      }
      const rawOvs = l.spec?._superGridBase?.overlays || l.spec?.overlays;
      if (!rawOvs) continue;
      const list = Array.isArray(rawOvs) ? rawOvs : Object.values(rawOvs);
      if (list.some(o => o?.roof && !o.walls?.includes("anchor_"))) {
        targetLayer = l;
        ovList = list;
        break;
      }
    }
    if (!targetLayer) return;

    const isSuperGrid = Boolean(targetLayer.spec?.superGrid);
    const regionW = isSuperGrid ? (targetLayer.spec.superGrid.regionPx || 100000) : (targetLayer.bounds?.w || 100000);
    const regionH = isSuperGrid ? (targetLayer.spec.superGrid.regionPx || 100000) : (targetLayer.bounds?.h || 100000);
    let originX = isSuperGrid ? 0 : (targetLayer.bounds?.x || 0);
    let originY = isSuperGrid ? 0 : (targetLayer.bounds?.y || 0);
    if (isSuperGrid && !targetLayer.spec._superGridBase && !targetLayer.spec.roofMaskUrl) {
      const firstRoof = ovList.find(o => o?.roof && !o.walls?.includes("anchor_") && Number.isFinite(o.cx) && Number.isFinite(o.cy));
      if (firstRoof) {
        originX = Math.floor(firstRoof.cx / regionW) * regionW;
        originY = Math.floor(firstRoof.cy / regionH) * regionH;
      }
    }
    const roofElevation = getLevelRoofElevation(targetLayer.level);

    return this._bakeRoofMaskFromList(ovList, {
      originX,
      originY,
      regionW,
      regionH,
      repeat: isSuperGrid,
      roofElevation,
      roofMaskUrl: targetLayer.spec?.roofMaskUrl || null,
      sceneId,
      mountedLevelId
    });
  },

  async _bakeRoofMaskFromList(ovList, { originX = 0, originY = 0, regionW = 100000, regionH = 100000, repeat = false, roofElevation = Infinity, roofMaskUrl = null, sceneId = canvas.scene?.id, mountedLevelId = canvas.level?.id } = {}) {
    const renderer = canvas?.app?.renderer;
    if (!renderer || (!ovList?.length && !roofMaskUrl)) return;

    const MAX_SPRITE_MASK_URLS = 24;
    const roofUrls = new Set();
    for (const ov of ovList || []) {
      if (ov?.roof && !ov.walls?.includes("anchor_")) roofUrls.add(ov.roof);
    }
    if (!roofUrls.size && !roofMaskUrl) return;

    const gen = ++this._roofMaskGen;
    this._roofMaskBaking = true;
    let rt = null;
    let container = null;
    try {
      const maxTex = renderer.gl?.getParameter?.(renderer.gl.MAX_TEXTURE_SIZE) || 2048;
      const maskSize = maxTex >= 2048 ? 2048 : 1024;

      let maskTex = null;
      let texByUrl = null;

      if (roofMaskUrl) {
        // Prebaked single-file roof alpha mask supplied by exporter (0 per-house texture loads!)
        maskTex = await this.texMgr.load(roofMaskUrl, { mipmap: false, isPinned: false });
        if (!this.active || this._roofMaskGen !== gen || canvas.scene?.id !== sceneId || canvas.level?.id !== mountedLevelId) {
          return;
        }
        if (!isTextureUsable(maskTex)) {
          maskTex = null;
          if (!roofUrls.size) return;
        }
      }
      if (!maskTex && roofUrls.size > 0 && roofUrls.size <= MAX_SPRITE_MASK_URLS) {
        // Small reusable template roof set (<= 24 shared textures): load into LRU cache without permanently pinning VRAM across levels
        const urlList = Array.from(roofUrls);
        const loaded = await Promise.all(urlList.map(url => this.texMgr.load(url, { mipmap: true, isPinned: false, maxDim: 2048 })));
        if (!this.active || this._roofMaskGen !== gen || canvas.scene?.id !== sceneId || canvas.level?.id !== mountedLevelId) {
          return;
        }
        texByUrl = new Map();
        for (let i = 0; i < urlList.length; i++) {
          if (isTextureUsable(loaded[i])) texByUrl.set(urlList[i], loaded[i]);
        }
        if (!texByUrl.size) texByUrl = null;
      }

      rt = PIXI.RenderTexture.create({
        width: maskSize,
        height: maskSize,
        scaleMode: PIXI.SCALE_MODES.LINEAR,
        mipmap: PIXI.MIPMAP_MODES.OFF,
        wrapMode: PIXI.WRAP_MODES.CLAMP
      });
      container = new PIXI.Container();

      const drawOvFootprint = (gfx, ov, sx, sy) => {
        const poly = Array.isArray(ov.poly) && ov.poly.length >= 6 ? ov.poly
          : (Array.isArray(ov.footprint) && ov.footprint.length >= 6 ? ov.footprint : null);
        if (poly) {
          const pts = new Array(poly.length);
          for (let i = 0; i < poly.length; i += 2) {
            pts[i] = (poly[i] - originX) * sx;
            pts[i + 1] = (poly[i + 1] - originY) * sy;
          }
          gfx.drawPolygon(pts);
        } else {
          const hw = (ov.w || 0) * 0.5;
          const hh = (ov.h || 0) * 0.5;
          if (hw <= 0 || hh <= 0) return;
          const rad = ((ov.rot || 0) * Math.PI) / 180;
          const c = Math.cos(rad);
          const s = Math.sin(rad);
          const cx = ov.cx - originX;
          const cy = ov.cy - originY;
          gfx.drawPolygon([
            (cx + (-hw * c - -hh * s)) * sx, (cy + (-hw * s + -hh * c)) * sy,
            (cx + (hw * c - -hh * s)) * sx, (cy + (hw * s + -hh * c)) * sy,
            (cx + (hw * c - hh * s)) * sx, (cy + (hw * s + hh * c)) * sy,
            (cx + (-hw * c - hh * s)) * sx, (cy + (-hw * s + hh * c)) * sy
          ]);
        }
      };

      if (maskTex) {
        const sp = new PIXI.Sprite(maskTex);
        sp.width = maskSize;
        sp.height = maskSize;
        container.addChild(sp);
      } else if (texByUrl) {
        const sx = maskSize / Math.max(1, regionW);
        const sy = maskSize / Math.max(1, regionH);
        const spriteLayer = new PIXI.Container();
        spriteLayer.scale.set(sx, sy);
        let fallbackGfx = null;
        for (const ov of ovList) {
          if (!ov?.roof || ov.walls?.includes("anchor_")) continue;
          const tex = texByUrl.get(ov.roof);
          if (isTextureUsable(tex)) {
            const sp = new PIXI.Sprite(tex);
            sp.anchor.set(0.5, 0.5);
            sp.position.set(ov.cx - originX, ov.cy - originY);
            sp.width = ov.w;
            sp.height = ov.h;
            sp.angle = ov.rot || 0;
            spriteLayer.addChild(sp);
          } else {
            if (!fallbackGfx) {
              fallbackGfx = new PIXI.Graphics();
              fallbackGfx.beginFill(0xffffff, 1.0);
            }
            drawOvFootprint(fallbackGfx, ov, sx, sy);
          }
        }
        container.addChild(spriteLayer);
        if (fallbackGfx) {
          fallbackGfx.endFill();
          container.addChild(fallbackGfx);
        }
      } else {
        // Large city with hundreds/thousands of unique roof textures (e.g. Kartograf exports):
        // NEVER preload or pin all roof textures at once (would blow VRAM!). Bake the macro roof mask
        // directly from manifest footprint geometry in ~2ms (0 network / 0 extra VRAM); individual roofs
        // stream strictly per-viewport at localZ >= 5 via syncOverlayMeshes() + LRUTextureManager.
        const sx = maskSize / Math.max(1, regionW);
        const sy = maskSize / Math.max(1, regionH);
        const gfx = new PIXI.Graphics();
        gfx.beginFill(0xffffff, 1.0);
        for (const ov of ovList) {
          if (!ov?.roof || ov.walls?.includes("anchor_")) continue;
          drawOvFootprint(gfx, ov, sx, sy);
        }
        gfx.endFill();
        container.addChild(gfx);
      }

      renderer.render(container, { renderTexture: rt, clear: true });
      container.destroy({ children: true, texture: false, baseTexture: false });
      container = null;

      this.lightBatch.setBakedRoofMask(rt, {
        originX,
        originY,
        regionW,
        regionH,
        repeat,
        roofElevation
      });
      rt = null;
      this._syncIndoorLightVisibility();
    } catch (err) {
      if (container && !container.destroyed) {
        try { container.destroy({ children: true, texture: false, baseTexture: false }); } catch {}
      }
      if (rt && !rt.destroyed) {
        try { rt.destroy(true); } catch {}
      }
      console.warn(`${MODULE_ID} | Failed baking roof mask:`, err);
    } finally {
      if (this._roofMaskGen === gen) this._roofMaskBaking = false;
    }
  },

  _syncIndoorLightVisibility() {
    if (!this.active || !this.lightBatch) return;
    const viewedBottom = getLevelBottomElevation(canvas.level);
    const curScale = canvas.stage?.scale?.x ?? 1;
    let wantMacroRoofMask = false;
    for (const layer of this.visibleLevelLayers) {
      if (!hasSpecOverlays(layer.spec?.overlays)) continue;
      const topElev = getLevelRoofElevation(layer.level);
      const hideRoofsForUpperView = !layer.level.isView && viewedBottom >= topElev;
      if (hideRoofsForUpperView) continue;
      if (!this._shouldMountRoofs(layer, curScale)) {
        wantMacroRoofMask = true;
        break;
      }
    }

    const prevHidden = this.lightBatch.hideIndoorLights;
    const prevBaked = this.lightBatch.useBakedRoofMask;
    const hasBakedMask = Boolean(this.lightBatch.bakedRoofMask && !this.lightBatch.bakedRoofMask.destroyed);

    let needRoofMaskNow = false;
    if (wantMacroRoofMask) {
      this._waitingForRoofsBeforeIndoor = true;
      needRoofMaskNow = true;
    } else if (this._waitingForRoofsBeforeIndoor) {
      // Wait until the first wave of interactive roof meshes is mounted and synced into CanvasDepthMask
      const roofsReady = this.overlayPending.size === 0
        && this.pendingOverlayMounts.length === 0
        && !this._depthElevSyncNeeded;
      if (roofsReady) {
        this._waitingForRoofsBeforeIndoor = false;
        needRoofMaskNow = false;
      } else {
        needRoofMaskNow = true;
      }
    }

    if (needRoofMaskNow) {
      if (hasBakedMask) {
        // Keep ALL lights (including indoor window glow!) active; baked pixel-accurate roof mask cuts roofs 1:1 with depthMask
        this.lightBatch.setUseBakedRoofMask(true);
        this.lightBatch.setIndoorLightsHidden(false);
      } else {
        // Fallback while bakedRoofMask is still loading or for chunked maps without a monolithic roof atlas
        this.lightBatch.setUseBakedRoofMask(false);
        this.lightBatch.setIndoorLightsHidden(true);
      }
    } else {
      this.lightBatch.setUseBakedRoofMask(false);
      this.lightBatch.setIndoorLightsHidden(false);
    }

    if (this.lightBatch.hideIndoorLights !== prevHidden || this.lightBatch.useBakedRoofMask !== prevBaked) {
      this.scheduleViewportLightSync(this.isActivelyMoving() ? 35 : 0);
    }
  },

  syncOverlayMeshes(layer, targetZ, vp) {
    const overlays = layer.spec?.overlays;
    if (!hasSpecOverlays(overlays)) return false;

    const PrimaryCanvasGroup = foundry.canvas.groups.PrimaryCanvasGroup;
    const { simGrid, simSectorPx, spec, level } = layer;
    const sectors = spec.sectors;
    const lid = level.id;
    const topElev = getLevelRoofElevation(level);
    const viewedBottom = getLevelBottomElevation(canvas.level);
    // If viewing an upper level above this level's top, hide lower-level roofs so upper floor tiles aren't covered
    const hideRoofsForUpperView = !level.isView && viewedBottom >= topElev;
    const localZ = targetZ - layer.zOffset;
    const showWalls = localZ >= 6;
    // Mount interactive roofs based on absolute screen cell size (pxPerCell >= 16px, with hysteresis),
    // not raw pyramid Z, so small or high-PPI (256 PPI) maps keep roofs & CanvasDepthMask lighting rock-solid across tactical zoom!
    const shouldMountRoofs = this._shouldMountRoofs(layer, vp.scale);
    const canReveal = shouldMountRoofs;

    const sx0 = Math.max(0, Math.floor(vp.x0 / simSectorPx));
    const sy0 = Math.max(0, Math.floor(vp.y0 / simSectorPx));
    const sx1 = Math.min(simGrid - 1, Math.floor(vp.x1 / simSectorPx));
    const sy1 = Math.min(simGrid - 1, Math.floor(vp.y1 / simSectorPx));

    const ovKey = shouldMountRoofs
      ? `on_${sx0}_${sy0}_${sx1}_${sy1}_${hideRoofsForUpperView ? 1 : 0}_${showWalls ? 2 : (canReveal ? 1 : 0)}`
      : `off_${hideRoofsForUpperView ? 1 : 0}`;
    if (ovKey === layer.lastOverlayKey) return false;
    layer.lastOverlayKey = ovKey;

    const neededOv = new Set();
    if (!shouldMountRoofs && this.pendingOverlayMounts.length > 0) {
      this.pendingOverlayMounts = this.pendingOverlayMounts.filter(item => {
        if (item?.lid === lid) {
          this._pendingOverlayKeys.delete(item.fullId);
          return false;
        }
        return true;
      });
    }
    if (shouldMountRoofs) {
      for (let sy = sy0; sy <= sy1; sy++) {
        for (let sx = sx0; sx <= sx1; sx++) {
          const sec = sectors?.[`${sx}_${sy}`];
          if (!sec?.o) continue;
          for (const oid of sec.o) {
            const ovSpec = overlays[oid];
            if (!ovSpec) continue;
            // At macro zoom (localZ < 6) only keep buildings that actually have a roof (no need for anchor foregrounds)
            if (!showWalls && (hideRoofsForUpperView || !ovSpec.roof)) continue;
            neededOv.add(`${lid}::${oid}`);
          }
        }
      }
    }

    const occSurfaces = canvas.masks?.occlusion?.occludedSurfaces;
    const wantOccMode = canReveal
      ? (CONST.OCCLUSION_MODES.FADE | CONST.OCCLUSION_MODES.RADIAL | CONST.OCCLUSION_MODES.SURFACE)
      : CONST.OCCLUSION_MODES.NONE;

    let changed = false;
    let retiredAnyRoof = false;
    for (const [fullId, ov] of this.activeOverlays) {
      if (ov.levelId !== lid) continue;
      if (!neededOv.has(fullId)) {
        // When zooming out from localZ >= 5 to localZ < 5 on a pyramid level, keep visible roofs mounted
        // (with occlusion disabled) until z<=4 baked-roof pyramid tiles finish covering the viewport so interiors never flash!
        if (!shouldMountRoofs && !hideRoofsForUpperView && layer.hasPyramid && ov.roofMesh && !ov.roofMesh.destroyed) {
          if (ov.wallsMesh) {
            this.retireMesh(ov.wallsMesh);
            ov.wallsMesh = null;
          }
          ov.retiring = true;
          if (ov.roofMesh.occlusionMode !== CONST.OCCLUSION_MODES.NONE) {
            ov.roofMesh.occlusionMode = CONST.OCCLUSION_MODES.NONE;
            ov.roofMesh.debounceSetOcclusion?.cancel?.();
            ov.roofMesh.occluded = false;
            this._occlusionDirty = true;
          }
          // Avoid 1-frame double light-cut (CanvasDepthMask + bakedRoofMask) while retiring roof waits for z<=4
          if (this.lightBatch?.bakedRoofMask && !this.lightBatch.bakedRoofMask.destroyed && ov.roofMesh.restrictsLight) {
            ov.roofMesh.restrictsLight = false;
            ov.roofMesh.updateCanvasTransform?.();
            this._markDepthDirty({ syncElev: true });
          }
          ov.roofMesh.hoverFade = false;
          ov.roofMesh.unoccludedAlpha = 1.0;
          this._tilesDirty = true;
          changed = true;
          continue;
        }
        const hadRoof = Boolean(ov.roofMesh);
        if (ov.roofMesh) this._emit("overlayRetire", { key: fullId, ov, mesh: ov.roofMesh });
        if (ov.wallsMesh) this.retireMesh(ov.wallsMesh);
        if (ov.roofMesh) this.retireMesh(ov.roofMesh);
        this.activeOverlays.delete(fullId);
        if (hadRoof) {
          this._markDepthDirty({ syncElev: true });
          retiredAnyRoof = true;
        }
        changed = true;
      } else {
        ov.retiring = false;
        if (hideRoofsForUpperView && ov.roofMesh) {
          this._emit("overlayRetire", { key: fullId, ov, mesh: ov.roofMesh });
          this.retireMesh(ov.roofMesh);
          ov.roofMesh = null;
          this._markDepthDirty({ syncElev: true });
          retiredAnyRoof = true;
          changed = true;
        } else if (ov.roofMesh) {
          if (!ov.roofMesh.restrictsLight) {
            ov.roofMesh.restrictsLight = true;
            ov.roofMesh.updateCanvasTransform?.();
            this._markDepthDirty({ syncElev: true });
          }
          if (ov.roofMesh.occlusionMode !== wantOccMode) {
            ov.roofMesh.occlusionMode = wantOccMode;
            if (!canReveal) {
              ov.roofMesh.debounceSetOcclusion?.cancel?.();
              ov.roofMesh.occluded = false;
            }
            this._occlusionDirty = true;
          }
          ov.roofMesh.hoverFade = canReveal;
        }
        const revealOnZ5 = localZ === 5 && ov.roofMesh && this._isRoofRevealed(ov.roofMesh, occSurfaces);
        if (ov.wallsMesh) ov.wallsMesh.visible = showWalls || revealOnZ5;
      }
    }
    if (retiredAnyRoof) this.invalidateShowstopperSurfaces();

    for (const fullId of neededOv) {
      if (this.activeOverlays.has(fullId)) {
        // Lazily load wallsMesh if this overlay was initially mounted at macro zoom with roof only
        const existing = this.activeOverlays.get(fullId);
        if (showWalls && !existing.wallsMesh && existing.srcWalls && existing.ovSpec) {
          this._ensureOverlayWallsMesh(fullId, layer, existing.ovSpec);
        }
        continue;
      }
      if (this.overlayPending.has(fullId) || this._pendingOverlayKeys.has(fullId)) continue;
      const rawOid = fullId.slice(fullId.indexOf("::") + 2);
      const ovSpec = overlays[rawOid];
      if (!ovSpec) continue;

      const needWalls = Boolean(showWalls && ovSpec.walls);
      const needRoof = Boolean(!hideRoofsForUpperView && ovSpec.roof);
      const syncWalls = needWalls ? this.texMgr.getSync(ovSpec.walls) : null;
      const syncRoof = needRoof ? this.texMgr.getSync(ovSpec.roof) : null;

      if ((!needWalls || syncWalls) && (!needRoof || syncRoof)) {
        if (syncWalls || syncRoof) {
          this._pendingOverlayKeys.add(fullId);
          this.pendingOverlayMounts.push({ fullId, lid, oid: rawOid, layer, ovSpec, topElev, tWalls: syncWalls, tRoof: syncRoof });
          changed = true;
        }
        continue;
      }

      const gen = this._mountGen;
      this.overlayPending.add(fullId);
      Promise.all([
        needWalls ? this.texMgr.load(ovSpec.walls, { mipmap: true, priority: 0, maxDim: 2048 }) : Promise.resolve(null),
        needRoof ? this.texMgr.load(ovSpec.roof, { mipmap: true, priority: 0, maxDim: 2048 }) : Promise.resolve(null)
      ]).then(([tWalls, tRoof]) => {
        if (this._mountGen === gen && this.levelLayers.get(lid) === layer) {
          this.overlayPending.delete(fullId);
        }
        if (!this.active || this._mountGen !== gen || this.levelLayers.get(lid) !== layer || this.activeOverlays.has(fullId) || this._pendingOverlayKeys.has(fullId)) return;
        const okWalls = isTextureUsable(tWalls) ? tWalls : null;
        const okRoof = isTextureUsable(tRoof) ? tRoof : null;
        if (!okWalls && !okRoof) return;
        this._pendingOverlayKeys.add(fullId);
        this.pendingOverlayMounts.push({ fullId, lid, oid: rawOid, layer, ovSpec, topElev, tWalls: okWalls, tRoof: okRoof });
      });
      changed = true;
    }

    return changed;
  },

  _mountOverlayMeshes(item, curVp) {
    const { fullId, lid, oid, layer, ovSpec, topElev } = item;
    if (!this.active || this.levelLayers.get(lid) !== layer || this.activeOverlays.has(fullId)) return false;
    const halfDiag = Math.hypot(ovSpec.w || 0, ovSpec.h || 0) * 0.5;
    const { simGrid, simSectorPx } = layer;
    const curSx0 = Math.max(0, Math.floor(curVp.x0 / simSectorPx));
    const curSy0 = Math.max(0, Math.floor(curVp.y0 / simSectorPx));
    const curSx1 = Math.min(simGrid - 1, Math.floor(curVp.x1 / simSectorPx));
    const curSy1 = Math.min(simGrid - 1, Math.floor(curVp.y1 / simSectorPx));
    const secX0 = curSx0 * simSectorPx;
    const secY0 = curSy0 * simSectorPx;
    const secX1 = (curSx1 + 1) * simSectorPx;
    const secY1 = (curSy1 + 1) * simSectorPx;
    if (ovSpec.cx + halfDiag < secX0 || ovSpec.cx - halfDiag > secX1 ||
        ovSpec.cy + halfDiag < secY0 || ovSpec.cy - halfDiag > secY1) {
      layer.lastOverlayKey = "";
      return false;
    }

    const PrimaryCanvasGroup = foundry.canvas.groups.PrimaryCanvasGroup;
    const localZNow = layer.lastTargetZ - layer.zOffset;
    const roofsMountedNow = this._shouldMountRoofs(layer, curVp?.scale ?? canvas.stage?.scale?.x ?? 1);
    if (!roofsMountedNow) return false;

    const tWalls = isTextureUsable(item.tWalls) ? item.tWalls : (item.tWalls && ovSpec.walls ? this.texMgr.getSync(ovSpec.walls) : null);
    const tRoof = isTextureUsable(item.tRoof) ? item.tRoof : (item.tRoof && ovSpec.roof ? this.texMgr.getSync(ovSpec.roof) : null);
    if ((item.tWalls && !tWalls) || (item.tRoof && !tRoof)) {
      layer.lastOverlayKey = "";
      return false;
    }
    if (!tWalls && !tRoof) return false;

    const ovTint = ovSpec.tint ?? 0xffffff;
    let wallsMesh = null;
    let roofMesh = null;

    if (tWalls) {
      wallsMesh = this.acquireMesh();
      wallsMesh.name = `Tile.BoundlessWalls.${fullId}`;
      wallsMesh.anchor.set(0.5, 0.5);
      wallsMesh.texture = tWalls;
      wallsMesh.tint = ovTint;
      wallsMesh.position.set(ovSpec.cx, ovSpec.cy);
      wallsMesh.width = ovSpec.w;
      wallsMesh.height = ovSpec.h;
      wallsMesh.angle = ovSpec.rot || 0;
      wallsMesh.elevation = topElev;
      wallsMesh.sortLayer = PrimaryCanvasGroup.SORT_LAYERS.TILES;
      wallsMesh.sort = 15;
      wallsMesh.occlusionMode = CONST.OCCLUSION_MODES.NONE;
      wallsMesh.alpha = 1.0;
      wallsMesh.unoccludedAlpha = 1.0;
      wallsMesh.occludedAlpha = 1.0;
      wallsMesh.hoverFade = false;
      wallsMesh.restrictsLight = false;
      wallsMesh.restrictsWeather = false;
      wallsMesh.visible = localZNow >= 6;
      canvas.primary.addChild(wallsMesh);
      wallsMesh.updateCanvasTransform?.();
      this._syncShowstopperMeshDof(wallsMesh);
    }

    if (tRoof) {
      const canRevealNow = roofsMountedNow;
      roofMesh = this.acquireMesh();
      roofMesh.name = `Tile.BoundlessRoof.${fullId}`;
      roofMesh.anchor.set(0.5, 0.5);
      roofMesh.texture = tRoof;
      roofMesh.tint = ovTint;
      roofMesh.position.set(ovSpec.cx, ovSpec.cy);
      roofMesh.width = ovSpec.w;
      roofMesh.height = ovSpec.h;
      roofMesh.angle = ovSpec.rot || 0;
      roofMesh.elevation = topElev;
      roofMesh.sortLayer = PrimaryCanvasGroup.SORT_LAYERS.TILES;
      roofMesh.sort = 45;
      roofMesh.occlusionMode = canRevealNow
        ? (CONST.OCCLUSION_MODES.FADE | CONST.OCCLUSION_MODES.RADIAL | CONST.OCCLUSION_MODES.SURFACE)
        : CONST.OCCLUSION_MODES.NONE;
      // Match Foundry v14 foreground tiles: ceiling defineSurface regions at level.elevation.top must NOT occlude this level's own roofs
      roofMesh._occludedBySameElevationSurfaces = false;
      roofMesh.alpha = 1.0;
      roofMesh.unoccludedAlpha = 1.0;
      roofMesh.occludedAlpha = 0.05;
      roofMesh.hoverFade = canRevealNow;
      roofMesh.restrictsLight = true;
      roofMesh.restrictsWeather = true;
      roofMesh.textureAlphaThreshold = 0.75;
      canvas.primary.addChild(roofMesh);
      roofMesh.updateCanvasTransform?.();
      this._syncShowstopperMeshDof(roofMesh);
    }

    const ovEntry = { levelId: lid, oid, ovSpec, wallsMesh, roofMesh, srcWalls: ovSpec.walls, srcRoof: ovSpec.roof, retiring: false };
    this.activeOverlays.set(fullId, ovEntry);
    if (roofMesh) this._emit("overlayMount", { key: fullId, ov: ovEntry });
    if (localZNow >= 6 && !wallsMesh && ovSpec.walls) {
      this._ensureOverlayWallsMesh(fullId, layer, ovSpec);
    }
    return true;
  },

  /**
   * Stream virtual tiles (`spec.tiles` indexed via `sectors[sk].t`) for a level.
   * Supports full Foundry v14 Tile semantics: elevation, occlusion modes, restrictsLight/Weather, sortLayer, LOD minZ.
   */
  syncVirtualTiles(layer, targetZ, vp, sharedVtSeen = null) {
    const tiles = layer.spec?.tiles;
    if (!tiles?.length) return false;

    const PrimaryCanvasGroup = foundry.canvas.groups.PrimaryCanvasGroup;
    const { simGrid, simSectorPx, spec, level } = layer;
    const sectors = spec.sectors;
    const lid = level.id;
    const defaultElev = getLevelBaseElevation(level);

    const sx0 = Math.max(0, Math.floor(vp.x0 / simSectorPx));
    const sy0 = Math.max(0, Math.floor(vp.y0 / simSectorPx));
    const sx1 = Math.min(simGrid - 1, Math.floor(vp.x1 / simSectorPx));
    const sy1 = Math.min(simGrid - 1, Math.floor(vp.y1 / simSectorPx));

    // Evaluate interior tile minZ using absolute cell size (with hysteresis) so 564+ hidden-under-roof props
    // don't mount and flood canvas.primary / burn-living-map at macro zoom (scale 0.05..0.15)!
    const showInterior = this._shouldMountInteriorTiles(layer, vp.scale);
    const effectiveZ = Math.max(targetZ, showInterior ? (layer.zOffset + 5) : 0);

    const isMoving = this.isActivelyMoving();
    // Quantize the predictive prefetch box using a STABLE screen-derived cell size (independent of velocity lookahead width)
    // so tileKey stays cached during smooth panning instead of thrashing every frame.
    const sw = globalThis.canvas?.app?.renderer?.screen?.width || 1920;
    const sh = globalThis.canvas?.app?.renderer?.screen?.height || 1080;
    const safeScale = Math.max(0.01, vp.scale || 1);
    const vpCellW = Math.max(384, Math.round((sw / safeScale) * 0.35));
    const vpCellH = Math.max(384, Math.round((sh / safeScale) * 0.35));
    const moveBucket = isMoving
      ? `_m_${Math.floor(vp.x0 / vpCellW)}_${Math.floor(vp.y0 / vpCellH)}_${Math.floor(vp.x1 / vpCellW)}_${Math.floor(vp.y1 / vpCellH)}`
      : "_s";
    const tileKey = `${effectiveZ}_${sx0}_${sy0}_${sx1}_${sy1}${moveBucket}_r${this.tileEditsRev}_d${sharedVtSeen ? sharedVtSeen.size : 0}`;
    if (tileKey === layer.lastTileKey && !sharedVtSeen) return false;
    const canSkipSameKey = tileKey === layer.lastTileKey;
    layer.lastTileKey = tileKey;
    if (isMoving) this._vtIdleCleanupNeeded = true;

    const secX0 = sx0 * simSectorPx;
    const secY0 = sy0 * simSectorPx;
    const secX1 = (sx1 + 1) * simSectorPx;
    const secY1 = (sy1 + 1) * simSectorPx;
    const tileIntersectsSectors = (t) => {
      const { pivX, pivY, halfDiag } = getVirtualTileBounds(t);
      return pivX + halfDiag >= secX0 && pivX - halfDiag <= secX1 && pivY + halfDiag >= secY0 && pivY - halfDiag <= secY1;
    };
    const vtDedupKey = (t) => t.gid
      ? `g:${t.gid}`
      : `f:${t.src}|${t.x}|${t.y}|${t.w}|${t.h}|${t.elevation ?? 0}|${t.rot || 0}|${t.sort || 0}`;

    // When this layer's tileKey did not change on a multi-level scene, still register its active tiles into sharedVtSeen
    // so lower levels continue deduplicating shared multi-level tiles without re-scanning sectors.
    if (canSkipSameKey && sharedVtSeen) {
      for (const [, vt] of this.activeVirtualTiles) {
        if (vt.levelId === lid && vt.tSpec) sharedVtSeen.add(vtDedupKey(vt.tSpec));
      }
      return false;
    }

    const needed = new Map();
    const checkUpperOcc = !level?.isView && !layer.isUpper;
    const isGM = Boolean(game.user?.isGM);
    const candidateTids = this._collectVirtualTileCandidates(lid, spec, sx0, sy0, sx1, sy1);
    for (const tid of candidateTids) {
      const tSpec = this.resolveVirtualTile(lid, tid, tiles[tid], level);
      if (!tSpec || (tSpec.hidden && !isGM)) continue;
      if (tSpec.minZ !== undefined && effectiveZ < tSpec.minZ) continue;
      if (tSpec.maxZ !== undefined && targetZ > tSpec.maxZ) continue;
      if (checkUpperOcc && this._isVirtualTileOccludedByUpper(layer, tSpec)) continue;
      if (tileIntersectsSectors(tSpec)) {
        if (sharedVtSeen) {
          const dk = vtDedupKey(tSpec);
          if (sharedVtSeen.has(dk)) continue;
          sharedVtSeen.add(dk);
        }
        needed.set(`${lid}::${tid}`, { tid, tSpec });
      }
    }

    let changed = false;
    let removedAny = false;
    let removedAnyLight = false;
    let removedAnyOcc = false;
    for (const [fullId, vt] of this.activeVirtualTiles) {
      if (vt.levelId !== lid) continue;
      if (!needed.has(fullId)) {
        // While actively zooming/panning, keep still-valid offscreen meshes mounted (only retire ones failing minZ/maxZ/hidden or covered by upper floor)
        // to avoid mount/retire thrashing and 3rd-party shadow rebuild storms (`burn-living-map`); `_vtIdleCleanupNeeded` trims offscreen once idle.
        if (isMoving) {
          const ts = vt.tSpec;
          const stillValidByLod = Boolean(ts && (!ts.hidden || isGM)
            && (ts.minZ === undefined || effectiveZ >= ts.minZ)
            && (ts.maxZ === undefined || targetZ <= ts.maxZ)
            && !(checkUpperOcc && this._isVirtualTileOccludedByUpper(layer, ts)));
          if (stillValidByLod) continue;
        }
        if (vt.mesh?.restrictsLight || vt.mesh?.restrictsWeather) removedAnyLight = true;
        if (vt.mesh && vt.mesh.occlusionMode !== CONST.OCCLUSION_MODES.NONE) removedAnyOcc = true;
        this._emit("virtualTileRetire", { key: fullId, vt, mesh: vt.mesh });
        if (vt.mesh) this.retireMesh(vt.mesh);
        this.activeVirtualTiles.delete(fullId);
        this._trackedOccVirtualTiles?.delete(fullId);
        removedAny = true;
        changed = true;
      }
    }
    if (removedAny) {
      this.invalidateShowstopperSurfaces();
      if (removedAnyOcc) this._occlusionDirty = true;
      if (removedAnyLight) this._markDepthDirty({ syncElev: true });
    }

    const reqRev = this.tileEditsRev;
    const gen = this._mountGen;
    const isViewedLayer = Boolean(level?.isView);
    const visVp = this.getViewportWorldRect(0.0);
    const isInRect = (t, rect) => {
      const { pivX, pivY, halfDiag } = getVirtualTileBounds(t);
      return pivX + halfDiag >= rect.x0 && pivX - halfDiag <= rect.x1 && pivY + halfDiag >= rect.y0 && pivY - halfDiag <= rect.y1;
    };
    for (const [fullId, { tid, tSpec }] of needed) {
      if (this.activeVirtualTiles.has(fullId) || this.virtualTilePending.has(fullId) || this._pendingVirtualTileKeys.has(fullId)) continue;
      if (!tSpec?.src || (tSpec.hidden && !isGM)) continue;

      const inVisRect = isInRect(tSpec, visVp);
      // During active zoom/pan stream everything inside the predictive prefetch viewport (`vp`) so props
      // decode & mount off-screen BEFORE sliding into view (zero pop-in!), skipping only far corners of giant sectors
      if (isMoving && !inVisRect && !isInRect(tSpec, vp)) continue;
      const onVis = isViewedLayer && inVisRect;
      const syncTex = this.texMgr.getSync(tSpec.src);
      if (syncTex) {
        this._pendingVirtualTileKeys.add(fullId);
        const qItem = { fullId, lid, tid, layer, tSpec, defaultElev, reqRev, gen, tex: syncTex };
        if (onVis) this.pendingVirtualTileMounts.unshift(qItem);
        else this.pendingVirtualTileMounts.push(qItem);
        this._tilesDirty = true;
        changed = true;
        continue;
      }

      this.virtualTilePending.add(fullId);
      this.texMgr.load(tSpec.src, { mipmap: true, priority: onVis ? 0 : 1 }).then(tex => {
        if (this._mountGen === gen && this.levelLayers.get(lid) === layer && this.tileEditsRev === reqRev) {
          this.virtualTilePending.delete(fullId);
        }
        if (!this.active || this._mountGen !== gen || this.levelLayers.get(lid) !== layer) return;
        if (this.activeVirtualTiles.has(fullId) || this._pendingVirtualTileKeys.has(fullId) || this.tileEditsRev !== reqRev) return;
        if (!isTextureUsable(tex)) {
          layer.lastTileKey = "";
          return;
        }
        this._pendingVirtualTileKeys.add(fullId);
        const qItem = { fullId, lid, tid, layer, tSpec, defaultElev, reqRev, gen, tex };
        if (onVis) this.pendingVirtualTileMounts.unshift(qItem);
        else this.pendingVirtualTileMounts.push(qItem);
        this._tilesDirty = true;
      });
      changed = true;
    }

    return changed;
  },

  _mountVirtualTileMesh(item, curVp) {
    if (!item) return null;
    const { fullId, lid, tid, layer, tSpec, defaultElev, reqRev, gen } = item;
    if (!this.active || this._mountGen !== gen || this.levelLayers.get(lid) !== layer) return null;
    if (this.activeVirtualTiles.has(fullId) || this.tileEditsRev !== reqRev) return null;

    const tex = isTextureUsable(item.tex) ? item.tex : this.texMgr.getSync(tSpec.src);
    if (!isTextureUsable(tex)) {
      layer.lastTileKey = "";
      return null;
    }

    const zNow = layer.lastTargetZ;
    const showInteriorNow = this._shouldMountInteriorTiles(layer, curVp?.scale ?? canvas.stage?.scale?.x ?? 1);
    const effZNow = Math.max(zNow, showInteriorNow ? (layer.zOffset + 5) : 0);
    if (tSpec.minZ !== undefined && effZNow < tSpec.minZ) return null;
    if (tSpec.maxZ !== undefined && zNow > tSpec.maxZ) return null;
    if (!layer.level?.isView && !layer.isUpper && this._isVirtualTileOccludedByUpper(layer, tSpec)) return null;

    const { simGrid, simSectorPx } = layer;
    const { pivX, pivY, halfDiag } = getVirtualTileBounds(tSpec);
    const curSx0 = Math.max(0, Math.floor(curVp.x0 / simSectorPx));
    const curSy0 = Math.max(0, Math.floor(curVp.y0 / simSectorPx));
    const curSx1 = Math.min(simGrid - 1, Math.floor(curVp.x1 / simSectorPx));
    const curSy1 = Math.min(simGrid - 1, Math.floor(curVp.y1 / simSectorPx));
    const secX0 = curSx0 * simSectorPx;
    const secY0 = curSy0 * simSectorPx;
    const secX1 = (curSx1 + 1) * simSectorPx;
    const secY1 = (curSy1 + 1) * simSectorPx;
    if (pivX + halfDiag < secX0 || pivX - halfDiag > secX1 || pivY + halfDiag < secY0 || pivY - halfDiag > secY1) {
      return null;
    }

    const PrimaryCanvasGroup = foundry.canvas.groups.PrimaryCanvasGroup;
    const m = this.acquireMesh();
    m.name = `Tile.BoundlessVirtual.${fullId}`;
    const ax = tSpec.anchorX ?? 0.5;
    const ay = tSpec.anchorY ?? 0.5;
    m.anchor.set(ax, ay);
    m.texture = tex;
    m.position.set(tSpec.x + (tSpec.anchorX === undefined ? tSpec.w * 0.5 : 0), tSpec.y + (tSpec.anchorY === undefined ? tSpec.h * 0.5 : 0));
    const sx = Number.isFinite(tSpec.scaleX) ? tSpec.scaleX : 1;
    const sy = Number.isFinite(tSpec.scaleY) ? tSpec.scaleY : 1;
    const fit = ["fill", "cover", "contain", "width", "height"].includes(tSpec.fit) ? tSpec.fit : "fill";
    if (typeof m.resize === "function" && tex.width > 0 && tex.height > 0) {
      m.resize(Math.max(0, tSpec.w || 0), Math.max(0, tSpec.h || 0), { fit, scaleX: sx, scaleY: sy });
    } else {
      m.width = tSpec.w;
      m.height = tSpec.h;
      if (sx < 0) m.scale.x = -Math.abs(m.scale.x);
      if (sy < 0) m.scale.y = -Math.abs(m.scale.y);
    }
    m.angle = tSpec.rot || 0;
    m.elevation = Number.isFinite(tSpec.elevation) ? tSpec.elevation : defaultElev;
    m.sortLayer = resolveSortLayer(tSpec.sortLayer, PrimaryCanvasGroup.SORT_LAYERS.TILES);
    m.sort = tSpec.sort ?? 50;

    const defaultOcc = layer.isUpper
      ? (CONST.OCCLUSION_MODES.FADE | CONST.OCCLUSION_MODES.RADIAL | CONST.OCCLUSION_MODES.SURFACE)
      : CONST.OCCLUSION_MODES.NONE;
    m.occlusionMode = resolveOcclusionMode(tSpec.occlusionMode, defaultOcc);
    const baseAlpha = tSpec.alpha ?? 1.0;
    const hiddenMult = tSpec.hidden ? 0.5 : 1.0;
    m.hidden = Boolean(tSpec.hidden);
    m.hoverFade = tSpec.hoverFade ?? (m.occlusionMode !== CONST.OCCLUSION_MODES.NONE && !(m.occlusionMode & CONST.OCCLUSION_MODES.SURFACE));
    m.restrictsLight = Boolean(tSpec.restrictsLight);
    m.restrictsWeather = Boolean(tSpec.restrictsWeather);
    const isDecorative = m.occlusionMode === CONST.OCCLUSION_MODES.NONE && !m.hoverFade && !m.restrictsLight && !m.restrictsWeather;
    if (isDecorative) {
      // Decorative tiles switch to PIXI "batch" shader which reads only m.alpha (ignores unoccludedAlpha)
      m.alpha = baseAlpha * hiddenMult;
      m.unoccludedAlpha = 1.0;
      m.occludedAlpha = tSpec.occludedAlpha ?? (layer.isUpper ? 0.08 : 0.2);
    } else {
      // OccludableSamplerShader ("batchOcclusion") multiplies m.alpha * mix(unoccludedAlpha, occludedAlpha, occ),
      // so keep m.alpha at 1.0 (or 0.5 for hidden GM preview) like native Foundry Tile to prevent alpha^2 darkening.
      m.alpha = hiddenMult;
      m.unoccludedAlpha = baseAlpha;
      m.occludedAlpha = tSpec.occludedAlpha ?? (layer.isUpper ? 0.08 : 0.2);
    }
    m.textureAlphaThreshold = tSpec.alphaThreshold ?? 0.75;
    if (tSpec.tint !== undefined && tSpec.tint !== null && tSpec.tint !== "") {
      if (typeof tSpec.tint === "number" && Number.isFinite(tSpec.tint)) {
        m.tint = tSpec.tint;
      } else {
        const c = foundry.utils.Color.from(tSpec.tint);
        if (c.valid) m.tint = c.valueOf();
      }
    }
    // Hide raw mesh if TilesLayer editor currently renders the native editable Tile for this exact level & slot
    const edTile = this.layerEditors?.tileActive ? this.layerEditors.tilesByKey.get(`t:${tid}`) : null;
    if (edTile && edTile.levelId === lid) {
      m.visible = false;
    }

    canvas.primary.addChild(m);
    m.updateCanvasTransform?.();
    // Decorative props with no occlusion/hoverFade/light restrictions render identically via fast PIXI "batch" shader
    // (halving draw calls & shader switches alongside burn-living-map shadows) and avoid per-frame quadtree rebuilds!
    if (m.occlusionMode === CONST.OCCLUSION_MODES.NONE && !m.hoverFade && !m.restrictsLight && !m.restrictsWeather) {
      m.pluginName = "batch";
      m.updateCanvasTransform = NOOP_TRANSFORM;
    }
    this._syncShowstopperMeshDof(m);
    const vtEntry = { levelId: lid, mesh: m, src: tSpec.src, tSpec };
    this.activeVirtualTiles.set(fullId, vtEntry);
    if (m.occlusionMode !== CONST.OCCLUSION_MODES.NONE) {
      if (!this._trackedOccVirtualTiles) this._trackedOccVirtualTiles = new Set();
      this._trackedOccVirtualTiles.add(fullId);
    }
    this._emit("virtualTileMount", { key: fullId, vt: vtEntry });
    return m;
  },

  _isPointInsideVirtualTile(px, py, tSpec, pad = 0) {
    const rawW = tSpec?.w || 0;
    const rawH = tSpec?.h || 0;
    if (rawW <= 0 || rawH <= 0) return false;
    const sx = Number.isFinite(tSpec.scaleX) && tSpec.scaleX !== 0 ? tSpec.scaleX : 1;
    const sy = Number.isFinite(tSpec.scaleY) && tSpec.scaleY !== 0 ? tSpec.scaleY : 1;
    const w = rawW * Math.abs(sx);
    const h = rawH * Math.abs(sy);
    // Anchor pivot matches syncVirtualTiles(): if anchorX is omitted, x/y is top-left and pivot is (x + w/2, y + h/2)
    const rawAx = tSpec.anchorX !== undefined ? tSpec.anchorX : 0.5;
    const rawAy = tSpec.anchorY !== undefined ? tSpec.anchorY : 0.5;
    const ax = sx < 0 ? (1 - rawAx) : rawAx;
    const ay = sy < 0 ? (1 - rawAy) : rawAy;
    const pivX = tSpec.anchorX === undefined ? (tSpec.x + rawW * 0.5) : tSpec.x;
    const pivY = tSpec.anchorY === undefined ? (tSpec.y + rawH * 0.5) : tSpec.y;
    const dx = px - pivX;
    const dy = py - pivY;
    const rot = tSpec.rot || 0;
    let lx = dx;
    let ly = dy;
    if (rot) {
      const rad = (-rot * Math.PI) / 180;
      const c = Math.cos(rad);
      const s = Math.sin(rad);
      lx = dx * c - dy * s;
      ly = dx * s + dy * c;
    }
    const minLx = -ax * w - pad;
    const maxLx = (1 - ax) * w + pad;
    const minLy = -ay * h - pad;
    const maxLy = (1 - ay) * h + pad;
    return lx >= minLx && lx <= maxLx && ly >= minLy && ly <= maxLy;
  },

  /**
   * Check whether a world point at elevation `tokElev` sits beneath a baked pyramid roof
   * (or unloaded virtual tile with `minZ > lastTargetZ`) when no native roofMesh is currently covering it.
   */
  isPointUnderBakedRoof(lid, tx, ty, tokElev = 0) {
    const layersToCheck = this.visibleLevelLayers?.length
      ? this.visibleLevelLayers
      : (this.levelLayers.get(lid) ? [this.levelLayers.get(lid)] : []);
    if (!layersToCheck.length) return false;
    const occSurfaces = canvas.masks?.occlusion?.occludedSurfaces;
    const viewedBottom = getLevelBottomElevation(canvas.level);
    const missingSrcs = this.texMgr?.missingSrcs;

    for (let li = 0; li < layersToCheck.length; li++) {
      const layer = layersToCheck[li];
      if (!layer?.spec) continue;
      const { simGrid, simSectorPx, spec, level } = layer;
      const layerId = level.id;
      const tileRev = this.tileEditsRev || 0;
      if (layer._roofCheckRev !== tileRev || layer._roofCheckSpec !== spec) {
        layer._roofCheckRev = tileRev;
        layer._roofCheckSpec = spec;
        let hasOv = false;
        if (spec.overlays) {
          for (const _ in spec.overlays) { hasOv = true; break; }
        }
        layer._hasRoofOverlays = hasOv;
        let hasMinZ = Boolean(this.tileEdits?.get?.(layerId)?.size);
        if (!hasMinZ && spec.tiles?.length) {
          for (let ti = 0; ti < spec.tiles.length; ti++) {
            if (spec.tiles[ti]?.minZ !== undefined) { hasMinZ = true; break; }
          }
        }
        layer._hasMinZTiles = hasMinZ;
      }
      if (!layer._hasRoofOverlays && !layer._hasMinZTiles) continue;
      const topElev = getLevelRoofElevation(level);
      const sx = Math.max(0, Math.min(simGrid - 1, Math.floor(tx / simSectorPx)));
      const sy = Math.max(0, Math.min(simGrid - 1, Math.floor(ty / simSectorPx)));

      // 1. Check baked building roofs across 3x3 neighbor sectors (buildings like taverns can straddle sector borders)
      if (layer._hasRoofOverlays && tokElev < topElev && spec.overlays && spec.sectors) {
        const hideRoofsForUpperView = !level.isView && viewedBottom >= topElev;
        if (!hideRoofsForUpperView) {
          for (let dy = -1; dy <= 1; dy++) {
            for (let dx = -1; dx <= 1; dx++) {
              const oList = spec.sectors[`${sx + dx}_${sy + dy}`]?.o;
              if (!oList?.length) continue;
              for (const oid of oList) {
                const ovSpec = spec.overlays[oid];
                if (!isPointUnderRoofSpec(tx, ty, ovSpec)) continue;
                // Do not permanently hide indoor tokens at tactical zoom if the roof texture 404'd
                if (ovSpec.roof && missingSrcs?.has?.(ovSpec.roof)) continue;
                const mountedRoof = this.activeOverlays.get(`${layerId}::${oid}`)?.roofMesh;
                if (!mountedRoof || mountedRoof.destroyed || !mountedRoof.visible || mountedRoof.unoccludedAlpha < 0.9) {
                  return true;
                }
                // Guard against a freshly mounted/unoccluded roof mesh still fading up from low alpha
                if (mountedRoof.alpha < 0.9 && !this._isRoofRevealed(mountedRoof, occSurfaces)) {
                  return true;
                }
              }
            }
          }
        }
      }

      // 2. Check virtual tiles with minZ (or elevated roof/canopy tiles) sitting above this point that are NOT yet mounted & opaque
      if (layer._hasMinZTiles && spec.tiles?.length) {
        const candidateTids = this._collectVirtualTileCandidates(
          layerId, spec,
          Math.max(0, sx - 1), Math.max(0, sy - 1),
          Math.min(simGrid - 1, sx + 1), Math.min(simGrid - 1, sy + 1)
        );
        const curTargetZ = layer.lastTargetZ ?? 0;
        const hasTileEditsOnLevel = Boolean(this.tileEdits?.get?.(layerId)?.size);
        const defaultLvlElev = getLevelBaseElevation(level);
        for (const tid of candidateTids) {
          const rawTile = spec.tiles[tid];
          if (!rawTile) continue;
          if (!hasTileEditsOnLevel) {
            const rawElev = Number.isFinite(rawTile.elevation) ? rawTile.elevation : defaultLvlElev;
            if (rawTile.minZ === undefined || rawTile.hidden || (rawTile.alpha ?? 1) < 0.35 || rawElev <= tokElev) continue;
            if (rawTile.maxZ !== undefined && curTargetZ > rawTile.maxZ) continue;
          }
          const tSpec = this.resolveVirtualTile(layerId, tid, rawTile, level);
          if (!tSpec || tSpec.hidden || (tSpec.alpha ?? 1) < 0.35 || (tSpec.elevation ?? 0) <= tokElev) continue;
          if (tSpec.maxZ !== undefined && curTargetZ > tSpec.maxZ) continue;
          if (tSpec.minZ !== undefined) {
            if (tSpec.src && missingSrcs?.has?.(tSpec.src)) continue;
            const mountedVt = this.activeVirtualTiles.get(`${layerId}::${tid}`)?.mesh;
            const targetAlpha = tSpec.alpha ?? 1;
            const vtReadyOpaque = Boolean(mountedVt && !mountedVt.destroyed && mountedVt.visible && (mountedVt.alpha >= targetAlpha * 0.9 || this._isRoofRevealed(mountedVt, occSurfaces)));
            if (!vtReadyOpaque && this._isPointInsideVirtualTile(tx, ty, tSpec, 0)) {
              return true;
            }
          }
        }
      }
    }

    return false;
  },

  /**
   * Resolve the highest solid Boundless surface (building roof overlay or virtual tile)
   * supporting a token at `(x, y)` with elevation `elev`. Used by Showstopper's
   * elevation/perspective/falling system so tokens standing on Boundless roofs or
   * virtual platforms rest solidly instead of hovering or falling to `0 ft`.
   */
  getSupportingSurfaceAt(x, y, elev = 0, levelId = null, rCore = 20) {
    if (!this.active || !Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(elev)) return null;
    const lid = levelId || canvas?.level?.id || null;
    const layers = lid && this.levelLayers.has(lid)
      ? [this.levelLayers.get(lid)]
      : Array.from(this.levelLayers.values());
    if (!layers.length) return null;

    let best = null;
    let bestElev = -Infinity;
    const radius = Math.max(4, Number(rCore) || 20);

    for (const layer of layers) {
      if (!layer?.spec) continue;
      const curLid = layer.level?.id;
      const { simGrid, simSectorPx, spec, level } = layer;
      const topElev = getLevelRoofElevation(level);
      const sx = Math.max(0, Math.min(simGrid - 1, Math.floor(x / simSectorPx)));
      const sy = Math.max(0, Math.min(simGrid - 1, Math.floor(y / simSectorPx)));

      // 1) Baked building roofs (`spec.overlays` -> `roofMesh` at `topElev`)
      if (topElev <= elev + 0.05 && topElev > bestElev + 0.001 && spec.overlays && spec.sectors) {
        let hitRoofId = null;
        for (let dy = -1; dy <= 1 && !hitRoofId; dy++) {
          for (let dx = -1; dx <= 1 && !hitRoofId; dx++) {
            const oList = spec.sectors[`${sx + dx}_${sy + dy}`]?.o;
            if (!oList?.length) continue;
            for (const oid of oList) {
              const ovSpec = spec.overlays[oid];
              if (!ovSpec?.roof || ovSpec.walls?.includes("anchor_")) continue;
              const halfMax = Math.max(ovSpec.w || 0, ovSpec.h || 0) * 0.72 + radius;
              if (Math.abs(x - ovSpec.cx) > halfMax || Math.abs(y - ovSpec.cy) > halfMax) continue;

              const fullId = `${curLid}::${oid}`;
              const mountedRoof = this.activeOverlays.get(fullId)?.roofMesh;
              if (mountedRoof && !mountedRoof.destroyed && mountedRoof.visible !== false) {
                if (meshSupportsSole(mountedRoof, x, y, radius, 0.25)) {
                  hitRoofId = fullId;
                  break;
                }
              } else if (isPointUnderRoofSpec(x, y, ovSpec)) {
                hitRoofId = fullId;
                break;
              }
            }
          }
        }
        if (hitRoofId) {
          bestElev = topElev;
          best = {
            elevation: topElev,
            level: level || null,
            sourceType: "tile",
            sourceId: hitRoofId,
            isLargePlatform: true
          };
        }
      }

      // 2) Virtual tiles (`spec.tiles` indexed per sector `sectors[sk].t`, sectorless lists, and dragged `tileEdits`)
      if (spec.tiles?.length) {
        const candidateTids = this._collectVirtualTileCandidates(
          curLid, spec,
          Math.max(0, sx - 1), Math.max(0, sy - 1),
          Math.min(simGrid - 1, sx + 1), Math.min(simGrid - 1, sy + 1)
        );
        for (const tid of candidateTids) {
          const tSpec = this.resolveVirtualTile(curLid, tid, spec.tiles[tid], level);
          if (!tSpec || tSpec.hidden) continue;
          if (tSpec.surfaceMode === "ignore" || tSpec.walkable === false) continue;
          const alpha = Number(tSpec.alpha ?? 1);
          if (tSpec.surfaceMode !== "solid" && alpha < 0.35) continue;

          const tElev = Number.isFinite(Number(tSpec.elevation)) ? Number(tSpec.elevation) : getLevelBaseElevation(level);
          if (tElev > elev + 0.05 || tElev <= bestElev + 0.001) continue;

          if (!this._isPointInsideVirtualTile(x, y, tSpec, radius)) continue;

          const fullId = `${curLid}::${tid}`;
          const mountedMesh = this.activeVirtualTiles.get(fullId)?.mesh;
          let supported = false;
          if (mountedMesh && !mountedMesh.destroyed && mountedMesh.visible !== false) {
            const alphaThr = tSpec.surfaceMode === "solid" ? 0.05 : Math.min(0.85, 0.25 / Math.max(0.35, alpha));
            supported = meshSupportsSole(mountedMesh, x, y, radius, alphaThr);
          } else {
            supported = this._isPointInsideVirtualTile(x, y, tSpec, 0);
          }

          if (supported) {
            bestElev = tElev;
            best = {
              elevation: tElev,
              level: level || null,
              sourceType: "tile",
              sourceId: fullId,
              isLargePlatform: true
            };
          }
        }
      }
    }

    return best;
  },

  isTokenUnderBakedRoof(tok) {
    if (!this.active || !tok || tok.destroyed || tok.isPreview || tok.controlled) return false;
    const doc = tok.document;
    const lid = doc?.level || canvas.level?.id;
    const rawElev = Number(doc?.elevation ?? 0);
    const visElev = Number.isFinite(Number(tok._ssJumpState?.elevation))
      ? Number(tok._ssJumpState.elevation)
      : (Number.isFinite(Number(tok._ssVisualElevation)) ? Number(tok._ssVisualElevation) : rawElev);
    const tokElev = Math.max(rawElev, visElev);
    return this.isPointUnderBakedRoof(lid, tok.center.x, tok.center.y, tokElev);
  },

  syncRoofTokenOcclusion() {
    if (!this.active || !canvas?.tokens?.placeables) return;

    // Fast O(1) bailout on maps with no baked roofs, no minZ tiles, and no previously hidden tokens
    if (this._roofHiddenTokens.size === 0 && this.visibleLevelLayers?.length) {
      const tileRev = this.tileEditsRev || 0;
      let anyCanHide = false;
      for (let i = 0; i < this.visibleLevelLayers.length; i++) {
        const layer = this.visibleLevelLayers[i];
        const spec = layer?.spec;
        if (!spec) continue;
        if (layer._roofCheckRev !== tileRev || layer._roofCheckSpec !== spec) {
          anyCanHide = true;
          break;
        }
        if (layer._hasRoofOverlays || layer._hasMinZTiles) {
          anyCanHide = true;
          break;
        }
      }
      if (!anyCanHide) return;
    }

    const nextHidden = new Set();
    for (const tok of canvas.tokens.placeables) {
      if (this.isTokenUnderBakedRoof(tok)) {
        nextHidden.add(tok);
        if (tok.renderable) tok.renderable = false;
        if (tok.mesh && !tok.mesh.destroyed && tok.mesh.renderable) tok.mesh.renderable = false;
        if (tok._ssJumpShadow && !tok._ssJumpShadow.destroyed && tok._ssJumpShadow.renderable) {
          tok._ssJumpShadow.renderable = false;
        }
      }
    }

    // Restore tokens that are no longer hidden by baked roofs
    let restoredAny = false;
    for (const tok of this._roofHiddenTokens) {
      if (nextHidden.has(tok)) continue;
      if (tok && !tok.destroyed) {
        tok.renderable = true;
        if (tok.mesh && !tok.mesh.destroyed) {
          tok.mesh.renderable = true;
          if (tok.visible !== false && !tok._ssHideMesh && tok.mesh.visible === false) tok.mesh.visible = true;
        }
        if (tok._ssJumpShadow && !tok._ssJumpShadow.destroyed) tok._ssJumpShadow.renderable = true;
        restoredAny = true;
      }
    }
    let hiddenChanged = nextHidden.size !== this._roofHiddenTokens.size;
    if (!hiddenChanged) {
      for (const tok of nextHidden) {
        if (!this._roofHiddenTokens.has(tok)) { hiddenChanged = true; break; }
      }
    }
    this._roofHiddenTokens = nextHidden;
    if (hiddenChanged || restoredAny) {
      this.tokenStreamer.onVisibilityChanged();
    }
    if (restoredAny && this.tokenStreamer.enabled) {
      this.tokenStreamer.scheduleSync(null, false);
    }
  },

  needsOcclusionRefreshNear(doc) {
    if (!this.active || !doc) return false;
    if (this.visibleLevelLayers.length > 1) return true;
    if (!this.activeOverlays.size && !this.activeVirtualTiles.size) return false;
    const tx = (doc.x ?? 0) + ((doc.width ?? 1) * (canvas.dimensions?.size || 100) * 0.5);
    const ty = (doc.y ?? 0) + ((doc.height ?? 1) * (canvas.dimensions?.size || 100) * 0.5);
    for (const ov of this.activeOverlays.values()) {
      if (!ov.roofMesh?.visible) continue;
      const rx = Math.max(ov.roofMesh.width || 0, ov.roofMesh.height || 0) * 0.65 + 250;
      if (Math.abs(tx - ov.roofMesh.x) <= rx && Math.abs(ty - ov.roofMesh.y) <= rx) return true;
    }
    const tracked = this._trackedOccVirtualTiles;
    if (tracked && tracked.size > 0) {
      for (const fullId of tracked) {
        const vt = this.activeVirtualTiles.get(fullId);
        const m = vt?.mesh;
        if (!m || m.destroyed) { tracked.delete(fullId); continue; }
        if (!m.visible || !m.occlusionMode) continue;
        const b = m.canvasBounds;
        if (b && Number.isFinite(b.x) && Number.isFinite(b.width)) {
          if (tx >= b.x - 250 && tx <= b.x + b.width + 250 && ty >= b.y - 250 && ty <= b.y + b.height + 250) return true;
        } else {
          const rx = Math.max(m.width || 0, m.height || 0) + 250;
          if (Math.abs(tx - m.x) <= rx && Math.abs(ty - m.y) <= rx) return true;
        }
      }
    } else if (!tracked) {
      for (const vt of this.activeVirtualTiles.values()) {
        const m = vt.mesh;
        if (!m?.visible || !m.occlusionMode) continue;
        const b = m.canvasBounds;
        if (b && Number.isFinite(b.x) && Number.isFinite(b.width)) {
          if (tx >= b.x - 250 && tx <= b.x + b.width + 250 && ty >= b.y - 250 && ty <= b.y + b.height + 250) return true;
        } else {
          const rx = Math.max(m.width || 0, m.height || 0) + 250;
          if (Math.abs(tx - m.x) <= rx && Math.abs(ty - m.y) <= rx) return true;
        }
      }
    }
    return false;
  }
};
