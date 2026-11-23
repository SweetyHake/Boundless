import { MODULE_ID } from "./utils.mjs";
import {
  PERF_CONFIG,
  perfStats,
  isAgPerfCoreActive,
  wrapFoundryMethod
} from "./perf-patcher.mjs";

/**
 * Boundless CPU & Perception Optimizer (Foundry VTT v14+).
 * Zero-config, visually identical CPU-pipeline optimizations active on ALL scenes:
 *  1. RenderFlags#set deduplication (skips propagation when requested flags are already set).
 *  2. Broad-phase visibility pruning (skips refreshVisibility for invisible tokens/notes out of range).
 *  3. Shared LOS cache (per perception generation) + cell visibility / fog exploration cache.
 *  4. FogManager#commit trailing throttle (with movement-loss guard & sync flush on save).
 *  5. CanvasOcclusionMask trailing throttle + PerceptionManager occlusion visibility guard.
 *  6. Adaptive drag-pipeline coalescing (with sync flush before finalize) + measureMovementPath memoization.
 *  7. Preview non-interactable hover skip, text style guard, identical sweep skip, light field guard.
 *  8. TextEditor.enrichHTML LRU cache (non-rollData) + optional idle FPS limiter.
 *
 * Automatically yields overlapping CPU patches when `ag-perf-core` is active.
 */

let _cpuInstalled = false;

let _geometryVersion = 1;
let _edgeVersion = 0;
let _perceptionVer = 0;
let _exploredVer = 0;

const _losCache = new Map();
const _cellVisCache = new Map();
const _cellExploredCache = new Map();
const _enrichCache = new Map();
const _rollValidateCache = new Map();
const _fogGuardSnap = new Map();
const _fieldSigs = new WeakMap();
let _measureCaches = new WeakMap();

let _visGuardToken = null;
let _visGuardWasVisible = false;

const _dragQ = { last: 0, pending: null, timerId: null };
let _dragRecalcMs = 0;

// ---------------------------------------------------------------------------
// Helpers (exported for unit tests)
// ---------------------------------------------------------------------------

export function rectInRange(b, s) {
  const nx = Math.max(b.x, Math.min(s.x, b.x + b.width));
  const ny = Math.max(b.y, Math.min(s.y, b.y + b.height));
  const dx = s.x - nx;
  const dy = s.y - ny;
  return (dx * dx + dy * dy) <= s.r * s.r;
}

export function buildMeasureCacheKey(waypoints, options) {
  let opts = "";
  for (const [k, v] of Object.entries(options ?? {})) {
    if (v !== null && typeof v === "object") return null;
    opts += `${k}=${String(v)};`;
  }
  let h1 = waypoints.length | 0;
  let h2 = 0x9e3779b9;
  for (let i = 0; i < waypoints.length; i++) {
    const w = waypoints[i];
    if (!Number.isFinite(w?.x) || !Number.isFinite(w?.y)) return null;
    h1 = (Math.imul(h1, 33) ^ (w.x | 0)) | 0;
    h2 = (Math.imul(h2, 31) ^ (w.y | 0)) | 0;
    h2 = (h2 ^ Math.round((w.elevation ?? 0) * 8)) | 0;
    if (w.action) h1 = (h1 ^ Math.imul(w.action.length, w.action.charCodeAt(0))) | 0;
    h1 = (h1 + (w.checkpoint ? 1 : 0) + (w.explicit ? 2 : 0) + (w.snapped ? 4 : 0)) | 0;
  }
  const first = waypoints[0];
  const last = waypoints[waypoints.length - 1];
  return `${h1},${h2},${first.x | 0},${first.y | 0},${last.x | 0},${last.y | 0}|${opts}`;
}

