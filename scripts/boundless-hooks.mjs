import { installCharacterSwitchPatch } from "./character-pins.mjs";
import { installLazyTokenLayerPatch } from "./token-streamer.mjs";
import { installGlobalSelectionPatches } from "./boundless-selection.mjs";
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
    const megaCfg = globalThis.canvas?.scene?.flags?.[MODULE_ID];
    const lvlCfg = globalThis.canvas?.level?.flags?.[MODULE_ID];
    if (megaCfg?.enabled || lvlCfg?.enabled || globalThis.Boundless?.active) {
      const maxLos = lvlCfg?.maxLosPx || megaCfg?.maxLosPx || MAX_LOS_RADIUS_PX;
      if (cfg.radius > maxLos) cfg.radius = maxLos;
    }
    return cfg;
  };
  losPatchInstalled = true;
}

export function installBulkSelectionPatch(controller) {
  installGlobalSelectionPatches(controller, PERF_CONFIG);
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
        // On standard scenes, skip synchronous gl.readPixels() alpha-map stall for non-hoverFade, non-occludable ground/background meshes,
        // while preserving opaque upper tiles/platforms that intentionally block hoverFade from bleeding through to roofs below.
        const baseElev = Number.isFinite(canvas?.level?.elevation?.base)
          ? canvas.level.elevation.base
          : (Number.isFinite(canvas?.level?.elevation?.bottom) ? canvas.level.elevation.bottom : 0);
        if (!this.hoverFade && !this.occlusionMode && (this.elevation ?? 0) <= baseElev) return false;
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
    if (!globalThis.canvas?.ready || !parentScene || parentScene.id !== globalThis.canvas.scene?.id) return;
    const flagChanges = changes?.flags?.[MODULE_ID];
    const flagDeleted = Boolean(changes?.flags && (`-=${MODULE_ID}` in changes.flags));
    if (flagChanges || flagDeleted) {
      controller.mount(parentScene);
    }
  });

  const isRuntimeReady = () => Boolean(controller.active && !controller._mounting && globalThis.canvas?.ready);

  Hooks.on("canvasPan", () => {
    if (!isRuntimeReady() || controller._restoringCamera) return;
    const now = performance.now();
    controller._lastPanMs = now;
    controller._updateCameraVelocity(now);
    controller.scheduleCameraSave();
    controller.updatePyramid();
    controller.scheduleViewportLightSync();
    controller.selectionOverlay?.refresh?.(false);
  });

  let _controlTokenQueued = false;
  Hooks.on("controlToken", () => {
    if (!isRuntimeReady()) return;
    if (controller.tokenStreamer?._selectingBatch) return;
    if (_controlTokenQueued) return;
    _controlTokenQueued = true;
    queueMicrotask(() => {
      _controlTokenQueued = false;
      if (!isRuntimeReady() || controller.tokenStreamer?._selectingBatch) return;
      controller.updateSimAndLightBubbles(false);
      if (controller.tokenStreamer?.enabled && !controller.tokenStreamer._nativeTokensActive) {
        controller.tokenStreamer.scheduleSync(null, true);
      }
      controller.tokenStreamer.onVisibilityChanged();
      controller.selectionOverlay?.refresh?.();
      controller._roofTokenOccDirty = true;
    });
  });

  Hooks.on("lightingRefresh", (effects) => {
    if (!isRuntimeReady()) return;
    controller.onLightingRefresh(effects);
  });

  let _sightRefreshQueued = false;
  Hooks.on("sightRefresh", () => {
    if (!isRuntimeReady()) return;
    if (_sightRefreshQueued) return;
    _sightRefreshQueued = true;
    queueMicrotask(() => {
      _sightRefreshQueued = false;
      if (!isRuntimeReady()) return;
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
            if (!isRuntimeReady()) return;
            controller._lastSightBubbleMs = performance.now();
            controller.updateSimAndLightBubbles(false);
          }, Math.max(16, Math.ceil(100 - elapsed)));
        }
      }
      controller.tokenStreamer.onVisibilityChanged();
    });
  });

  // Coalesce burst Token hooks (batch create / drag / delete / draw) into a single microtask flush so K tokens stay O(N) instead of O(K*N)
  let _tokBatchQueued = false;
  let _tokBatchBubbles = false;
  let _tokBatchSelection = false;
  let _tokBatchVoidFilter = false;
  let _tokBatchVoidFilterForce = false;
  let _tokBatchOcclusion = false;
  const queueTokenBatchFlush = ({ bubbles = false, selection = false, voidFilter = false, voidFilterForce = false, occlusion = false } = {}) => {
    if (bubbles) _tokBatchBubbles = true;
    if (selection) _tokBatchSelection = true;
    if (voidFilter) _tokBatchVoidFilter = true;
    if (voidFilterForce) _tokBatchVoidFilterForce = true;
    if (occlusion) _tokBatchOcclusion = true;
    if (_tokBatchQueued) return;
    _tokBatchQueued = true;
    queueMicrotask(() => {
      const doBubbles = _tokBatchBubbles;
      const doSelection = _tokBatchSelection;
      const doVoidFilter = _tokBatchVoidFilter;
      const doVoidForce = _tokBatchVoidFilterForce;
      const doOcclusion = _tokBatchOcclusion;
      _tokBatchQueued = false;
      _tokBatchBubbles = false;
      _tokBatchSelection = false;
      _tokBatchVoidFilter = false;
      _tokBatchVoidFilterForce = false;
      _tokBatchOcclusion = false;
      if (!isRuntimeReady()) return;
      if (doVoidFilter) controller._syncInterfaceVoidFilter(doVoidForce);
      if (doBubbles) controller.updateSimAndLightBubbles(false);
      if (doSelection) controller.selectionOverlay?.refresh?.(true);
      if (doOcclusion) {
        canvas.perception?.update?.({ refreshOcclusion: true, refreshOcclusionStates: true, refreshOcclusionMask: true });
      }
    });
  };

  Hooks.on("updateToken", (doc, changes) => {
    if (!isRuntimeReady() || doc?.parent?.id !== canvas.scene?.id) return;
    controller.tokenStreamer.onTokenUpdated(doc, changes);
    controller.charPins.onTokenUpdated(doc, changes);
    const posChanged = "x" in changes || "y" in changes || "level" in changes;
    const sizeChanged = "width" in changes || "height" in changes;
    const elevChanged = "elevation" in changes;
    const lightChanged = "light" in changes || "sight" in changes;
    if (posChanged || sizeChanged || elevChanged || lightChanged) {
      if ((posChanged || elevChanged) && !controller._depthDirty && controller._hasMultiElevationDepth()) controller._depthDirty = true;
      if (posChanged || sizeChanged || elevChanged) controller._roofTokenOccDirty = true;
      const needOcc = posChanged && !_tokBatchOcclusion && controller.needsOcclusionRefreshNear(doc);
      queueTokenBatchFlush({
        bubbles: posChanged || lightChanged,
        selection: posChanged || sizeChanged || elevChanged,
        occlusion: needOcc
      });
    }
  });

  Hooks.on("drawToken", (tok) => {
    if (!isRuntimeReady() || tok?.document?.parent?.id !== canvas.scene?.id) return;
    controller.tokenStreamer.onTokenDrawn(tok);
    if (!tok.isPreview) queueTokenBatchFlush({ voidFilter: true, voidFilterForce: true });
  });

  Hooks.on("refreshToken", (tok, flags) => {
    if (!isRuntimeReady() || tok?.document?.parent?.id !== canvas.scene?.id) return;
    if (flags?.refreshPosition || flags?.refreshElevation) {
      controller._roofTokenOccDirty = true;
    }
  });

  Hooks.on("createToken", (doc) => {
    if (!isRuntimeReady() || doc?.parent?.id !== canvas.scene?.id) return;
    controller.tokenStreamer.onTokenCreated(doc);
    controller.charPins.onTokenCreatedOrDeleted();
    controller._depthDirty = true;
    controller._roofTokenOccDirty = true;
    queueTokenBatchFlush({ bubbles: true, voidFilter: true, voidFilterForce: true });
  });

  Hooks.on("deleteToken", (doc) => {
    if (!isRuntimeReady() || doc?.parent?.id !== canvas.scene?.id) return;
    if (doc._object) controller._roofHiddenTokens?.delete?.(doc._object);
    controller.tokenStreamer.onTokenDeleted(doc);
    controller.charPins.onTokenCreatedOrDeleted();
    controller._depthDirty = true;
    controller._roofTokenOccDirty = true;
    const needOcc = !_tokBatchOcclusion && controller.needsOcclusionRefreshNear(doc);
    queueTokenBatchFlush({ bubbles: true, selection: true, voidFilter: true, occlusion: needOcc });
  });

  Hooks.on("updateUser", (_user, changes) => {
    if (!isRuntimeReady()) return;
    if ("character" in changes || "color" in changes) {
      controller.charPins.onUserOrActorUpdated();
    }
  });

  Hooks.on("updateActor", (_actor, changes) => {
    if (!isRuntimeReady()) return;
    if ("img" in changes || "name" in changes || "ownership" in changes) {
      controller.charPins.onUserOrActorUpdated();
    }
  });

  // Sync TokenImpostorLayer visibility immediately when INVISIBLE / BURROW effects toggle on unmounted NPCs
  const onEffectVisibilityChange = (effect, changes = null) => {
    if (!isRuntimeReady() || !controller.tokenStreamer?.enabled) return;
    const inv = CONFIG?.specialStatusEffects?.INVISIBLE || "invisible";
    const bur = CONFIG?.specialStatusEffects?.BURROW || "burrow";
    const statuses = effect?.statuses;
    const removedOrToggled = Boolean(changes && ("statuses" in changes || "disabled" in changes));
    if (removedOrToggled || statuses?.has?.(inv) || statuses?.has?.(bur)) {
      controller.tokenStreamer.onVisibilityChanged();
    }
  };
  Hooks.on("createActiveEffect", (e) => onEffectVisibilityChange(e));
  Hooks.on("updateActiveEffect", (e, ch) => onEffectVisibilityChange(e, ch));
  Hooks.on("deleteActiveEffect", (e) => onEffectVisibilityChange(e));

  Hooks.on("collapseSidebar", () => {
    if (!isRuntimeReady()) return;
    controller.charPins._lastSidebarCheckMs = 0;
    setTimeout(() => {
      if (isRuntimeReady()) controller.charPins.updateViewport();
    }, 120);
  });

  window.addEventListener("resize", () => {
    if (!isRuntimeReady()) return;
    controller._recomputeWorldMinScale?.();
    controller.poiManager._layoutDirty = true;
    controller.poiManager.updateViewport();
    controller.charPins._lastSidebarCheckMs = 0;
    controller.charPins.updateViewport();
  });

  // React seamlessly to native TileDocuments added/edited/removed on any level (floors blocking lower-level lights, roofs, etc.)
  for (const hookName of ["createTile", "updateTile", "deleteTile"]) {
    Hooks.on(hookName, (doc) => {
      if (!isRuntimeReady() || doc?.parent?.id !== canvas.scene?.id) return;
      controller._depthDirty = true;
      controller._depthElevSyncNeeded = true;
      controller._occlusionDirty = true;
    });
  }

  // React to native WallDocuments added/edited/removed on any level so GPU light shadows stay in sync
  for (const hookName of ["createWall", "updateWall", "deleteWall"]) {
    Hooks.on(hookName, (doc) => {
      if (!isRuntimeReady() || !controller.visibleLevelLayers.length || doc?.parent?.id !== canvas.scene?.id) return;
      controller.scheduleLightBatchRebuild();
    });
  }

  // React to ALT highlight & v14 Region/Surface changes so CanvasDepthMask and z=5 interior reveal sync immediately
  Hooks.on("highlightObjects", () => {
    if (!isRuntimeReady()) return;
    controller._depthDirty = true;
  });

  for (const hookName of ["createRegion", "updateRegion", "deleteRegion", "createRegionBehavior", "updateRegionBehavior", "deleteRegionBehavior"]) {
    Hooks.on(hookName, (doc) => {
      if (!isRuntimeReady()) return;
      const sc = doc?.parent?.documentName === "Scene" ? doc.parent : doc?.parent?.parent;
      if (sc && sc.id !== canvas.scene?.id) return;
      controller._depthDirty = true;
      controller._occlusionDirty = true;
    });
  }

  Hooks.on("initializeEdges", (scene) => {
    if (!isRuntimeReady() || (scene && scene.id !== canvas.scene?.id)) return;
    controller.simSectors.clear();
    controller.lastSimKey = "";
    controller._lastActorSimKey = "";
    controller.updateSimAndLightBubbles(true);
  });

  Hooks.on("canvasTearDown", () => {
    controller.unmount();
  });
}
