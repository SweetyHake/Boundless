import { TokenImpostorLayer } from "./token-impostors.mjs";

const MODULE_ID = "boundless";
const TOKEN_SECTOR_PX = 4000;       // 40x40 cells per spatial bucket
const MOUNT_ENTER_SCALE = 0.11;     // Start streaming native NPC placeables when descending past 0.11x (11px/token)
const MOUNT_EXIT_SCALE = 0.085;     // Hysteresis exit: hand back to GPU Impostor Atlas below 0.085x
const MOUNT_VP_PAD_PX = 1600;       // Pre-draw native tokens 16 cells outside viewport edge
const CULL_VP_PAD_PX = 450;         // Frustum culling margin for `renderable` toggle
const LOD_DETAIL_MIN_SCALE = 0.22;  // Below 0.22x hide tiny unreadable nameplate/tooltip/bars/effects
const UNMOUNT_MIN_DIST_PX = 10000;  // Distance outside viewport before LRU-evicting offscreen PIXI placeable
const MAX_MOUNTED_NPCS = 160;       // Client-side PIXI placeable budget (TokenDocuments stay 100% intact in DB!)
const WARM_ORBIT_KEEP = 48;         // Keep a warm cache of 48 recently seen NPCs when zooming briefly to orbit
const DRAW_FRAME_BUDGET_MS = 4.5;   // Max main-thread time spent calling native Token#draw() per animation frame
const FLIGHT_PREWARM_BUDGET_MS = 2.0; // Low frame budget while camera is flying so 144 FPS flight stays silky
const MAX_DRAWS_PER_FRAME = 6;      // Cap per rAF once textures are pre-decoded in parallel
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
  if (doc.flags?.[MODULE_ID]?.pinned) return true;
  if (doc.combatant) return true;
  if (game.combat?.combatants?.some?.(c => c.tokenId === doc.id && c.sceneId === doc.parent?.id)) return true;
  const light = doc._source?.light ?? doc.light;
  if ((Number(light?.dim) || 0) > 0 || (Number(light?.bright) || 0) > 0) return true;
  const obj = doc._object;
  if (obj && !obj.destroyed) {
    if (obj.controlled || obj._animation || obj.movementAnimationPromise) return true;
    if (obj.targeted?.size > 0) return true;
  }
  return false;
}

function isLazyTokenLayerActiveForScene(scene) {
  if (!scene) return false;
  const cfg = scene.flags?.[MODULE_ID] || {};
  if (cfg.virtualizeTokens === false) return false;
  return Boolean(cfg.enabled || scene.levels?.some?.(l => l.flags?.[MODULE_ID]?.enabled));
}

