import { TokenImpostorLayer } from "./token-impostors.mjs";
import { MODULE_ID, getShowstopperMovementApi, getEffectiveScale, getLevelBaseElevation, hasTokenPermissionLazy } from "./utils.mjs";
import { invalidateTokenLayerCache } from "./perf-gpu.mjs";

const TOKEN_SECTOR_PX = 4000;       // 40x40 cells per spatial bucket
const MOUNT_ENTER_SCALE = 0.11;     // Start streaming native NPC placeables when descending past 0.11x (11px/token)
const MOUNT_EXIT_SCALE = 0.085;     // Hysteresis exit: hand back to GPU Impostor Atlas below 0.085x
const MOUNT_VP_PAD_PX = 1600;       // Pre-draw native tokens 16 cells outside viewport edge
const CULL_VP_PAD_PX = 450;         // Frustum culling margin for `renderable` toggle
const LOD_DETAIL_MIN_SCALE = 0.22;  // Below 0.22x hide tiny unreadable nameplate/tooltip/bars/effects
const UNMOUNT_MIN_DIST_PX = 10000;  // Distance outside viewport before LRU-evicting offscreen PIXI placeable
const MAX_MOUNTED_NPCS = 160;       // Client-side PIXI placeable budget (TokenDocuments stay 100% intact in DB!)
const WARM_ORBIT_KEEP = 48;         // Keep a warm cache of 48 recently seen NPCs when zooming briefly to orbit
const DRAW_FRAME_BUDGET_MS = 2.4;   // Max main-thread time spent calling native Token#draw() per animation frame (120 FPS safe)
const FLIGHT_PREWARM_BUDGET_MS = 1.6; // Low frame budget while camera is flying so 120+ FPS flight stays silky
const MAX_DRAWS_PER_FRAME = 3;      // Cap per rAF once textures are pre-decoded in parallel
const CROSSFADE_MS = 160;           // Smooth over-composite Impostor -> Native fade duration
const PREDECODE_LOOKAHEAD = 6;      // Parallel off-blocking texture pre-decode batch size

function getSectorCoords(x, y) {
  return [
    Math.floor((Number(x) || 0) / TOKEN_SECTOR_PX),
    Math.floor((Number(y) || 0) / TOKEN_SECTOR_PX)
  ];
}

function getSectorKey(x, y) {
  const [sx, sy] = getSectorCoords(x, y);
  return `${sx}_${sy}`;
}

function getTokenDocBounds(doc, grid) {
  const x = Number(doc?._source?.x ?? doc?.x ?? 0);
  const y = Number(doc?._source?.y ?? doc?.y ?? 0);
  const sz = typeof doc?.getSize === "function" ? doc.getSize() : null;
  const w = (sz && Number.isFinite(sz.width)) ? sz.width : ((Number(doc?._source?.width ?? doc?.width ?? 1) || 1) * grid);
  const h = (sz && Number.isFinite(sz.height)) ? sz.height : ((Number(doc?._source?.height ?? doc?.height ?? 1) || 1) * grid);
  const cp = typeof doc?.getCenterPoint === "function" ? doc.getCenterPoint() : null;
  const cx = (cp && Number.isFinite(cp.x)) ? cp.x : (x + w * 0.5);
  const cy = (cp && Number.isFinite(cp.y)) ? cp.y : (y + h * 0.5);
  return { x, y, w, h, cx, cy };
}

/**
 * Determine whether a TokenDocument must stay permanently mounted as a live Token placeable
 * (PCs, linked story actors, combatants, light emitters, GM-pinned, controlled/targeted).
 * Never touches `doc.actor` so Foundry v14 lazy `ActorDelta` stays untouched for idle NPCs.
 */
function isAlwaysMountedTokenDoc(doc) {
  if (!doc) return true;
  if (doc.actorLink) return true;
  const base = doc.baseActor;
  if (base?.hasPlayerOwner || base?.type === "character") return true;
  if (!game.user?.isGM && hasTokenPermissionLazy(doc, game.user, "OWNER")) return true;
  if (!game.user?.isGM && (doc.sight?.enabled ?? doc._source?.sight?.enabled) && hasTokenPermissionLazy(doc, game.user, "OBSERVER")) return true;
  if (doc.flags?.[MODULE_ID]?.pinned) return true;
  if (doc.combatant) return true;
  if (game.combat?.combatants?.some?.(c => c.tokenId === doc.id && c.sceneId === doc.parent?.id)) return true;
  const light = doc.light ?? doc._source?.light;
  if ((Number(light?.dim) || 0) > 0 || (Number(light?.bright) || 0) > 0) return true;
  const obj = doc._object;
  if (obj && !obj.destroyed) {
    if (obj.controlled || obj.hasPreview || obj.hasActiveHUD || obj.movementAnimationPromise || (obj.animationContexts?.size > 0)) return true;
    if (obj.targeted?.size > 0) return true;
  }
  return false;
}

function isLazyTokenLayerActiveForScene(scene) {
  if (!scene) return false;
  const cfg = scene.flags?.[MODULE_ID] || {};
  if (cfg.virtualizeTokens === false) return false;
  const visibleLevels = (scene.levels?.sorted || []).filter(l => l?.isVisible);
  if (!visibleLevels.length && canvas?.level && canvas.scene?.id === scene.id) {
    visibleLevels.push(canvas.level);
  }
  if (visibleLevels.length > 0) {
    const anyLevelEnabled = visibleLevels.some(l => l.flags?.[MODULE_ID]?.enabled === true);
    const sceneEnabledForVisible = Boolean(cfg.enabled) && visibleLevels.some(l => l.flags?.[MODULE_ID]?.enabled !== false);
    return anyLevelEnabled || sceneEnabledForVisible;
  }
  return Boolean(cfg.enabled || scene.levels?.some?.(l => l.flags?.[MODULE_ID]?.enabled));
}

let lazyPatchInstalled = false;
let lazyFilteredViewKey = null;
let lazyDrawDepth = 0;
const coreDrawingCounts = new WeakMap();
const coreDrawPromises = new WeakMap();

/**
 * Patch `TokenLayer.prototype.viewedDocuments` ONCE at init so initial `TokenLayer#_draw()`
 * on Boundless scenes only mounts core/PC/combat/light tokens synchronously (~15ms startup even with 3000 native tokens!),
 * while all remaining NPCs stay 100% intact in `scene.tokens` (preserving `isLazyDelta = true`) and stream
 * natively via `TokenStreamer` strictly within each client's viewport.
 */
export function installLazyTokenLayerPatch() {
  if (lazyPatchInstalled) return;
  const TokenLayerCls = foundry.canvas?.layers?.TokenLayer ?? CONFIG.Token?.layerClass;
  if (!TokenLayerCls?.prototype?.viewedDocuments) return;

  if (typeof TokenLayerCls.prototype._draw === "function") {
    const origLayerDraw = TokenLayerCls.prototype._draw;
    TokenLayerCls.prototype._draw = async function (...args) {
      lazyDrawDepth++;
      try {
        return await origLayerDraw.apply(this, args);
      } finally {
        lazyDrawDepth = Math.max(0, lazyDrawDepth - 1);
        if (lazyDrawDepth === 0) {
          const ts = globalThis.Boundless?.tokenStreamer;
          const scene = this.scene ?? globalThis.canvas?.scene;
          if (ts?.enabled && scene?.id && ts.sceneId === scene.id) {
            ts._lastStreamKey = "";
            ts.impostors?.markVisibilityDirty?.();
            ts._queueSyncMicrotask?.(true);
          }
        }
      }
    };
  }

  const origViewed = TokenLayerCls.prototype.viewedDocuments;
  TokenLayerCls.prototype.viewedDocuments = function* () {
    const scene = this.scene ?? canvas?.scene;
    if (lazyDrawDepth <= 0 || !isLazyTokenLayerActiveForScene(scene)) {
      yield* origViewed.call(this);
      return;
    }
    const viewKey = `${scene.id}::${canvas?.level?.id ?? ""}`;
    for (const doc of origViewed.call(this)) {
      if (isAlwaysMountedTokenDoc(doc)) {
        yield doc;
      } else {
        lazyFilteredViewKey = viewKey;
      }
    }
  };
  const TokenCls = foundry.canvas?.placeables?.Token ?? CONFIG.Token?.objectClass;
  if (TokenCls?.prototype?.draw) {
    const origDraw = TokenCls.prototype.draw;
    TokenCls.prototype.draw = function (...args) {
      coreDrawingCounts.set(this, (coreDrawingCounts.get(this) || 0) + 1);
      const cleanup = (promiseRef) => {
        const rem = (coreDrawingCounts.get(this) || 1) - 1;
        if (rem <= 0) {
          coreDrawingCounts.delete(this);
          if (!promiseRef || coreDrawPromises.get(this) === promiseRef) coreDrawPromises.delete(this);
        } else {
          coreDrawingCounts.set(this, rem);
        }
      };
      let rawRes;
      try {
        rawRes = origDraw.apply(this, args);
      } catch (err) {
        cleanup(null);
        throw err;
      }
      const p = Promise.resolve(rawRes).finally(() => cleanup(p));
      coreDrawPromises.set(this, p);
      return p;
    };
  }
  lazyPatchInstalled = true;
}

/**
 * Pure Client-Side Lazy Native TokenLayer Streamer + Dynamic Impostor Atlas (0 DB writes, 100% native compatibility).
 * - Every `TokenDocument` lives permanently in `scene.tokens` (zero fake `preCreate`/`create`/`deleteToken` hooks ->
 *   100% compatibility with `cs-hero-box`, `multiple-rings`, `midi-qol`, `dae`, `auraeffects`, `showstopper`, rotations, FoW).
 * - Above tactical zoom, `TokenImpostorLayer` renders all visible tokens in 1 GPU draw call inside `canvas.primary`
 *   using a dynamic 64x64 Texture Atlas (with strict Foundry v14 FoW/vision/roof gating).
 * - When zooming in (or prewarming a `flyTo` landing zone), native `Token#draw()` streams in with parallel texture
 *   pre-decoding and a 160ms over-composite crossfade via `mesh.unoccludedAlpha` (never mutating `tok.alpha`/`mesh.alpha`).
 */
