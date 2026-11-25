import { MODULE_ID, getEffectiveScale, resolveFoundryRoute } from "./utils.mjs";

const CHUNK_STREAM_MIN_SCALE = 0.022; // Below ~0.022x (true continental orbit), macro pyramid + soft Gaussian macroLights handle rendering with 0 chunk fetches
const CHUNK_VP_PAD_PX = 14000;        // Prefetch neighboring chunks 140 cells outside screen edge
const CHUNK_TOKEN_PAD_PX = 8000;      // Keep chunks loaded within 80 cells around every active token
const MAX_LOADED_CHUNKS = 8;          // LRU RAM + VRAM budget per level (~2-3 MB RAM total regardless of world size)

/**
 * Spatial Chunk Streamer for `boundless-chunked-v1` worlds.
 * Lazily fetches `chunks/{cx}_{cy}.json` strictly around active tokens and zoomed-in viewport,
 * merges their sectors/overlays transparently into `layer.spec`, triggers non-blocking GPU light streaming,
 * and evicts distant chunks via LRU so 6000x6000+ worlds stay O(1) in RAM & startup latency.
 */
export class ChunkStreamer {
  constructor(controller) {
    this.controller = controller;
    /** @type {Map<string, object>} levelId -> { layer, cfg, populated, loaded: Map<ck, rec>, pending: Map<ck, Promise>, lastKey: string } */
    this.states = new Map();
    this._gen = 0;
  }

  mount(visibleLevelLayers) {
    this.unmount();
    this._gen++;
    if (!Array.isArray(visibleLevelLayers)) return;

    for (const layer of visibleLevelLayers) {
      const cfg = layer?.spec?.chunks;
      if (!cfg?.baseUrl || !cfg?.chunkWorldPx) continue;

      // Ensure sparse containers exist for transparent sector & overlay merging
      if (!layer.spec.sectors || typeof layer.spec.sectors !== "object") {
        layer.spec.sectors = {};
      }
      if (!layer.spec.overlays || typeof layer.spec.overlays !== "object") {
        layer.spec.overlays = {};
      }

      this.states.set(layer.level.id, {
        layer,
        cfg,
        populated: new Set(Array.isArray(cfg.populated) ? cfg.populated : []),
        loaded: new Map(),  // ck -> { key, sectorKeys, overlayIds, lastUsedMs }
        pending: new Map(), // ck -> { promise, abort }
        failed: new Map(),  // ck -> retryAfterMs (Infinity for 404/410)
        sectorRefs: new Map(),  // sk -> count of loaded chunks referencing sk
        overlayRefs: new Map(), // oid -> count of loaded chunks referencing oid
        prewarmKeys: new Set(),
        lastKey: ""
      });
    }
  }

  unmount() {
    this._gen++;
    for (const [, st] of this.states) {
      for (const [, req] of st.pending) {
        try { req?.abort?.abort?.(); } catch {}
      }
      for (const [ck] of st.loaded) {
        this._evictChunk(st, ck, false);
      }
      st.loaded.clear();
      st.pending.clear();
      st.failed?.clear?.();
    }
    this.states.clear();
  }

  isChunkedLevel(levelId) {
    return this.states.has(levelId);
  }

  getStats() {
    let loaded = 0, pending = 0, populated = 0;
    for (const st of this.states.values()) {
      loaded += st.loaded.size;
      pending += st.pending.size;
      populated += st.populated.size;
    }
    return { levels: this.states.size, loaded, pending, populated, maxBudget: MAX_LOADED_CHUNKS };
  }