function makeTickerThrottle(getMs, statKeys, opts = {}) {
  const st = { last: 0, timerId: null, original: null, lastSelf: null, lastArgs: null, dirty: false };
  const wrapper = function (wrapped, ...args) {
    const ms = getMs();
    if (!ms || !st.original) return wrapped(...args);
    const now = performance.now();
    const elapsed = now - st.last;
    if ((elapsed >= ms) || opts.force?.()) {
      st.last = now;
      st.dirty = false;
      st.lastSelf = null;
      st.lastArgs = null;
      if (st.timerId !== null) {
        clearTimeout(st.timerId);
        st.timerId = null;
      }
      perfStats[statKeys.run]++;
      const result = wrapped(...args);
      opts.onRun?.();
      return result;
    }
    perfStats[statKeys.skip]++;
    st.dirty = true;
    st.lastSelf = this;
    st.lastArgs = args;
    if (st.timerId === null) {
      const delay = Math.max(1, Math.ceil(ms - elapsed));
      st.timerId = setTimeout(() => {
        st.timerId = null;
        const self = st.lastSelf;
        const args2 = st.lastArgs;
        st.lastSelf = null;
        st.lastArgs = null;
        if (!self || !globalThis.canvas?.ready) return;
        st.last = performance.now();
        st.dirty = false;
        perfStats[statKeys.trail]++;
        try {
          st.original.call(self, ...(args2 ?? []));
          opts.onRun?.();
        } catch (err) {
          console.error(`${MODULE_ID} | throttle trailing error:`, err);
        }
      }, delay);
    }
  };
  return {
    wrapper,
    reset: () => {
      if (st.timerId !== null) { clearTimeout(st.timerId); st.timerId = null; }
      st.last = 0;
      st.dirty = false;
      st.lastSelf = null;
      st.lastArgs = null;
    },
    setOriginal: (fn) => { st.original = fn; },
    getOriginal: () => st.original,
    isDirty: () => st.dirty
  };
}

// ---------------------------------------------------------------------------
// 1. RenderFlags deduplication
// ---------------------------------------------------------------------------

function patchRenderFlags() {
  return wrapFoundryMethod("RenderFlags", "set", function (wrapped, changes) {
    if (PERF_CONFIG.perfEnabled && PERF_CONFIG.perfCpuPerception && changes && typeof changes === "object") {
      let allPresent = true;
      for (const k in changes) {
        if (changes[k] && !this.has(k)) {
          allPresent = false;
          break;
        }
      }
      if (allPresent) {
        perfStats.flagsDeduped++;
        return;
      }
    }
    return wrapped(changes);
  });
}

// ---------------------------------------------------------------------------
// 2. Broad-phase visibility pruning + shared LOS cache
// ---------------------------------------------------------------------------

function collectVisionRanges() {
  if (canvas.environment?.globalLightSource?.active) return null;
  const sources = [];
  const lights = [];
  let sawUnboundedLightPerception = false;
  for (const vs of canvas.effects?.visionSources ?? []) {
    if (!vs.active) continue;
    let maxR = vs.data?.radius ?? 0;
    const modes = vs.object?.document?.detectionModes;
    if (modes) {
      for (const [id, m] of Object.entries(modes)) {
        const range = m?.range ?? 0;
        if (range === Infinity) {
          if (id === "lightPerception") { sawUnboundedLightPerception = true; continue; }
          return null;
        }
        if (range > 0 && typeof vs.object?.getLightRadius === "function") {
          const px = vs.object.getLightRadius(range);
          if (px > maxR) maxR = px;
        }
      }
    }
    sources.push({ x: vs.data.x, y: vs.data.y, r: maxR });
  }
  for (const ls of canvas.effects?.lightSources ?? []) {
    if (!ls.active) continue;
    if (ls.data?.vision) sources.push({ x: ls.data.x, y: ls.data.y, r: ls.data.radius ?? 0 });
    if (sawUnboundedLightPerception) lights.push({ x: ls.data.x, y: ls.data.y, r: ls.data.radius ?? 0 });
  }
  return { sources, lights };
}

