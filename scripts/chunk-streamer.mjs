const MODULE_ID = "boundless";
const CHUNK_STREAM_MIN_SCALE = 0.042; // Below ~0.042x (orbital view), macro pyramid + macroLights handle rendering with 0 chunk fetches
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
        pending: new Map(), // ck -> Promise
        lastKey: ""
      });
    }
  }

  unmount() {
    this._gen++;
    for (const [, st] of this.states) {
      for (const [ck] of st.loaded) {
        this._evictChunk(st, ck, false);
      }
      st.loaded.clear();
      st.pending.clear();
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
    const needed = new Set();

    const addBox = (x0, y0, x1, y1) => {
      const cx0 = Math.max(0, Math.floor(x0 / cw));
      const cy0 = Math.max(0, Math.floor(y0 / cw));
      const cx1 = Math.min(cols - 1, Math.floor(x1 / cw));
      const cy1 = Math.min(rows - 1, Math.floor(y1 / cw));
      for (let cy = cy0; cy <= cy1; cy++) {
        for (let cx = cx0; cx <= cx1; cx++) {
          const ck = `${cx}_${cy}`;
          if (populated.size === 0 || populated.has(ck)) needed.add(ck);
        }
      }
    };

    // 1. Always keep chunks loaded around active tokens on this level
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
        addBox(tx - CHUNK_TOKEN_PAD_PX, ty - CHUNK_TOKEN_PAD_PX, tx + CHUNK_TOKEN_PAD_PX, ty + CHUNK_TOKEN_PAD_PX);
      }
    }

    // 2. Load chunks visible in viewport when zoomed below orbital scale
    if (vp && vp.scale >= CHUNK_STREAM_MIN_SCALE) {
      addBox(
        vp.x0 - CHUNK_VP_PAD_PX,
        vp.y0 - CHUNK_VP_PAD_PX,
        vp.x1 + CHUNK_VP_PAD_PX,
        vp.y1 + CHUNK_VP_PAD_PX
      );
    }

    return needed;
  }

  /** Preload destination chunk silently while camera is flying to a distant POI. */
  prewarmPoint(worldX, worldY) {
    if (this.states.size === 0) return;
    for (const [, st] of this.states) {
      const { cfg, populated } = st;
      const cw = cfg.chunkWorldPx;
      const cx = Math.floor(worldX / cw);
      const cy = Math.floor(worldY / cw);
      const ck = `${cx}_${cy}`;
      if ((populated.size === 0 || populated.has(ck)) && !st.loaded.has(ck) && !st.pending.has(ck)) {
        this._fetchChunk(st, ck);
      }
    }
  }

  update(vp) {
    if (this.states.size === 0) return;
    const now = performance.now();

    for (const [, st] of this.states) {
      const needed = this._collectNeededChunks(st, vp);
      st.lastNeeded = needed;
      for (const ck of needed) {
        const rec = st.loaded.get(ck);
        if (rec) {
          rec.lastUsedMs = now;
        } else if (!st.pending.has(ck)) {
          this._fetchChunk(st, ck);
        }
      }
      this._enforceLru(st, needed);
    }
  }

  _enforceLru(st, needed = st.lastNeeded) {
    if (st.loaded.size <= MAX_LOADED_CHUNKS) return;
    const evictable = [];
    for (const [ck, rec] of st.loaded) {
      if (!needed?.has?.(ck)) evictable.push(rec);
    }
    evictable.sort((a, b) => a.lastUsedMs - b.lastUsedMs);
    while (st.loaded.size > MAX_LOADED_CHUNKS && evictable.length > 0) {
      const victim = evictable.shift();
      this._evictChunk(st, victim.key, true);
    }
  }

  _fetchChunk(st, ck) {
    const gen = this._gen;
    const url = `${st.cfg.baseUrl}/${ck}.json`;
    const p = fetch(url)
      .then(r => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json();
      })
      .then(data => {
        st.pending.delete(ck);
        if (gen !== this._gen || !this.states.has(st.layer.level.id)) return;
        this._mountChunkData(st, ck, data);
      })
      .catch(err => {
        st.pending.delete(ck);
        console.warn(`${MODULE_ID} | Failed to load chunk ${url}:`, err);
      });
    st.pending.set(ck, p);
    return p;
  }

  _mountChunkData(st, ck, data) {
    if (!data || st.loaded.has(ck)) return;
    const { layer } = st;
    const spec = layer.spec;

    const overlayIds = [];
    if (data.overlays && typeof data.overlays === "object") {
      for (const [oid, ovSpec] of Object.entries(data.overlays)) {
        spec.overlays[oid] = ovSpec;
        overlayIds.push(oid);
      }
    }

    const sectorKeys = [];
    if (data.sectors && typeof data.sectors === "object") {
      for (const [sk, sec] of Object.entries(data.sectors)) {
        spec.sectors[sk] = sec;
        sectorKeys.push(sk);
      }
    }

    st.loaded.set(ck, {
      key: ck,
      sectorKeys,
      overlayIds,
      lastUsedMs: performance.now()
    });
    this._enforceLru(st);

    // Trigger non-blocking incremental GPU light baking for this chunk + refresh local overlays/sim/doors
    this.controller?.onChunkLoaded?.(layer, ck, data);
  }

  _evictChunk(st, ck, notifyController) {
    const rec = st.loaded.get(ck);
    if (!rec) return;
    const { layer } = st;
    const spec = layer.spec;

    for (let i = 0; i < rec.sectorKeys.length; i++) {
      delete spec.sectors[rec.sectorKeys[i]];
    }
    for (let i = 0; i < rec.overlayIds.length; i++) {
      delete spec.overlays[rec.overlayIds[i]];
    }
    st.loaded.delete(ck);

    if (notifyController) {
      this.controller?.onChunkUnloaded?.(layer, ck);
    }
  }
}
