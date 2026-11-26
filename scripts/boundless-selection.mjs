import { MODULE_ID, getEffectiveScale, smoothstep } from "./utils.mjs";

const DOUBLE_PRESS_WINDOW_MS = 2500;
const LARGE_SCENE_THRESHOLD = 80;
const MAX_CTRL_A_TOKENS = 250;
const MAX_MARQUEE_MATERIALIZE = 250;
const MACRO_BORDER_MAX_SCALE = 0.28;
const MACRO_BORDER_FULL_SCALE = 0.16;

let patchesInstalled = false;
let _bulkSelectDepth = 0;
let _bulkVisionDirty = false;
let _bulkPerceptionFlags = null;

/**
 * Pure planner for two-stage Ctrl+A selection on global & large maps:
 *  - Stage 1 (first press): select controllable objects inside the current viewport.
 *  - Stage 2 (second press within 2.5s on the same layer/level): expand selection to the entire level.
 *  - Small standard scenes (<= threshold & not Boundless): keep 100% native Foundry Ctrl+A behavior.
 */
export function computeSmartSelectAllPlan({
  isBoundless = false,
  totalOnLevel = 0,
  inViewCount = 0,
  lastState = null,
  nowMs = 0,
  layerName = "",
  levelId = "",
  largeSceneThreshold = LARGE_SCENE_THRESHOLD,
  doublePressWindowMs = DOUBLE_PRESS_WINDOW_MS
} = {}) {
  if (!isBoundless && totalOnLevel <= largeSceneThreshold) {
    return { action: "native", nextState: null };
  }

  const isRepeat = Boolean(
    lastState &&
    lastState.layerName === layerName &&
    lastState.levelId === levelId &&
    (nowMs - lastState.ts) <= doublePressWindowMs
  );

  if (isRepeat) {
    return { action: "level", nextState: null };
  }

  if (inViewCount === 0 && totalOnLevel > 0) {
    return {
      action: "prompt-level-empty",
      nextState: { layerName, levelId, ts: nowMs }
    };
  }

  if (inViewCount >= totalOnLevel) {
    return { action: "viewport", notify: false, nextState: null };
  }

  return {
    action: "viewport",
    notify: true,
    nextState: { layerName, levelId, ts: nowMs }
  };
}

function getVisibleWorldRect(padFraction = 0.02) {
  const stage = canvas?.stage;
  const dims = canvas?.screenDimensions;
  if (!stage || !dims) return null;
  const scale = Math.max(0.001, stage.scale?.x || 1);
  const halfW = (dims[0] / scale) * (0.5 + padFraction);
  const halfH = (dims[1] / scale) * (0.5 + padFraction);
  const px = stage.pivot?.x ?? 0;
  const py = stage.pivot?.y ?? 0;
  return {
    x0: px - halfW,
    y0: py - halfH,
    x1: px + halfW,
    y1: py + halfH,
    scale
  };
}

function notifyKey(key, data = {}, level = "info") {
  if (!ui?.notifications) return;
  const msg = game.i18n?.format ? game.i18n.format(key, data) : key;
  const fn = ui.notifications[level] ?? ui.notifications.info;
  try { fn.call(ui.notifications, msg); } catch {}
}

/**
 * Lightweight screen-scaled selection outline for controlled tokens at macro/orbital zoom (< 0.28x),
 * where Foundry's world-space 4px border shrinks below 1 screen pixel and becomes invisible.
 * Strictly event-driven (0 work per idle frame).
 */
export class MacroSelectionOverlay {
  constructor(controller) {
    this.controller = controller;
    this.gfx = null;
    this._mounted = false;
    this._lastScale = NaN;
  }

  mount() {
    this.unmount();
    const parent = canvas?.interface;
    if (!parent || parent.destroyed) return;
    const gfx = new PIXI.Graphics();
    gfx.name = "BoundlessMacroSelectionOverlay";
    gfx.eventMode = "none";
    gfx.interactiveChildren = false;
    gfx.zIndex = 950;
    gfx.visible = false;
    parent.addChild(gfx);
    this.gfx = gfx;
    this._mounted = true;
    this.refresh(true);
  }