let lazyPatchInstalled = false;

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

  const origViewed = TokenLayerCls.prototype.viewedDocuments;
  TokenLayerCls.prototype.viewedDocuments = function* () {
    const scene = this.scene ?? canvas?.scene;
    if (!isLazyTokenLayerActiveForScene(scene)) {
      yield* origViewed.call(this);
      return;
    }
    for (const doc of origViewed.call(this)) {
      if (isAlwaysMountedTokenDoc(doc)) {
        yield doc;
      }
    }
  };
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
    this._pumping = false;
    this._evictTimer = null;
    this._gen = 0;
    this._lastVp = null;
    this._lastLodDetail = null;
    this._lastStreamKey = "";
    this._nativeTokensActive = false;
    this._flightPrewarmTarget = null;
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
    const curScale = canvas?.stage?.scale?.x ?? 1;
    this._nativeTokensActive = curScale >= MOUNT_ENTER_SCALE;

    // Build O(1) spatial hash of all native TokenDocuments without touching `doc.actor`
    const iterable = scene.tokens?.values?.() ?? scene.tokens ?? [];
    for (const doc of iterable) {
      this._indexDoc(doc);
    }

    this.impostors.mount(scene);
  }

  unmount() {
    this.enabled = false;
    this.sceneId = null;
    this._gen++;
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
    if ((targetScale || 0) < MOUNT_EXIT_SCALE) return;

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
    // Hysteresis prevents rapid mount/unmount thrashing around the transition zoom level
    if (curVp.scale >= MOUNT_ENTER_SCALE) this._nativeTokensActive = true;
    else if (curVp.scale < MOUNT_EXIT_SCALE) this._nativeTokensActive = false;
    const showTokens = this._nativeTokensActive;

    const showDetail = curVp.scale >= LOD_DETAIL_MIN_SCALE;
    const lodChanged = showDetail !== this._lastLodDetail;
    this._lastLodDetail = showDetail;

    const cullX0 = curVp.x0 - CULL_VP_PAD_PX;
    const cullY0 = curVp.y0 - CULL_VP_PAD_PX;
    const cullX1 = curVp.x1 + CULL_VP_PAD_PX;
    const cullY1 = curVp.y1 + CULL_VP_PAD_PX;
    const grid = canvas.grid?.size || 100;

    // 1. Fast frustum `renderable` culling & zoom LOD on currently mounted native tokens (runs even during camera flight!)
    const roofHidden = this.controller?._roofHiddenTokens;
    const placeables = canvas.tokens.placeables;
    let anyRenderableToggled = false;
    for (let i = 0; i < placeables.length; i++) {
      const tok = placeables[i];
      if (!tok || tok.destroyed || tok.isPreview) continue;
      const doc = tok.document;
      const w = (doc?.width || 1) * grid;
      const h = (doc?.height || 1) * grid;
      const tx = doc?._source?.x ?? doc?.x ?? tok.x ?? 0;
      const ty = doc?._source?.y ?? doc?.y ?? tok.y ?? 0;
      const onScreen = showTokens && (tx + w >= cullX0 && tx <= cullX1 && ty + h >= cullY0 && ty <= cullY1);
      const keepVisible = onScreen || tok.controlled;
      if (keepVisible) this.lastSeenMs.set(doc.id, now);

      const blockedByRoof = Boolean(roofHidden?.has?.(tok));
      const wantRenderable = keepVisible && !blockedByRoof;
      if (tok.renderable !== wantRenderable) {
        if (!wantRenderable && this._activeFades.has(doc.id)) {
          this._finishFadeImmediate(doc.id);
        }
        tok.renderable = wantRenderable;
        anyRenderableToggled = true;
      }
      if (tok.mesh && !tok.mesh.destroyed) {
        if (tok.mesh.renderable !== wantRenderable) {
          tok.mesh.renderable = wantRenderable;
          anyRenderableToggled = true;
        }
        // Foundry v14 Token#_refreshVisibility sets mesh.visible = visible && renderable; restore it when returning to view
        if (wantRenderable && tok.visible !== false && tok.mesh.visible === false) {
          tok.mesh.visible = true;
        }
      }

      // LOD: hide tiny unreadable sub-elements at far macro zoom (< 0.22x) to cut draw calls & Canvas2D cost
      if (lodChanged || wantRenderable) {
        if (tok.nameplate) tok.nameplate.renderable = showDetail;
        if (tok.tooltip) tok.tooltip.renderable = showDetail;
        if (tok.bars) tok.bars.renderable = showDetail;
        if (tok.effects) tok.effects.renderable = showDetail;
      }
    }

    if (anyRenderableToggled || force) {
      this.impostors.markVisibilityDirty();
    }

    // Skip spawning/evicting transit placeables while camera is flying across the continent
    // (impostors & prewarmTarget keep both flight and landing seamless!)
    if (this.controller?.isCameraFlying) return;
    this._flightPrewarmTarget = null;

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
      const src = this._getDocTexSrc(this._drawQueue[i]?.doc);
      if (!src || this._isTexReady(src) || this._inflightTexLoads.has(src)) continue;
      const p = Promise.resolve(loadTexFn(src))
        .catch(() => null)
        .finally(() => {
          this._inflightTexLoads.delete(src);
          this._decodedTexSrcs.add(src);
          if (this.enabled && gen === this._gen && this._drawQueue.length > 0) {
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
          if (isFlying && !cand?.isPrewarm) continue;
          if (this._isTexReady(this._getDocTexSrc(cand?.doc))) {
            pickIdx = i;
            break;
          }
        }

        const item = this._drawQueue[pickIdx];
        if (isFlying && !item?.isPrewarm) {
          this._drawQueue.splice(pickIdx, 1);
          if (item?.doc?.id) this._queuedIds.delete(item.doc.id);
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

        if (!doc.parent || doc.parent.id !== this.sceneId || !doc.viewed) continue;

        const dx = Number(doc._source?.x ?? doc.x ?? 0);
        const dy = Number(doc._source?.y ?? doc.y ?? 0);

        if (item.isPrewarm && prewarmBox) {
          if (dx < prewarmBox.x0 || dx > prewarmBox.x1 || dy < prewarmBox.y0 || dy > prewarmBox.y1) continue;
        } else {
          // Drop stale queue items if camera already zoomed out or panned far away
          if (curVp && !this._nativeTokensActive && !isAlwaysMountedTokenDoc(doc)) continue;
          if (curVp) {
            const pad = MOUNT_VP_PAD_PX * 1.6;
            if (dx < curVp.x0 - pad || dx > curVp.x1 + pad || dy < curVp.y0 - pad || dy > curVp.y1 + pad) {
              continue;
            }
          }
        }

        const existing = doc._object;
        if (existing && !existing.destroyed && existing.parent === layer.objects) continue;

        this._drawingIds.add(doc.id);
        try {
          const loadTexFn = globalThis.foundry?.canvas?.loadTexture ?? globalThis.loadTexture;
          if (texSrc && !this._isTexReady(texSrc) && typeof loadTexFn === "function") {
            await loadTexFn(texSrc);
            this._decodedTexSrcs.add(texSrc);
          }
          if (!this.enabled || gen !== this._gen || !canvas?.ready || doc.parent?.id !== this.sceneId) return;

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
          if (!this.enabled || gen !== this._gen) return;

          this.lastSeenMs.set(doc.id, performance.now());
          if (doc._source?.sight?.enabled && (doc.baseActor?.hasPlayerOwner || obj.controlled)) {
            anyVisionDrawn = true;
          }

          // Start smooth 160ms over-composite crossfade via mesh.unoccludedAlpha (never touches tok.alpha or mesh.alpha!)
          if (shouldFade && obj.mesh && !obj.mesh.destroyed) {
            const hasUnoccluded = "unoccludedAlpha" in obj.mesh;
            const targetOccluded = Number.isFinite(obj.mesh.occludedAlpha) ? obj.mesh.occludedAlpha : 0.5;
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
          } else {
            this.impostors.setFadeOverride(doc.id, null);
            this.impostors.markVisibilityDirty();
          }

          // Apply current LOD detail state immediately to newly drawn token
          const showDetail = (this._lastVp?.scale ?? 1) >= LOD_DETAIL_MIN_SCALE;
          if (!showDetail) {
            if (obj.nameplate) obj.nameplate.renderable = false;
            if (obj.tooltip) obj.tooltip.renderable = false;
            if (obj.bars) obj.bars.renderable = false;
            if (obj.effects) obj.effects.renderable = false;
          }
          drawnThisFrame++;
        } catch (err) {
          this.impostors.setFadeOverride(doc.id, null);
          console.warn(`${MODULE_ID} | Lazy Token#draw() failed for ${doc.id}:`, err);
        } finally {
          this._drawingIds.delete(doc.id);
        }
      }

      if (drawnThisFrame > 0 && this.enabled && canvas?.ready) {
        this.controller._roofTokenOccDirty = true;
        if (anyVisionDrawn) {
          canvas.perception?.update?.({ refreshVision: true, refreshOcclusion: true });
        }
      }
    } finally {
      this._pumping = false;
      const hasReadyOrPending = this._drawQueue.length > 0 && deferredWaitingTex < this._drawQueue.length;
      if (hasReadyOrPending && this.enabled && gen === this._gen) {
        this._scheduleDrawPump();
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

    const maxToEvict = Math.min(24, Math.max(0, placeables.length - targetKeep));
    let evicted = 0;
    for (let i = 0; i < candidates.length && i < maxToEvict; i++) {
      const { tok, doc } = candidates[i];
      try {
        this._finishFadeImmediate(doc.id);
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
      this.impostors.markVisibilityDirty();
    }

    // If more distant placeables remain above budget (e.g. after zooming out to orbital view), drain smoothly
    if (evicted > 0 && candidates.length > evicted && (placeables.length - evicted) > targetKeep) {
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

  onTokenCreated(doc) {
    if (!this.enabled || !doc || doc.parent?.id !== this.sceneId) return;
    this._indexDoc(doc);
    this.lastSeenMs.set(doc.id, performance.now());
    this.impostors.upsertToken(doc);
  }

  onTokenUpdated(doc, changes) {
    if (!this.enabled || !doc || doc.parent?.id !== this.sceneId) return;
    const moved = "x" in changes || "y" in changes || "level" in changes;
    const lightChanged = "light" in changes;
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
      || "disposition" in changes;

    if (moved) {
      this._indexDoc(doc);
    }
    if (visualChanged) {
      this.impostors.upsertToken(doc);
    }
    if (moved || lightChanged) {
      const needsMount = !doc._object || doc._object.destroyed;
      if (needsMount && lightChanged && isAlwaysMountedTokenDoc(doc) && doc.viewed) {
        if (!this._queuedIds.has(doc.id) && !this._drawingIds.has(doc.id)) {
          this._drawQueue.unshift({ doc, distSq: 0 });
          this._queuedIds.add(doc.id);
          this._primeQueueTextures();
          this._scheduleDrawPump();
        }
      } else if (moved && this._lastVp && needsMount) {
        // If a previously unmounted NPC moved into the current viewport, queue its native draw
        this._lastStreamKey = "";
        this.scheduleSync(this._lastVp, true);
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

  onVisibilityChanged() {
    if (!this.enabled) return;
    this.impostors.markVisibilityDirty();
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