function pruneOutOfSight() {
  if (!canvas?.visibility?.tokenVision) return;
  const tokens = canvas.tokens?.placeables;
  const notes = canvas.notes?.placeables;
  const totalCandidates = (tokens?.length || 0) + (notes?.length || 0);
  // Skip broad-phase overhead when there are barely any placeables to prune
  if (totalCandidates < 8) return;
  if (game.user?.isGM && !canvas.effects?.visionSources?.some?.(s => s.active)) return;
  let ranges;
  try { ranges = collectVisionRanges(); } catch { return; }
  if (!ranges) return;
  const { sources, lights } = ranges;
  const anyIn = (b, list) => {
    for (let i = 0; i < list.length; i++) if (rectInRange(b, list[i])) return true;
    return false;
  };

  for (const t of canvas.tokens?.placeables ?? []) {
    if (t.visible || t.controlled || t.document?.hidden) continue;
    if (t.isPreview || t._preview?._previewType === "config") continue;
    if (!t.bounds) continue;
    if (anyIn(t.bounds, sources)) continue;
    if (lights.length && anyIn(t.bounds, lights)) continue;
    if (t.renderFlags?.has?.("refreshVisibility")) {
      t.renderFlags.delete("refreshVisibility");
      perfStats.tokensPruned++;
    }
  }
  for (const n of canvas.notes?.placeables ?? []) {
    if (n.visible || n.document?.global || n.controlled) continue;
    if (!n.bounds) continue;
    if (anyIn(n.bounds, sources)) continue;
    if (lights.length && anyIn(n.bounds, lights)) continue;
    if (canvas.fog?.isPointExplored?.({ x: n.document.x, y: n.document.y })) continue;
    if (n.renderFlags?.has?.("refreshVisibility")) {
      n.renderFlags.delete("refreshVisibility");
      perfStats.notesPruned++;
    }
  }
}

function sourceLosSig(vs) {
  const d = vs.data ?? {};
  return `${(vs.x ?? d.x ?? 0).toFixed(1)},${(vs.y ?? d.y ?? 0).toFixed(1)},${d.elevation ?? 0}`
    + `,${vs.radius ?? d.radius ?? 0},${d.angle ?? 360},${d.rotation ?? 0},${d.externalRadius ?? ""}`;
}

function patchVisibilityAndLos() {
  const ok1 = wrapFoundryMethod("CanvasVisibility", "restrictVisibility", function (wrapped, ...args) {
    _perceptionVer++;
    _losCache.clear();
    const res = wrapped(...args);
    if (PERF_CONFIG.perfEnabled && PERF_CONFIG.perfCpuPerception) {
      pruneOutOfSight();
    }
    return res;
  });

  const ok2 = wrapFoundryMethod("DetectionMode", "_testLOS", function (wrapped, visionSource, mode, target, test) {
    if (!PERF_CONFIG.perfEnabled || !PERF_CONFIG.perfCpuPerception || !this.walls) {
      return wrapped(visionSource, mode, target, test);
    }
    const p = test?.point;
    if (!p) return wrapped(visionSource, mode, target, test);
    const key = `${p.x.toFixed(1)},${p.y.toFixed(1)},${(p.elevation ?? 0).toFixed(1)}`
      + `|${test.level?.id ?? ""}|${this.constructor.name}|${this.walls ? 1 : 0}${this.angle ? 1 : 0}`
      + `|${visionSource.sourceId}|${sourceLosSig(visionSource)}`;
    const hit = _losCache.get(key);
    if (hit !== undefined) {
      perfStats.losHits++;
      return hit;
    }
    perfStats.losMisses++;
    const res = wrapped(visionSource, mode, target, test);
    if (_losCache.size >= 10000) _losCache.delete(_losCache.keys().next().value);
    _losCache.set(key, res);
    return res;
  });

  const ok3 = wrapFoundryMethod("CanvasVisibility", "testVisibility", function (wrapped, points, options = {}) {
    if (!PERF_CONFIG.perfEnabled || !PERF_CONFIG.perfCpuPerception || options?.object) {
      return wrapped(points, options);
    }
    const arr = Array.isArray(points) ? points : [points];
    if (arr.length !== 1) return wrapped(points, options);
    const p = arr[0];
    if (!Number.isFinite(p?.x) || !Number.isFinite(p?.y)) return wrapped(points, options);
    const key = `${p.x.toFixed(1)},${p.y.toFixed(1)},${(p.elevation ?? 0).toFixed(1)}|t${options.tolerance ?? 2}|v${_perceptionVer}`;
    const hit = _cellVisCache.get(key);
    if (hit !== undefined) {
      perfStats.cellVisHits++;
      return hit;
    }
    perfStats.cellVisMisses++;
    const res = wrapped(points, options);
    if (_cellVisCache.size >= 5000) _cellVisCache.delete(_cellVisCache.keys().next().value);
    _cellVisCache.set(key, res);
    return res;
  });

  const ok4 = wrapFoundryMethod("FogManager", "isPointExplored", function (wrapped, point) {
    if (!PERF_CONFIG.perfEnabled || !PERF_CONFIG.perfCpuPerception || !Number.isFinite(point?.x) || !Number.isFinite(point?.y)) {
      return wrapped(point);
    }
    const key = `${point.x.toFixed(1)},${point.y.toFixed(1)}|e${_exploredVer}`;
    const hit = _cellExploredCache.get(key);
    if (hit !== undefined) {
      perfStats.cellFogHits++;
      return hit;
    }
    perfStats.cellFogMisses++;
    const res = wrapped(point);
    if (_cellExploredCache.size >= 5000) _cellExploredCache.delete(_cellExploredCache.keys().next().value);
    _cellExploredCache.set(key, res);
    return res;
  });

  return [Boolean(ok1), Boolean(ok2), Boolean(ok3), Boolean(ok4)];
}