export class TokenStreamer {
  constructor(controller) {
    this.controller = controller;
    this.impostors = new TokenImpostorLayer(controller, this);
    this.enabled = false;
    this.sceneId = null;

    /** @type {Map<string, Set<string>>} "sx_sy" -> Set<docId> */
    this.sectorIndex = new Map();
    /** @type {Map<string, string>} docId -> "sx_sy" */
    this.docSector = new Map();
    /** @type {Map<string, number>} docId -> lastVisibleTimestampMs (for client-side LRU eviction) */
    this.lastSeenMs = new Map();

    /** @type {Array<{ doc: any, distSq: number, isPrewarm?: boolean }>} */
    this._drawQueue = [];
    /** @type {Set<string>} */
    this._queuedIds = new Set();
    /** @type {Set<string>} */
    this._drawingIds = new Set();
    /** @type {Set<string>} */
    this._decodedTexSrcs = new Set();
    /** @type {Map<string, Promise>} */
    this._inflightTexLoads = new Map();
    /** @type {Map<string, { tok: any, doc: any, t: number, dur: number, hasUnoccluded: boolean, targetOccluded: number, isTranslucent: boolean }>} */
    this._activeFades = new Map();

    this._rafId = null;
    this._materializeRafId = null;
    this._selectRafId = null;
    this._selectGen = 0;
    this._selectingBatch = false;
    this._pumping = false;
    this._evictTimer = null;
    this._gen = 0;
    this._lastVp = null;
    this._lastLodDetail = null;
    this._lastStreamKey = "";
    this._nativeTokensActive = false;
    this._flightPrewarmTarget = null;
    this._syncMicrotaskQueued = false;
    this._syncMicrotaskForce = false;
  }

  isTokenDrawing(tok) {
    if (!tok) return false;
    if ((coreDrawingCounts.get(tok) || 0) > 0) return true;
    const docId = tok.document?.id;
    return Boolean(docId && this._drawingIds.has(docId));
  }

  _indexDoc(doc) {
    if (!doc?.id) return;
    const x = Number(doc._source?.x ?? doc.x ?? 0);
    const y = Number(doc._source?.y ?? doc.y ?? 0);
    const sk = getSectorKey(x, y);
    const prev = this.docSector.get(doc.id);
    if (prev === sk) return;
    if (prev) {
      const oldSet = this.sectorIndex.get(prev);
      if (oldSet) {
        oldSet.delete(doc.id);
        if (oldSet.size === 0) this.sectorIndex.delete(prev);
      }
    }
    let set = this.sectorIndex.get(sk);
    if (!set) {
      set = new Set();
      this.sectorIndex.set(sk, set);
    }
    set.add(doc.id);
    this.docSector.set(doc.id, sk);
  }

  _unindexDoc(docId) {
    const prev = this.docSector.get(docId);
    if (!prev) return;
    this.docSector.delete(docId);
    const set = this.sectorIndex.get(prev);
    if (set) {
      set.delete(docId);
      if (set.size === 0) this.sectorIndex.delete(prev);
    }
    this.lastSeenMs.delete(docId);
  }

  _finishFadeImmediate(docId) {
    const fade = this._activeFades.get(docId);
    if (!fade) return;
    this._activeFades.delete(docId);
    if (fade.hasUnoccluded && fade.tok?.mesh && !fade.tok.mesh.destroyed) {
      fade.tok.mesh.unoccludedAlpha = 1.0;
      fade.tok.mesh.occludedAlpha = fade.targetOccluded;
    }
    this.impostors.setFadeOverride(docId, null);
  }

  mount(scene) {
    this.unmount();
    if (!isLazyTokenLayerActiveForScene(scene)) return;

    this.enabled = true;
    this.sceneId = scene.id;
    this._gen++;
    lazyFilteredViewKey = null;
    const curScale = canvas?.stage?.scale?.x ?? 1;
    this._nativeTokensActive = curScale >= MOUNT_ENTER_SCALE;

    // Build O(1) spatial hash of all native TokenDocuments without touching `doc.actor`
    const iterable = scene.tokens?.values?.() ?? scene.tokens ?? [];
    for (const doc of iterable) {
      this._indexDoc(doc);
    }

    this.impostors.mount(scene);
  }

  _cancelMaterialize() {
    if (this._materializeRafId !== null) {
      if (typeof cancelAnimationFrame === "function") {
        try { cancelAnimationFrame(this._materializeRafId); } catch {}
      } else {
        clearTimeout(this._materializeRafId);
      }
      this._materializeRafId = null;
    }
  }

  _materializeMissingPlaceables(scene, gen, { allowWhenFlagsEnabled = false } = {}) {
    this._cancelMaterialize();
    if (!scene?.tokens || !canvas?.tokens?.objects) return;
    const queue = [];
    for (const doc of scene.tokens) {
      if (!doc || !doc.viewed) continue;
      const existing = doc._object;
      if (existing && !existing.destroyed && existing.parent === canvas.tokens.objects) continue;
      queue.push(doc);
    }
    if (!queue.length) {
      lazyFilteredViewKey = null;
      return;
    }

    const sched = typeof requestAnimationFrame === "function" ? requestAnimationFrame : (fn => setTimeout(fn, 16));
    const step = async () => {
      this._materializeRafId = null;
      if (gen !== this._gen || this.enabled || !canvas?.ready || canvas.scene?.id !== scene.id || !canvas.tokens?.objects) return;
      if (this.controller?._mounting) {
        this._materializeRafId = sched(() => { step(); });
        return;
      }
      if (allowWhenFlagsEnabled) {
        if (this.controller?.active) return;
      } else if (isLazyTokenLayerActiveForScene(canvas.scene)) {
        return;
      }
      const layer = canvas.tokens;
      const startMs = performance.now();
      let drawn = 0;
      let anyPerception = false;

      while (queue.length > 0 && drawn < MAX_DRAWS_PER_FRAME && (performance.now() - startMs) < DRAW_FRAME_BUDGET_MS) {
        const doc = queue.shift();
        if (!doc || doc.parent?.id !== scene.id || !scene.tokens?.has?.(doc.id) || !doc.viewed) continue;
        const existing = doc._object;
        if (existing && !existing.destroyed && existing.parent === layer.objects) continue;
        try {
          doc._destroyed = false;
          const obj = (doc._object && !doc._object.destroyed) ? doc._object : layer.createObject(doc);
          doc._object = obj;
          if (obj.parent !== layer.objects) layer.objects.addChild(obj);
          await obj.draw();
          if (gen !== this._gen || this.enabled || !canvas?.ready || canvas.scene?.id !== scene.id) return;
          if (!scene.tokens?.has?.(doc.id) || obj.destroyed) {
            if (!obj.destroyed) {
              try {
                layer.objects.removeChild(obj);
                obj.destroy({ children: true });
              } catch {}
            }
            continue;
          }
          drawn++;
          if (doc._source?.sight?.enabled || Number(doc._source?.light?.dim || 0) > 0 || Number(doc._source?.light?.bright || 0) > 0) {
            anyPerception = true;
          }
        } catch (err) {
          console.warn(`${MODULE_ID} | Failed to restore virtualized token "${doc.name}":`, err);
        }
      }

      if (anyPerception && canvas?.ready && canvas.scene?.id === scene.id) {
        canvas.perception?.update?.({ initializeVision: true, initializeLighting: true, refreshVision: true, refreshLighting: true });
      }

      if (queue.length > 0 && gen === this._gen && !this.enabled && canvas?.ready && canvas.scene?.id === scene.id) {
        this._materializeRafId = sched(() => { step(); });
      } else if (queue.length === 0 && gen === this._gen) {
        lazyFilteredViewKey = null;
      }
    };

    this._materializeRafId = sched(() => { step(); });
  }

  unmount() {
    const wasEnabled = this.enabled;
    const prevSceneId = this.sceneId;
    this.enabled = false;
    this.sceneId = null;
    this._gen++;
    this.cancelPendingSelection();
    this._cancelMaterialize();
    if (this._rafId !== null && typeof cancelAnimationFrame === "function") {
      try { cancelAnimationFrame(this._rafId); } catch {}
    }
    this._rafId = null;
    this._pumping = false;
    if (this._evictTimer !== null) {
      clearTimeout(this._evictTimer);
      this._evictTimer = null;
    }
    for (const docId of Array.from(this._activeFades.keys())) {
      this._finishFadeImmediate(docId);
    }
    this._activeFades.clear();
    if (wasEnabled && canvas?.tokens?.placeables) {
      const roofHidden = this.controller?._roofHiddenTokens;
      for (const tok of canvas.tokens.placeables) {
        if (!tok || tok.destroyed || tok.isPreview) continue;
        if (tok.nameplate) tok.nameplate.renderable = true;
        if (tok.tooltip) tok.tooltip.renderable = true;
        if (tok.bars) tok.bars.renderable = true;
        if (tok.effects) tok.effects.renderable = true;
        if (roofHidden?.has?.(tok)) continue;
        tok.renderable = true;
        if (tok.mesh && !tok.mesh.destroyed) {
          tok.mesh.renderable = true;
          const hiddenByShowstopper = typeof tok._ssOcclusionAlpha === "number" && Number.isFinite(tok._ssOcclusionAlpha) && tok._ssOcclusionAlpha <= 0.01;
          if (tok.visible !== false && !hiddenByShowstopper && tok.mesh.visible === false) {
            tok.mesh.visible = true;
          }
        }
        if (tok._ssJumpShadow && !tok._ssJumpShadow.destroyed) {
          tok._ssJumpShadow.renderable = true;
        }
      }
    }
    this.impostors.unmount();

    this._drawQueue = [];
    this._queuedIds.clear();
    this._drawingIds.clear();
    this._decodedTexSrcs.clear();
    this._inflightTexLoads.clear();
    this.sectorIndex.clear();
    this.docSector.clear();
    this.lastSeenMs.clear();
    this._lastVp = null;
    this._lastLodDetail = null;
    this._lastStreamKey = "";
    this._nativeTokensActive = false;
    this._flightPrewarmTarget = null;
    this._syncMicrotaskQueued = false;
    this._syncMicrotaskForce = false;

    const curScene = canvas?.scene;
    const curViewKey = curScene?.id ? `${curScene.id}::${canvas?.level?.id ?? ""}` : null;
    if (
      wasEnabled &&
      prevSceneId &&
      canvas?.ready &&
      curScene?.id === prevSceneId &&
      canvas.tokens?.objects
    ) {
      if (curViewKey) lazyFilteredViewKey = curViewKey;
      if (!isLazyTokenLayerActiveForScene(curScene)) {
        this._materializeMissingPlaceables(curScene, this._gen);
      } else if (!this.controller?.active) {
        this._materializeMissingPlaceables(curScene, this._gen, { allowWhenFlagsEnabled: true });
      }
    } else if (
      !wasEnabled &&
      curViewKey &&
      lazyFilteredViewKey === curViewKey &&
      canvas?.ready &&
      canvas.tokens?.objects
    ) {
      if (!isLazyTokenLayerActiveForScene(curScene)) {
        this._materializeMissingPlaceables(curScene, this._gen);
      } else if (!this.controller?.active) {
        this._materializeMissingPlaceables(curScene, this._gen, { allowWhenFlagsEnabled: true });
      }
    }
  }