  _collectNeededChunks(st, vp) {
    const { cfg, populated, layer } = st;
    const cw = cfg.chunkWorldPx;
    const cols = cfg.cols || Math.ceil((layer.worldPx || cw) / cw);
    const rows = cfg.rows || Math.ceil((layer.worldPx || cw) / cw);
    const tokenChunks = new Set();
    const vpChunks = new Set();

    const addBox = (dest, x0, y0, x1, y1) => {
      const cx0 = Math.max(0, Math.floor(x0 / cw));
      const cy0 = Math.max(0, Math.floor(y0 / cw));
      const cx1 = Math.min(cols - 1, Math.floor(x1 / cw));
      const cy1 = Math.min(rows - 1, Math.floor(y1 / cw));
      for (let cy = cy0; cy <= cy1; cy++) {
        for (let cx = cx0; cx <= cx1; cx++) {
          const ck = `${cx}_${cy}`;
          if (populated.size === 0 || populated.has(ck)) dest.add(ck);
        }
      }
    };

    // 1. Always keep chunks loaded around active tokens on this level (highest priority)
    const tokens = canvas?.tokens?.placeables;
    if (Array.isArray(tokens)) {
      const lid = layer.level.id;
      for (let i = 0; i < tokens.length; i++) {
        const tok = tokens[i];
        if (!tok || tok.destroyed || tok.isPreview) continue;
        const tLid = tok.document?.level || canvas.level?.id;
        if (tLid && tLid !== lid) continue;
        const tx = tok.center?.x ?? tok.document?.x ?? 0;
        const ty = tok.center?.y ?? tok.document?.y ?? 0;
        addBox(tokenChunks, tx - CHUNK_TOKEN_PAD_PX, ty - CHUNK_TOKEN_PAD_PX, tx + CHUNK_TOKEN_PAD_PX, ty + CHUNK_TOKEN_PAD_PX);
      }
    }

    // 2. Load chunks visible in viewport when zoomed below orbital scale
    if (vp && getEffectiveScale(vp.scale) >= CHUNK_STREAM_MIN_SCALE) {
      addBox(
        vpChunks,
        vp.x0 - CHUNK_VP_PAD_PX,
        vp.y0 - CHUNK_VP_PAD_PX,
        vp.x1 + CHUNK_VP_PAD_PX,
        vp.y1 + CHUNK_VP_PAD_PX
      );
    }

    // Enforce MAX_LOADED_CHUNKS budget: prioritize token chunks first, then nearest viewport chunks to camera center
    const needed = new Set();
    const camX = vp ? (vp.x0 + vp.x1) * 0.5 : 0;
    const camY = vp ? (vp.y0 + vp.y1) * 0.5 : 0;
    const sortByCamDist = (set) => {
      const arr = [];
      for (const ck of set) {
        const sep = ck.indexOf("_");
        const cx = Number(ck.slice(0, sep));
        const cy = Number(ck.slice(sep + 1));
        const dx = (cx + 0.5) * cw - camX;
        const dy = (cy + 0.5) * cw - camY;
        arr.push({ ck, d2: dx * dx + dy * dy });
      }
      arr.sort((a, b) => a.d2 - b.d2);
      return arr;
    };

    if (tokenChunks.size <= MAX_LOADED_CHUNKS) {
      for (const ck of tokenChunks) needed.add(ck);
    } else {
      const sortedTok = sortByCamDist(tokenChunks);
      for (let i = 0; i < MAX_LOADED_CHUNKS && i < sortedTok.length; i++) needed.add(sortedTok[i].ck);
    }

    if (needed.size < MAX_LOADED_CHUNKS && vpChunks.size > 0) {
      const remainingVp = new Set();
      for (const ck of vpChunks) {
        if (!needed.has(ck)) remainingVp.add(ck);
      }
      const sortedVp = sortByCamDist(remainingVp);
      for (let i = 0; i < sortedVp.length && needed.size < MAX_LOADED_CHUNKS; i++) {
        needed.add(sortedVp[i].ck);
      }
    }

    return needed;
  }

  _canFetchChunk(st, ck, now = performance.now()) {
    if (st.loaded.has(ck) || st.pending.has(ck)) return false;
    const retryAfter = st.failed?.get(ck);
    if (retryAfter !== undefined && now < retryAfter) return false;
    return true;
  }

  /** Preload destination chunk silently while camera is flying to a distant POI. */
  prewarmPoint(worldX, worldY) {
    if (this.states.size === 0 || !Number.isFinite(worldX) || !Number.isFinite(worldY)) return;
    const now = performance.now();
    for (const [, st] of this.states) {
      const { cfg, populated, layer } = st;
      const cw = cfg.chunkWorldPx;
      const cols = cfg.cols || Math.ceil((layer.worldPx || cw) / cw);
      const rows = cfg.rows || Math.ceil((layer.worldPx || cw) / cw);
      const cx = Math.floor(worldX / cw);
      const cy = Math.floor(worldY / cw);
      if (cx < 0 || cy < 0 || cx >= cols || cy >= rows) continue;
      const ck = `${cx}_${cy}`;
      if (populated.size === 0 || populated.has(ck)) {
        if (st.pending.has(ck)) {
          st.prewarmKeys?.add?.(ck);
        } else if (this._canFetchChunk(st, ck, now)) {
          st.prewarmKeys?.add?.(ck);
          this._fetchChunk(st, ck);
        }
      }
    }
  }