  unmount() {
    this._mounted = false;
    this._lastScale = NaN;
    if (this.gfx) {
      try {
        this.gfx.parent?.removeChild?.(this.gfx);
        if (!this.gfx.destroyed) this.gfx.destroy();
      } catch {}
      this.gfx = null;
    }
  }

  refresh(force = true) {
    if (!this._mounted || !this.gfx || this.gfx.destroyed) return;
    const gfx = this.gfx;
    const rawScale = canvas?.stage?.scale?.x || 1;
    if (!force && this._lastScale === rawScale) return;
    this._lastScale = rawScale;
    const controlled = canvas?.tokens?.controlled;
    const effScale = getEffectiveScale(rawScale);

    if (!this.controller?.active || !controlled?.length || effScale >= MACRO_BORDER_MAX_SCALE) {
      if (gfx.visible) {
        gfx.clear();
        gfx.visible = false;
      }
      return;
    }

    const alpha = smoothstep(MACRO_BORDER_MAX_SCALE, MACRO_BORDER_FULL_SCALE, effScale);
    if (alpha <= 0.02) {
      if (gfx.visible) {
        gfx.clear();
        gfx.visible = false;
      }
      return;
    }

    const color = CONFIG?.Canvas?.dispositionColors?.CONTROLLED ?? 0xFF9829;
    const invScale = 1 / Math.max(0.0005, rawScale);
    const lineWidth = Math.max(3, 2.5 * invScale);
    const pad = Math.max(4, 5 * invScale);
    const minBox = 18 * invScale;
    const radius = Math.max(4, 5 * invScale);
    const grid = canvas.grid?.size || 100;

    gfx.clear();
    gfx.visible = true;
    gfx.lineStyle(lineWidth, color, 0.92 * alpha);
    gfx.beginFill(color, 0.14 * alpha);

    for (let i = 0; i < controlled.length; i++) {
      const tok = controlled[i];
      if (!tok || tok.destroyed) continue;
      const doc = tok.document;
      const docSz = (!tok.w || !tok.h) ? doc?.getSize?.() : null;
      const w = tok.w || docSz?.width || ((Number(doc?.width) || 1) * grid);
      const h = tok.h || docSz?.height || ((Number(doc?.height) || 1) * grid);
      const tx = Number.isFinite(tok.x) ? tok.x : (Number(doc?.x) || 0);
      const ty = Number.isFinite(tok.y) ? tok.y : (Number(doc?.y) || 0);
      const drawW = Math.max(w + pad * 2, minBox);
      const drawH = Math.max(h + pad * 2, minBox);
      const cx = tx + w * 0.5;
      const cy = ty + h * 0.5;
      gfx.drawRoundedRect(cx - drawW * 0.5, cy - drawH * 0.5, drawW, drawH, radius);
    }
    gfx.endFill();
  }
}

/**
 * Install unified global-map selection, two-stage Ctrl+A, impostor clicking, and O(K) bulk-selection patches.
 * Replaces the legacy `installBulkSelectionPatch` without duplicating wrappers.
 */