  getStats() {
    const totalDocs = canvas?.scene?.tokens?.size ?? 0;
    const mountedPlaceables = canvas?.tokens?.objects?.children?.length ?? 0;
    let renderableCount = 0;
    for (const t of canvas?.tokens?.placeables || []) {
      if (t && !t.destroyed && t.renderable) renderableCount++;
    }
    return {
      enabled: this.enabled,
      totalDocs,
      mountedPlaceables,
      renderableCount,
      queuedDraws: this._drawQueue.length,
      activeFades: this._activeFades.size,
      sectors: this.sectorIndex.size,
      impostors: this.impostors.getStats()
    };
  }

  /**
   * Called each frame from `controller.stepCrossfades(dtMs)`.
   * Drives smooth 160ms over-composite Impostor -> Native crossfades and flushes dirty Impostor Atlas/VBO buffers.
   */
  step(dtMs) {
    if (!this.enabled) return;

    if (this._activeFades.size > 0) {
      const dt = Math.min(50, Math.max(1, dtMs || 16.6));
      for (const [docId, fade] of Array.from(this._activeFades.entries())) {
        const tok = fade.tok;
        if (!tok || tok.destroyed || !tok.mesh || tok.mesh.destroyed) {
          this._activeFades.delete(docId);
          this.impostors.setFadeOverride(docId, null);
          continue;
        }
        fade.t = Math.min(1.0, fade.t + dt / fade.dur);
        const t = fade.t;

        if (fade.hasUnoccluded) {
          tok.mesh.unoccludedAlpha = t;
          tok.mesh.occludedAlpha = fade.targetOccluded * t;
          // Over-composite for opaque tokens (impostor stays 1.0 under native mesh until t=0.85 so ground never bleeds through)
          const impMult = fade.isTranslucent
            ? (1.0 - t)
            : (t < 0.85 ? 1.0 : Math.max(0.0, 1.0 - (t - 0.85) / 0.15));
          this.impostors.setFadeOverride(docId, impMult);
        } else {
          // Zero-mutation fallback: native renders immediately at native alpha while impostor dissolves beneath it
          this.impostors.setFadeOverride(docId, 1.0 - t);
        }

        if (t >= 1.0) {
          this._finishFadeImmediate(docId);
        }
      }
    }

    this.impostors.tick();
  }

  /**
   * Pre-decode textures and silently mount nearest tokens around a `flyTo` landing point
   * while camera is in flight (<= 2ms/frame budget), eliminating post-landing token pop-in.
   */
  prewarmTarget(worldX, worldY, targetScale) {
    if (!this.enabled || !canvas?.ready || !canvas.scene?.tokens) return;
    const minScale = this._nativeTokensActive ? MOUNT_EXIT_SCALE : MOUNT_ENTER_SCALE;
    if ((targetScale || 0) < minScale) return;

    const [sw = 1600, sh = 1000] = canvas.screenDimensions || [];
    const safeScale = Math.max(MOUNT_EXIT_SCALE, targetScale || 0.45);
    const halfW = (sw / safeScale) * 0.58 + 400;
    const halfH = (sh / safeScale) * 0.58 + 400;
    const x0 = worldX - halfW;
    const y0 = worldY - halfH;
    const x1 = worldX + halfW;
    const y1 = worldY + halfH;
    this._flightPrewarmTarget = { x0, y0, x1, y1, cx: worldX, cy: worldY };

    const sx0 = Math.floor(x0 / TOKEN_SECTOR_PX);
    const sy0 = Math.floor(y0 / TOKEN_SECTOR_PX);
    const sx1 = Math.floor(x1 / TOKEN_SECTOR_PX);
    const sy1 = Math.floor(y1 / TOKEN_SECTOR_PX);

    const candidates = [];
    const scene = canvas.scene;
    for (let sy = sy0; sy <= sy1; sy++) {
      for (let sx = sx0; sx <= sx1; sx++) {
        const ids = this.sectorIndex.get(`${sx}_${sy}`);
        if (!ids) continue;
        for (const docId of ids) {
          if (this._queuedIds.has(docId) || this._drawingIds.has(docId)) continue;
          const doc = scene.tokens.get(docId);
          if (!doc || !doc.viewed) continue;
          const existing = doc._object;
          if (existing && !existing.destroyed && existing.parent === canvas.tokens?.objects) continue;
          const dx = Number(doc._source?.x ?? doc.x ?? 0);
          const dy = Number(doc._source?.y ?? doc.y ?? 0);
          if (dx < x0 || dx > x1 || dy < y0 || dy > y1) continue;
          const distSq = (dx - worldX) ** 2 + (dy - worldY) ** 2;
          candidates.push({ doc, distSq, isPrewarm: true });
        }
      }
    }

    if (!candidates.length) return;
    candidates.sort((a, b) => a.distSq - b.distSq);
    const take = Math.min(48, candidates.length);
    for (let i = 0; i < take; i++) {
      const c = candidates[i];
      this._drawQueue.push(c);
      this._queuedIds.add(c.doc.id);
    }
    this._primeQueueTextures();
    this._scheduleDrawPump();
  }

  /**
   * Main per-viewport entry point (called from `updatePyramid()` on pan/zoom).
   * 1) Updates frustum `renderable` culling + zoom LOD on already-mounted native Tokens (0 allocations).
   * 2) Enqueues unmounted visible TokenDocuments for time-sliced native `Token#draw()` (<= 4.5ms/frame).
   * 3) Client-side LRU eviction of distant offscreen PIXI placeables (never deletes `TokenDocument`!).
   */
  scheduleSync(vp = null, force = false) {
    if (!this.enabled || !canvas?.ready || !canvas.tokens?.objects) return;
    if (vp) this._lastVp = vp;
    const curVp = this._lastVp || this.controller?.getViewportWorldRect?.(0.25);
    if (!curVp) return;

    const now = performance.now();
    const grid = canvas.grid?.size || 100;
    const effScale = curVp.scale * (grid / 100);
    // Hysteresis prevents rapid mount/unmount thrashing around the transition zoom level (in absolute px/cell)
    if (effScale >= MOUNT_ENTER_SCALE) this._nativeTokensActive = true;
    else if (effScale < MOUNT_EXIT_SCALE) this._nativeTokensActive = false;
    const showTokens = this._nativeTokensActive;

    const showDetail = effScale >= LOD_DETAIL_MIN_SCALE;
    const lodChanged = showDetail !== this._lastLodDetail;
    this._lastLodDetail = showDetail;

    const cullX0 = curVp.x0 - CULL_VP_PAD_PX;
    const cullY0 = curVp.y0 - CULL_VP_PAD_PX;
    const cullX1 = curVp.x1 + CULL_VP_PAD_PX;
    const cullY1 = curVp.y1 + CULL_VP_PAD_PX;

    // 1. Fast frustum `renderable` culling & zoom LOD on currently mounted native tokens (runs even during camera flight!)
    const roofHidden = this.controller?._roofHiddenTokens;
    const activeCombat = game.combat?.started ? game.combat : null;
    const activeTurnTokenId = (activeCombat && activeCombat.combatant?.sceneId === canvas.scene?.id)
      ? activeCombat.combatant?.tokenId
      : null;
    const placeables = canvas.tokens.placeables;
    let toggledDocs = null;
    for (let i = 0; i < placeables.length; i++) {
      const tok = placeables[i];
      if (!tok || tok.destroyed || tok.isPreview || this.isTokenDrawing(tok)) continue;
      const doc = tok.document;
      if (!doc) continue;
      const w = tok.w || ((Number(doc._source?.width ?? doc.width) || 1) * grid);
      const h = tok.h || ((Number(doc._source?.height ?? doc.height) || 1) * grid);
      const tx = doc?._source?.x ?? doc?.x ?? tok.x ?? 0;
      const ty = doc?._source?.y ?? doc?.y ?? tok.y ?? 0;
      const docOnScreen = tx + w >= cullX0 && tx <= cullX1 && ty + h >= cullY0 && ty <= cullY1;
      const isAnimating = Boolean(tok.movementAnimationPromise || (tok.animationContexts?.size > 0));
      const animOnScreen = isAnimating && (tok.x + w >= cullX0 && tok.x <= cullX1 && tok.y + h >= cullY0 && tok.y <= cullY1);
      const onScreen = showTokens && (docOnScreen || animOnScreen);
      const isActiveTurn = Boolean(tok.turnMarker?.visible || (activeTurnTokenId && doc.id === activeTurnTokenId));
      const keepVisible = onScreen || tok.controlled || isActiveTurn || (tok.targeted?.size > 0);
      if (keepVisible) this.lastSeenMs.set(doc.id, now);

      let blockedByRoof = Boolean(roofHidden?.has?.(tok));
      // Synchronous roof check before revealing/keeping a token on zoom-in/pan so it never flashes above an unmounted roof
      if (!blockedByRoof && keepVisible && this.controller?.isTokenUnderBakedRoof?.(tok)) {
        roofHidden?.add?.(tok);
        blockedByRoof = true;
      }
      const wantRenderable = keepVisible && !blockedByRoof;
      let tokToggled = false;
      if (tok.renderable !== wantRenderable) {
        if (!wantRenderable && this._activeFades.has(doc.id)) {
          this._finishFadeImmediate(doc.id);
        }
        tok.renderable = wantRenderable;
        tokToggled = true;
      }
      if (tok.mesh && !tok.mesh.destroyed) {
        if (tok.mesh.renderable !== wantRenderable) {
          tok.mesh.renderable = wantRenderable;
          tokToggled = true;
        }
        // Foundry v14 Token#_refreshVisibility sets mesh.visible = visible && renderable; restore it when returning to view,
        // unless Showstopper intentionally hid the token (e.g. flying above camera lens occlusion).
        const hiddenByShowstopper = typeof tok._ssOcclusionAlpha === "number" && Number.isFinite(tok._ssOcclusionAlpha) && tok._ssOcclusionAlpha <= 0.01;
        if (wantRenderable && tok.visible !== false && !hiddenByShowstopper && tok.mesh.visible === false) {
          tok.mesh.visible = true;
        }
      }
      if (tok._ssJumpShadow && !tok._ssJumpShadow.destroyed && tok._ssJumpShadow.renderable !== wantRenderable) {
        tok._ssJumpShadow.renderable = wantRenderable;
      }
      if (tokToggled) {
        if (!toggledDocs) toggledDocs = [];
        toggledDocs.push(doc);
      }

      // LOD: hide tiny unreadable sub-elements at far macro zoom (< 0.22x) to cut draw calls & Canvas2D cost
      if (lodChanged || wantRenderable) {
        if (tok.nameplate) tok.nameplate.renderable = showDetail;
        if (tok.tooltip) tok.tooltip.renderable = showDetail;
        if (tok.bars) tok.bars.renderable = showDetail;
        if (tok.effects) tok.effects.renderable = showDetail;
      }
    }

    const anyRenderableToggled = Boolean(toggledDocs && toggledDocs.length > 0);
    if (anyRenderableToggled || lodChanged) {
      invalidateTokenLayerCache();
    }
    if (anyRenderableToggled) {
      // Update ONLY the toggled tokens in O(K) on pan frames; on force sync, refresh all impostors too
      if (force) {
        this.impostors.refreshVisibility(true);
      } else if (typeof this.impostors.refreshTokenStates === "function") {
        this.impostors.refreshTokenStates(toggledDocs);
      } else {
        this.impostors.refreshVisibility(true);
      }
      this.impostors.flush();
    } else if (force) {
      this.impostors.markVisibilityDirty();
    }

    // Skip spawning/evicting transit placeables while camera is flying across the continent
    // (impostors & prewarmTarget keep both flight and landing seamless!)
    if (this.controller?.isCameraFlying) {
      this._lastStreamKey = "";
      return;
    }
    this._flightPrewarmTarget = null;
    if (this._drawQueue.length > 0 && !this._pumping && this._rafId === null) {
      this._primeQueueTextures();
      this._scheduleDrawPump();
    }

    const mountX0 = curVp.x0 - MOUNT_VP_PAD_PX;
    const mountY0 = curVp.y0 - MOUNT_VP_PAD_PX;
    const mountX1 = curVp.x1 + MOUNT_VP_PAD_PX;
    const mountY1 = curVp.y1 + MOUNT_VP_PAD_PX;
    const sx0 = Math.floor(mountX0 / TOKEN_SECTOR_PX);
    const sy0 = Math.floor(mountY0 / TOKEN_SECTOR_PX);
    const sx1 = Math.floor(mountX1 / TOKEN_SECTOR_PX);
    const sy1 = Math.floor(mountY1 / TOKEN_SECTOR_PX);
    const viewedLevelId = canvas.level?.id || "";

    const streamKey = showTokens
      ? `on_${viewedLevelId}_${sx0}_${sy0}_${sx1}_${sy1}_${Math.floor(mountX0 / 600)}_${Math.floor(mountY0 / 600)}_${Math.floor(mountX1 / 600)}_${Math.floor(mountY1 / 600)}`
      : "off";
    if (!force && streamKey === this._lastStreamKey) return;
    this._lastStreamKey = streamKey;

    // 2. Enqueue unmounted visible TokenDocuments for time-sliced native Token#draw()
    const scene = canvas.scene;
    if (showTokens && scene?.tokens && this.sectorIndex.size > 0) {
      const focusX = (curVp.x0 + curVp.x1) * 0.5;
      const focusY = (curVp.y0 + curVp.y1) * 0.5;
      let addedAny = false;

      for (let sy = sy0; sy <= sy1; sy++) {
        for (let sx = sx0; sx <= sx1; sx++) {
          const ids = this.sectorIndex.get(`${sx}_${sy}`);
          if (!ids) continue;
          for (const docId of ids) {
            if (this._queuedIds.has(docId) || this._drawingIds.has(docId)) continue;
            const doc = scene.tokens.get(docId);
            if (!doc || !doc.viewed) continue;
            const existing = doc._object;
            if (existing && !existing.destroyed && existing.parent === canvas.tokens.objects) continue;

            const dx = Number(doc._source?.x ?? doc.x ?? 0);
            const dy = Number(doc._source?.y ?? doc.y ?? 0);
            if (dx < mountX0 || dx > mountX1 || dy < mountY0 || dy > mountY1) continue;

            const distSq = (dx - focusX) ** 2 + (dy - focusY) ** 2;
            this._drawQueue.push({ doc, distSq });
            this._queuedIds.add(docId);
            addedAny = true;
          }
        }
      }

      if (addedAny) {
        this._drawQueue.sort((a, b) => a.distSq - b.distSq);
        this._primeQueueTextures();
        this._scheduleDrawPump();
      }
    }

    // 3. Client-side LRU eviction of distant offscreen PIXI placeables (zero DB changes!)
    this._evictDistantPlaceables(curVp, showTokens);
  }