  update(vp) {
    if (this._updating || this.states.size === 0) return;
    // Fast quantized early-exit on 120 Hz panning inside the same chunk grid cell
    if (vp) {
      let qKey = `${this._gen}|${Math.floor(vp.x0 / 2500)}_${Math.floor(vp.y0 / 2500)}_${Math.floor(vp.x1 / 2500)}_${Math.floor(vp.y1 / 2500)}_${(vp.scale ?? 1) >= 0.022 ? 1 : 0}`;
      const toks = globalThis.canvas?.tokens?.placeables;
      if (toks?.length) {
        let th = toks.length | 0;
        for (let i = 0; i < toks.length; i++) {
          const t = toks[i];
          if (!t || t.destroyed || !t.center) continue;
          if (!t.controlled && !t.document?.baseActor?.hasPlayerOwner) continue;
          th = (Math.imul(th, 31) ^ (Math.floor(t.center.x / 2500) + Math.imul(Math.floor(t.center.y / 2500), 131))) | 0;
        }
        qKey += `|${th}`;
      }
      if (this._lastUpdateQKey === qKey) return;
      this._lastUpdateQKey = qKey;
    }
    this._updating = true;
    try {
      const now = performance.now();

      for (const [, st] of this.states) {
        const needed = this._collectNeededChunks(st, vp);
        st.lastNeeded = needed;
        // Abort stale in-flight fetches that left the viewport/token budget (keep active flight prewarms)
        for (const [ck, req] of Array.from(st.pending.entries())) {
          if (!needed.has(ck) && !st.prewarmKeys?.has?.(ck)) {
            st.pending.delete(ck);
            try { req?.abort?.abort?.(); } catch {}
          }
        }
        for (const ck of needed) {
          const rec = st.loaded.get(ck);
          if (rec) {
            rec.lastUsedMs = now;
          } else if (this._canFetchChunk(st, ck, now)) {
            this._fetchChunk(st, ck);
          }
        }
        this._enforceLru(st, needed, { deferRefresh: true });
      }
    } finally {
      this._updating = false;
    }
  }

  _enforceLru(st, needed = st.lastNeeded, { deferRefresh = false } = {}) {
    if (st.loaded.size <= MAX_LOADED_CHUNKS) return;
    const evictable = [];
    for (const [ck, rec] of st.loaded) {
      if (!needed?.has?.(ck)) evictable.push(rec);
    }
    evictable.sort((a, b) => a.lastUsedMs - b.lastUsedMs);
    const evictedKeys = [];
    while (st.loaded.size > MAX_LOADED_CHUNKS && evictable.length > 0) {
      const victim = evictable.shift();
      this._evictChunk(st, victim.key, false);
      evictedKeys.push(victim.key);
    }
    for (let i = 0; i < evictedKeys.length; i++) {
      this.controller?.onChunkUnloaded?.(st.layer, evictedKeys[i], { deferRefresh });
    }
  }

  _fetchChunk(st, ck) {
    const gen = this._gen;
    const url = resolveFoundryRoute(`${st.cfg.baseUrl}/${ck}.json`);
    const abort = typeof AbortController !== "undefined" ? new AbortController() : null;
    const req = { promise: null, abort };
    st.pending.set(ck, req);
    const p = fetch(url, abort ? { signal: abort.signal } : undefined)
      .then(r => {
        if (!r.ok) {
          const err = new Error(`HTTP ${r.status}`);
          err.status = r.status;
          throw err;
        }
        return r.json();
      })
      .then(data => {
        const isCurrent = st.pending.get(ck) === req;
        if (isCurrent) {
          st.pending.delete(ck);
          st.prewarmKeys?.delete?.(ck);
        }
        if (!isCurrent || gen !== this._gen || !this.states.has(st.layer.level.id)) return;
        st.failed?.delete?.(ck);
        this._mountChunkData(st, ck, data);
      })
      .catch(err => {
        const isCurrent = st.pending.get(ck) === req;
        if (isCurrent) {
          st.pending.delete(ck);
          st.prewarmKeys?.delete?.(ck);
        }
        if (err?.name === "AbortError" || gen !== this._gen || !isCurrent) return;
        const perm = err?.status === 404 || err?.status === 410;
        st.failed?.set?.(ck, perm ? Infinity : (performance.now() + 15000));
        console.warn(`${MODULE_ID} | Failed to load chunk ${url}:`, err);
      });
    req.promise = p;
    return p;
  }

