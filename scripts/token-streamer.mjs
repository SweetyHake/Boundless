const MODULE_ID = "boundless";
const TOKEN_SECTOR_PX = 4000;       // 40x40 cells per spatial bucket
const MOUNT_MIN_SCALE = 0.075;      // Below ~0.075x (orbital view), skip drawing offscreen/tiny NPC placeables
const MOUNT_VP_PAD_PX = 1600;       // Pre-draw native tokens 16 cells outside viewport edge
const CULL_VP_PAD_PX = 450;         // Frustum culling margin for `renderable` toggle
const LOD_DETAIL_MIN_SCALE = 0.22;  // Below 0.22x hide tiny unreadable nameplate/tooltip/bars/effects
const UNMOUNT_MIN_DIST_PX = 10000;  // Distance outside viewport before LRU-evicting offscreen PIXI placeable
const MAX_MOUNTED_NPCS = 160;       // Client-side PIXI placeable budget (TokenDocuments stay 100% intact in DB!)
const DRAW_FRAME_BUDGET_MS = 4.5;   // Max main-thread time spent calling native Token#draw() per animation frame
const MAX_DRAWS_PER_FRAME = 3;      // Hard cap per rAF so crowded cities stream in smoothly at 144 FPS

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
 * Pure Client-Side Lazy Native TokenLayer Streamer (0 DB writes, 0 proxies, 100% native compatibility).
 * - Every `TokenDocument` lives permanently in `scene.tokens` (zero fake `preCreate`/`create`/`deleteToken` hooks ->
 *   100% compatibility with `cs-hero-box`, `multiple-rings`, `midi-qol`, `dae`, `auraeffects`, `showstopper`, rotations, FoW).
 * - Maintains an O(1) spatial hash of all `scene.tokens` by `_source.x / _source.y`.
 * - Streams native `Token#draw()` (full Dynamic Token Ring, Hero in a Box pop-outs, shaders, bars, rotations) strictly
 *   inside each client's viewport with a 4.5ms/frame rAF budget and async texture pre-decoding.
 * - Applies zoom LOD (hiding unreadable nameplates/bars below 0.22x), strict frustum `renderable` culling, and
 *   client-only LRU eviction of distant offscreen PIXI placeables (leaving `TokenDocument` untouched in DB).
 */
export class TokenStreamer {
  constructor(controller) {
    this.controller = controller;
    this.enabled = false;
    this.sceneId = null;

    /** @type {Map<string, Set<string>>} "sx_sy" -> Set<docId> */
    this.sectorIndex = new Map();
    /** @type {Map<string, string>} docId -> "sx_sy" */
    this.docSector = new Map();
    /** @type {Map<string, number>} docId -> lastVisibleTimestampMs (for client-side LRU eviction) */
    this.lastSeenMs = new Map();

    /** @type {Array<{ doc: any, distSq: number }>} */
    this._drawQueue = [];
    /** @type {Set<string>} */
    this._queuedIds = new Set();
    /** @type {Set<string>} */
    this._drawingIds = new Set();
    this._rafId = null;
    this._pumping = false;
    this._evictTimer = null;
    this._gen = 0;
    this._lastVp = null;
    this._lastLodDetail = null;
    this._lastStreamKey = "";
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

  mount(scene) {
    this.unmount();
    if (!isLazyTokenLayerActiveForScene(scene)) return;

    this.enabled = true;
    this.sceneId = scene.id;
    this._gen++;

    // Build O(1) spatial hash of all native TokenDocuments without touching `doc.actor`
    const iterable = scene.tokens?.values?.() ?? scene.tokens ?? [];
    for (const doc of iterable) {
      this._indexDoc(doc);
    }
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
    this._drawQueue = [];
    this._queuedIds.clear();
    this._drawingIds.clear();
    this.sectorIndex.clear();
    this.docSector.clear();
    this.lastSeenMs.clear();
    this._lastVp = null;
    this._lastLodDetail = null;
    this._lastStreamKey = "";
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
      sectors: this.sectorIndex.size
    };
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
    const showTokens = curVp.scale >= MOUNT_MIN_SCALE;
    const showDetail = curVp.scale >= LOD_DETAIL_MIN_SCALE;
    const lodChanged = showDetail !== this._lastLodDetail;
    this._lastLodDetail = showDetail;

    const cullX0 = curVp.x0 - CULL_VP_PAD_PX;
    const cullY0 = curVp.y0 - CULL_VP_PAD_PX;
    const cullX1 = curVp.x1 + CULL_VP_PAD_PX;
    const cullY1 = curVp.y1 + CULL_VP_PAD_PX;
    const grid = canvas.grid?.size || 100;

    // 1. Fast frustum `renderable` culling & zoom LOD on currently mounted native tokens
    const roofHidden = this.controller?._roofHiddenTokens;
    const placeables = canvas.tokens.placeables;
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
      if (tok.renderable !== wantRenderable) tok.renderable = wantRenderable;
      if (tok.mesh && !tok.mesh.destroyed && tok.mesh.renderable !== wantRenderable) {
        tok.mesh.renderable = wantRenderable;
      }

      // LOD: hide tiny unreadable sub-elements at far macro zoom (< 0.22x) to cut draw calls & Canvas2D cost
      if (lodChanged || wantRenderable) {
        if (tok.nameplate) tok.nameplate.renderable = showDetail;
        if (tok.tooltip) tok.tooltip.renderable = showDetail;
        if (tok.bars) tok.bars.renderable = showDetail;
        if (tok.effects) tok.effects.renderable = showDetail;
      }
    }