  _getDocTexSrc(doc) {
    return doc?._source?.texture?.src ?? doc?.texture?.src ?? "";
  }

  _isTexReady(src) {
    if (!src) return true;
    if (this._decodedTexSrcs.has(src)) return true;
    try {
      if (globalThis.PIXI?.Assets?.cache?.has?.(src)) {
        this._decodedTexSrcs.add(src);
        return true;
      }
    } catch {}
    return false;
  }

  /** Kick off parallel non-blocking texture pre-decodes for the top queued tokens. */
  _primeQueueTextures() {
    const loadTexFn = globalThis.foundry?.canvas?.loadTexture ?? globalThis.loadTexture;
    if (typeof loadTexFn !== "function" || this._drawQueue.length === 0) return;

    const gen = this._gen;
    const limit = Math.min(PREDECODE_LOOKAHEAD, this._drawQueue.length);
    for (let i = 0; i < limit; i++) {
      const qDoc = this._drawQueue[i]?.doc;
      if (!qDoc || (globalThis.canvas?.scene?.tokens?.has && !globalThis.canvas.scene.tokens.has(qDoc.id))) continue;
      const src = this._getDocTexSrc(qDoc);
      if (!src || this._isTexReady(src) || this._inflightTexLoads.has(src)) continue;
      const p = Promise.resolve(loadTexFn(src))
        .catch(() => null)
        .finally(() => {
          if (gen !== this._gen) return;
          this._inflightTexLoads.delete(src);
          this._decodedTexSrcs.add(src);
          if (this.enabled && this._drawQueue.length > 0) {
            this._scheduleDrawPump();
          }
        });
      this._inflightTexLoads.set(src, p);
    }
  }

  _scheduleDrawPump() {
    if (this._pumping || this._rafId !== null || this._drawQueue.length === 0) return;
    const sched = typeof requestAnimationFrame === "function"
      ? requestAnimationFrame
      : (fn) => setTimeout(fn, 16);
    this._rafId = sched(() => {
      this._rafId = null;
      return this._pumpDrawQueue();
    });
  }