// ---------------------------------------------------------------------------
// 3. Fog Commit & Occlusion Throttling + Occlusion Visibility Guard
// ---------------------------------------------------------------------------

function fogVisionMovedFar() {
  const px = 100;
  for (const vs of canvas.effects?.visionSources ?? []) {
    if (!vs.active || vs.isPreview) continue;
    const id = vs.sourceId ?? vs.uuid;
    const x = vs.data?.x ?? vs.x;
    const y = vs.data?.y ?? vs.y;
    const r = vs.radius ?? vs.data?.radius ?? 0;
    const prev = _fogGuardSnap.get(id);
    if (prev === undefined) return true;
    const dx = x - prev.x;
    const dy = y - prev.y;
    if ((dx * dx + dy * dy) >= px * px || r !== prev.r) return true;
  }
  return false;
}

function fogSnapshot() {
  _fogGuardSnap.clear();
  _exploredVer++;
  for (const vs of canvas.effects?.visionSources ?? []) {
    if (!vs.active || vs.isPreview) continue;
    _fogGuardSnap.set(vs.sourceId ?? vs.uuid, {
      x: vs.data?.x ?? vs.x,
      y: vs.data?.y ?? vs.y,
      r: vs.radius ?? vs.data?.radius ?? 0
    });
  }
}

const _fogThrottle = makeTickerThrottle(
  () => (PERF_CONFIG.perfEnabled && PERF_CONFIG.perfFogOcclusionThrottle) ? 50 : 0,
  { run: "fogCommitted", skip: "fogSkipped", trail: "fogTrailing" },
  {
    force: () => {
      if (fogVisionMovedFar()) {
        perfStats.fogGuardCommitted++;
        return true;
      }
      return false;
    },
    onRun: fogSnapshot
  }
);

const _occMaskThrottle = makeTickerThrottle(
  () => (PERF_CONFIG.perfEnabled && PERF_CONFIG.perfFogOcclusionThrottle) ? 33 : 0,
  { run: "occlusionRun", skip: "occlusionSkipped", trail: "occlusionTrailing" }
);

const _occObjThrottle = makeTickerThrottle(
  () => (PERF_CONFIG.perfEnabled && PERF_CONFIG.perfFogOcclusionThrottle) ? 33 : 0,
  { run: "occObjRun", skip: "occObjSkipped", trail: "occObjTrailing" }
);