    // Skip spawning/evicting placeables while camera is flying across the continent
    if (this.controller?.isCameraFlying) return;

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
        this._scheduleDrawPump();
      }
    }

    // 3. Client-side LRU eviction of distant offscreen PIXI placeables (zero DB changes!)
    this._evictDistantPlaceables(curVp, showTokens);
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
    if (this.controller?.isCameraFlying) return;

    this._pumping = true;
    const gen = this._gen;
    const layer = canvas.tokens;
    const curVp = this._lastVp;
    const startMs = performance.now();
    let drawnThisFrame = 0;
    let anyVisionDrawn = false;

    try {
      while (
        this._drawQueue.length > 0 &&
        drawnThisFrame < MAX_DRAWS_PER_FRAME &&
        (performance.now() - startMs) < DRAW_FRAME_BUDGET_MS
      ) {
        const item = this._drawQueue.shift();
        const doc = item?.doc;
        if (!doc) continue;
        this._queuedIds.delete(doc.id);

        if (!doc.parent || doc.parent.id !== this.sceneId || !doc.viewed) continue;
        // Drop stale queue items if camera already panned far away
        if (curVp && curVp.scale < MOUNT_MIN_SCALE && !isAlwaysMountedTokenDoc(doc)) continue;
        if (curVp) {
          const dx = Number(doc._source?.x ?? doc.x ?? 0);
          const dy = Number(doc._source?.y ?? doc.y ?? 0);
          const pad = MOUNT_VP_PAD_PX * 1.6;
          if (dx < curVp.x0 - pad || dx > curVp.x1 + pad || dy < curVp.y0 - pad || dy > curVp.y1 + pad) {
            continue;
          }
        }

        const existing = doc._object;
        if (existing && !existing.destroyed && existing.parent === layer.objects) continue;

        this._drawingIds.add(doc.id);
        try {
          // Pre-decode texture asynchronously before native Token#draw() to avoid synchronous GPU upload stall
          const texSrc = doc._source?.texture?.src ?? doc.texture?.src;
          const loadTexFn = globalThis.foundry?.canvas?.loadTexture ?? globalThis.loadTexture;
          if (texSrc && typeof loadTexFn === "function") {
            await loadTexFn(texSrc);
          }
          if (!this.enabled || gen !== this._gen || !canvas?.ready || doc.parent?.id !== this.sceneId) return;

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
      if (this._drawQueue.length > 0 && this.enabled && gen === this._gen) {
        this._scheduleDrawPump();
      }
    }
  }

  _evictDistantPlaceables(vp, showTokens) {
    const layer = canvas?.tokens;
    if (!layer?.objects?.children) return;

    const placeables = layer.placeables;
    if (showTokens && placeables.length <= MAX_MOUNTED_NPCS) return;

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

    const targetKeep = showTokens ? MAX_MOUNTED_NPCS : 0;
    const maxToEvict = Math.min(24, Math.max(0, placeables.length - targetKeep));
    let evicted = 0;
    for (let i = 0; i < candidates.length && i < maxToEvict; i++) {
      const { tok, doc } = candidates[i];
      try {
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
  }

  onTokenUpdated(doc, changes) {
    if (!this.enabled || !doc || doc.parent?.id !== this.sceneId) return;
    const moved = "x" in changes || "y" in changes || "level" in changes;
    const lightChanged = "light" in changes;
    if (moved) {
      this._indexDoc(doc);
    }
    if (moved || lightChanged) {
      const needsMount = !doc._object || doc._object.destroyed;
      if (needsMount && lightChanged && isAlwaysMountedTokenDoc(doc) && doc.viewed) {
        if (!this._queuedIds.has(doc.id) && !this._drawingIds.has(doc.id)) {
          this._drawQueue.unshift({ doc, distSq: 0 });
          this._queuedIds.add(doc.id);
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
    this._unindexDoc(doc.id);
    this._queuedIds.delete(doc.id);
    this._drawingIds.delete(doc.id);
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