  async _pumpDrawQueue() {
    if (this._pumping || !this.enabled || !canvas?.ready || !canvas.tokens?.objects) return;
    const isFlying = Boolean(this.controller?.isCameraFlying);
    if (isFlying && !this._flightPrewarmTarget) return;

    this._pumping = true;
    const gen = this._gen;
    const layer = canvas.tokens;
    const curVp = this._lastVp;
    const prewarmBox = this._flightPrewarmTarget;
    const budgetMs = isFlying ? FLIGHT_PREWARM_BUDGET_MS : DRAW_FRAME_BUDGET_MS;
    const maxDraws = isFlying ? 2 : MAX_DRAWS_PER_FRAME;
    const startMs = performance.now();
    let drawnThisFrame = 0;
    let anyVisionDrawn = false;
    let deferredWaitingTex = 0;

    try {
      this._primeQueueTextures();

      while (
        this._drawQueue.length > 0 &&
        drawnThisFrame < maxDraws &&
        (performance.now() - startMs) < budgetMs
      ) {
        // Pick first ready-texture item within lookahead so cold textures never stall already-decoded tokens
        let pickIdx = 0;
        const scanMax = Math.min(PREDECODE_LOOKAHEAD, this._drawQueue.length);
        for (let i = 0; i < scanMax; i++) {
          const cand = this._drawQueue[i];
          if (isFlying && !cand?.isPrewarm && !isAlwaysMountedTokenDoc(cand?.doc)) continue;
          if (this._isTexReady(this._getDocTexSrc(cand?.doc))) {
            pickIdx = i;
            break;
          }
        }

        const item = this._drawQueue[pickIdx];
        if (isFlying && !item?.isPrewarm && !isAlwaysMountedTokenDoc(item?.doc)) {
          this._drawQueue.splice(pickIdx, 1);
          if (item?.doc?.id) this._queuedIds.delete(item.doc.id);
          this._lastStreamKey = "";
          continue;
        }

        const doc = item?.doc;
        if (!doc) {
          this._drawQueue.splice(pickIdx, 1);
          continue;
        }

        // If texture is currently loading in parallel, let it finish without stalling the frame
        const texSrc = this._getDocTexSrc(doc);
        if (texSrc && !this._isTexReady(texSrc) && this._inflightTexLoads.has(texSrc)) {
          deferredWaitingTex++;
          if (deferredWaitingTex >= Math.min(PREDECODE_LOOKAHEAD, this._drawQueue.length)) break;
          // Rotate to back of lookahead window
          this._drawQueue.splice(pickIdx, 1);
          this._drawQueue.splice(Math.min(PREDECODE_LOOKAHEAD - 1, this._drawQueue.length), 0, item);
          continue;
        }

        this._drawQueue.splice(pickIdx, 1);
        this._queuedIds.delete(doc.id);

        if (!doc.parent || doc.parent.id !== this.sceneId || !doc.viewed || (globalThis.canvas?.scene?.tokens?.has && !globalThis.canvas.scene.tokens.has(doc.id))) continue;

        const dx = Number(doc._source?.x ?? doc.x ?? 0);
        const dy = Number(doc._source?.y ?? doc.y ?? 0);

        if (item.isPrewarm && prewarmBox) {
          if (dx < prewarmBox.x0 || dx > prewarmBox.x1 || dy < prewarmBox.y0 || dy > prewarmBox.y1) continue;
        } else {
          // Drop stale queue items if camera already zoomed out or panned far away
          const alwaysMounted = isAlwaysMountedTokenDoc(doc);
          if (curVp && !this._nativeTokensActive && !alwaysMounted) continue;
          if (curVp && !alwaysMounted) {
            const pad = MOUNT_VP_PAD_PX * 1.6;
            if (dx < curVp.x0 - pad || dx > curVp.x1 + pad || dy < curVp.y0 - pad || dy > curVp.y1 + pad) {
              continue;
            }
          }
        }

        const existing = doc._object;
        if (existing && !existing.destroyed && existing.parent === layer.objects) continue;

        this._drawingIds.add(doc.id);
        let abortedPump = false;
        try {
          const loadTexFn = globalThis.foundry?.canvas?.loadTexture ?? globalThis.loadTexture;
          if (texSrc && !this._isTexReady(texSrc) && typeof loadTexFn === "function") {
            await loadTexFn(texSrc);
            if (gen === this._gen) this._decodedTexSrcs.add(texSrc);
          }
          if (!this.enabled || gen !== this._gen || !canvas?.ready) {
            abortedPump = true;
            break;
          }
          if (doc.parent?.id !== this.sceneId || !canvas.scene?.tokens?.has?.(doc.id) || !doc.viewed) {
            continue;
          }

          // Keep impostor visible beneath while native token draws & fades in
          const shouldFade = !item.isPrewarm && this.impostors.mounted;
          if (shouldFade) {
            this.impostors.setFadeOverride(doc.id, 1.0);
          }

          doc._destroyed = false;
          const obj = (doc._object && !doc._object.destroyed) ? doc._object : layer.createObject(doc);
          doc._object = obj;
          if (obj.parent !== layer.objects) {
            layer.objects.addChild(obj);
          }
          await obj.draw();
          if (gen === this._gen) this._drawingIds.delete(doc.id);
          if (!this.enabled || gen !== this._gen || !canvas?.ready) {
            abortedPump = true;
            break;
          }
          if (!canvas.scene?.tokens?.has?.(doc.id) || obj.destroyed) {
            if (!obj.destroyed) {
              try {
                layer.objects.removeChild(obj);
                obj.destroy({ children: true });
              } catch {}
            }
            this.impostors.setFadeOverride(doc.id, null);
            continue;
          }

          const latestVp = this._lastVp;
          let offscreenAfterDraw = false;
          if (latestVp) {
            const gSz = canvas.grid?.size || 100;
            const b = getTokenDocBounds(doc, gSz);
            const curX = doc._source?.x ?? doc.x ?? obj.x ?? 0;
            const curY = doc._source?.y ?? doc.y ?? obj.y ?? 0;
            offscreenAfterDraw = (
              curX + b.w < latestVp.x0 - CULL_VP_PAD_PX ||
              curX > latestVp.x1 + CULL_VP_PAD_PX ||
              curY + b.h < latestVp.y0 - CULL_VP_PAD_PX ||
              curY > latestVp.y1 + CULL_VP_PAD_PX
            );
          }

          if ((!this._nativeTokensActive || offscreenAfterDraw) && !obj.controlled) {
            obj.renderable = false;
            if (obj.mesh && !obj.mesh.destroyed) obj.mesh.renderable = false;
            if (obj._ssJumpShadow && !obj._ssJumpShadow.destroyed) obj._ssJumpShadow.renderable = false;
            this.impostors.setFadeOverride(doc.id, null);
            this.impostors.upsertToken(doc);
            this.impostors.flush();
            drawnThisFrame++;
            continue;
          }

          this.lastSeenMs.set(doc.id, performance.now());
          if ((doc.sight?.enabled ?? doc._source?.sight?.enabled) && (doc.baseActor?.hasPlayerOwner || obj.controlled)) {
            anyVisionDrawn = true;
          }

          // Start smooth 160ms over-composite crossfade via mesh.unoccludedAlpha (never touches tok.alpha or mesh.alpha!)
          if (shouldFade && obj.mesh && !obj.mesh.destroyed) {
            const hasUnoccluded = "unoccludedAlpha" in obj.mesh;
            const targetOccluded = (Number.isFinite(obj.mesh.occludedAlpha) && obj.mesh.occludedAlpha > 0) ? obj.mesh.occludedAlpha : 0.5;
            const isTranslucent = Boolean(doc._source?.hidden || (Number(doc.alpha ?? doc._source?.alpha ?? 1) < 0.99));
            if (hasUnoccluded) {
              obj.mesh.unoccludedAlpha = 0.0;
              obj.mesh.occludedAlpha = 0.0;
            }
            this._activeFades.set(doc.id, {
              tok: obj,
              doc,
              t: 0,
              dur: hasUnoccluded ? CROSSFADE_MS : 120,
              hasUnoccluded,
              targetOccluded,
              isTranslucent
            });
            this.impostors.setFadeOverride(doc.id, 1.0);
            this.impostors.flush();
          } else {
            this.impostors.upsertToken(doc);
            this.impostors.setFadeOverride(doc.id, null);
            this.impostors.flush();
          }

          // Immediately suppress newly drawn token if sitting beneath an unmounted/baked roof so it never flashes for 1 frame
          if (this.controller?.isTokenUnderBakedRoof?.(obj)) {
            this.controller._roofHiddenTokens?.add?.(obj);
            obj.renderable = false;
            if (obj.mesh && !obj.mesh.destroyed) obj.mesh.renderable = false;
            if (obj._ssJumpShadow && !obj._ssJumpShadow.destroyed) obj._ssJumpShadow.renderable = false;
          }

          // Apply current LOD detail state immediately to newly drawn token
          const showDetail = getEffectiveScale(this._lastVp?.scale ?? 1) >= LOD_DETAIL_MIN_SCALE;
          if (!showDetail) {
            if (obj.nameplate) obj.nameplate.renderable = false;
            if (obj.tooltip) obj.tooltip.renderable = false;
            if (obj.bars) obj.bars.renderable = false;
            if (obj.effects) obj.effects.renderable = false;
          }

          // Sync Showstopper elevation perspective / hover / shadow for newly streamed elevated tokens
          const ssApi = getShowstopperMovementApi();
          if (ssApi?.getTokenMovementSetting?.("vertical")) {
            const baseElev = getLevelBaseElevation(canvas?.level);
            const tokElev = Number(doc._source?.elevation ?? doc.elevation ?? 0) || 0;
            const obsElev = Number(ssApi.getObserverElevation?.() ?? baseElev);
            if (Math.abs(tokElev - baseElev) > 0.05 || Math.abs(obsElev - baseElev) > 0.05) {
              try { ssApi.syncTokenFlyHover?.(obj); } catch {}
              this.controller?._scheduleShowstopperDofSync?.();
            }
          }
          drawnThisFrame++;
        } catch (err) {
          if (gen === this._gen) this.impostors.setFadeOverride(doc.id, null);
          console.warn(`${MODULE_ID} | Lazy Token#draw() failed for ${doc.id}:`, err);
        } finally {
          if (gen === this._gen) this._drawingIds.delete(doc.id);
        }
        if (abortedPump) break;
      }

      if (drawnThisFrame > 0 && this.enabled && gen === this._gen && canvas?.ready) {
        this.controller._roofTokenOccDirty = true;
        if (anyVisionDrawn) {
          canvas.perception?.update?.({ refreshVision: true, refreshOcclusion: true });
        }
      }
    } finally {
      if (gen === this._gen) {
        this._pumping = false;
        const lookaheadLimit = Math.min(PREDECODE_LOOKAHEAD, this._drawQueue.length);
        let hasReadyOrPending = false;
        for (let i = 0; i < lookaheadLimit; i++) {
          const qSrc = this._getDocTexSrc(this._drawQueue[i]?.doc);
          if (!qSrc || !this._inflightTexLoads.has(qSrc)) {
            hasReadyOrPending = true;
            break;
          }
        }
        if (hasReadyOrPending && this.enabled) {
          this._scheduleDrawPump();
        }
      }
    }
  }

  _evictDistantPlaceables(vp, showTokens) {
    const layer = canvas?.tokens;
    if (!layer?.objects?.children) return;

    const placeables = layer.placeables;
    const targetKeep = showTokens ? MAX_MOUNTED_NPCS : WARM_ORBIT_KEEP;
    if (placeables.length <= targetKeep) return;

    const evictX0 = vp.x0 - UNMOUNT_MIN_DIST_PX;
    const evictY0 = vp.y0 - UNMOUNT_MIN_DIST_PX;
    const evictX1 = vp.x1 + UNMOUNT_MIN_DIST_PX;
    const evictY1 = vp.y1 + UNMOUNT_MIN_DIST_PX;
    const candidates = [];

    for (let i = 0; i < placeables.length; i++) {
      const tok = placeables[i];
      if (!tok || tok.destroyed || tok.isPreview) continue;
      if ((coreDrawingCounts.get(tok) || 0) > 0 || !tok.mesh || tok.mesh.destroyed) continue;
      const doc = tok.document;
      if (!doc || this._drawingIds.has(doc.id) || isAlwaysMountedTokenDoc(doc)) continue;

      const tx = doc._source?.x ?? doc.x ?? tok.x ?? 0;
      const ty = doc._source?.y ?? doc.y ?? tok.y ?? 0;
      const farAway = !showTokens || (tx < evictX0 || tx > evictX1 || ty < evictY0 || ty > evictY1);
      if (!farAway) continue;

      candidates.push({ tok, doc, lastSeen: this.lastSeenMs.get(doc.id) || 0 });
    }

    if (candidates.length === 0) return;
    candidates.sort((a, b) => a.lastSeen - b.lastSeen);

    const ssApi = getShowstopperMovementApi();
    const maxToEvict = Math.min(24, Math.max(0, placeables.length - targetKeep));
    let evicted = 0;
    for (let i = 0; i < candidates.length && i < maxToEvict; i++) {
      const { tok, doc } = candidates[i];
      try {
        this._finishFadeImmediate(doc.id);
        // Clean up Showstopper jump/fly shadow & DoF filter references before destroying offscreen placeable
        if (ssApi?.clearJumpStateForToken) {
          try { ssApi.clearJumpStateForToken(tok, { destroyShadow: true }); } catch {}
        } else if (tok._ssJumpShadow && !tok._ssJumpShadow.destroyed) {
          try {
            tok._ssJumpShadow.parent?.removeChild?.(tok._ssJumpShadow);
            tok._ssJumpShadow.destroy?.();
          } catch {}
          tok._ssJumpShadow = null;
        }
        this.controller?._roofHiddenTokens?.delete?.(tok);
        layer.objects.removeChild(tok);
        tok.destroy({ children: true });
        // Restore `_destroyed = false` so the live TokenDocument stays 100% healthy and re-drawable when camera returns!
        doc._object = null;
        doc._destroyed = false;
        evicted++;
      } catch (err) {
        console.warn(`${MODULE_ID} | Failed to evict offscreen Token placeable ${doc.id}:`, err);
      }
    }

    if (evicted > 0) {
      invalidateTokenLayerCache();
      this.impostors.markVisibilityDirty();
    }

    // If more distant placeables remain above budget (e.g. after zooming out to orbital view), drain smoothly
    if (evicted > 0 && candidates.length > evicted && placeables.length > targetKeep) {
      if (this._evictTimer === null) {
        const gen = this._gen;
        this._evictTimer = setTimeout(() => {
          this._evictTimer = null;
          if (!this.enabled || gen !== this._gen) return;
          this.scheduleSync(null, true);
        }, 120);
      }
    }
  }

