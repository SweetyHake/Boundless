/**
 * Boundless — Priority Web Worker Pool for Off-Main-Thread Tile Decoding (`createImageBitmap`)
 * - Runs 2..4 dedicated decoder workers (auto-sized from `navigator.hardwareConcurrency`)
 * - Priority queue: 0 = pinned/core, 1 = visible tiles/overlays, 2 = background prewarm
 * - Zero-copy `ImageBitmap` transfer + in-flight `AbortController` cancellation for stale tiles
 * - Automatic fallback detection for non-raster URLs (SVG/video) or unsupported environments
 */

const RASTER_EXT_RE = /\.(webp|png|jpe?g|avif|bmp|gif)(\?.*)?$/i;
const MAX_INFLIGHT_PER_WORKER = 2;

export function isWorkerDecodableUrl(src) {
  if (!src || typeof src !== "string") return false;
  if (src.startsWith("data:") || src.startsWith("blob:")) return false;
  return RASTER_EXT_RE.test(src);
}

function resolveAbsoluteUrl(src) {
  try {
    const base = typeof document !== "undefined" && document.baseURI
      ? document.baseURI
      : (typeof location !== "undefined" ? location.href : undefined);
    return base ? new URL(src, base).href : src;
  } catch {
    return src;
  }
}

export class TileWorkerPool {
  constructor({ poolSize, workerFactory } = {}) {
    const hw = typeof navigator !== "undefined" ? (navigator.hardwareConcurrency || 4) : 4;
    this.poolSize = Math.max(1, Math.min(4, poolSize ?? Math.max(2, Math.floor(hw / 2))));
    this._workerFactory = workerFactory || null;
    this._workers = [];
    this._workerLoad = [];
    this._initialized = false;
    this._supported = null;

    this._nextId = 1;
    /** @type {Array<{ id: number, src: string, url: string, priority: number, resolve: Function, reject: Function }>} */
    this._queue = [];
    /** @type {Map<number, { src: string, workerIdx: number, priority: number, resolve: Function, reject: Function }>} */
    this._active = new Map();
    /** @type {Map<string, Set<number>>} src -> Set<jobId> */
    this._jobsBySrc = new Map();

    // Telemetry
    this.stats = {
      workerDecoded: 0,
      fallbackDecoded: 0,
      aborted: 0,
      errors: 0,
      totalDecodeMs: 0
    };
  }

  isSupported() {
    if (this._supported !== null) return this._supported;
    if (this._workerFactory) {
      this._supported = true;
      return true;
    }
    this._supported = (
      typeof Worker === "function" &&
      typeof createImageBitmap === "function" &&
      typeof fetch === "function"
    );
    return this._supported;
  }

  _ensureWorkers() {
    if (this._initialized) return this._workers.length > 0;
    this._initialized = true;
    if (!this.isSupported()) return false;

    const workerUrl = this._workerFactory
      ? null
      : new URL("./tile-decode.worker.mjs", import.meta.url);

    for (let i = 0; i < this.poolSize; i++) {
      try {
        const w = this._workerFactory
          ? this._workerFactory(i)
          : new Worker(workerUrl, { type: "module" });
        const idx = this._workers.length;
        w.onmessage = (ev) => this._onWorkerMessage(idx, ev);
        w.onerror = (err) => this._onWorkerError(idx, err);
        this._workers.push(w);
        this._workerLoad.push(0);
      } catch (err) {
        console.warn("boundless | Failed to spawn tile decoder worker:", err);
        break;
      }
    }

    if (this._workers.length === 0) {
      this._supported = false;
      return false;
    }
    return true;
  }

  _trackSrc(src, id) {
    let set = this._jobsBySrc.get(src);
    if (!set) {
      set = new Set();
      this._jobsBySrc.set(src, set);
    }
    set.add(id);
  }

  _untrackSrc(src, id) {
    const set = this._jobsBySrc.get(src);
    if (!set) return;
    set.delete(id);
    if (set.size === 0) this._jobsBySrc.delete(src);
  }

  /**
   * Decode an image URL into an `ImageBitmap` off the main thread.
   * Resolves to `ImageBitmap` or rejects with `{ aborted: true }` / Error.
   */
  decode(src, { priority = 1, premultiply = true } = {}) {
    if (!isWorkerDecodableUrl(src) || !this._ensureWorkers()) {
      return Promise.reject(new Error("worker_unsupported"));
    }

    const id = this._nextId++;
    const url = resolveAbsoluteUrl(src);
    this._trackSrc(src, id);

    return new Promise((resolve, reject) => {
      const job = { id, src, url, priority, premultiply, resolve, reject };
      // Insert in priority order (smaller priority number = higher urgency)
      let insertAt = this._queue.length;
      for (let i = 0; i < this._queue.length; i++) {
        if (priority < this._queue[i].priority) {
          insertAt = i;
          break;
        }
      }
      this._queue.splice(insertAt, 0, job);
      this._dispatch();
    });
  }

  /**
   * Raise priority of a queued job (e.g. if a prewarm tile suddenly enters the viewport).
   */
  boost(src, newPriority = 0) {
    const ids = this._jobsBySrc.get(src);
    if (!ids?.size) return;
    let moved = false;
    for (const job of this._queue) {
      if (ids.has(job.id) && newPriority < job.priority) {
        job.priority = newPriority;
        moved = true;
      }
    }
    if (moved) {
      this._queue.sort((a, b) => a.priority - b.priority);
    }
  }