  _mountChunkData(st, ck, data) {
    if (!data || st.loaded.has(ck)) return;
    const { layer } = st;
    const spec = layer.spec;

    // If we are already at capacity and every loaded chunk is actively needed, skip mounting an unrequested stale chunk
    if (st.loaded.size >= MAX_LOADED_CHUNKS && !st.lastNeeded?.has?.(ck)) {
      let hasEvictable = false;
      for (const loadedKey of st.loaded.keys()) {
        if (!st.lastNeeded?.has?.(loadedKey)) {
          hasEvictable = true;
          break;
        }
      }
      if (!hasEvictable) return;
    }

    const overlayIds = [];
    if (data.overlays && typeof data.overlays === "object") {
      for (const [oid, ovSpec] of Object.entries(data.overlays)) {
        spec.overlays[oid] = ovSpec;
        overlayIds.push(oid);
        st.overlayRefs.set(oid, (st.overlayRefs.get(oid) || 0) + 1);
      }
    }

    const sectorKeys = [];
    if (data.sectors && typeof data.sectors === "object") {
      for (const [sk, sec] of Object.entries(data.sectors)) {
        spec.sectors[sk] = sec;
        sectorKeys.push(sk);
        st.sectorRefs.set(sk, (st.sectorRefs.get(sk) || 0) + 1);
      }
    }

    st.loaded.set(ck, {
      key: ck,
      sectorKeys,
      overlayIds,
      data,
      lastUsedMs: performance.now()
    });
    // Protect the freshly mounted chunk from immediate self-eviction before onChunkLoaded runs
    const protect = new Set(st.lastNeeded || []);
    protect.add(ck);
    this._enforceLru(st, protect, { deferRefresh: true });
    if (!st.loaded.has(ck)) return;

    // Trigger non-blocking incremental GPU light baking for this chunk + refresh local overlays/sim/doors
    try {
      this.controller?.onChunkLoaded?.(layer, ck, data);
    } catch (err) {
      console.warn(`${MODULE_ID} | Error in onChunkLoaded(${ck}):`, err);
    }
  }

  /** Re-queue GPU light baking for all currently resident chunks (e.g. after GM wall/light edits). */
  requeueAllLoadedChunks() {
    if (!this.controller?.lightBatch || this.states.size === 0) return;
    for (const [, st] of this.states) {
      for (const [ck, rec] of st.loaded) {
        if (rec?.data) {
          this.controller.lightBatch.queueChunkBake(st.layer, ck, rec.data);
        }
      }
    }
  }

  _evictChunk(st, ck, notifyController) {
    const rec = st.loaded.get(ck);
    if (!rec) return;
    const { layer } = st;
    const spec = layer.spec;

    for (let i = 0; i < rec.sectorKeys.length; i++) {
      const sk = rec.sectorKeys[i];
      const nextRef = (st.sectorRefs.get(sk) || 1) - 1;
      if (nextRef <= 0) {
        st.sectorRefs.delete(sk);
        delete spec.sectors[sk];
      } else {
        st.sectorRefs.set(sk, nextRef);
      }
    }
    for (let i = 0; i < rec.overlayIds.length; i++) {
      const oid = rec.overlayIds[i];
      const nextRef = (st.overlayRefs.get(oid) || 1) - 1;
      if (nextRef <= 0) {
        st.overlayRefs.delete(oid);
        delete spec.overlays[oid];
      } else {
        st.overlayRefs.set(oid, nextRef);
      }
    }
    st.loaded.delete(ck);

    if (notifyController) {
      this.controller?.onChunkUnloaded?.(layer, ck);
    }
  }
}