function patchFogAndOcclusion() {
  const regFog = wrapFoundryMethod("FogManager", "commit", _fogThrottle.wrapper);
  if (regFog) _fogThrottle.setOriginal(regFog.original);

  const regSave = wrapFoundryMethod("FogManager", "save", function (wrapped, ...args) {
    if (PERF_CONFIG.perfEnabled && PERF_CONFIG.perfFogOcclusionThrottle && _fogThrottle.isDirty()) {
      try {
        _fogThrottle.getOriginal()?.call(this);
        fogSnapshot();
        perfStats.fogSaveFlushed++;
      } catch {}
      _fogThrottle.reset();
    }
    return wrapped(...args);
  });

  const regOcc1 = wrapFoundryMethod("CanvasOcclusionMask", "_updateOcclusionMask", _occMaskThrottle.wrapper);
  if (regOcc1) _occMaskThrottle.setOriginal(regOcc1.original);

  const regOcc2 = wrapFoundryMethod("CanvasOcclusionMask", "_updateOccludedObjects", _occObjThrottle.wrapper);
  if (regOcc2) _occObjThrottle.setOriginal(regOcc2.original);

  const regPerc = wrapFoundryMethod("PerceptionManager", "update", function (wrapped, flags) {
    if (
      PERF_CONFIG.perfEnabled &&
      PERF_CONFIG.perfFogOcclusionThrottle &&
      _visGuardToken &&
      flags &&
      flags.refreshOcclusion === true &&
      Object.keys(flags).length === 1 &&
      _visGuardToken.visible === _visGuardWasVisible
    ) {
      perfStats.occlusionGuardSkipped++;
      return;
    }
    return wrapped(flags);
  });

  const regVis = wrapFoundryMethod("Token", "_refreshVisibility", function (wrapped) {
    if (!PERF_CONFIG.perfEnabled || !PERF_CONFIG.perfFogOcclusionThrottle) return wrapped();
    _visGuardToken = this;
    _visGuardWasVisible = this.visible;
    try { return wrapped(); }
    finally { _visGuardToken = null; }
  });

  return [Boolean(regFog), Boolean(regSave), Boolean(regOcc1), Boolean(regOcc2), Boolean(regPerc), Boolean(regVis)];
}

// ---------------------------------------------------------------------------
// 4. Drag Pipeline Coalescing + Measure Memoization + Preview Hover Skip
// ---------------------------------------------------------------------------

function getDragWindowMs() {
  if (!PERF_CONFIG.perfEnabled || !PERF_CONFIG.perfDragCoalesce) return 0;
  // Preserve silky 120–144 Hz responsiveness when drag recalc is fast; only throttle adaptively when heavy
  return Math.min(50, Math.max(6, _dragRecalcMs * 2));
}

function flushDragDestination(forceSync = false) {
  if (_dragQ.timerId !== null && forceSync) {
    clearTimeout(_dragQ.timerId);
    _dragQ.timerId = null;
  }
  const pending = _dragQ.pending;
  if (!pending) return;
  _dragQ.pending = null;
  _dragQ.last = performance.now();
  perfStats.dragDestFlushed++;
  const { token, point, snap } = pending;
  if (token.destroyed || !globalThis.canvas?.ready) return;
  const t0 = performance.now();
  try { token._updateDragDestination(point, { snap }); }
  catch (err) { console.error(`${MODULE_ID} | drag flush error:`, err); }
  _dragRecalcMs = performance.now() - t0;
}