  /* ------------------------- Live Document Hooks ------------------------- */

  _queueSyncMicrotask(force = false) {
    if (force) {
      this._syncMicrotaskForce = true;
      this._lastStreamKey = "";
    }
    if (this._syncMicrotaskQueued) return;
    this._syncMicrotaskQueued = true;
    const gen = this._gen;
    queueMicrotask(() => {
      const doForce = this._syncMicrotaskForce;
      this._syncMicrotaskQueued = false;
      this._syncMicrotaskForce = false;
      if (!this.enabled || gen !== this._gen || !this._lastVp) return;
      this.scheduleSync(this._lastVp, doForce);
    });
  }

  onTokenCreated(doc) {
    if (!this.enabled || !doc || doc.parent?.id !== this.sceneId) return;
    this._indexDoc(doc);
    this.lastSeenMs.set(doc.id, performance.now());
    this.impostors.queueUpsertToken(doc);
  }

  onTokenUpdated(doc, changes) {
    if (!this.enabled || !doc || doc.parent?.id !== this.sceneId) return;
    const moved = "x" in changes || "y" in changes || "level" in changes;
    const alwaysMountChanged = "light" in changes || "sight" in changes || "actorLink" in changes || Boolean(changes.flags?.[MODULE_ID]);
    const visualChanged = moved
      || "elevation" in changes
      || "hidden" in changes
      || "alpha" in changes
      || "texture" in changes
      || "rotation" in changes
      || "lockRotation" in changes
      || "width" in changes
      || "height" in changes
      || "ring" in changes
      || "disposition" in changes
      || Boolean(changes.flags?.["multiple-rings"]);

    if (moved) {
      this._indexDoc(doc);
    }
    if (visualChanged) {
      this.impostors.queueUpsertToken(doc);
    }
    if (moved || alwaysMountChanged) {
      const needsMount = !doc._object || doc._object.destroyed || doc._object.parent !== canvas?.tokens?.objects;
      if (needsMount && alwaysMountChanged && isAlwaysMountedTokenDoc(doc) && doc.viewed) {
        if (!this._queuedIds.has(doc.id) && !this._drawingIds.has(doc.id)) {
          this._drawQueue.unshift({ doc, distSq: 0 });
          this._queuedIds.add(doc.id);
          this._primeQueueTextures();
          this._scheduleDrawPump();
        }
      } else if (moved && this._lastVp) {
        // Coalesce batch token moves into one viewport sync microtask instead of O(K*N) synchronous scans
        this._queueSyncMicrotask(needsMount);
      }
    }
  }

  onTokenDeleted(doc) {
    if (!this.enabled || !doc) return;
    this._finishFadeImmediate(doc.id);
    this._unindexDoc(doc.id);
    this._queuedIds.delete(doc.id);
    this._drawingIds.delete(doc.id);
    this.impostors.removeToken(doc.id);
  }

  onTokenDrawn(tok) {
    if (!this.enabled || !tok?.document || tok.isPreview) return;
    const doc = tok.document;
    if (doc.parent?.id !== this.sceneId) return;
    if (this._drawingIds.has(doc.id)) return;
    const gen = this._gen;
    // PlaceableObject#draw() fires `drawToken` BEFORE restoring `tok.visible`/`tok.renderable`,
    // and our patched `Token.prototype.draw` decrements `coreDrawingCounts` in `.finally()`.
    // Chain onto the tracked draw promise so post-draw sync sees both restored visibility and `isTokenDrawing(tok) === false`.
    const finish = () => {
      if (!this.enabled || gen !== this._gen || tok.destroyed || doc.parent?.id !== this.sceneId) return;
      if (this.isTokenDrawing(tok)) return;
      if (!this._nativeTokensActive && !tok.controlled) {
        tok.renderable = false;
        if (tok.mesh && !tok.mesh.destroyed) tok.mesh.renderable = false;
        if (tok._ssJumpShadow && !tok._ssJumpShadow.destroyed) tok._ssJumpShadow.renderable = false;
      } else if (this._lastVp) {
        this._queueSyncMicrotask(false);
      }
      this.impostors.queueUpsertToken(doc);
    };
    const pending = coreDrawPromises.get(tok);
    if (pending) pending.then(finish, finish);
    else queueMicrotask(finish);
  }

  onCombatChanged() {
    if (!this.enabled || !canvas?.ready || !canvas.scene?.tokens) return;
    const sceneId = canvas.scene.id;
    const combatants = game.combat?.combatants;
    if (combatants) {
      for (const c of combatants) {
        if (c?.sceneId !== sceneId || !c.tokenId) continue;
        const doc = canvas.scene.tokens.get(c.tokenId);
        if (!doc || !doc.viewed) continue;
        const mounted = doc._object && !doc._object.destroyed && doc._object.parent === canvas.tokens?.objects;
        if (!mounted && !this._queuedIds.has(doc.id) && !this._drawingIds.has(doc.id)) {
          this._queuedIds.add(doc.id);
          this._drawQueue.unshift({ doc, distSq: 0 });
        }
      }
      if (this._drawQueue.length > 0 && !this._pumping && this._rafId === null) {
        this._primeQueueTextures();
        this._scheduleDrawPump();
      }
    }
    this._lastStreamKey = "";
    this._queueSyncMicrotask(true);
  }

  onVisibilityChanged() {
    if (!this.enabled) return;
    this.impostors.markVisibilityDirty();
  }

  /* ------------------------- Global Map Selection & Impostor Picking ------------------------- */

  cancelPendingSelection() {
    this._selectGen++;
    this._selectingBatch = false;
    if (this._selectRafId !== null) {
      if (typeof cancelAnimationFrame === "function") {
        try { cancelAnimationFrame(this._selectRafId); } catch {}
      } else {
        clearTimeout(this._selectRafId);
      }
      this._selectRafId = null;
    }
  }

  _canUserControlDoc(doc, minPermission = "OWNER") {
    if (!doc || doc.viewed === false) return false;
    const isGM = Boolean(game.user?.isGM);
    if (!isGM) {
      if (doc._source?.hidden ?? doc.hidden) return false;
      if (minPermission && !hasTokenPermissionLazy(doc, game.user, minPermission)) return false;
    }
    const existing = doc._object;
    if (existing && !existing.destroyed) {
      if (existing.visible === false || existing.isPreview) return false;
      if (existing._ssHitboxRect?.occluded) return false;
    } else if (!isGM) {
      const grid = canvas.grid?.size || 100;
      const b = getTokenDocBounds(doc, grid);
      const lid = doc._source?.level ?? doc.level ?? canvas.level?.id;
      const elev = Number(doc._source?.elevation ?? doc.elevation ?? 0) || 0;
      if (this.controller?.isPointUnderBakedRoof?.(lid, b.cx, b.cy, elev)) return false;
      const isOwner = hasTokenPermissionLazy(doc, game.user, "OWNER");
      if (!isOwner) {
        // Prevent double-click / target leaks through fog of war or invisible/burrowed status
        const inv = globalThis.CONFIG?.specialStatusEffects?.INVISIBLE || "invisible";
        const bur = globalThis.CONFIG?.specialStatusEffects?.BURROW || "burrow";
        if (doc.hasStatusEffect?.(inv) || doc.hasStatusEffect?.(bur)) return false;
        if (canvas?.visibility?.tokenVision && typeof canvas.visibility.testVisibility === "function") {
          const tol = Math.min(grid * 0.5, Math.max(b.w, b.h) * 0.45);
          if (!canvas.visibility.testVisibility({ x: b.cx, y: b.cy }, { tolerance: tol })) return false;
        }
      }
    }
    return true;
  }

  async materializeDoc(doc) {
    if (!this.enabled || !doc || !canvas?.ready || !canvas.tokens?.objects) return null;
    if (doc.parent?.id !== this.sceneId || !doc.viewed) return null;
    let obj = doc._object;
    if (obj && !obj.destroyed && obj.parent === canvas.tokens.objects) {
      if (!obj.renderable && !this.isTokenDrawing(obj)) {
        obj.renderable = true;
        if (obj.mesh && !obj.mesh.destroyed) obj.mesh.renderable = true;
        invalidateTokenLayerCache();
        this.impostors.upsertToken(doc);
        this.impostors.flush();
      }
      return obj;
    }
    if (this._drawingIds.has(doc.id) || (obj && this.isTokenDrawing(obj))) return null;
    const gen = this._gen;
    const layer = canvas.tokens;
    this._drawingIds.add(doc.id);
    try {
      const texSrc = this._getDocTexSrc(doc);
      const loadTexFn = globalThis.foundry?.canvas?.loadTexture ?? globalThis.loadTexture;
      if (texSrc && !this._isTexReady(texSrc) && typeof loadTexFn === "function") {
        await loadTexFn(texSrc);
        if (gen === this._gen) this._decodedTexSrcs.add(texSrc);
      }
      if (!this.enabled || gen !== this._gen || !canvas?.ready) return null;
      if (!canvas.scene?.tokens?.has?.(doc.id) || !doc.viewed) return null;
      doc._destroyed = false;
      obj = (doc._object && !doc._object.destroyed) ? doc._object : layer.createObject(doc);
      doc._object = obj;
      if (obj.parent !== layer.objects) layer.objects.addChild(obj);
      await obj.draw();
      obj.applyRenderFlags?.();
      obj.renderable = true;
      if (obj.mesh && !obj.mesh.destroyed) obj.mesh.renderable = true;
      this.lastSeenMs.set(doc.id, performance.now());
      invalidateTokenLayerCache();
      this.impostors.upsertToken(doc);
      this.impostors.flush();
      return obj;
    } catch (err) {
      console.warn(`${MODULE_ID} | Failed to materialize Token ${doc.id}:`, err);
      return null;
    } finally {
      if (gen === this._gen) this._drawingIds.delete(doc.id);
    }
  }