  /**
   * Cancel any pending or in-flight decode for `src`.
   */
  cancel(src) {
    const ids = this._jobsBySrc.get(src);
    if (!ids?.size) return 0;
    let cancelled = 0;

    for (const id of Array.from(ids)) {
      // Check queued jobs first
      const qIdx = this._queue.findIndex(j => j.id === id);
      if (qIdx !== -1) {
        const [job] = this._queue.splice(qIdx, 1);
        this._untrackSrc(src, id);
        this.stats.aborted++;
        cancelled++;
        const err = new Error("aborted");
        err.aborted = true;
        job.reject(err);
        continue;
      }

      // Check active in-flight worker jobs
      const act = this._active.get(id);
      if (act) {
        this._active.delete(id);
        this._untrackSrc(src, id);
        this._workerLoad[act.workerIdx] = Math.max(0, (this._workerLoad[act.workerIdx] || 1) - 1);
        try {
          this._workers[act.workerIdx]?.postMessage({ type: "cancel", id });
        } catch {}
        this.stats.aborted++;
        cancelled++;
        const err = new Error("aborted");
        err.aborted = true;
        act.reject(err);
      }
    }

    if (cancelled > 0) this._dispatch();
    return cancelled;
  }

  /**
   * Cancel queued/in-flight jobs whose priority >= minPriority (e.g. drop stale prewarm jobs with priority 2).
   */
  cancelAtOrBelowPriority(minPriority = 2) {
    const toCancel = new Set();
    for (const job of this._queue) {
      if (job.priority >= minPriority) toCancel.add(job.src);
    }
    for (const act of this._active.values()) {
      if (act.priority >= minPriority) toCancel.add(act.src);
    }
    let total = 0;
    for (const src of toCancel) total += this.cancel(src);
    return total;
  }

  cancelAll() {
    let total = 0;
    for (const src of Array.from(this._jobsBySrc.keys())) {
      total += this.cancel(src);
    }
    return total;
  }

  _dispatch() {
    while (this._queue.length > 0 && this._workers.length > 0) {
      // Pick least-loaded worker under MAX_INFLIGHT_PER_WORKER
      let bestIdx = -1;
      let bestLoad = MAX_INFLIGHT_PER_WORKER;
      for (let i = 0; i < this._workers.length; i++) {
        if (this._workerLoad[i] < bestLoad) {
          bestLoad = this._workerLoad[i];
          bestIdx = i;
        }
      }
      if (bestIdx === -1) break;

      const job = this._queue.shift();
      this._workerLoad[bestIdx]++;
      this._active.set(job.id, {
        src: job.src,
        workerIdx: bestIdx,
        priority: job.priority,
        resolve: job.resolve,
        reject: job.reject
      });

      try {
        this._workers[bestIdx].postMessage({
          type: "decode",
          id: job.id,
          url: job.url,
          premultiply: job.premultiply
        });
      } catch (err) {
        this._active.delete(job.id);
        this._untrackSrc(job.src, job.id);
        this._workerLoad[bestIdx] = Math.max(0, this._workerLoad[bestIdx] - 1);
        this.stats.errors++;
        job.reject(err);
      }
    }
  }

  _onWorkerMessage(workerIdx, event) {
    const msg = event?.data;
    if (!msg) return;
    const act = this._active.get(msg.id);
    if (!act) {
      // Job was already cancelled on main thread — immediately release transferred bitmap to avoid VRAM/RAM leak!
      if (msg.bitmap && typeof msg.bitmap.close === "function") {
        try { msg.bitmap.close(); } catch {}
      }
      return;
    }

    this._active.delete(msg.id);
    this._untrackSrc(act.src, msg.id);
    this._workerLoad[workerIdx] = Math.max(0, (this._workerLoad[workerIdx] || 1) - 1);

    if (msg.aborted) {
      this.stats.aborted++;
      const err = new Error("aborted");
      err.aborted = true;
      act.reject(err);
    } else if (msg.bitmap) {
      this.stats.workerDecoded++;
      this.stats.totalDecodeMs += Number(msg.decodeMs) || 0;
      act.resolve(msg.bitmap);
    } else {
      this.stats.errors++;
      act.reject(new Error(msg.error || "decode_failed"));
    }

    this._dispatch();
  }

  _onWorkerError(workerIdx, err) {
    console.warn(`boundless | Tile decoder worker #${workerIdx} error:`, err?.message || err);
    // Reject all jobs assigned to this worker so callers fall back cleanly
    for (const [id, act] of Array.from(this._active.entries())) {
      if (act.workerIdx !== workerIdx) continue;
      this._active.delete(id);
      this._untrackSrc(act.src, id);
      this.stats.errors++;
      act.reject(new Error("worker_error"));
    }
    this._workerLoad[workerIdx] = 0;
    this._dispatch();
  }

  getStats() {
    return {
      supported: this._supported,
      workers: this._workers.length,
      queued: this._queue.length,
      inFlight: this._active.size,
      workerDecoded: this.stats.workerDecoded,
      fallbackDecoded: this.stats.fallbackDecoded,
      aborted: this.stats.aborted,
      errors: this.stats.errors,
      avgDecodeMs: this.stats.workerDecoded > 0
        ? Math.round((this.stats.totalDecodeMs / this.stats.workerDecoded) * 100) / 100
        : 0
    };
  }

  destroy() {
    this.cancelAll();
    for (const w of this._workers) {
      try { w.terminate?.(); } catch {}
    }
    this._workers = [];
    this._workerLoad = [];
    this._initialized = false;
  }
}