function patchDragAndMovement() {
  const okMove = wrapFoundryMethod("Token", "_onDragLeftMove", function (wrapped, event) {
    const ms = getDragWindowMs();
    const dest = event?.interactionData?.destination;
    if (!ms || !Number.isFinite(dest?.x) || !Number.isFinite(dest?.y)) return wrapped(event);

    const now = performance.now();
    const elapsed = now - _dragQ.last;
    if (elapsed >= ms) {
      _dragQ.last = now;
      _dragQ.pending = null;
      if (_dragQ.timerId !== null) {
        clearTimeout(_dragQ.timerId);
        _dragQ.timerId = null;
      }
      perfStats.dragDestRun++;
      const t0 = performance.now();
      const res = wrapped(event);
      _dragRecalcMs = performance.now() - t0;
      return res;
    }

    try { canvas._onDragCanvasPan(event); } catch {}
    _dragQ.pending = { token: this, point: { x: dest.x, y: dest.y }, snap: !event.shiftKey };
    perfStats.dragDestSkipped++;
    if (_dragQ.timerId === null) {
      const delay = Math.max(1, Math.ceil(ms - elapsed));
      _dragQ.timerId = setTimeout(() => {
        _dragQ.timerId = null;
        flushDragDestination(false);
      }, delay);
    }
  });

  const okFinal = wrapFoundryMethod("Token", "_finalizeDragLeft", function (wrapped, ...args) {
    flushDragDestination(true);
    return wrapped(...args);
  });

  const okMeasure = wrapFoundryMethod("Token", "measureMovementPath", function (wrapped, waypoints, options = {}) {
    if (!PERF_CONFIG.perfEnabled || !PERF_CONFIG.perfDragCoalesce || !Array.isArray(waypoints) || waypoints.length < 2) {
      return wrapped(waypoints, options);
    }
    const key = buildMeasureCacheKey(waypoints, options);
    if (key === null) return wrapped(waypoints, options);
    let cache = _measureCaches.get(this);
    if (!cache) {
      cache = new Map();
      _measureCaches.set(this, cache);
    }
    const hit = cache.get(key);
    if (hit !== undefined) {
      perfStats.measureHits++;
      return hit;
    }
    perfStats.measureRuns++;
    const res = wrapped(waypoints, options);
    if (cache.size >= 4) cache.delete(cache.keys().next().value);
    cache.set(key, res);
    return res;
  });

  const okPos = wrapFoundryMethod("Token", "_refreshPosition", function (wrapped) {
    if (PERF_CONFIG.perfEnabled && PERF_CONFIG.perfDragCoalesce && !this.isInteractable && this.mesh) {
      const { x, y } = this.document;
      if (this.position.x !== x || this.position.y !== y) {
        this.position.set(x, y);
        const center = this.mesh.position = this.center;
        if (this.turnMarker) this.turnMarker.position.set(center.x - x, center.y - y);
        perfStats.emulatedSkipped++;
        return;
      }
    }
    return wrapped();
  });

  return [Boolean(okMove), Boolean(okFinal), Boolean(okMeasure), Boolean(okPos)];
}

// ---------------------------------------------------------------------------
// 5. Text Style Guard, Detection Filter Guard, Light Field Guard, Identical Sweep Skip, EnrichHTML Cache
// ---------------------------------------------------------------------------