  /**
   * O(K) spatial query returning every controllable TokenDocument on the current level overlapping `rect`.
   * Works at ALL zoom levels — including orbital/macro zoom when tokens are rendered via GPU Impostors.
   */
  getControllableDocsInRect(rect) {
    const out = [];
    const scene = canvas?.scene;
    if (!this.enabled || !scene?.tokens || !rect) return out;
    const grid = canvas.grid?.size || 100;
    const rx0 = Number(rect.x0 ?? rect.x ?? 0);
    const ry0 = Number(rect.y0 ?? rect.y ?? 0);
    const rx1 = rect.x1 !== undefined ? Number(rect.x1) : (rx0 + Number(rect.width ?? 0));
    const ry1 = rect.y1 !== undefined ? Number(rect.y1) : (ry0 + Number(rect.height ?? 0));
    const minX = Math.min(rx0, rx1);
    const maxX = Math.max(rx0, rx1);
    const minY = Math.min(ry0, ry1);
    const maxY = Math.max(ry0, ry1);

    // Pad sector search by max expected token footprint (8 cells) so huge tokens anchored in neighbor sectors are included
    const sectorPad = grid * 8;
    const sx0 = Math.floor((minX - sectorPad) / TOKEN_SECTOR_PX);
    const sy0 = Math.floor((minY - sectorPad) / TOKEN_SECTOR_PX);
    const sx1 = Math.floor((maxX + sectorPad) / TOKEN_SECTOR_PX);
    const sy1 = Math.floor((maxY + sectorPad) / TOKEN_SECTOR_PX);

    for (let sy = sy0; sy <= sy1; sy++) {
      for (let sx = sx0; sx <= sx1; sx++) {
        const ids = this.sectorIndex.get(`${sx}_${sy}`);
        if (!ids) continue;
        for (const docId of ids) {
          const doc = scene.tokens.get(docId);
          if (!this._canUserControlDoc(doc)) continue;
          const b = getTokenDocBounds(doc, grid);
          if (b.x + b.w < minX || b.x > maxX || b.y + b.h < minY || b.y > maxY) continue;
          out.push(doc);
        }
      }
    }
    return out;
  }

  /**
   * Return every controllable TokenDocument on the currently viewed level, sorted nearest-first to camera pivot.
   */
  getControllableDocsOnLevel() {
    const out = [];
    const scene = canvas?.scene;
    if (!this.enabled || !scene?.tokens) return out;
    const cx = canvas.stage?.pivot?.x ?? 0;
    const cy = canvas.stage?.pivot?.y ?? 0;
    for (const doc of scene.tokens) {
      if (!this._canUserControlDoc(doc)) continue;
      out.push(doc);
    }
    out.sort((a, b) => {
      const da = ((Number(a._source?.x ?? a.x ?? 0) - cx) ** 2) + ((Number(a._source?.y ?? a.y ?? 0) - cy) ** 2);
      const db = ((Number(b._source?.x ?? b.x ?? 0) - cx) ** 2) + ((Number(b._source?.y ?? b.y ?? 0) - cy) ** 2);
      return da - db;
    });
    return out;
  }

  /**
   * Pick the nearest controllable TokenDocument under world point `(wx, wy)` using at least `minHitRadiusWorld`
   * so clicking tiny impostors on global/continental maps feels effortless.
   */
  findHitDocAtPoint(wx, wy, minHitRadiusWorld = 0, { minPermission = "OWNER" } = {}) {
    const scene = canvas?.scene;
    if (!this.enabled || !scene?.tokens) return null;
    const grid = canvas.grid?.size || 100;
    const pad = Math.max(grid * 4, Number(minHitRadiusWorld) || 0);
    const sx0 = Math.floor((wx - pad) / TOKEN_SECTOR_PX);
    const sy0 = Math.floor((wy - pad) / TOKEN_SECTOR_PX);
    const sx1 = Math.floor((wx + pad) / TOKEN_SECTOR_PX);
    const sy1 = Math.floor((wy + pad) / TOKEN_SECTOR_PX);

    let bestDoc = null;
    let bestDistSq = Infinity;
    for (let sy = sy0; sy <= sy1; sy++) {
      for (let sx = sx0; sx <= sx1; sx++) {
        const ids = this.sectorIndex.get(`${sx}_${sy}`);
        if (!ids) continue;
        for (const docId of ids) {
          const doc = scene.tokens.get(docId);
          if (!this._canUserControlDoc(doc, minPermission)) continue;
          const b = getTokenDocBounds(doc, grid);
          const halfW = Math.max(b.w * 0.5, minHitRadiusWorld);
          const halfH = Math.max(b.h * 0.5, minHitRadiusWorld);
          const dx = Math.abs(wx - b.cx);
          const dy = Math.abs(wy - b.cy);
          if (dx > halfW || dy > halfH) continue;
          const distSq = dx * dx + dy * dy;
          if (distSq < bestDistSq) {
            bestDistSq = distSq;
            bestDoc = doc;
          }
        }
      }
    }
    return bestDoc;
  }

  /**
   * Ensure already-mounted Token placeables for `docs` have `renderable = true` so Foundry's
   * `controllableObjects()` sees them even on macro zoom (impostor mode). Returns unmounted docs.
   */
  prepareMountedTokensForSelection(docs) {
    const missing = [];
    const layer = canvas?.tokens;
    if (!layer?.objects || !Array.isArray(docs) || !docs.length) return missing;
    const now = performance.now();
    let revealedAny = false;
    for (let i = 0; i < docs.length; i++) {
      const doc = docs[i];
      if (!doc) continue;
      const tok = doc._object;
      if (tok && !tok.destroyed && tok.parent === layer.objects && !this.isTokenDrawing(tok)) {
        this.lastSeenMs.set(doc.id, now);
        if (!tok.renderable) {
          tok.renderable = true;
          revealedAny = true;
        }
        if (tok.mesh && !tok.mesh.destroyed) {
          if (!tok.mesh.renderable) {
            tok.mesh.renderable = true;
            revealedAny = true;
          }
          const hiddenByShowstopper = typeof tok._ssOcclusionAlpha === "number" && Number.isFinite(tok._ssOcclusionAlpha) && tok._ssOcclusionAlpha <= 0.01;
          if (tok.visible !== false && !hiddenByShowstopper && tok.mesh.visible === false) {
            tok.mesh.visible = true;
          }
        }
      } else {
        missing.push(doc);
      }
    }
    if (revealedAny) {
      invalidateTokenLayerCache();
      this.impostors.refreshVisibility(true);
      this.impostors.flush();
    }
    return missing;
  }

