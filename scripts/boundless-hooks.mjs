import { installCharacterSwitchPatch } from "./character-pins.mjs";
import { installLazyTokenLayerPatch } from "./token-streamer.mjs";
import { PERF_CONFIG } from "./perf-patcher.mjs";
import { installGpuPerfEngine, refreshGpuPerfSettings } from "./perf-gpu.mjs";
import { installCpuPerfEngine } from "./perf-cpu.mjs";
import { installAutoPerfEngine, updateStandardSceneCulling, restoreAllStandardCulling } from "./perf-auto.mjs";
import { MAX_LOS_RADIUS_PX } from "./boundless-lighting.mjs";
import { MODULE_ID } from "./utils.mjs";

let losPatchInstalled = false;
export function installLosHorizonPatch() {
  if (losPatchInstalled) return;
  const PVS = foundry.canvas?.sources?.PointVisionSource ?? CONFIG.Canvas.visionSourceClass;
  if (!PVS?.prototype?._getPolygonConfiguration) return;
  const orig = PVS.prototype._getPolygonConfiguration;
  PVS.prototype._getPolygonConfiguration = function (...args) {
    const cfg = orig.apply(this, args);
    const megaCfg = canvas?.scene?.flags?.[MODULE_ID];
    if (megaCfg?.enabled && cfg.radius > (megaCfg.maxLosPx || MAX_LOS_RADIUS_PX)) {
      cfg.radius = megaCfg.maxLosPx || MAX_LOS_RADIUS_PX;
    }
    return cfg;
  };
  losPatchInstalled = true;
}

/**
 * Eliminate Foundry v14's O(K^2) vision-polygon storm during marquee box-selection (`selectObjects`)
 * and `releaseAll`: normally every `Token#_onControl` / `_onRelease` loops over ALL `placeables`
 * calling `initializeVisionSource()`, recomputing K*(K+1)/2 vision polygons in one frame.
 * Batching defers vision source initialization to ONE single pass after the marquee loop finishes.
 */
let bulkSelectPatchInstalled = false;
let _bulkSelectDepth = 0;
let _bulkVisionDirty = false;
export function installBulkSelectionPatch(controller) {
  if (bulkSelectPatchInstalled) return;
  const TokenLayerCls = foundry.canvas?.layers?.TokenLayer ?? CONFIG.Token?.layerClass;
  const TokenCls = foundry.canvas?.placeables?.Token ?? CONFIG.Token?.objectClass;
  if (!TokenLayerCls?.prototype || !TokenCls?.prototype?.initializeVisionSource) return;

  const origInitVision = TokenCls.prototype.initializeVisionSource;
  TokenCls.prototype.initializeVisionSource = function (...args) {
    if (_bulkSelectDepth > 0 && (controller?.active || PERF_CONFIG.perfEnabled)) {
      _bulkVisionDirty = true;
      return;
    }
    return origInitVision.apply(this, args);
  };

  const wrapBulk = (methodName) => {
    const orig = TokenLayerCls.prototype[methodName];
    if (typeof orig !== "function") return;
    TokenLayerCls.prototype[methodName] = function (...args) {
      if (!controller?.active && !PERF_CONFIG.perfEnabled) return orig.apply(this, args);
      _bulkSelectDepth++;
      let result;
      try {
        result = orig.apply(this, args);
      } finally {
        _bulkSelectDepth--;
        if (_bulkSelectDepth === 0 && _bulkVisionDirty) {
          _bulkVisionDirty = false;
          const placeables = this.placeables;
          if (Array.isArray(placeables)) {
            for (let i = 0; i < placeables.length; i++) {
              const t = placeables[i];
              if (t && !t.destroyed) origInitVision.call(t);
            }
          }
          canvas.perception?.update?.({
            refreshVision: true,
            refreshSounds: true,
            refreshOcclusion: this.occlusionMode & CONST.TOKEN_OCCLUSION_MODES.CONTROLLED
          });
        }
      }
      return result;
    };
  };

  wrapBulk("selectObjects");
  wrapBulk("releaseAll");
  bulkSelectPatchInstalled = true;
}