function patchMiscCpuGuards() {
  const okNp = wrapFoundryMethod("Token", "_refreshNameplate", function (wrapped) {
    if (!PERF_CONFIG.perfEnabled || !PERF_CONFIG.perfCpuPerception) return wrapped();
    const key = `${this.document?.name}|${this.w}`;
    if (this.__blNpKey === key) {
      perfStats.textSkipped++;
      return;
    }
    this.__blNpKey = key;
    return wrapped();
  });

  const okTt = wrapFoundryMethod("Token", "_refreshTooltip", function (wrapped) {
    if (!PERF_CONFIG.perfEnabled || !PERF_CONFIG.perfCpuPerception) return wrapped();
    const key = `${this._getTooltipText?.()}|${this.w}|${canvas.dimensions?.uiScale}`;
    if (this.__blTtKey === key) {
      perfStats.textSkipped++;
      return;
    }
    this.__blTtKey = key;
    return wrapped();
  });

  const okDet = wrapFoundryMethod("Token", "_renderDetectionFilter", function (wrapped, renderer) {
    if (PERF_CONFIG.perfEnabled && PERF_CONFIG.perfCpuPerception && (!this.visible || this.mesh?.renderable === false)) {
      perfStats.detFilterSkipped++;
      return;
    }
    return wrapped(renderer);
  });

  const okFields = wrapFoundryMethod("LightingLayer", "refreshFields", function (wrapped) {
    if (!PERF_CONFIG.perfEnabled || !PERF_CONFIG.perfCpuPerception || !this.active) return wrapped();
    const s = canvas.dimensions?.uiScale;
    for (const al of this.placeables ?? []) {
      const ls = al.lightSource;
      const sig = ls ? `${ls.active ? 1 : 0}:${ls.updateId ?? 0}|${s}` : `none|${s}`;
      if (_fieldSigs.get(al) === sig) {
        perfStats.lightFieldsSkipped++;
        continue;
      }
      _fieldSigs.set(al, sig);
      al.renderFlags?.set?.({ refreshField: true });
    }
  });

  const sourceInitWrapper = function (wrapped, data = {}, options = {}) {
    if (!PERF_CONFIG.perfEnabled || !PERF_CONFIG.perfCpuPerception) return wrapped(data, options);
    let dataSame = true;
    if (data && !foundry.utils.isEmpty(data)) {
      for (const k of Object.keys(data)) {
        if (JSON.stringify(this.data?.[k]) !== JSON.stringify(data[k])) {
          dataSame = false;
          break;
        }
      }
    }
    const stateSig = `${JSON.stringify(this.blinded ?? "")}|${JSON.stringify(this.suppression ?? "")}`;
    if (!options?.reset && this.shape && dataSame && this.__blSweepV === `${_geometryVersion}|${_edgeVersion}|${stateSig}`) {
      perfStats.sweepSkipped++;
      return this;
    }
    if (this.requiresEdges === true && (!dataSame || options?.reset)) _edgeVersion++;
    perfStats.sweepRun++;
    const result = wrapped(data, options);
    this.__blSweepV = `${_geometryVersion}|${_edgeVersion}|${stateSig}`;
    return result;
  };

  const okSources = ["PointVisionSource", "PointLightSource", "PointDarknessSource"].map((cls) =>
    Boolean(wrapFoundryMethod(cls, "initialize", sourceInitWrapper))
  );

  const okEnrich = wrapFoundryMethod("TextEditor", "enrichHTML", function (wrapped, content, options = {}) {
    if (!PERF_CONFIG.perfEnabled || !PERF_CONFIG.perfEnrichCache || options?.rollData || typeof content !== "string") {
      return wrapped(content, options);
    }
    const o = options ?? {};
    const b = (v, def) => ((v ?? def) ? 1 : 0);
    const key = `${content}|s${b(o.secrets, false)}|d${b(o.documents, true)}`
      + `|l${b(o.links, true)}|e${b(o.embeds, true)}|r${b(o.rolls, true)}`
      + `|c${b(o.custom, true)}|${o.relativeTo?.uuid ?? ""}|${o._embedDepth ?? 0}`;
    const hit = _enrichCache.get(key);
    if (hit !== undefined) {
      perfStats.enrichHits++;
      if (_enrichCache.size > 1) { _enrichCache.delete(key); _enrichCache.set(key, hit); }
      return Promise.resolve(hit);
    }
    perfStats.enrichMisses++;
    const res = wrapped(content, options);
    const store = (val) => {
      if (_enrichCache.size >= 800) _enrichCache.delete(_enrichCache.keys().next().value);
      _enrichCache.set(key, val);
    };
    if (res?.then) res.then(store, () => {});
    else store(res);
    return res;
  }, { staticOnly: true });

  // Cache deterministic Roll.validate(formula) grammar parsing (called heavily on actor sheets & attack activities)
  const okRollVal = wrapFoundryMethod("Roll", "validate", function (wrapped, formula) {
    if (!PERF_CONFIG.perfEnabled || !PERF_CONFIG.perfEnrichCache || typeof formula !== "string" || formula.length > 200) {
      return wrapped(formula);
    }
    const hit = _rollValidateCache.get(formula);
    if (hit !== undefined) {
      perfStats.rollValidateHits++;
      return hit;
    }
    const res = wrapped(formula);
    if (_rollValidateCache.size >= 512) _rollValidateCache.delete(_rollValidateCache.keys().next().value);
    _rollValidateCache.set(formula, res);
    return res;
  }, { staticOnly: true });

  // Skip per-frame uniform/shader animation CPU work for offscreen-culled light sources
  const okLightAnim = wrapFoundryMethod("PointLightSource", "animate", function (wrapped, dt) {
    if (PERF_CONFIG.perfEnabled && PERF_CONFIG.perfAutoCulling) {
      const bgOn = this.background?.renderable !== false && this.background;
      const ilOn = this.illumination?.renderable !== false && this.illumination;
      const coOn = this.coloration?.renderable !== false && this.coloration;
      if ((this.background || this.illumination || this.coloration) && !bgOn && !ilOn && !coOn) {
        perfStats.lightAnimSkipped++;
        return;
      }
    }
    return wrapped(dt);
  });

  return [Boolean(okNp), Boolean(okTt), Boolean(okDet), Boolean(okFields), ...okSources, Boolean(okEnrich), Boolean(okRollVal), Boolean(okLightAnim)];
}