  /**
   * Time-sliced materialization & selection for unmounted (or impostor-mode) TokenDocuments.
   * Caps work to <= 2.4ms/frame so even selecting 150+ tokens on a global map stays locked at 120 FPS.
   */
  materializeAndSelect(docs, { releaseOthers = false, maxCount = 250, bulkRunner = null, onProgress = null, selectionRect = null, onComplete = null } = {}) {
    const layer = canvas?.tokens;
    if (!this.enabled || !canvas?.ready || !layer?.objects || !layer.active) return { immediate: 0, queued: 0, capped: false };
    const list = Array.isArray(docs) ? docs : [];
    const capped = list.length > maxCount;
    const targetDocs = capped ? list.slice(0, maxCount) : list.slice();

    if (releaseOthers && layer.controlled.length > 0) {
      layer.releaseAll();
    }

    this.cancelPendingSelection();
    const selectGen = this._selectGen;
    const gen = this._gen;
    const runBulk = typeof bulkRunner === "function" ? bulkRunner : ((fn) => fn());

    const missing = this.prepareMountedTokensForSelection(targetDocs);
    const grid = canvas.grid?.size || 100;
    const isDocOnScreen = (doc) => {
      const vp = this._lastVp || this.controller?.getViewportWorldRect?.(0.1);
      if (!vp || !doc) return true;
      const b = getTokenDocBounds(doc, grid);
      return !(b.x + b.w < vp.x0 - CULL_VP_PAD_PX || b.x > vp.x1 + CULL_VP_PAD_PX || b.y + b.h < vp.y0 - CULL_VP_PAD_PX || b.y > vp.y1 + CULL_VP_PAD_PX);
    };

    let immediate = 0;
    const controlledTokens = [];
    runBulk(() => {
      for (let i = 0; i < targetDocs.length; i++) {
        const doc = targetDocs[i];
        const tok = doc?._object;
        if (tok && !tok.destroyed && tok.parent === layer.objects) {
          if (selectionRect && typeof tok._overlapsSelection === "function" && !tok._overlapsSelection(selectionRect)) {
            if (!this._nativeTokensActive && !tok.controlled) {
              tok.renderable = false;
              if (tok.mesh && !tok.mesh.destroyed) tok.mesh.renderable = false;
            }
            continue;
          }
          if (!tok.controlled) {
            const onScr = isDocOnScreen(doc);
            if (!onScr && !this._nativeTokensActive) {
              tok.renderable = false;
              if (tok.mesh && !tok.mesh.destroyed) tok.mesh.renderable = false;
            }
            if (tok.control({ force: !onScr, releaseOthers: false, renderSidebar: false })) {
              immediate++;
              controlledTokens.push(tok);
            }
          } else {
            controlledTokens.push(tok);
          }
        }
      }
    });
    if (immediate > 0) {
      this.impostors.refreshVisibility(true);
      this.impostors.flush();
      if (!missing.length) {
        ui.placeables?.render?.();
        if (game.activeTool === "select") ui.placeablesPalette?.render?.();
      }
    }

    if (!missing.length) {
      onProgress?.({ done: true, selected: layer.controlled.length });
      onComplete?.(controlledTokens);
      return { immediate, queued: 0, capped };
    }

    // Pre-decode first lookahead textures in parallel so Token#draw() never stalls
    const loadTexFn = globalThis.foundry?.canvas?.loadTexture ?? globalThis.loadTexture;
    const primeSlice = (queue) => {
      if (typeof loadTexFn !== "function") return;
      const n = Math.min(6, queue.length);
      for (let i = 0; i < n; i++) {
        const src = this._getDocTexSrc(queue[i]);
        if (!src || this._isTexReady(src) || this._inflightTexLoads.has(src)) continue;
        const p = Promise.resolve(loadTexFn(src)).catch(() => null).finally(() => {
          if (gen === this._gen) {
            this._inflightTexLoads.delete(src);
            this._decodedTexSrcs.add(src);
          }
        });
        this._inflightTexLoads.set(src, p);
      }
    };

    const queue = missing.slice();
    primeSlice(queue);
    this._selectingBatch = true;

    const sched = typeof requestAnimationFrame === "function" ? requestAnimationFrame : (fn) => setTimeout(fn, 16);
    const step = async () => {
      this._selectRafId = null;
      if (selectGen !== this._selectGen || gen !== this._gen || !this.enabled || !canvas?.ready || !layer.active) {
        if (selectGen === this._selectGen) this._selectingBatch = false;
        return;
      }

      const budgetMs = 1.8;
      const maxPerFrame = 2;
      let frameWorkMs = 0;
      let drawn = 0;
      const newlyMounted = [];

      while (queue.length > 0 && drawn < maxPerFrame && frameWorkMs < budgetMs) {
        const doc = queue.shift();
        if (!doc || !canvas.scene?.tokens?.has?.(doc.id) || !this._canUserControlDoc(doc)) continue;
        let obj = doc._object;
        const onScr = isDocOnScreen(doc);
        if (this._drawingIds.has(doc.id) || this.isTokenDrawing(obj)) {
          queue.push(doc);
          break;
        }
        if (obj && !obj.destroyed && obj.parent === layer.objects) {
          if (onScr) {
            obj.renderable = true;
            if (obj.mesh && !obj.mesh.destroyed) obj.mesh.renderable = true;
          }
          newlyMounted.push({ tok: obj, onScr });
          continue;
        }
        this._drawingIds.add(doc.id);
        try {
          const src = this._getDocTexSrc(doc);
          if (src && !this._isTexReady(src) && typeof loadTexFn === "function") {
            await loadTexFn(src);
            if (gen === this._gen) this._decodedTexSrcs.add(src);
          }
          if (selectGen !== this._selectGen || gen !== this._gen || !this.enabled || !canvas?.ready || !layer.active) break;
          if (!canvas.scene?.tokens?.has?.(doc.id)) continue;
          const tDraw = performance.now();
          doc._destroyed = false;
          obj = (doc._object && !doc._object.destroyed) ? doc._object : layer.createObject(doc);
          doc._object = obj;
          if (obj.parent !== layer.objects) layer.objects.addChild(obj);
          await obj.draw();
          frameWorkMs += (performance.now() - tDraw);
          if (gen === this._gen) this._drawingIds.delete(doc.id);
          if (selectGen !== this._selectGen || gen !== this._gen || !this.enabled || !canvas?.ready || !layer.active) {
            if (obj && !obj.destroyed && !this._nativeTokensActive && !obj.controlled) {
              obj.renderable = false;
              if (obj.mesh && !obj.mesh.destroyed) obj.mesh.renderable = false;
              if (obj._ssJumpShadow && !obj._ssJumpShadow.destroyed) obj._ssJumpShadow.renderable = false;
              this.impostors.markVisibilityDirty();
            }
            break;
          }
          if (obj.destroyed || !canvas.scene?.tokens?.has?.(doc.id)) {
            if (!obj.destroyed) {
              try {
                layer.objects.removeChild(obj);
                obj.destroy({ children: true });
              } catch {}
            }
            continue;
          }
          // Apply renderFlags immediately so Foundry v14 populates `obj.shape` & `obj.position` before `_overlapsSelection` (hex grids!)
          try { obj.applyRenderFlags?.(); } catch {}
          // Keep offscreen / roof-occluded tokens non-renderable so selecting 150+ continent tokens adds zero offscreen GPU cost!
          const blockedByRoof = Boolean(
            this.controller?._roofHiddenTokens?.has?.(obj) ||
            this.controller?.isTokenUnderBakedRoof?.(obj)
          );
          if (blockedByRoof) this.controller?._roofHiddenTokens?.add?.(obj);
          const wantVis = onScr && !blockedByRoof;
          obj.renderable = wantVis;
          if (obj.mesh && !obj.mesh.destroyed) {
            obj.mesh.renderable = wantVis;
            const hiddenByShowstopper = typeof obj._ssOcclusionAlpha === "number" && Number.isFinite(obj._ssOcclusionAlpha) && obj._ssOcclusionAlpha <= 0.01;
            if (wantVis && obj.visible !== false && !hiddenByShowstopper && obj.mesh.visible === false) {
              obj.mesh.visible = true;
            }
          }
          if (wantVis) this.lastSeenMs.set(doc.id, performance.now());
          const showDetail = getEffectiveScale(this._lastVp?.scale ?? (canvas.stage?.scale?.x || 1)) >= LOD_DETAIL_MIN_SCALE;
          if (!showDetail) {
            if (obj.nameplate) obj.nameplate.renderable = false;
            if (obj.tooltip) obj.tooltip.renderable = false;
            if (obj.bars) obj.bars.renderable = false;
            if (obj.effects) obj.effects.renderable = false;
          }
          newlyMounted.push({ tok: obj, onScr });
          drawn++;
        } catch (err) {
          console.warn(`${MODULE_ID} | Failed to materialize selected token ${doc.id}:`, err);
        } finally {
          if (gen === this._gen) this._drawingIds.delete(doc.id);
        }
      }

      if (newlyMounted.length > 0 && selectGen === this._selectGen && gen === this._gen && layer.active) {
        runBulk(() => {
          for (let i = 0; i < newlyMounted.length; i++) {
            const { tok, onScr } = newlyMounted[i];
            if (!tok || tok.destroyed) continue;
            if (selectionRect && typeof tok._overlapsSelection === "function" && !tok._overlapsSelection(selectionRect)) {
              if (!this._nativeTokensActive && !tok.controlled) {
                tok.renderable = false;
                if (tok.mesh && !tok.mesh.destroyed) tok.mesh.renderable = false;
              }
              continue;
            }
            if (!tok.controlled) {
              if (tok.control({ force: !onScr, releaseOthers: false, renderSidebar: false })) {
                controlledTokens.push(tok);
              }
            } else {
              controlledTokens.push(tok);
            }
          }
        });
        invalidateTokenLayerCache();
        this.impostors.markVisibilityDirty();
      }

      if (queue.length > 0 && selectGen === this._selectGen && gen === this._gen && this.enabled && layer.active) {
        primeSlice(queue);
        this._selectRafId = sched(() => { step(); });
      } else if (selectGen === this._selectGen) {
        this._selectingBatch = false;
        this.impostors.refreshVisibility(true);
        this.impostors.flush();
        this.controller?.selectionOverlay?.refresh?.();
        this.controller?.updateSimAndLightBubbles?.(false);
        ui.placeables?.render?.();
        if (game.activeTool === "select") ui.placeablesPalette?.render?.();
        onProgress?.({ done: true, selected: layer.controlled.length });
        onComplete?.(controlledTokens);
      }
    };

    this._selectRafId = sched(() => { step(); });
    return { immediate, queued: queue.length, capped };
  }

  /* ------------------------- Utility: Migrate / Populate Native Tokens ------------------------- */

  /** Restore any legacy `flags["boundless"].virtualTokens` back into native `scene.tokens` and remove the flag. */
  async restoreLegacyVirtualTokens(scene = canvas?.scene) {
    if (!game.user?.isActiveGM || !scene) return 0;
    const legacy = scene.flags?.[MODULE_ID]?.virtualTokens;
    if (!legacy || typeof legacy !== "object") return 0;
    const entries = Object.values(legacy).filter(Boolean);
    if (!entries.length) {
      await scene.unsetFlag(MODULE_ID, "virtualTokens");
      return 0;
    }

    let restored = 0;
    for (let i = 0; i < entries.length; i += 100) {
      const slice = entries.slice(i, i + 100);
      const batch = [];
      for (const e of slice) {
        const actor = e.actorId ? game.actors?.get?.(e.actorId) : null;
        const ov = {
          x: e.x, y: e.y, elevation: e.elevation ?? 0, rotation: e.rotation ?? 0,
          width: e.width ?? 1, height: e.height ?? 1, hidden: Boolean(e.hidden),
          disposition: e.disposition ?? CONST.TOKEN_DISPOSITIONS.HOSTILE, name: e.name || "NPC"
        };
        if (e.level && scene.levels?.has?.(e.level)) ov.level = e.level;
        const obj = actor?.getTokenDocument ? (await actor.getTokenDocument(ov)).toObject() : { actorId: e.actorId, ...ov };
        if (e.delta) obj.delta = foundry.utils.deepClone(e.delta);
        delete obj._id;
        batch.push(obj);
      }
      const created = await scene.createEmbeddedDocuments("Token", batch);
      restored += created.length;
    }
    await scene.unsetFlag(MODULE_ID, "virtualTokens");
    return restored;
  }

  /**
   * Populate the scene with `count` 100% native `TokenDocument`s spread across cities/provinces.
   * Thanks to `LazyTokenLayer`, only tokens inside the viewport actually draw or materialize `ActorDelta`.
   */
  async spawnNativePopulation(count = 500, { scene = canvas?.scene } = {}) {
    if (!game.user?.isActiveGM || !scene) return 0;
    const actors = (game.actors?.contents || []).filter(a => a.type !== "character" && a.prototypeToken?.texture?.src);
    const pool = (actors.length ? actors : (game.actors?.contents || []).filter(a => a.prototypeToken?.texture?.src)).slice(0, 32);
    if (!pool.length) {
      ui.notifications?.warn("В мире нет актёров с текстурой токена для заселения.");
      return 0;
    }

    const worldW = scene.width || 100000;
    const worldH = scene.height || 100000;
    const is6000 = worldW >= 500000;
    const hubs = [];
    if (is6000) {
      for (let gy = 0; gy < 6; gy++) {
        for (let gx = 0; gx < 6; gx++) {
          hubs.push({ x: gx * 100000 + 26500, y: gy * 100000 + 53000, spread: 4200 });
          hubs.push({ x: gx * 100000 + 72000, y: gy * 100000 + 28000, spread: 3600 });
        }
      }
    } else {
      hubs.push(
        { x: 26500, y: 53000, spread: 5000 },
        { x: 52000, y: 50000, spread: 4500 },
        { x: 74000, y: 31000, spread: 4000 },
        { x: 24000, y: 24000, spread: 4000 }
      );
    }

    let seed = 1337;
    const rand = () => {
      seed = (seed * 1664525 + 1013904223) >>> 0;
      return seed / 4294967296;
    };

    let createdTotal = 0;
    for (let offset = 0; offset < count; offset += 150) {
      const end = Math.min(count, offset + 150);
      const batch = [];
      for (let i = offset; i < end; i++) {
        const actor = pool[i % pool.length];
        const hub = hubs[i % hubs.length];
        const angle = rand() * Math.PI * 2;
        const dist = Math.sqrt(rand()) * hub.spread;
        const x = Math.max(400, Math.min(worldW - 400, Math.round((hub.x + Math.cos(angle) * dist) / 100) * 100));
        const y = Math.max(400, Math.min(worldH - 400, Math.round((hub.y + Math.sin(angle) * dist) / 100) * 100));
        const td = await actor.getTokenDocument({ x, y });
        batch.push(td.toObject());
      }
      const created = await scene.createEmbeddedDocuments("Token", batch);
      createdTotal += created.length;
    }
    return createdTotal;
  }
}
