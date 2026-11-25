import { TileWorkerPool, isWorkerDecodableUrl } from "./tile-worker-pool.mjs";
import { isTextureUsable } from "./utils.mjs";

export const MAX_VRAM_TEXTURES = 1024; // Default high entry cap so small 256px prop textures across multi-level scenes don't evict pyramid/roof textures
export const MAX_VRAM_BYTES = 1536 * 1024 * 1024; // ~1.5 GB default VRAM budget (mipmapped RGBA estimate)

export const VRAM_PROFILES = Object.freeze({
  low: Object.freeze({ maxBytes: 512 * 1024 * 1024, maxTextures: 384 }),
  balanced: Object.freeze({ maxBytes: 1024 * 1024 * 1024, maxTextures: 768 }),
  high: Object.freeze({ maxBytes: MAX_VRAM_BYTES, maxTextures: MAX_VRAM_TEXTURES }),
  ultra: Object.freeze({ maxBytes: 2048 * 1024 * 1024, maxTextures: 1536 })
});

/**
 * Resolve a concrete VRAM texture cache budget for the requested profile (`auto` | `low` | `balanced` | `high` | `ultra`).
 * Note: Chromium caps `navigator.deviceMemory` at 8 GB even on 32/64 GB machines, so <= 4 GB maps to `low`,
 * low-core systems map to `balanced`, and 8+ GB multi-core desktops map to `high` (1.5 GB).
 */
export function resolveVramBudget(profile = "auto", hw = null) {
  const key = typeof profile === "string" ? profile.toLowerCase() : "auto";
  if (key !== "auto" && key in VRAM_PROFILES) {
    const p = VRAM_PROFILES[key];
    return { profile: key, effectiveProfile: key, maxBytes: p.maxBytes, maxTextures: p.maxTextures };
  }
  const nav = hw || (typeof globalThis !== "undefined" ? globalThis.navigator : null);
  const devMem = Number(nav?.deviceMemory);
  const cores = Number(nav?.hardwareConcurrency);
  let effective = "high";
  if (Number.isFinite(devMem) && devMem > 0 && devMem <= 4) {
    effective = "low";
  } else if (Number.isFinite(cores) && cores > 0 && cores <= 4) {
    effective = "balanced";
  }
  const p = VRAM_PROFILES[effective];
  return { profile: "auto", effectiveProfile: effective, maxBytes: p.maxBytes, maxTextures: p.maxTextures };
}

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
  _fallbackFailures = new Map(); // src -> consecutive fallback failure count
  workerOwned = new Map();  // src -> { tex: PIXI.Texture, bitmap: ImageBitmap }
  workerPool = new TileWorkerPool();
  _gen = 0;
  vramProfile = "auto";
  effectiveProfile = "high";
  maxVramBytes = MAX_VRAM_BYTES;
  maxVramTextures = MAX_VRAM_TEXTURES;

  constructor({ profile = "auto", hw = null } = {}) {
    this.setVramProfile(profile, hw);
  }

  setVramProfile(profile = "auto", hw = null) {
    const resolved = resolveVramBudget(profile, hw);
    this.vramProfile = resolved.profile;
    this.effectiveProfile = resolved.effectiveProfile;
    this.maxVramBytes = resolved.maxBytes;
    this.maxVramTextures = resolved.maxTextures;
    return resolved;
  }

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
    tex.baseTexture._boundlessManaged = true;
    tex.baseTexture.mipmap = mipmap ? PIXI.MIPMAP_MODES.ON : PIXI.MIPMAP_MODES.OFF;
    tex.baseTexture.scaleMode = PIXI.SCALE_MODES.LINEAR;
    tex.baseTexture.wrapMode = PIXI.WRAP_MODES.CLAMP;
    tex.baseTexture.update();
  }

  _loadFallback(src, mipmap, gen = this._gen) {
    this.workerPool.stats.fallbackDecoded++;
    return foundry.canvas.loadTexture(src).then(tex => {
      if (gen !== this._gen) {
        // Never unload Foundry-managed PIXI.Assets textures that native Tiles/Tokens/Lights may still share
        return null;
      }
      if (isTextureUsable(tex)) {
        this._fallbackFailures.delete(src);
        const prevOwned = this.workerOwned.get(src);
        if (prevOwned) {
          this.workerOwned.delete(src);
          try { prevOwned.tex?.destroy?.(true); } catch {}
          try { prevOwned.bitmap?.close?.(); } catch {}
        }
        // Do NOT set _boundlessManaged or mutate wrapMode/mipmap on shared Foundry PIXI.Assets BaseTextures
        // (avoids permanent VRAM leak after scene switch and per-frame video mipmap regeneration).
        this._trackLru(src, tex);
        return tex;
      }
      const fails = (this._fallbackFailures.get(src) || 0) + 1;
      if (fails >= 2) {
        this._fallbackFailures.delete(src);
        this.missingSrcs.add(src);
      } else {
        this._fallbackFailures.set(src, fails);
      }
      return null;
    }).catch(() => {
      if (gen === this._gen) {
        const fails = (this._fallbackFailures.get(src) || 0) + 1;
        if (fails >= 2) {
          this._fallbackFailures.delete(src);
          this.missingSrcs.add(src);
        } else {
          this._fallbackFailures.set(src, fails);
        }
      }
      return null;
    });
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
        let base = null;
        try {
          base = new PIXI.BaseTexture(bitmap, {
            mipmap: mipmap ? PIXI.MIPMAP_MODES.ON : PIXI.MIPMAP_MODES.OFF,
            scaleMode: PIXI.SCALE_MODES.LINEAR,
            wrapMode: PIXI.WRAP_MODES.CLAMP,
            alphaMode: PIXI.ALPHA_MODES.PMA,
            resolution: 1
          });
          base._boundlessManaged = true;
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
          try { base?.destroy?.(); } catch {}
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
    }
    // Non-workerOwned fallback textures belong to Foundry's global PIXI.Assets cache and may be shared with native placeables
  }

  needsPrune() {
    return this.lru.size > this.maxVramTextures || this.totalBytes > this.maxVramBytes;
  }

  prune(inUseSet, maxEvict = Infinity) {
    if (!this.needsPrune()) return 0;
    let evicted = 0;
    for (const [src] of this.lru) {
      if (!this.needsPrune() || evicted >= maxEvict) break;
      if (this.pinned.has(src) || inUseSet?.has?.(src)) continue;
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
      for (const [src, owned] of Array.from(this.workerOwned.entries())) {
        this.workerOwned.delete(src);
        try { owned.tex?.destroy?.(true); } catch {}
        try { owned.bitmap?.close?.(); } catch {}
      }
      this.bytesBySrc.clear();
      this.totalBytes = 0;
    }
    this.missingSrcs.clear();
    this._fallbackFailures.clear();
    this.promises.clear();
  }

  getStats() {
    return {
      lruSize: this.lru.size,
      vramMB: +(this.totalBytes / (1024 * 1024)).toFixed(1),
      vramBudgetMB: Math.round(this.maxVramBytes / (1024 * 1024)),
      maxVramTextures: this.maxVramTextures,
      vramProfile: this.vramProfile,
      effectiveProfile: this.effectiveProfile,
      pinnedSize: this.pinned.size,
      missingCount: this.missingSrcs.size,
      workerOwned: this.workerOwned.size,
      pending: this.promises.size,
      ...this.workerPool.getStats()
    };
  }
}