// ---------------------------------------------------------------------------
// 6. Optional Idle FPS Limiter (battery/laptop saver)
// ---------------------------------------------------------------------------

const _idle = { attached: false, last: 0, throttled: false, savedMax: undefined };

function restoreIdleFps() {
  if (!_idle.throttled) return;
  _idle.throttled = false;
  try {
    canvas.app.ticker.maxFPS = _idle.savedMax ?? (game.settings.get("core", "maxFPS") || 0);
  } catch {}
  _idle.savedMax = undefined;
}

function attachIdleFpsLimiter() {
  if (_idle.attached || !globalThis.canvas?.app?.ticker) return;
  _idle.attached = true;
  _idle.last = performance.now();
  const bump = () => {
    _idle.last = performance.now();
    restoreIdleFps();
  };
  window.addEventListener("pointermove", bump, { passive: true });
  window.addEventListener("pointerdown", bump, { passive: true });
  window.addEventListener("wheel", bump, { passive: true });
  window.addEventListener("keydown", bump);
  Hooks.on("sightRefresh", bump);

  canvas.app.ticker.add(() => {
    if (!PERF_CONFIG.perfEnabled || !PERF_CONFIG.perfIdleFpsLimit) {
      restoreIdleFps();
      return;
    }
    if (!_idle.throttled && (performance.now() - _idle.last >= 6000)) {
      _idle.throttled = true;
      _idle.savedMax = canvas.app.ticker.maxFPS;
      perfStats.idleThrottles++;
      canvas.app.ticker.maxFPS = 20;
    }
  });
}

// ---------------------------------------------------------------------------
// Lifecycle Installer
// ---------------------------------------------------------------------------

export function invalidateCpuGeometry() {
  _geometryVersion++;
}

export function resetCpuCaches() {
  _losCache.clear();
  _perceptionVer++;
  _exploredVer++;
  _cellVisCache.clear();
  _cellExploredCache.clear();
  _measureCaches = new WeakMap();
  _fogGuardSnap.clear();
  _dragQ.last = 0;
  _dragQ.pending = null;
  if (_dragQ.timerId !== null) { clearTimeout(_dragQ.timerId); _dragQ.timerId = null; }
  _fogThrottle.reset();
  _occMaskThrottle.reset();
  _occObjThrottle.reset();
}

export function installCpuPerfEngine() {
  if (_cpuInstalled) return;
  _cpuInstalled = true;

  if (globalThis.game?.settings?.get?.("core", "noCanvas")) return;
  if (isAgPerfCoreActive()) {
    console.info(`${MODULE_ID} | AG Perf Core detected; yielding overlapping CPU perception patches.`);
    return;
  }

  patchRenderFlags();
  patchVisibilityAndLos();
  patchFogAndOcclusion();
  patchDragAndMovement();
  patchMiscCpuGuards();

  Hooks.on("canvasReady", () => {
    resetCpuCaches();
    attachIdleFpsLimiter();
  });

  for (const h of ["createWall", "updateWall", "deleteWall", "createRegion", "updateRegion", "deleteRegion", "createLevel", "updateLevel", "deleteLevel", "updateScene"]) {
    Hooks.on(h, () => { _geometryVersion++; });
  }
  for (const h of ["createRegionBehavior", "updateRegionBehavior", "deleteRegionBehavior", "updateToken"]) {
    Hooks.on(h, () => { _measureCaches = new WeakMap(); });
  }

  const lightAddsEdges = (cfg) => Boolean(cfg?.negative || ((cfg?.priority ?? 0) > 0));
  Hooks.on("createLight", (l) => { if (lightAddsEdges(l?.config)) _edgeVersion++; });
  Hooks.on("updateLight", (_l, ch) => { if (ch && "config" in ch) _edgeVersion++; });
  Hooks.on("deleteLight", (l) => { if (lightAddsEdges(l?.config)) _edgeVersion++; });
  Hooks.on("createToken", (t) => { if (t?.light && lightAddsEdges(t.light)) _edgeVersion++; });
  Hooks.on("updateToken", (_t, ch) => { if (ch && "light" in ch) _edgeVersion++; });
  Hooks.on("deleteToken", (t) => { if (t?.light && lightAddsEdges(t.light)) _edgeVersion++; });
}