/**
 * Prevent Foundry v14's `PrimaryCanvasGroup#_onMouseMove` (`#updateHoveredObjects`) from triggering
 * synchronous `gl.readPixels()` alpha-map extraction (`TextureLoader.getTextureAlphaData`, 10-30ms GPU stalls)
 * on every Boundless pyramid tile / static prop (which all carry a default `_hoverFadeState` class field even when `hoverFade = false`)
 * and while the camera is actively zooming/panning.
 */
let hoverFadeHitTestPatchInstalled = false;
let _inHoverFadeHitTest = false;
export function installHoverFadeHitTestPatch(controller) {
  if (hoverFadeHitTestPatchInstalled) return;
  const PCG = foundry.canvas?.groups?.PrimaryCanvasGroup;
  const PSM = foundry.canvas?.primary?.PrimarySpriteMesh;
  if (!PCG?.prototype?._onMouseMove || !PSM?.prototype?.containsCanvasPoint) return;

  const origOnMouseMove = PCG.prototype._onMouseMove;
  PCG.prototype._onMouseMove = function (...args) {
    if (!controller?.active && !PERF_CONFIG.perfEnabled) return origOnMouseMove.apply(this, args);
    _inHoverFadeHitTest = true;
    try {
      return origOnMouseMove.apply(this, args);
    } finally {
      _inHoverFadeHitTest = false;
    }
  };

  const origContainsCanvasPoint = PSM.prototype.containsCanvasPoint;
  PSM.prototype.containsCanvasPoint = function (...args) {
    if (_inHoverFadeHitTest) {
      if (controller?.active && this._boundlessMesh) {
        if (!this.hoverFade && !this.occlusionMode) return false;
        if (this._boundlessTile && !this.hoverFade) return false;
        if (controller.isActivelyMoving()) return false;
      } else if (PERF_CONFIG.perfEnabled) {
        // On any standard scene, skip synchronous gl.readPixels() alpha-map stall for non-hoverFade, non-occludable meshes
        if (!this.hoverFade && !this.occlusionMode) return false;
      }
    }
    return origContainsCanvasPoint.apply(this, args);
  };

  hoverFadeHitTestPatchInstalled = true;
}

export function syncPerfConfigFromSettings() {
  if (!game.settings?.get) return;
  const read = (k, def) => {
    try { return game.settings.get(MODULE_ID, k); } catch { return def; }
  };
  const master = Boolean(read("perfEnabled", true));
  const tokUi = Boolean(read("perfTokenUiBatching", true));
  const wallsIcons = Boolean(read("perfWallSprites", true));
  const cpu = Boolean(read("perfCpuPerception", true));
  const auto = Boolean(read("perfAutoCulling", true));

  PERF_CONFIG.perfEnabled = master;
  PERF_CONFIG.perfTokenUiBatching = tokUi;
  PERF_CONFIG.perfTokenUiCache = tokUi;
  PERF_CONFIG.perfWallSprites = wallsIcons;
  PERF_CONFIG.perfControlIconCache = wallsIcons;
  PERF_CONFIG.perfLightShaders = Boolean(read("perfLightShaders", true));
  PERF_CONFIG.perfLightingScale = String(read("perfLightingScale", "auto") || "auto");
  PERF_CONFIG.perfDisableUiBlur = Boolean(read("perfDisableUiBlur", false));
  PERF_CONFIG.perfCpuPerception = cpu;
  PERF_CONFIG.perfDragCoalesce = cpu;
  PERF_CONFIG.perfFogOcclusionThrottle = cpu;
  PERF_CONFIG.perfEnrichCache = cpu;
  PERF_CONFIG.perfIdleFpsLimit = Boolean(read("perfIdleFpsLimit", false));
  PERF_CONFIG.perfAutoCulling = auto;
  PERF_CONFIG.perfVramCleanup = auto;
  PERF_CONFIG.perfIdleLevelPrewarm = auto;
  PERF_CONFIG.perfHeavySceneHint = auto;
}

