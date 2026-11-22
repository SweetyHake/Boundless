import { TileWorkerPool, isWorkerDecodableUrl } from "./tile-worker-pool.mjs";
import { isTextureUsable } from "./utils.mjs";

export const MAX_VRAM_TEXTURES = 1024; // High entry cap so small 256px prop textures across multi-level scenes don't evict pyramid/roof textures
export const MAX_VRAM_BYTES = 1536 * 1024 * 1024; // ~1.5 GB VRAM budget (mipmapped RGBA estimate) for high-PPI multi-level LRU cache

/**
 * VRAM-budgeted LRU texture cache backed by off-main-thread `TileWorkerPool` decoding.
 * Preserves decoded GPU textures across same-scene level switches via `cancelInflight()`,
 * and evicts everything cleanly on scene switches via `clear(true)`.
 */
export class LRUTextureManager {
  promises = new Map();     // src -> Promise<PIXI.Texture>
  lru = new Map();          // src -> PIXI.Texture (insertion order = LRU -> MRU)
  bytesBySrc = new Map();   // src -> estimated VRAM bytes (RGBA + mipmaps)
  totalBytes = 0;
  pinned = new Set();       // Static icons + z0..z1 low-level pyramid stay resident
  missingSrcs = new Set();  // Negative cache for HTTP 404/410 sparse tiles (avoids fallback retries)
  workerOwned = new Map();  // src -> { tex: PIXI.Texture, bitmap: ImageBitmap }
  workerPool = new TileWorkerPool();
  _gen = 0;

  _estimateBytes(tex) {
    const bt = tex?.baseTexture;
    const w = bt?.realWidth || tex?.width || 256;
    const h = bt?.realHeight || tex?.height || 256;
    const mip = bt?.mipmap ? 1.34 : 1.0;
    return Math.max(4096, Math.round(w * h * 4 * mip));
  }

  _trackLru(src, tex) {
    const prev = this.bytesBySrc.get(src) || 0;
    const next = this._estimateBytes(tex);
    this.totalBytes += (next - prev);
    this.bytesBySrc.set(src, next);
    this.lru.delete(src);
    this.lru.set(src, tex);
  }

  pin(src) {
    if (src) this.pinned.add(src);
  }

  getSync(src) {
    const tex = this.lru.get(src);
    if (tex) {
      if (!isTextureUsable(tex)) {
        this._disposeEntry(src);
        return null;
      }
      this.lru.delete(src);
      this.lru.set(src, tex);
    }
    return tex || null;
  }

  _configureBaseTexture(tex, mipmap) {
    if (!tex?.baseTexture) return;
    tex.baseTexture.mipmap = mipmap ? PIXI.MIPMAP_MODES.ON : PIXI.MIPMAP_MODES.OFF;
    tex.baseTexture.scaleMode = PIXI.SCALE_MODES.LINEAR;
    tex.baseTexture.wrapMode = PIXI.WRAP_MODES.CLAMP;
    tex.baseTexture.update();
  }

  _loadFallback(src, mipmap, gen = this._gen) {
    this.workerPool.stats.fallbackDecoded++;
    return foundry.canvas.loadTexture(src).then(tex => {
      if (gen !== this._gen) return null;
      if (tex?.baseTexture) {
        this._configureBaseTexture(tex, mipmap);
        this._trackLru(src, tex);
      }
      return tex;
    }).catch(() => null);
  }