export function installGlobalSelectionPatches(controller, PERF_CONFIG) {
  if (patchesInstalled) return;
  const PlaceablesLayerCls = foundry.canvas?.layers?.PlaceablesLayer;
  const TokenLayerCls = foundry.canvas?.layers?.TokenLayer ?? CONFIG.Token?.layerClass;
  const TokenCls = foundry.canvas?.placeables?.Token ?? CONFIG.Token?.objectClass;
  const PerceptionCls = foundry.canvas?.perception?.PerceptionManager ?? canvas?.perception?.constructor;
  if (!TokenLayerCls?.prototype || !TokenCls?.prototype?.initializeVisionSource) return;

  const origInitVision = TokenCls.prototype.initializeVisionSource;
  TokenCls.prototype.initializeVisionSource = function (...args) {
    if (_bulkSelectDepth > 0 && !args[0]?.deleted && globalThis.canvas?.ready && (controller?.active || PERF_CONFIG?.perfEnabled)) {
      _bulkVisionDirty = true;
      return;
    }
    return origInitVision.apply(this, args);
  };

  let origPerceptionUpdate = null;
  if (PerceptionCls?.prototype?.update) {
    origPerceptionUpdate = PerceptionCls.prototype.update;
    PerceptionCls.prototype.update = function (flags = {}, ...rest) {
      if (_bulkSelectDepth > 0 && (controller?.active || PERF_CONFIG?.perfEnabled) && flags && typeof flags === "object") {
        if (!_bulkPerceptionFlags) _bulkPerceptionFlags = {};
        for (const [k, v] of Object.entries(flags)) {
          if (v) _bulkPerceptionFlags[k] = v;
        }
        return;
      }
      return origPerceptionUpdate.call(this, flags, ...rest);
    };
  }

  const runBulkOnTokenLayer = (layer, fn) => {
    _bulkSelectDepth++;
    try {
      return fn();
    } finally {
      _bulkSelectDepth--;
      if (_bulkSelectDepth === 0) {
        const visionDirty = _bulkVisionDirty;
        const mergedFlags = _bulkPerceptionFlags;
        _bulkVisionDirty = false;
        _bulkPerceptionFlags = null;

        if (visionDirty && globalThis.canvas?.ready) {
          const placeables = layer?.placeables;
          if (Array.isArray(placeables)) {
            for (let i = 0; i < placeables.length; i++) {
              const t = placeables[i];
              if (!t || t.destroyed) continue;
              // Skip blind NPCs that have no vision source instance and no sight enabled
              const hasSight = Boolean(t.vision || t.document?._source?.sight?.enabled || t.document?.sight?.enabled);
              if (hasSight) {
                // Call the full prototype chain so 3rd-party libWrapper wrappers (vision-5e, levels) still run
                try { t.initializeVisionSource(); } catch {}
              }
            }
          }
          const finalFlags = mergedFlags ? { ...mergedFlags } : {};
          finalFlags.refreshVision = true;
          finalFlags.refreshSounds = true;
          if (layer?.occlusionMode & CONST.TOKEN_OCCLUSION_MODES.CONTROLLED) {
            finalFlags.refreshOcclusion = true;
          }
          try { canvas.perception?.update?.(finalFlags); } catch {}
        } else if (mergedFlags && globalThis.canvas?.ready) {
          try { canvas.perception?.update?.(mergedFlags); } catch {}
        }
        try { controller?.selectionOverlay?.refresh?.(); } catch {}
      }
    }
  };

  const wrapBulkMethod = (methodName, extraHooks = null) => {
    const orig = TokenLayerCls.prototype[methodName];
    if (typeof orig !== "function") return;
    TokenLayerCls.prototype[methodName] = function (...args) {
      if (!controller?.active && !PERF_CONFIG?.perfEnabled) return orig.apply(this, args);
      if (extraHooks?.before) extraHooks.before.call(this, args);
      const res = runBulkOnTokenLayer(this, () => orig.apply(this, args));
      if (extraHooks?.after) extraHooks.after.call(this, args, res);
      return res;
    };
  };

  // 1. Marquee `selectObjects`: support impostors & unmounted TokenDocuments seamlessly at ANY zoom!
  if (typeof TokenLayerCls.prototype.selectObjects === "function") {
    const origSelectObjects = TokenLayerCls.prototype.selectObjects;
    TokenLayerCls.prototype.selectObjects = function (...args) {
      if (!controller?.active && !PERF_CONFIG?.perfEnabled) return origSelectObjects.apply(this, args);
      let missing = null;
      const streamer = controller?.tokenStreamer;
      const callArgs = args.slice();
      if (controller?.active && streamer?.enabled && this.options?.controllableObjects !== false) {
        const rect = callArgs[0];
        if (
          rect &&
          Number.isFinite(rect.x) &&
          Number.isFinite(rect.y) &&
          Number.isFinite(rect.width) &&
          Number.isFinite(rect.height) &&
          rect.width !== 0 &&
          rect.height !== 0
        ) {
          const normRect = (rect.width < 0 || rect.height < 0)
            ? {
                ...rect,
                x: rect.width < 0 ? rect.x + rect.width : rect.x,
                y: rect.height < 0 ? rect.y + rect.height : rect.y,
                width: Math.abs(rect.width),
                height: Math.abs(rect.height)
              }
            : rect;
          callArgs[0] = normRect;
          streamer.cancelPendingSelection();
          const docs = streamer.getControllableDocsInRect(normRect);
          if (docs.length > 0) {
            const m = streamer.prepareMountedTokensForSelection(docs);
            if (m.length > 0) missing = m;
          }
        }
      }
      const res = runBulkOnTokenLayer(this, () => origSelectObjects.apply(this, callArgs));
      if (controller?.active && streamer?.enabled && this.options?.controllableObjects !== false) {
        if (missing?.length) {
          const normRect = callArgs[0];
          const remainingBudget = Math.max(0, MAX_MARQUEE_MATERIALIZE - (this.controlled?.length || 0));
          const selRect = (normRect && typeof PIXI?.Rectangle === "function")
            ? new PIXI.Rectangle(normRect.x, normRect.y, normRect.width, normRect.height)
            : null;
          if (remainingBudget > 0) {
            streamer.materializeAndSelect(missing, {
              releaseOthers: false,
              maxCount: remainingBudget,
              selectionRect: selRect,
              bulkRunner: (fn) => runBulkOnTokenLayer(this, fn)
            });
          }
        }
        if (!streamer._nativeTokensActive) {
          queueMicrotask(() => {
            if (controller.active && streamer.enabled && !streamer._nativeTokensActive) {
              streamer.scheduleSync(null, true);
            }
          });
        }
      }
      return res;
    };
  }

  // 2. `releaseAll`: cancel pending async selection and smoothly hand macro-zoom tokens back to Impostors
  wrapBulkMethod("releaseAll", {
    before() {
      controller?.tokenStreamer?.cancelPendingSelection?.();
    },
    after() {
      const streamer = controller?.tokenStreamer;
      if (controller?.active && streamer?.enabled && !streamer._nativeTokensActive) {
        queueMicrotask(() => {
          if (controller.active && streamer.enabled) {
            streamer.scheduleSync(null, true);
          }
        });
      }
    }
  });

  // 3. `controlAll`: previously unwrapped in Foundry v14 -> caused O(K^2) vision storm on Ctrl+A!
  //    Also restore `renderable` on mounted tokens when called directly at macro zoom on Boundless.
  wrapBulkMethod("controlAll", {
    before() {
      const streamer = controller?.tokenStreamer;
      if (!controller?.active || !streamer?.enabled) return;
      const docs = streamer.getControllableDocsOnLevel?.();
      if (docs?.length) streamer.prepareMountedTokensForSelection?.(docs);
    }
  });

  // 4. Smart two-stage Ctrl+A on PlaceablesLayer
  const isEditableFocused = () => {
    if (globalThis.game?.keyboard?.hasFocus) return true;
    const el = globalThis.document?.activeElement;
    if (!el || el === globalThis.document?.body) return false;
    const tag = el.tagName;
    if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return true;
    return Boolean(el.isContentEditable || el.closest?.('[contenteditable="true"], .ProseMirror'));
  };

  let lastSelectAllState = null;
  if (PlaceablesLayerCls?.prototype?._onSelectAllKey) {
    const origSelectAllKey = PlaceablesLayerCls.prototype._onSelectAllKey;
    PlaceablesLayerCls.prototype._onSelectAllKey = function (event) {
      if (isEditableFocused()) return false;
      if (!this.options?.controllableObjects || !this.active) {
        return origSelectAllKey.call(this, event);
      }

      const isBoundless = Boolean(controller?.active);
      if (!isBoundless && !PERF_CONFIG?.perfEnabled) {
        return origSelectAllKey.call(this, event);
      }
      const layerName = this.options?.name || this.constructor?.name || "";
      const levelId = canvas?.level?.id || "";
      const nowMs = performance.now();
      const vp = isBoundless ? controller.getViewportWorldRect(0.02) : getVisibleWorldRect(0.02);

      // Special handling for TokenLayer with Boundless TokenStreamer (handles impostors & unmounted NPCs!)
      if (isBoundless && this === canvas.tokens && controller.tokenStreamer?.enabled && vp) {
        const streamer = controller.tokenStreamer;
        const inViewDocs = streamer.getControllableDocsInRect(vp);
        const allLevelDocs = streamer.getControllableDocsOnLevel();
        const plan = computeSmartSelectAllPlan({
          isBoundless: true,
          totalOnLevel: allLevelDocs.length,
          inViewCount: inViewDocs.length,
          lastState: lastSelectAllState,
          nowMs,
          layerName,
          levelId
        });
        lastSelectAllState = plan.nextState;

        if (plan.action === "prompt-level-empty") {
          notifyKey("BOUNDLESS.Selection.ViewportEmpty", { total: allLevelDocs.length }, "info");
          return true;
        }

        if (plan.action === "viewport") {
          const res = streamer.materializeAndSelect(inViewDocs, {
            releaseOthers: true,
            maxCount: MAX_MARQUEE_MATERIALIZE,
            bulkRunner: (fn) => runBulkOnTokenLayer(this, fn)
          });
          const picked = Math.min(inViewDocs.length, MAX_MARQUEE_MATERIALIZE);
          if (res.capped) {
            notifyKey("BOUNDLESS.Selection.LevelCapped", {
              selected: picked,
              total: allLevelDocs.length
            }, "warn");
          } else if (plan.notify) {
            notifyKey("BOUNDLESS.Selection.ViewportSelected", {
              selected: picked,
              total: allLevelDocs.length
            }, "info");
          }
          return true;
        }

        if (plan.action === "level") {
          const res = streamer.materializeAndSelect(allLevelDocs, {
            releaseOthers: true,
            maxCount: MAX_CTRL_A_TOKENS,
            bulkRunner: (fn) => runBulkOnTokenLayer(this, fn)
          });
          const picked = Math.min(allLevelDocs.length, MAX_CTRL_A_TOKENS);
          if (res.capped) {
            notifyKey("BOUNDLESS.Selection.LevelCapped", { selected: picked, total: allLevelDocs.length }, "warn");
          } else if (allLevelDocs.length > 0) {
            notifyKey("BOUNDLESS.Selection.LevelSelected", { selected: picked }, "info");
          }
          return true;
        }
      }

      // Virtual Boundless editor layers (walls, lighting, sounds, tiles): guard macro overview and select viewport cleanly
      if (isBoundless && vp) {
        const isVirtualWalls = this === canvas.walls && controller.wallEditor?.active;
        const isVirtualLights = this === canvas.lighting && controller.layerEditors?.lightActive;
        const isVirtualSounds = this === canvas.sounds && controller.layerEditors?.soundActive;
        const isVirtualTiles = this === canvas.tiles && controller.layerEditors?.tileActive;
        if (isVirtualWalls || isVirtualLights || isVirtualSounds || isVirtualTiles) {
          if (isVirtualWalls) controller.wallEditor.syncViewport(true, vp);
          else controller.layerEditors.syncViewport(true, vp);

          const inMacroOverview =
            (isVirtualWalls && controller.wallEditor.macroGfx?.visible) ||
            (isVirtualLights && controller.layerEditors.lightMacroGfx?.visible) ||
            (isVirtualSounds && controller.layerEditors.soundMacroGfx?.visible) ||
            (isVirtualTiles && (controller.layerEditors._getViewedLayer?.()?.spec?.tiles?.length > 0) && getEffectiveScale(vp.scale) < 0.18);
          if (inMacroOverview) {
            notifyKey("BOUNDLESS.Selection.ZoomInVirtualLayer", {}, "info");
            return true;
          }
          this.selectObjects({ x: vp.x0, y: vp.y0, width: vp.x1 - vp.x0, height: vp.y1 - vp.y0 }, { releaseOthers: true });
          return true;
        }
      }

      // Standard placeable layers (drawings, notes, templates, regions, or dense standard scenes > 80 objects)
      if (vp) {
        const allControllable = Array.from(this.controllableObjects());
        const rect = new PIXI.Rectangle(vp.x0, vp.y0, vp.x1 - vp.x0, vp.y1 - vp.y0);
        let inViewCount = 0;
        for (let i = 0; i < allControllable.length; i++) {
          if (allControllable[i]._overlapsSelection?.(rect)) inViewCount++;
        }
        const plan = computeSmartSelectAllPlan({
          isBoundless,
          totalOnLevel: allControllable.length,
          inViewCount,
          lastState: lastSelectAllState,
          nowMs,
          layerName,
          levelId
        });
        lastSelectAllState = plan.nextState;

        if (plan.action === "prompt-level-empty") {
          notifyKey("BOUNDLESS.Selection.ViewportEmpty", { total: allControllable.length }, "info");
          return true;
        }
        if (plan.action === "viewport") {
          this.selectObjects({ x: vp.x0, y: vp.y0, width: vp.x1 - vp.x0, height: vp.y1 - vp.y0 }, { releaseOthers: true });
          if (plan.notify) {
            notifyKey("BOUNDLESS.Selection.ViewportSelected", {
              selected: inViewCount,
              total: allControllable.length
            }, "info");
          }
          return true;
        }
        if (plan.action === "level") {
          return origSelectAllKey.call(this, event);
        }
      }

      return origSelectAllKey.call(this, event);
    };
  }

  // 5. Click & double-click directly on GPU Token Impostors at macro/orbital zoom
  if (typeof TokenLayerCls.prototype._onClickLeft === "function") {
    const origClickLeft = TokenLayerCls.prototype._onClickLeft;
    TokenLayerCls.prototype._onClickLeft = function (event) {
      const streamer = controller?.tokenStreamer;
      if (
        this.active &&
        controller?.active &&
        streamer?.enabled &&
        !streamer._nativeTokensActive &&
        !this._draggedToken &&
        !this.hover &&
        (game.activeTool === "select" || game.activeTool === "target") &&
        !event?.ctrlKey &&
        !event?.metaKey &&
        !canvas.controls?.ruler?.active &&
        !CONFIG.Canvas?.rulerClass?.canMeasure
      ) {
        const origin = event?.interactionData?.origin ?? event?.getLocalPosition?.(this);
        if (origin && Number.isFinite(origin.x) && Number.isFinite(origin.y)) {
          const rawScale = Math.max(0.0005, canvas.stage?.scale?.x || 1);
          const minHitRadius = Math.max(40, 14 / rawScale);
          if (game.activeTool === "target") {
            const hitDoc = streamer.findHitDocAtPoint(origin.x, origin.y, minHitRadius, { minPermission: null });
            if (hitDoc) {
              const releaseOthers = !event.shiftKey;
              Promise.resolve(streamer.materializeDoc?.(hitDoc)).then((tok) => {
                if (!tok || tok.destroyed) return;
                tok.setTarget?.(!tok.isTargeted, { releaseOthers });
                if (!streamer._nativeTokensActive) {
                  queueMicrotask(() => {
                    if (controller.active && streamer.enabled && !streamer._nativeTokensActive) {
                      streamer.scheduleSync(null, true);
                    }
                  });
                }
              }).catch(() => {});
              return;
            }
          } else {
            const hitDoc = streamer.findHitDocAtPoint(origin.x, origin.y, minHitRadius);
            if (hitDoc) {
              this.hud?.close?.();
              if (event.shiftKey && hitDoc._object?.controlled) {
                hitDoc._object.release();
                controller?.selectionOverlay?.refresh?.();
                queueMicrotask(() => {
                  if (controller.active && streamer.enabled && !streamer._nativeTokensActive) {
                    streamer.scheduleSync(null, true);
                  }
                });
                return;
              }
              streamer.materializeAndSelect([hitDoc], {
                releaseOthers: !event.shiftKey,
                maxCount: 1,
                bulkRunner: (fn) => runBulkOnTokenLayer(this, fn)
              });
              return;
            }
          }
        }
      }
      return origClickLeft.call(this, event);
    };
  }

  if (typeof TokenLayerCls.prototype._onClickLeft2 === "function") {
    const origClickLeft2 = TokenLayerCls.prototype._onClickLeft2;
    TokenLayerCls.prototype._onClickLeft2 = function (event) {
      const streamer = controller?.tokenStreamer;
      if (
        this.active &&
        controller?.active &&
        streamer?.enabled &&
        !streamer._nativeTokensActive &&
        !this._draggedToken &&
        !this.hover &&
        game.activeTool === "select" &&
        !event?.shiftKey &&
        !event?.ctrlKey &&
        !event?.metaKey &&
        !canvas.controls?.ruler?.active &&
        !CONFIG.Canvas?.rulerClass?.canMeasure
      ) {
        const origin = event?.interactionData?.origin ?? event?.getLocalPosition?.(this);
        if (origin && Number.isFinite(origin.x) && Number.isFinite(origin.y)) {
          const rawScale = Math.max(0.0005, canvas.stage?.scale?.x || 1);
          const minHitRadius = Math.max(40, 14 / rawScale);
          const minPermission = event?.altKey ? "OWNER" : "LIMITED";
          const hitDoc = streamer.findHitDocAtPoint(origin.x, origin.y, minHitRadius, { minPermission });
          if (hitDoc) {
            if (event.altKey) {
              if (hitDoc.canUserModify?.(game.user, "update") && hitDoc.sheet?.render) {
                hitDoc.sheet.render(true);
                return;
              }
            } else if (hitDoc.flags?.["item-piles"]?.data?.enabled) {
              Promise.resolve(streamer.materializeDoc?.(hitDoc)).then((tok) => {
                if (tok && !tok.destroyed) tok._onClickLeft2?.(event);
                if (!streamer._nativeTokensActive) {
                  queueMicrotask(() => {
                    if (controller.active && streamer.enabled && !streamer._nativeTokensActive) {
                      streamer.scheduleSync(null, true);
                    }
                  });
                }
              }).catch(() => {});
              return;
            } else {
              const sheet = hitDoc.actor?.sheet;
              if (sheet?.render) {
                if (sheet.rendered) {
                  sheet.maximize?.();
                  sheet.bringToFront?.();
                } else {
                  sheet.render(true, { token: hitDoc });
                }
                return;
              }
            }
          }
        }
      }
      return origClickLeft2.call(this, event);
    };
  }

  // Right-click on macro-zoom impostor opens native Token HUD cleanly
  if (typeof TokenLayerCls.prototype._onClickRight === "function") {
    const origClickRight = TokenLayerCls.prototype._onClickRight;
    TokenLayerCls.prototype._onClickRight = function (event) {
      const streamer = controller?.tokenStreamer;
      if (
        this.active &&
        controller?.active &&
        streamer?.enabled &&
        !streamer._nativeTokensActive &&
        !this._draggedToken &&
        !this.hover &&
        game.activeTool === "select" &&
        !event?.ctrlKey &&
        !event?.metaKey
      ) {
        const origin = event?.interactionData?.origin ?? event?.getLocalPosition?.(this);
        if (origin && Number.isFinite(origin.x) && Number.isFinite(origin.y)) {
          const rawScale = Math.max(0.0005, canvas.stage?.scale?.x || 1);
          const minHitRadius = Math.max(40, 14 / rawScale);
          const hitDoc = streamer.findHitDocAtPoint(origin.x, origin.y, minHitRadius);
          if (hitDoc) {
            const alreadyControlled = Boolean(hitDoc._object?.controlled);
            streamer.materializeAndSelect([hitDoc], {
              releaseOthers: !alreadyControlled && !event.shiftKey,
              maxCount: 1,
              bulkRunner: (fn) => runBulkOnTokenLayer(this, fn),
              onComplete: (tokens) => {
                const tok = tokens?.[0] || hitDoc._object;
                if (tok && !tok.destroyed && this.active && (typeof tok._canHUD !== "function" || tok._canHUD(game.user, event))) {
                  if (tok.hasActiveHUD) this.hud?.close?.();
                  else this.hud?.bind?.(tok);
                }
              }
            });
            return;
          }
        }
      }
      return origClickRight.call(this, event);
    };
  }

  patchesInstalled = true;
}