export function registerBoundlessHooks(controller) {
  Hooks.once("init", () => {
    if (game.settings?.register) {
      const onPerfChange = () => {
        syncPerfConfigFromSettings();
        refreshGpuPerfSettings();
        if (PERF_CONFIG.perfEnabled && PERF_CONFIG.perfAutoCulling) {
          updateStandardSceneCulling();
        } else {
          restoreAllStandardCulling();
        }
      };

      game.settings.register(MODULE_ID, "perfEnabled", {
        name: "BOUNDLESS.Perf.Enabled",
        hint: "BOUNDLESS.Perf.EnabledHint",
        scope: "client",
        config: true,
        type: Boolean,
        default: true,
        onChange: onPerfChange
      });
      game.settings.register(MODULE_ID, "perfTokenUiBatching", {
        name: "BOUNDLESS.Perf.TokenUi",
        hint: "BOUNDLESS.Perf.TokenUiHint",
        scope: "client",
        config: true,
        type: Boolean,
        default: true,
        onChange: onPerfChange
      });
      game.settings.register(MODULE_ID, "perfWallSprites", {
        name: "BOUNDLESS.Perf.WallsAndIcons",
        hint: "BOUNDLESS.Perf.WallsAndIconsHint",
        scope: "client",
        config: true,
        type: Boolean,
        default: true,
        onChange: onPerfChange
      });
      game.settings.register(MODULE_ID, "perfLightShaders", {
        name: "BOUNDLESS.Perf.LightShaders",
        hint: "BOUNDLESS.Perf.LightShadersHint",
        scope: "client",
        config: true,
        type: Boolean,
        default: true,
        requiresReload: true,
        onChange: onPerfChange
      });
      game.settings.register(MODULE_ID, "perfLightingScale", {
        name: "BOUNDLESS.Perf.LightingScale",
        hint: "BOUNDLESS.Perf.LightingScaleHint",
        scope: "client",
        config: true,
        type: String,
        choices: {
          auto: "BOUNDLESS.Perf.LightingScaleAuto",
          full: "BOUNDLESS.Perf.LightingScaleFull",
          balanced: "BOUNDLESS.Perf.LightingScaleBalanced",
          performance: "BOUNDLESS.Perf.LightingScalePerformance"
        },
        default: "auto",
        onChange: onPerfChange
      });
      game.settings.register(MODULE_ID, "perfCpuPerception", {
        name: "BOUNDLESS.Perf.CpuPerception",
        hint: "BOUNDLESS.Perf.CpuPerceptionHint",
        scope: "client",
        config: true,
        type: Boolean,
        default: true,
        onChange: onPerfChange
      });
      game.settings.register(MODULE_ID, "perfAutoCulling", {
        name: "BOUNDLESS.Perf.AutoScene",
        hint: "BOUNDLESS.Perf.AutoSceneHint",
        scope: "client",
        config: true,
        type: Boolean,
        default: true,
        onChange: onPerfChange
      });
      game.settings.register(MODULE_ID, "perfDisableUiBlur", {
        name: "BOUNDLESS.Perf.DisableUiBlur",
        hint: "BOUNDLESS.Perf.DisableUiBlurHint",
        scope: "client",
        config: true,
        type: Boolean,
        default: false,
        onChange: onPerfChange
      });
      game.settings.register(MODULE_ID, "perfIdleFpsLimit", {
        name: "BOUNDLESS.Perf.IdleFpsLimit",
        hint: "BOUNDLESS.Perf.IdleFpsLimitHint",
        scope: "client",
        config: true,
        type: Boolean,
        default: false,
        onChange: onPerfChange
      });
      game.settings.register(MODULE_ID, "vramProfile", {
        name: "BOUNDLESS.Settings.VramProfile",
        hint: "BOUNDLESS.Settings.VramProfileHint",
        scope: "client",
        config: true,
        type: String,
        choices: {
          auto: "BOUNDLESS.Settings.VramAuto",
          low: "BOUNDLESS.Settings.VramLow",
          balanced: "BOUNDLESS.Settings.VramBalanced",
          high: "BOUNDLESS.Settings.VramHigh",
          ultra: "BOUNDLESS.Settings.VramUltra"
        },
        default: "auto",
        onChange: (value) => controller.applyVramProfile(value)
      });
    }
    syncPerfConfigFromSettings();
    controller.applyVramProfile();
    installLazyTokenLayerPatch();
    installBulkSelectionPatch(controller);
    installHoverFadeHitTestPatch(controller);
    installCharacterSwitchPatch(controller);
  });

  Hooks.once("setup", () => {
    syncPerfConfigFromSettings();
    installGpuPerfEngine();
    installCpuPerfEngine();
    installAutoPerfEngine(controller);
  });

  Hooks.once("ready", async () => {
    const mod = game.modules?.get?.(MODULE_ID);
    if (mod) mod.api = controller;
    controller._ensureSocket();
    await controller.migrateLegacyScenes();
  });

  Hooks.on("canvasReady", (c) => {
    controller.mount(c.scene);
  });

  Hooks.on("updateScene", (scene, changes) => {
    controller.onSceneUpdate(scene, changes);
  });

  Hooks.on("updateLevel", (level, changes) => {
    const parentScene = level?.parent;
    if (!parentScene || parentScene.id !== canvas.scene?.id) return;
    const flagChanges = changes?.flags?.[MODULE_ID];
    const flagDeleted = Boolean(changes?.flags && (`-=${MODULE_ID}` in changes.flags));
    if (flagChanges || flagDeleted) {
      controller.mount(parentScene);
    }
  });

  Hooks.on("canvasPan", () => {
    if (!controller.active || controller._restoringCamera || controller._mounting) return;
    const now = performance.now();
    controller._lastPanMs = now;
    controller._updateCameraVelocity(now);
    controller.scheduleCameraSave();
    controller.updatePyramid();
    controller.scheduleViewportLightSync();
  });

  let _controlTokenQueued = false;
  Hooks.on("controlToken", () => {
    if (!controller.active) return;
    if (_controlTokenQueued) return;
    _controlTokenQueued = true;
    queueMicrotask(() => {
      _controlTokenQueued = false;
      if (!controller.active) return;
      controller.updateSimAndLightBubbles(false);
      controller.tokenStreamer.onVisibilityChanged();
      controller._roofTokenOccDirty = true;
    });
  });

  Hooks.on("lightingRefresh", (effects) => {
    if (!controller.active) return;
    controller.onLightingRefresh(effects);
  });

  let _sightRefreshQueued = false;
  Hooks.on("sightRefresh", () => {
    if (!controller.active) return;
    if (_sightRefreshQueued) return;
    _sightRefreshQueued = true;
    queueMicrotask(() => {
      _sightRefreshQueued = false;
      if (!controller.active) return;
      controller.fogManager.revealFromActiveVision();
      controller.wallEditor.refreshDoorVisibility();
      const hasVision = (canvas.effects?.visionSources?.size ?? 0) > 0;
      if (hasVision !== controller._hadVisionSources) {
        controller._hadVisionSources = hasVision;
        if (controller._sightBubbleTimer) { clearTimeout(controller._sightBubbleTimer); controller._sightBubbleTimer = null; }
        controller._lastSightBubbleMs = performance.now();
        controller.updateSimAndLightBubbles(false);
      } else if (hasVision) {
        const now = performance.now();
        const elapsed = now - controller._lastSightBubbleMs;
        if (elapsed >= 100) {
          if (controller._sightBubbleTimer) { clearTimeout(controller._sightBubbleTimer); controller._sightBubbleTimer = null; }
          controller._lastSightBubbleMs = now;
          controller.updateSimAndLightBubbles(false);
        } else if (!controller._sightBubbleTimer) {
          controller._sightBubbleTimer = setTimeout(() => {
            controller._sightBubbleTimer = null;
            if (!controller.active) return;
            controller._lastSightBubbleMs = performance.now();
            controller.updateSimAndLightBubbles(false);
          }, Math.max(16, Math.ceil(100 - elapsed)));
        }
      }
      controller.tokenStreamer.onVisibilityChanged();
    });
  });

  Hooks.on("updateToken", (doc, changes) => {
    if (!controller.active || doc?.parent?.id !== canvas.scene?.id) return;
    controller.tokenStreamer.onTokenUpdated(doc, changes);
    controller.charPins.onTokenUpdated(doc, changes);
    const posChanged = "x" in changes || "y" in changes || "level" in changes;
    const elevChanged = "elevation" in changes;
    const lightChanged = "light" in changes || "sight" in changes;
    if (posChanged || elevChanged || lightChanged) {
      if ((posChanged || elevChanged) && controller._hasMultiElevationDepth()) controller._depthDirty = true;
      if (posChanged || lightChanged) controller.updateSimAndLightBubbles(false);
      if (posChanged || elevChanged) controller._roofTokenOccDirty = true;
      if (posChanged && controller.needsOcclusionRefreshNear(doc)) {
        canvas.perception.update({ refreshOcclusion: true, refreshOcclusionStates: true, refreshOcclusionMask: true });
      }
    }
  });

  Hooks.on("drawToken", (tok) => {
    if (!controller.active || tok?.document?.parent?.id !== canvas.scene?.id) return;
    controller.tokenStreamer.onTokenDrawn(tok);
    if (!tok.isPreview) controller._syncInterfaceVoidFilter(true);
  });

  Hooks.on("refreshToken", (tok, flags) => {
    if (!controller.active || tok?.document?.parent?.id !== canvas.scene?.id) return;
    if (flags?.refreshPosition || flags?.refreshElevation) {
      controller._roofTokenOccDirty = true;
    }
  });

  Hooks.on("createToken", (doc) => {
    if (!controller.active || doc?.parent?.id !== canvas.scene?.id) return;
    controller.tokenStreamer.onTokenCreated(doc);
    controller.charPins.onTokenCreatedOrDeleted();
    controller._depthDirty = true;
    controller._syncInterfaceVoidFilter(true);
    controller.updateSimAndLightBubbles(false);
    controller.syncRoofTokenOcclusion();
  });

  Hooks.on("deleteToken", (doc) => {
    if (!controller.active || doc?.parent?.id !== canvas.scene?.id) return;
    controller.tokenStreamer.onTokenDeleted(doc);
    controller.charPins.onTokenCreatedOrDeleted();
    controller._depthDirty = true;
    queueMicrotask(() => { if (controller.active) controller._syncInterfaceVoidFilter(); });
    controller.updateSimAndLightBubbles(false);
  });

  Hooks.on("updateUser", (_user, changes) => {
    if (!controller.active) return;
    if ("character" in changes || "color" in changes) {
      controller.charPins.onUserOrActorUpdated();
    }
  });

  Hooks.on("updateActor", (_actor, changes) => {
    if (!controller.active) return;
    if ("img" in changes || "name" in changes || "ownership" in changes) {
      controller.charPins.onUserOrActorUpdated();
    }
  });

  Hooks.on("collapseSidebar", () => {
    if (!controller.active) return;
    controller.charPins._lastSidebarCheckMs = 0;
    setTimeout(() => {
      if (controller.active) controller.charPins.updateViewport();
    }, 120);
  });

  window.addEventListener("resize", () => {
    if (!controller.active) return;
    controller.poiManager._layoutDirty = true;
    controller.poiManager.updateViewport();
    controller.charPins._lastSidebarCheckMs = 0;
    controller.charPins.updateViewport();
  });

  // React seamlessly to native TileDocuments added/edited/removed on any level (floors blocking lower-level lights, roofs, etc.)
  for (const hookName of ["createTile", "updateTile", "deleteTile"]) {
    Hooks.on(hookName, (doc) => {
      if (!controller.active || doc?.parent?.id !== canvas.scene?.id) return;
      controller._depthDirty = true;
      controller._depthElevSyncNeeded = true;
      controller._occlusionDirty = true;
    });
  }

  // React to native WallDocuments added/edited/removed on any level so GPU light shadows stay in sync
  for (const hookName of ["createWall", "updateWall", "deleteWall"]) {
    Hooks.on(hookName, (doc) => {
      if (!controller.active || !controller.visibleLevelLayers.length || doc?.parent?.id !== canvas.scene?.id) return;
      controller.scheduleLightBatchRebuild();
    });
  }

  // React to ALT highlight & v14 Region/Surface changes so CanvasDepthMask and z=5 interior reveal sync immediately
  Hooks.on("highlightObjects", () => {
    if (!controller.active) return;
    controller._depthDirty = true;
  });

  for (const hookName of ["createRegion", "updateRegion", "deleteRegion", "createRegionBehavior", "updateRegionBehavior", "deleteRegionBehavior"]) {
    Hooks.on(hookName, (doc) => {
      if (!controller.active) return;
      const sc = doc?.parent?.documentName === "Scene" ? doc.parent : doc?.parent?.parent;
      if (sc && sc.id !== canvas.scene?.id) return;
      controller._depthDirty = true;
      controller._occlusionDirty = true;
    });
  }

  Hooks.on("initializeEdges", (scene) => {
    if (!controller.active || (scene && scene.id !== canvas.scene?.id)) return;
    controller.simSectors.clear();
    controller.lastSimKey = "";
    controller.updateSimAndLightBubbles(true);
  });

  Hooks.on("canvasTearDown", () => {
    controller.unmount();
  });
}