  load(src, { mipmap = true, isPinned = false, priority = 1, maxDim = 0 } = {}) {
    if (!src || this.missingSrcs.has(src)) return Promise.resolve(null);
    if (isPinned) this.pinned.add(src);
    const existing = this.getSync(src);
    if (existing) return Promise.resolve(existing);
    if (this.promises.has(src)) {
      this.workerPool.boost(src, priority);
      return this.promises.get(src);
    }

    const gen = this._gen;
    const useWorker = isWorkerDecodableUrl(src) && this.workerPool.isSupported();
    let p;
    if (useWorker) {
      p = this.workerPool.decode(src, { priority, maxDim }).then(bitmap => {
        if (!bitmap) return null;
        if (gen !== this._gen) {
          try { bitmap.close(); } catch {}
          return null;
        }
        try {
          const base = new PIXI.BaseTexture(bitmap, {
            mipmap: mipmap ? PIXI.MIPMAP_MODES.ON : PIXI.MIPMAP_MODES.OFF,
            scaleMode: PIXI.SCALE_MODES.LINEAR,
            wrapMode: PIXI.WRAP_MODES.CLAMP,
            alphaMode: PIXI.ALPHA_MODES.PMA,
            resolution: 1
          });
          const tex = new PIXI.Texture(base);
          const prevOwned = this.workerOwned.get(src);
          if (prevOwned) {
            try { prevOwned.tex?.destroy?.(true); } catch {}
            try { prevOwned.bitmap?.close?.(); } catch {}
          }
          this.workerOwned.set(src, { tex, bitmap });
          this._trackLru(src, tex);
          return tex;
        } catch {
          try { bitmap.close(); } catch {}
          if (gen !== this._gen) return null;
          return this._loadFallback(src, mipmap, gen);
        }
      }).catch(err => {
        if (err?.aborted || gen !== this._gen) return null;
        if (err?.notFound) {
          this.missingSrcs.add(src);
          return null;
        }
        return this._loadFallback(src, mipmap, gen);
      }).finally(() => {
        if (this.promises.get(src) === p) this.promises.delete(src);
      });
    } else {
      p = this._loadFallback(src, mipmap, gen).finally(() => {
        if (this.promises.get(src) === p) this.promises.delete(src);
      });
    }

    this.promises.set(src, p);
    return p;
  }

  cancel(src) {
    if (!src || this.lru.has(src) || this.pinned.has(src)) return 0;
    const cancelled = this.workerPool.cancel(src);
    if (cancelled > 0) this.promises.delete(src);
    return cancelled;
  }

  cancelPrewarm() {
    const cancelledSrcs = this.workerPool.cancelAtOrBelowPriority(2, this.pinned);
    if (cancelledSrcs && typeof cancelledSrcs[Symbol.iterator] === "function") {
      for (const src of cancelledSrcs) {
        this.promises.delete(src);
      }
      return cancelledSrcs.size;
    }
    return cancelledSrcs || 0;
  }

  /**
   * Abort all in-flight worker requests while preserving resident GPU textures in LRU
   * (enables near-instant level switching within the same scene).
   */
  cancelInflight() {
    this._gen++;
    this.workerPool.cancelAll();
    this.promises.clear();
  }

  _disposeEntry(src) {
    this.lru.delete(src);
    const bytes = this.bytesBySrc.get(src);
    if (bytes !== undefined) {
      this.totalBytes = Math.max(0, this.totalBytes - bytes);
      this.bytesBySrc.delete(src);
    }
    const owned = this.workerOwned.get(src);
    if (owned) {
      this.workerOwned.delete(src);
      try { owned.tex?.destroy?.(true); } catch {}
      try { owned.bitmap?.close?.(); } catch {}
    } else {
      PIXI.Assets.unload(src).catch(() => {});
    }
  }

  needsPrune() {
    return this.lru.size > MAX_VRAM_TEXTURES || this.totalBytes > MAX_VRAM_BYTES;
  }

  prune(inUseSet, maxEvict = Infinity) {
    if (!this.needsPrune()) return 0;
    let evicted = 0;
    for (const [src] of this.lru) {
      if (!this.needsPrune() || evicted >= maxEvict) break;
      if (this.pinned.has(src) || inUseSet.has(src)) continue;
      this._disposeEntry(src);
      evicted++;
    }
    return evicted;
  }

  clear(includePinned = false) {
    this._gen++;
    this.workerPool.cancelAll();
    if (includePinned) this.pinned.clear();
    for (const [src] of Array.from(this.lru.entries())) {
      if (includePinned || !this.pinned.has(src)) this._disposeEntry(src);
    }
    if (includePinned) {
      this.bytesBySrc.clear();
      this.totalBytes = 0;
    }
    this.missingSrcs.clear();
    this.promises.clear();
  }

  getStats() {
    return {
      lruSize: this.lru.size,
      vramMB: +(this.totalBytes / (1024 * 1024)).toFixed(1),
      pinnedSize: this.pinned.size,
      missingCount: this.missingSrcs.size,
      workerOwned: this.workerOwned.size,
      pending: this.promises.size,
      ...this.workerPool.getStats()
    };
  }
}
