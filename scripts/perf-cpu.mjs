import { MODULE_ID } from "./utils.mjs";
import {
  PERF_CONFIG,
  perfStats,
  isAgPerfCoreActive,
  wrapFoundryMethod,
  wrapTargetMethod
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
let _lastLightSig = null;

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
    if (typeof v === "function" || (v !== null && typeof v === "object")) return null;
    opts += `${k}=${String(v)};`;
  }
  const exact = waypoints.length <= 12;
  let exactKey = "";
  let h1 = waypoints.length | 0;
  let h2 = 0x9e3779b9;
  for (let i = 0; i < waypoints.length; i++) {
    const w = waypoints[i];
    if (!Number.isFinite(w?.x) || !Number.isFinite(w?.y)) return null;
    // TerrainData or explicit per-waypoint cost can vary dynamically (difficult terrain / regions) -> skip cache
    if (w.terrain != null || w.cost != null) return null;
    const qx = Math.round(w.x * 16) | 0;
    const qy = Math.round(w.y * 16) | 0;
    const elevUndef = w.elevation === undefined;
    const elevNull = w.elevation === null;
    const qElev = (elevUndef || elevNull) ? 0 : (Math.round(w.elevation * 8) | 0);
    const flags = (w.checkpoint ? 1 : 0) | (w.explicit ? 2 : 0) | (w.snapped ? 4 : 0) | (w.intermediate ? 8 : 0);
    if (exact) {
      const eStr = elevUndef ? "u" : (elevNull ? "n" : String(qElev));
      exactKey += `${qx},${qy},${eStr},${w.action ?? ""},${w.level ?? ""},${w.width ?? ""},${w.height ?? ""},${w.depth ?? ""},${w.shape ?? ""},${flags};`;
    } else {
      h1 = (Math.imul(h1, 33) ^ qx) | 0;
      h2 = (Math.imul(h2, 31) ^ qy) | 0;
      h2 = (Math.imul(h2, 31) ^ (elevUndef ? 0x55aa55aa : (elevNull ? 0x33cc33cc : qElev))) | 0;
      if (w.action) {
        for (let c = 0; c < w.action.length; c++) {
          h1 = (Math.imul(h1, 31) ^ w.action.charCodeAt(c)) | 0;
        }
      }
      if (w.level) {
        for (let c = 0; c < w.level.length; c++) {
          h2 = (Math.imul(h2, 31) ^ w.level.charCodeAt(c)) | 0;
        }
      }
      if (w.width != null) h1 = (Math.imul(h1, 17) ^ Math.round(w.width * 16)) | 0;
      if (w.height != null) h2 = (Math.imul(h2, 17) ^ Math.round(w.height * 16)) | 0;
      if (w.depth != null) h1 = (Math.imul(h1, 13) ^ Math.round(w.depth * 16)) | 0;
      if (w.shape != null) h2 = (Math.imul(h2, 13) ^ (w.shape | 0)) | 0;
      h1 = (h1 + flags) | 0;
    }
  }
  if (exact) return `E:${exactKey}|${opts}`;
  const first = waypoints[0];
  const last = waypoints[waypoints.length - 1];
  return `${h1},${h2},${Math.round(first.x * 16)},${Math.round(first.y * 16)},${Math.round(last.x * 16)},${Math.round(last.y * 16)}|${opts}`;
}

function makeTickerThrottle(methodName, getMs, statKeys, opts = {}) {
  const st = { last: 0, timerId: null, lastSelf: null, lastArgs: null, dirty: false, inTrailing: false };
  const wrapper = function (wrapped, ...args) {
    const ms = getMs();
    if (!ms) return wrapped(...args);
    if (st.inTrailing) {
      st.last = performance.now();
      st.dirty = false;
      const result = wrapped(...args);
      opts.onRun?.();
      return result;
    }
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
        if (!self || !globalThis.canvas?.ready || typeof self[methodName] !== "function") return;
        st.dirty = false;
        perfStats[statKeys.trail]++;
        st.inTrailing = true;
        try {
          self[methodName](...(args2 ?? []));
        } catch (err) {
          console.error(`${MODULE_ID} | throttle trailing error:`, err);
        } finally {
          st.inTrailing = false;
        }
      }, delay);
    }
  };
  return {
    wrapper,
    flush: (targetSelf) => {
      if (st.timerId !== null) { clearTimeout(st.timerId); st.timerId = null; }
      const self = targetSelf || st.lastSelf;
      const args2 = st.lastArgs;
      st.lastSelf = null;
      st.lastArgs = null;
      st.dirty = false;
      if (self && typeof self[methodName] === "function") {
        st.inTrailing = true;
        try {
          self[methodName](...(args2 ?? []));
          return true;
        } finally {
          st.inTrailing = false;
        }
      }
      return false;
    },
    reset: () => {
      if (st.timerId !== null) { clearTimeout(st.timerId); st.timerId = null; }
      st.last = 0;
      st.dirty = false;
      st.inTrailing = false;
      st.lastSelf = null;
      st.lastArgs = null;
    },
    isDirty: () => st.dirty
  };
}

// ---------------------------------------------------------------------------
// 1. RenderFlags deduplication
// ---------------------------------------------------------------------------

const _rfClosureCache = new WeakMap();

function getRenderFlagClosure(flagsDef, key) {
  if (!flagsDef || typeof flagsDef !== "object") return null;
  let map = _rfClosureCache.get(flagsDef);
  if (!map) {
    map = new Map();
    _rfClosureCache.set(flagsDef, map);
  }
  let entry = map.get(key);
  if (entry !== undefined) return entry;
  const rootCfg = flagsDef[key];
  if (!rootCfg) {
    // Unknown flag: must delegate to core so Foundry handles/warns identically
    entry = { unknown: true, addList: null, hasAnyReset: true };
    map.set(key, entry);
    return entry;
  }
  const visited = new Set([key]);
  const stack = [key];
  const addList = [];
  let hasAnyReset = false;
  let hasDeprecated = false;
  while (stack.length) {
    const cur = stack.pop();
    const cfg = flagsDef[cur];
    if (!cfg) {
      hasAnyReset = true;
      continue;
    }
    if (cfg.deprecated) hasDeprecated = true;
    if (cfg.reset?.length > 0) hasAnyReset = true;
    if (!cfg.alias) addList.push(cur);
    const prop = cfg.propagate;
    if (prop?.length) {
      for (let i = 0; i < prop.length; i++) {
        const p = prop[i];
        if (!visited.has(p)) {
          visited.add(p);
          stack.push(p);
        }
      }
    }
  }
  entry = { unknown: false, addList, hasAnyReset, hasDeprecated };
  map.set(key, entry);
  return entry;
}

function patchRenderFlags() {
  return wrapFoundryMethod("RenderFlags", "set", function (wrapped, changes) {
    if (!PERF_CONFIG.perfEnabled || !PERF_CONFIG.perfCpuPerception || !changes || typeof changes !== "object") {
      return wrapped(changes);
    }
    const flagsDef = this.flags;
    if (!flagsDef) return wrapped(changes);

    // Zero-alloc fast path: verify all requested flags are known, non-deprecated, and have no reset clauses;
    // handles both regular and alias flags (e.g. { refresh: true }) without Object.entries() or new Set().
    let hasTruthy = false;
    let needsFallback = false;
    for (const k in changes) {
      if (!changes[k]) continue;
      hasTruthy = true;
      const closure = getRenderFlagClosure(flagsDef, k);
      if (!closure || closure.unknown || closure.hasAnyReset || closure.hasDeprecated) {
        needsFallback = true;
        break;
      }
    }
    if (!hasTruthy) return;
    if (needsFallback) return wrapped(changes);

    let addedAny = false;
    for (const k in changes) {
      if (!changes[k]) continue;
      const addList = getRenderFlagClosure(flagsDef, k).addList;
      for (let i = 0; i < addList.length; i++) {
        const f = addList[i];
        if (!this.has(f)) {
          this.add(f);
          addedAny = true;
        }
      }
    }

    const obj = this.object;
    const pending = obj ? globalThis.canvas?.pendingRenderFlags?.[this.priority] : null;
    if (!addedAny && (!pending || pending.has(obj))) {
      perfStats.flagsDeduped++;
      return;
    }
    if (pending && obj) pending.add(obj);
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
    let maxR = Math.max(vs.data?.radius ?? 0, vs.data?.lightRadius ?? 0, vs.data?.externalRadius ?? 0);
    const modes = vs.object?.document?.detectionModes;
    if (modes) {
      for (const [id, m] of Object.entries(modes)) {
        if (m?.enabled === false) continue;
        const rawRange = m?.range;
        if (rawRange === null || rawRange === Infinity) {
          if (id === "lightPerception") { sawUnboundedLightPerception = true; continue; }
          return null;
        }
        const range = Number(rawRange) || 0;
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
  // On Boundless scenes, virtual GPU lights live in MegaLightBatch rather than canvas.effects.lightSources;
  // include virtual lights within LOS reach of any active vision source so enemies standing under them stay visible.
  if (sawUnboundedLightPerception && sources.length > 0) {
    const lb = globalThis.Boundless?.active ? globalThis.Boundless.lightBatch : null;
    const metaMap = lb?.lightMetaById;
    if (metaMap?.size) {
      const activeLvlId = canvas.level?.id;
      const maxLosSq = 4600 * 4600;
      for (const meta of metaMap.values()) {
        if (!meta || meta.dimPx <= 0) continue;
        if (activeLvlId && meta.levelId && meta.levelId !== activeLvlId) continue;
        let nearVision = false;
        for (let i = 0; i < sources.length; i++) {
          const dx = meta.lx - sources[i].x;
          const dy = meta.ly - sources[i].y;
          if (dx * dx + dy * dy <= maxLosSq) { nearVision = true; break; }
        }
        if (nearVision) lights.push({ x: meta.lx, y: meta.ly, r: meta.dimPx });
      }
    }
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
  const hasActiveVision = Boolean(canvas.effects?.visionSources?.some?.(s => s.active));
  if (game.user?.isGM && !hasActiveVision) {
    // In GM overview (no active vision sources), offscreen/impostor-culled tokens that are already visible
    // don't need redundant Token#_refreshVisibility() runs on every lighting/zoom refresh.
    const activeLvlId = canvas.level?.id;
    for (const t of tokens ?? []) {
      if (!t || t.destroyed || t.renderable || !t.visible || t.controlled || t.isPreview) continue;
      if (t.detectionFilter || t._preview?._previewType === "config") continue;
      if (activeLvlId && t.document?.level && t.document.level !== activeLvlId) continue;
      if (t.renderFlags?.has?.("refreshVisibility")) {
        t.renderFlags.delete("refreshVisibility");
        perfStats.tokensPruned++;
      }
    }
    return;
  }
  let ranges;
  try { ranges = collectVisionRanges(); } catch { return; }
  if (!ranges) return;
  const { sources, lights } = ranges;
  const anyIn = (b, list) => {
    for (let i = 0; i < list.length; i++) if (rectInRange(b, list[i])) return true;
    return false;
  };

  for (const t of canvas.tokens?.placeables ?? []) {
    if (t.visible || t.controlled || t.document?.hidden || t.isOwner || t.document?.testUserPermission?.(game.user, "OBSERVER")) continue;
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
    if (n.visible || n.isPreview || n.document?.global || n.controlled) continue;
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
  const uid = vs.updateId ?? 0;
  const d = vs.data ?? {};
  const vx = vs.x ?? d.x ?? 0;
  const vy = vs.y ?? d.y ?? 0;
  const elev = d.elevation ?? 0;
  const lvlId = vs.level?.id ?? "";
  const angle = d.angle ?? 360;
  const rot = d.rotation ?? 0;
  const rad = vs.radius ?? d.radius ?? 0;
  if (
    vs._blLosSigVer === _perceptionVer &&
    vs._blLosSigUid === uid &&
    vs._blLosSigX === vx &&
    vs._blLosSigY === vy &&
    vs._blLosSigElev === elev &&
    vs._blLosSigLvl === lvlId &&
    vs._blLosSigAngle === angle &&
    vs._blLosSigRot === rot &&
    vs._blLosSigRad === rad &&
    vs._blLosSigStr
  ) {
    return vs._blLosSigStr;
  }
  const sig = `${Math.round(vx * 10)},${Math.round(vy * 10)},${elev}`
    + `,${lvlId},${d.walls !== false ? 1 : 0},${uid}`
    + `,${rad},${angle},${rot},${d.externalRadius ?? ""}`;
  vs._blLosSigVer = _perceptionVer;
  vs._blLosSigUid = uid;
  vs._blLosSigX = vx;
  vs._blLosSigY = vy;
  vs._blLosSigElev = elev;
  vs._blLosSigLvl = lvlId;
  vs._blLosSigAngle = angle;
  vs._blLosSigRot = rot;
  vs._blLosSigRad = rad;
  vs._blLosSigStr = sig;
  return sig;
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
  }, { type: "WRAPPER" });

  const ok2 = wrapFoundryMethod("DetectionMode", "_testLOS", function (wrapped, visionSource, mode, target, test) {
    if (!PERF_CONFIG.perfEnabled || !PERF_CONFIG.perfCpuPerception || !this.walls) {
      return wrapped(visionSource, mode, target, test);
    }
    const p = test?.point;
    if (!p) return wrapped(visionSource, mode, target, test);
    const key = `${Math.round(p.x * 10)},${Math.round(p.y * 10)},${Math.round((p.elevation ?? 0) * 10)}`
      + `|${test.level?.id ?? ""}|${this.constructor.name}:${this.id ?? ""}:${this.type ?? ""}|${this.walls ? 1 : 0}${this.angle ? 1 : 0}`
      + `|${visionSource.sourceId}|${sourceLosSig(visionSource)}`;
    const hit = _losCache.get(key);
    if (hit !== undefined) {
      perfStats.losHits++;
      if (this.angle || (visionSource.data?.angle ?? 360) >= 360) {
        test.los?.set?.(visionSource, hit);
      }
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
    // Fast-path when tokenVision is disabled (e.g. non-vision scenes or GM overview without sight)
    if (!this.tokenVision) return true;
    const isSingleObj = points && !Array.isArray(points);
    if (!isSingleObj && (!Array.isArray(points) || points.length !== 1)) return wrapped(points, options);
    const p = isSingleObj ? points : points[0];
    if (!Number.isFinite(p?.x) || !Number.isFinite(p?.y)) return wrapped(points, options);
    // Avoid polluting _cellVisCache with transient high-frequency mouse cursor coordinates from Canvas##onMouseMove
    if (p === globalThis.canvas?.mousePosition) return wrapped(points, options);
    const elev = p.elevation ?? globalThis.canvas?.level?.elevation?.base ?? 0;
    const key = `${Math.round(p.x * 10)},${Math.round(p.y * 10)},${Math.round(elev * 10)}|${globalThis.canvas?.level?.id ?? ""}|tv1|t${options.tolerance ?? 2}|v${_perceptionVer}|g${_geometryVersion}|e${_edgeVersion}`;
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

  // Prototype-backed visibility test object eliminates per-offset Object.defineProperty + 2 closures in v14 _createVisibilityTestConfig
  class FastVisibilityTest {
    constructor(point, level) {
      this.point = point;
      this.level = level;
      this.los = new Map();
    }
    get elevation() {
      globalThis.foundry?.utils?.logCompatibilityWarning?.("CanvasVisibilityTest#elevation is deprecated. Use CanvasVisibilityTest#point.elevation instead.", { since: 14, until: 16, once: true });
      return this.point.elevation;
    }
    set elevation(v) {
      globalThis.foundry?.utils?.logCompatibilityWarning?.("CanvasVisibilityTest#elevation is deprecated. Use CanvasVisibilityTest#point.elevation instead.", { since: 14, until: 16, once: true });
      this.point.elevation = v;
    }
  }
  const ZERO_OFFSETS = [[0, 0]];
  const TOL2_OFFSETS = [[0, 0], [-2, -2], [-2, 0], [-2, 2], [0, -2], [0, 2], [2, -2], [2, 0], [2, 2]];

  const ok4 = wrapFoundryMethod("CanvasVisibility", "_createVisibilityTestConfig", function (wrapped, points, options = {}) {
    if (!PERF_CONFIG.perfEnabled || !PERF_CONFIG.perfCpuPerception) return wrapped(points, options);
    const pts = Array.isArray(points) ? points : [points];
    const t = options?.tolerance ?? 2;
    const offsets = t === 0 ? ZERO_OFFSETS : (t === 2 ? TOL2_OFFSETS : (t > 0 ? [[0, 0], [-t, -t], [-t, 0], [-t, t], [0, -t], [0, t], [t, -t], [t, 0], [t, t]] : ZERO_OFFSETS));
    const object = options?.object ?? null;
    const rawLevel = options?.level;
    const level = typeof rawLevel === "string"
      ? (globalThis.canvas?.scene?.levels?.get?.(rawLevel) ?? globalThis.canvas?.level)
      : (rawLevel ?? globalThis.canvas?.level);
    const defaultElev = level?.elevation?.bottom ?? 0;
    const tests = [];
    for (let i = 0; i < pts.length; i++) {
      const pt = pts[i];
      if (!pt) continue;
      const px = pt.x;
      const py = pt.y;
      const pe = pt.elevation ?? defaultElev;
      for (let j = 0; j < offsets.length; j++) {
        const off = offsets[j];
        tests.push(new FastVisibilityTest({ x: px + off[0], y: py + off[1], elevation: pe }, level));
      }
    }
    return { object, level, tests };
  });

  // Note: FogManager#isPointExplored is intentionally NOT wrapped — v14's native implementation is an O(1)
  // 3x3 Uint8ClampedArray lookup (~200ns, 0 allocs), which is faster than building string cache keys.
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
  "commit",
  () => (PERF_CONFIG.perfEnabled && PERF_CONFIG.perfFogOcclusionThrottle) ? 50 : 0,
  { run: "fogCommitted", skip: "fogSkipped", trail: "fogTrailing" },
  {
    force: () => {
      // Shared Fog v14 toggles shared containers visible ONLY during synchronous commit()
      const vis = globalThis.canvas?.visibility?.vision;
      if (vis?.sight?.shared?.visible || vis?.light?.mask?.shared?.visible) return true;
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
  "_updateOcclusionMask",
  () => (PERF_CONFIG.perfEnabled && PERF_CONFIG.perfFogOcclusionThrottle) ? 33 : 0,
  { run: "occlusionRun", skip: "occlusionSkipped", trail: "occlusionTrailing" }
);

const _occObjThrottle = makeTickerThrottle(
  "_updateOccludedObjects",
  () => (PERF_CONFIG.perfEnabled && PERF_CONFIG.perfFogOcclusionThrottle) ? 33 : 0,
  { run: "occObjRun", skip: "occObjSkipped", trail: "occObjTrailing" }
);

function patchFogAndOcclusion() {
  const regFog = wrapFoundryMethod("FogManager", "commit", _fogThrottle.wrapper);

  const regSave = wrapFoundryMethod("FogManager", "save", function (wrapped, ...args) {
    if (PERF_CONFIG.perfEnabled && PERF_CONFIG.perfFogOcclusionThrottle && _fogThrottle.isDirty()) {
      try {
        if (_fogThrottle.flush(this)) perfStats.fogSaveFlushed++;
      } catch {}
    }
    return wrapped(...args);
  }, { type: "WRAPPER" });

  const regOcc1 = wrapFoundryMethod("CanvasOcclusionMask", "_updateOcclusionMask", _occMaskThrottle.wrapper);
  const regOcc2 = wrapFoundryMethod("CanvasOcclusionMask", "_updateOccludedObjects", _occObjThrottle.wrapper);

  // Track v14 surfaceExposure changes (roofs/levels) so sourceInitWrapper never skips light/vision recompute.
  // In v14 PerceptionManager.applyRenderFlags clears renderFlags BEFORE calling _updateOccludedSurfaces(flags),
  // mutating args[0] (`flags.initializeLightSources` / `flags.initializeVision`), so check both args[0] and surface set diff!
  const regOccSurf = wrapFoundryMethod("CanvasOcclusionMask", "_updateOccludedSurfaces", function (wrapped, ...args) {
    const prevSet = this.occludedSurfaces ? new Set(this.occludedSurfaces) : null;
    const res = wrapped(...args);
    const nextSet = this.occludedSurfaces;
    let changed = Boolean(args[0]?.initializeLightSources || args[0]?.initializeVision);
    if (!changed && prevSet && nextSet) {
      if (prevSet.size !== nextSet.size) changed = true;
      else {
        for (const s of nextSet) {
          if (!prevSet.has(s)) { changed = true; break; }
        }
      }
    }
    const pf = globalThis.canvas?.perception?.renderFlags;
    if (changed || pf?.has?.("initializeLightSources") || pf?.has?.("initializeVision")) {
      _geometryVersion++;
      _perceptionVer++;
      _losCache.clear();
    }
    return res;
  }, { type: "WRAPPER" });

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
    const prevToken = _visGuardToken;
    const prevWasVisible = _visGuardWasVisible;
    _visGuardToken = this;
    _visGuardWasVisible = this.visible;
    try { return wrapped(); }
    finally {
      _visGuardToken = prevToken;
      _visGuardWasVisible = prevWasVisible;
    }
  }, { type: "WRAPPER" });

  return [Boolean(regFog), Boolean(regSave), Boolean(regOcc1), Boolean(regOcc2), Boolean(regOccSurf), Boolean(regPerc), Boolean(regVis)];
}

// ---------------------------------------------------------------------------
// 4. Drag Pipeline Coalescing + Measure Memoization + Preview Hover Skip
// ---------------------------------------------------------------------------

function getDragWindowMs() {
  if (!PERF_CONFIG.perfEnabled || !PERF_CONFIG.perfDragCoalesce) return 0;
  // Preserve zero-overhead native 144 Hz drag when recalc is fast (< 2.5 ms);
  // engage adaptive coalescing automatically as soon as drag recalc becomes heavy (e.g. live vision+fog on large maps).
  if (_dragRecalcMs < 2.5) return 0;
  return Math.min(50, _dragRecalcMs * 2);
}

function clearDragPending() {
  if (_dragQ.timerId !== null) {
    clearTimeout(_dragQ.timerId);
    _dragQ.timerId = null;
  }
  _dragQ.pending = null;
}

function flushDragDestination(forceSync = false, overrideEvent = null) {
  if (_dragQ.timerId !== null && forceSync) {
    clearTimeout(_dragQ.timerId);
    _dragQ.timerId = null;
  }
  const pending = _dragQ.pending;
  if (!pending) return;
  _dragQ.pending = null;
  _dragQ.last = performance.now();
  const { token, point, snap } = pending;
  if (!token || token.destroyed || !globalThis.canvas?.ready) return;
  if (token.layer?._draggedToken && token.layer._draggedToken !== token) return;
  if (!token.mouseInteractionManager?.interactionData?.contexts) return;
  const ovDest = overrideEvent?.interactionData?.destination;
  const finalPoint = (Number.isFinite(ovDest?.x) && Number.isFinite(ovDest?.y)) ? { x: ovDest.x, y: ovDest.y } : point;
  const finalSnap = overrideEvent ? !overrideEvent.shiftKey : snap;
  perfStats.dragDestFlushed++;
  const t0 = performance.now();
  try { token._updateDragDestination(finalPoint, { snap: finalSnap }); }
  catch (err) { console.error(`${MODULE_ID} | drag flush error:`, err); }
  _dragRecalcMs = performance.now() - t0;
}

function patchDragAndMovement() {
  const okMove = wrapFoundryMethod("Token", "_onDragLeftMove", function (wrapped, event) {
    const dest = event?.interactionData?.destination;
    if (!PERF_CONFIG.perfEnabled || !PERF_CONFIG.perfDragCoalesce || !Number.isFinite(dest?.x) || !Number.isFinite(dest?.y)) {
      return wrapped(event);
    }

    const ms = getDragWindowMs();
    const now = performance.now();
    const elapsed = now - _dragQ.last;
    if (ms === 0 || elapsed >= ms) {
      _dragQ.last = now;
      clearDragPending();
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

  // Flush BEFORE drop / waypoint commits so the final mouse cell is always persisted accurately
  const okDrop = wrapFoundryMethod("Token", "_onDragLeftDrop", function (wrapped, event, ...rest) {
    flushDragDestination(true, event);
    return wrapped(event, ...rest);
  }, { type: "WRAPPER" });

  const okWaypoint = wrapFoundryMethod("Token", "_addDragWaypoint", function (wrapped, ...args) {
    flushDragDestination(true);
    return wrapped(...args);
  }, { type: "WRAPPER" });

  const okRemoveWp = wrapFoundryMethod("Token", "_removeDragWaypoint", function (wrapped, ...args) {
    clearDragPending();
    return wrapped(...args);
  }, { type: "WRAPPER" });

  const okElev = wrapFoundryMethod("Token", "_changeDragElevation", function (wrapped, ...args) {
    flushDragDestination(true);
    return wrapped(...args);
  }, { type: "WRAPPER" });

  // On cancel / finalize, simply cancel any stale pending timer and reset recalc EMA
  const okFinal = wrapFoundryMethod("Token", "_finalizeDragLeft", function (wrapped, ...args) {
    clearDragPending();
    _dragRecalcMs = 0;
    return wrapped(...args);
  }, { type: "WRAPPER" });

  const cloneMeasureResult = (r) => {
    if (!r || typeof r !== "object") return r;
    const out = { ...r };
    if (Array.isArray(r.spaces)) out.spaces = r.spaces.slice();
    if (Array.isArray(r.waypoints)) out.waypoints = r.waypoints.slice();
    return out;
  };

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
      return cloneMeasureResult(hit);
    }
    perfStats.measureRuns++;
    const res = wrapped(waypoints, options);
    if (cache.size >= 4) cache.delete(cache.keys().next().value);
    cache.set(key, cloneMeasureResult(res));
    return res;
  });

  const okPos = wrapFoundryMethod("Token", "_refreshPosition", function (wrapped) {
    if (PERF_CONFIG.perfEnabled && PERF_CONFIG.perfDragCoalesce && !this.isInteractable) {
      const MIM = globalThis.foundry?.canvas?.interaction?.MouseInteractionManager ?? globalThis.MouseInteractionManager;
      if (MIM && typeof MIM.emulateMoveEvent === "function") {
        const origEmulate = MIM.emulateMoveEvent;
        let skipped = false;
        MIM.emulateMoveEvent = () => { skipped = true; };
        try {
          return wrapped();
        } finally {
          MIM.emulateMoveEvent = origEmulate;
          if (skipped) perfStats.emulatedSkipped++;
        }
      }
    }
    return wrapped();
  });

  return [Boolean(okMove), Boolean(okDrop), Boolean(okWaypoint), Boolean(okRemoveWp), Boolean(okElev), Boolean(okFinal), Boolean(okMeasure), Boolean(okPos)];
}

// ---------------------------------------------------------------------------
// 5. Text Style Guard, Detection Filter Guard, Light Field Guard, Identical Sweep Skip, EnrichHTML Cache
// ---------------------------------------------------------------------------

function safeValuesEqual(a, b, depth = 0) {
  if (Object.is(a, b)) return true;
  if (!a || !b || typeof a !== "object" || typeof b !== "object" || depth > 3) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a)) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (!safeValuesEqual(a[i], b[i], depth + 1)) return false;
    return true;
  }
  const ka = Object.keys(a);
  const kb = Object.keys(b);
  if (ka.length !== kb.length) return false;
  for (let i = 0; i < ka.length; i++) {
    const k = ka[i];
    if (!Object.prototype.hasOwnProperty.call(b, k)) return false;
    if (!safeValuesEqual(a[k], b[k], depth + 1)) return false;
  }
  return true;
}

function isCompatibleSourceGeom(g) {
  return Boolean(
    g &&
    !g.destroyed &&
    g.buffers?.length > 0 &&
    g.attributes?.aVertexPosition?.size === 2 &&
    g.attributes?.aDepthValue &&
    typeof g.getIndex === "function" &&
    g.getIndex()
  );
}

const _attachedVisionMeshes = new Set();
const _enrichAllowedKeys = new Set([
  "secrets", "documents", "links", "embeds", "rolls", "custom", "relativeTo", "_embedDepth", "async"
]);

function patchMiscCpuGuards() {
  const okNp = wrapFoundryMethod("Token", "_refreshNameplate", function (wrapped) {
    if (!PERF_CONFIG.perfEnabled || !PERF_CONFIG.perfCpuPerception) return wrapped();
    const docName = this.document?.name ?? "";
    const key = `${docName}|${this.w}|${this.h}|${canvas.dimensions?.uiScale}`;
    if (this.__blNpKey === key && this.__blNpObj === this.nameplate && this.nameplate?.text === this.__blNpText) {
      perfStats.textSkipped++;
      return;
    }
    const res = wrapped();
    this.__blNpKey = key;
    this.__blNpObj = this.nameplate;
    this.__blNpText = this.nameplate?.text;
    return res;
  });

  const okTt = wrapFoundryMethod("Token", "_refreshTooltip", function (wrapped) {
    if (!PERF_CONFIG.perfEnabled || !PERF_CONFIG.perfCpuPerception) return wrapped();
    const text = this._getTooltipText?.() ?? "";
    const key = `${text}|${this.w}|${this.h}|${canvas.dimensions?.uiScale}|${this.tooltip?.y ?? ""}`;
    if (
      this.__blTtKey === key &&
      this.__blTtObj === this.tooltip &&
      this.__blLvlObj === this.levelIndicator &&
      this.tooltip?.text === text
    ) {
      perfStats.textSkipped++;
      return;
    }
    const res = wrapped();
    this.__blTtKey = `${text}|${this.w}|${this.h}|${canvas.dimensions?.uiScale}|${this.tooltip?.y ?? ""}`;
    this.__blTtObj = this.tooltip;
    this.__blLvlObj = this.levelIndicator;
    return res;
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
      // Never cache virtual Boundless lights or lights without an initialized lightSource
      if (!ls || al.document?._mmVirtualLight) {
        _fieldSigs.delete(al);
        al.renderFlags?.set?.({ refreshField: true });
        continue;
      }
      const sig = `${ls.active ? 1 : 0}:${ls.updateId ?? 0}|${s}`;
      if (_fieldSigs.get(al) === sig) {
        perfStats.lightFieldsSkipped++;
        continue;
      }
      _fieldSigs.set(al, sig);
      al.renderFlags?.set?.({ refreshField: true });
    }
  });

  const quickStateSig = (src) => {
    const b = src.blinded;
    const s = src.suppression;
    if (!b && !s) return "";
    let out = "";
    if (b && typeof b === "object") {
      for (const k in b) if (b[k]) out += `b:${k}|`;
    } else if (b) {
      out += `b:${b}|`;
    }
    if (s && typeof s === "object") {
      for (const k in s) if (s[k]) out += `s:${k}|`;
    } else if (s) {
      out += `s:${s}|`;
    }
    return out;
  };

  let _priorityLightVersion = 0;
  let _darknessSourceVersion = 0;

  const sourceInitWrapper = function (wrapped, data = {}, options = {}) {
    if (!PERF_CONFIG.perfEnabled || !PERF_CONFIG.perfCpuPerception) {
      this.__blSweepV = null;
      return wrapped(data, options);
    }
    let dataSame = true;
    if (data) {
      for (const k in data) {
        if (!safeValuesEqual(this.data?.[k], data[k])) {
          dataSame = false;
          break;
        }
      }
    }
    const env = globalThis.canvas?.environment;
    const darkLevel = Number(((env?.darknessLevel ?? 0)).toFixed(4));
    const globalLightActive = env?.globalLightSource?.active ? 1 : 0;
    const darkSrcCount = globalThis.canvas?.effects?.darknessSources?.size || 0;
    const isDarknessSrc = Boolean(this.requiresEdges === true || this.constructor?.name?.includes?.("Darkness"));
    const isPriorityLight = !isDarknessSrc && Boolean((this.data?.priority ?? 0) > 0 || (data?.priority ?? 0) > 0);
    const stateSig = quickStateSig(this);
    // Split priority-light vs darkness versions so multiple darkness sources or multiple Daylight sources
    // never cascade-invalidate each other, while Daylight still invalidates darkness suppression and vice versa.
    const envDep = `${isPriorityLight ? "" : _priorityLightVersion}:${isDarknessSrc ? "" : _darknessSourceVersion}`;
    const curV = `${_geometryVersion}|${_edgeVersion}|${envDep}|${darkLevel}|${globalLightActive}|${darkSrcCount}|${stateSig}`;
    const hasValidGeom = !this.attached || this.data?.disabled || isCompatibleSourceGeom(this._geometry) || Boolean(this._geometry && !this._geometry.destroyed);
    if (!options?.reset && this.shape && hasValidGeom && dataSame && this.__blSweepV === curV) {
      perfStats.sweepSkipped++;
      return this;
    }
    if (this.requiresEdges === true && (!dataSame || options?.reset)) _edgeVersion++;
    const envChanged = this.__blLastDark !== darkLevel || this.__blLastGlobal !== globalLightActive;
    if (!dataSame || options?.reset || envChanged) {
      if (isDarknessSrc) _darknessSourceVersion++;
      else if (isPriorityLight) _priorityLightVersion++;
    }
    perfStats.sweepRun++;
    const result = wrapped(data, options);
    this.__blLastDark = darkLevel;
    this.__blLastGlobal = globalLightActive;
    const postIsDarkness = Boolean(this.requiresEdges === true || this.constructor?.name?.includes?.("Darkness"));
    const postIsPrioLight = !postIsDarkness && Boolean((this.data?.priority ?? 0) > 0);
    const postEnvDep = `${postIsPrioLight ? "" : _priorityLightVersion}:${postIsDarkness ? "" : _darknessSourceVersion}`;
    this.__blSweepV = `${_geometryVersion}|${_edgeVersion}|${postEnvDep}|${darkLevel}|${globalLightActive}|${darkSrcCount}|${quickStateSig(this)}`;
    return result;
  };

  const okSources = ["PointVisionSource", "PointLightSource", "PointDarknessSource"].map((cls) =>
    Boolean(wrapFoundryMethod(cls, "initialize", sourceInitWrapper))
  );

  // Fast PointEffectSource._updateGeometry:
  // 1) Skip full re-triangulation when shape.points, origin, radius, and offset are unchanged (saves 100% of
  //    idle lights on initializeLightSources and lights behind walls during Showstopper animated door sweeps).
  // 2) Replace Foundry's 6-pass scale=1e8 ClipperOffset (which triggers JS Int128 software emulation and builds
  //    up to 6 concentric offset rings on 200 PPI maps) with a single local-coordinate ClipperOffset pass
  //    (strictly inside fast native int range, zero Int128) + earcut.earcutEdges soft-edge strip (7-10x faster,
  //    visual MAE ~0.007-0.03). Includes narrow-slit fallback at 0.35x offset so thin door cracks keep soft light.
  let _sharedOffsetter = null;
  const fastSourceGeometryWrapper = function (wrapped) {
    if (!PERF_CONFIG.perfEnabled || !PERF_CONFIG.perfCpuPerception) {
      this.__blGeomKey = null;
      return wrapped();
    }
    // PointDarknessSource builds its mesh from _visualShape (padded by darknessSourcePaddingMultiplier)
    const shape = this._visualShape ?? this.shape;
    const pts = shape?.points;
    const origin = shape?.origin;
    const radius = shape?.config?.radius ?? 0;
    if (!pts || pts.length < 6 || !origin || !(radius > 0)) {
      this.__blGeomKey = null;
      return wrapped();
    }
    const gridSize = globalThis.canvas?.scene?._source?.grid?.size ?? 100;
    const offset = this._flags?.renderSoftEdges
      ? (this.constructor?.EDGE_OFFSET ?? 0) * (gridSize / 100)
      : 0;
    if (offset > 0) {
      this.__blGeomKey = null;
      return wrapped();
    }

    const existingGeom = this._geometry;
    const geomUsable = isCompatibleSourceGeom(existingGeom);
    // If an existing non-destroyed geometry has an incompatible layout (e.g. interleaved), delegate safely
    if (existingGeom && !existingGeom.destroyed && !geomUsable) {
      this.__blGeomKey = null;
      return wrapped();
    }

    // 1. Exact shape cache check — skip PolygonMesher completely when polygon did not change
    const gKey = `${origin.x}|${origin.y}|${radius}|${offset}|${pts.length}`;
    if (geomUsable && this.__blGeomKey === gKey && this.__blGeomPts?.length === pts.length) {
      const prev = this.__blGeomPts;
      let same = true;
      for (let i = 0; i < pts.length; i++) {
        if (Math.abs(prev[i] - pts[i]) > 1e-4) { same = false; break; }
      }
      if (same) {
        perfStats.geomCacheHits++;
        return;
      }
    }

    // 2. Fast local-coordinate 1-pass soft-edge mesher (falls back cleanly to wrapped() if deps missing)
    const Clipper = globalThis.ClipperLib;
    const pixiEarcut = globalThis.PIXI?.utils?.earcut;
    const edgeEarcut = globalThis.earcut?.earcutEdges;
    if (typeof pixiEarcut !== "function" || (offset !== 0 && !Clipper?.ClipperOffset)) {
      this.__blGeomKey = null;
      return wrapped();
    }

    try {
      const x = origin.x;
      const y = origin.y;
      const invR = 1 / radius;
      const outerN = pts.length >> 1;
      if (outerN > 65530) { this.__blGeomKey = null; return wrapped(); }

      let vBuf, dBuf, idxBuf;
      if (offset === 0) {
        const idx = pixiEarcut(pts, null, 2);
        if (!idx?.length) { this.__blGeomKey = null; return wrapped(); }
        vBuf = new Float32Array(outerN * 2);
        dBuf = new Float32Array(outerN);
        dBuf.fill(1.0);
        for (let i = 0; i < outerN; i++) {
          vBuf[i * 2] = (pts[i * 2] - x) * invR;
          vBuf[i * 2 + 1] = (pts[i * 2 + 1] - y) * invR;
        }
        idxBuf = new Uint16Array(idx);
      } else {
        if (!_sharedOffsetter) _sharedOffsetter = new Clipper.ClipperOffset(7);
        // Local coords centered at (x, y) keep |coord * scale| <= 1e8 << ClipperLib loRange (~1.07e9),
        // completely avoiding slow JS Int128 multiplication while keeping <= 0.0001 px precision.
        const scale = Math.min(10000, Math.max(100, Math.floor(1e8 / Math.max(radius, 1))));
        const invScale = 1 / scale;
        const path = new Clipper.Path(outerN);
        let oMinX = Infinity, oMaxX = -Infinity, oMinY = Infinity, oMaxY = -Infinity;
        for (let i = 0, k = 0; i < pts.length; i += 2, k++) {
          const lx = pts[i] - x;
          const ly = pts[i + 1] - y;
          if (lx < oMinX) oMinX = lx;
          if (lx > oMaxX) oMaxX = lx;
          if (ly < oMinY) oMinY = ly;
          if (ly > oMaxY) oMaxY = ly;
          path[k] = new Clipper.IntPoint(Math.round(lx * scale), Math.round(ly * scale));
        }
        let paths = new Clipper.Paths();
        try {
          _sharedOffsetter.AddPath(path, Clipper.JoinType.jtMiter, Clipper.EndType.etClosedPolygon);
          _sharedOffsetter.Execute(paths, Math.round(offset * scale));
        } finally {
          _sharedOffsetter.Clear();
        }

        // If 1-pass inset collapsed a narrow corridor or doorway slit (< 2 * |offset|) while leaving the main room,
        // the collapsed branch would render at depth = 0 (black beam). Delegate to Foundry's multi-pass PolygonMesher.
        if (paths.length > 0) {
          let iMinX = Infinity, iMaxX = -Infinity, iMinY = Infinity, iMaxY = -Infinity;
          for (let c = 0; c < paths.length; c++) {
            const p = paths[c];
            for (let i = 0; i < p.length; i++) {
              const px = p[i].X * invScale;
              const py = p[i].Y * invScale;
              if (px < iMinX) iMinX = px;
              if (px > iMaxX) iMaxX = px;
              if (py < iMinY) iMinY = py;
              if (py > iMaxY) iMaxY = py;
            }
          }
          const maxShrink = Math.abs(offset) * 3.5;
          if (
            (iMinX - oMinX) > maxShrink ||
            (oMaxX - iMaxX) > maxShrink ||
            (iMinY - oMinY) > maxShrink ||
            (oMaxY - iMaxY) > maxShrink
          ) {
            this.__blGeomKey = null;
            return wrapped();
          }
        }

        let innerDepth = 1.0;
        // Narrow-slit fallback: if full offset collapsed a thin light beam (e.g. door barely ajar),
        // try a 35% inset so the slit keeps a smooth gradient instead of turning fully transparent.
        if (!paths.length) {
          paths = new Clipper.Paths();
          try {
            _sharedOffsetter.AddPath(path, Clipper.JoinType.jtMiter, Clipper.EndType.etClosedPolygon);
            _sharedOffsetter.Execute(paths, Math.round(offset * 0.35 * scale));
          } finally {
            _sharedOffsetter.Clear();
          }
          innerDepth = 0.55;
        }

        let totalVerts = outerN;
        for (let c = 0; c < paths.length; c++) totalVerts += paths[c].length;
        if (totalVerts > 65530) { this.__blGeomKey = null; return wrapped(); }

        const useEdgeEarcut = paths.length > 0 && typeof edgeEarcut === "function";
        const stride = useEdgeEarcut ? 3 : 2;
        const flat = new Float64Array(totalVerts * stride);
        if (useEdgeEarcut) {
          for (let i = 0; i < outerN; i++) {
            const o = i * 3;
            flat[o] = pts[i * 2] - x;
            flat[o + 1] = pts[i * 2 + 1] - y;
            flat[o + 2] = 0.0;
          }
        } else {
          for (let i = 0; i < outerN; i++) {
            flat[i * 2] = pts[i * 2] - x;
            flat[i * 2 + 1] = pts[i * 2 + 1] - y;
          }
        }

        const holes = new Array(paths.length);
        let vp = outerN * stride;
        let vOff = outerN;
        for (let c = 0; c < paths.length; c++) {
          holes[c] = vOff;
          const p = paths[c];
          if (useEdgeEarcut) {
            for (let i = 0; i < p.length; i++) {
              flat[vp++] = p[i].X * invScale;
              flat[vp++] = p[i].Y * invScale;
              flat[vp++] = innerDepth;
            }
          } else {
            for (let i = 0; i < p.length; i++) {
              flat[vp++] = p[i].X * invScale;
              flat[vp++] = p[i].Y * invScale;
            }
          }
          vOff += p.length;
        }

        let outerIdx;
        const innerIdxList = [];
        let totalIdxLen = 0;
        if (paths.length) {
          outerIdx = useEdgeEarcut ? edgeEarcut(flat, holes) : pixiEarcut(flat, holes, 2);
          totalIdxLen = outerIdx.length;
          for (let c = 0; c < paths.length; c++) {
            const p = paths[c];
            const sub = flat.subarray(holes[c] * stride, (holes[c] + p.length) * stride);
            const iIdx = pixiEarcut(sub, null, stride);
            innerIdxList.push(iIdx);
            totalIdxLen += iIdx.length;
          }
        } else {
          outerIdx = pixiEarcut(flat, null, stride);
          totalIdxLen = outerIdx.length;
        }
        if (!totalIdxLen) { this.__blGeomKey = null; return wrapped(); }

        vBuf = new Float32Array(totalVerts * 2);
        dBuf = new Float32Array(totalVerts);
        const fallbackDepth = paths.length ? 0.0 : 0.65;
        if (useEdgeEarcut) {
          for (let i = 0; i < totalVerts; i++) {
            vBuf[i * 2] = flat[i * 3] * invR;
            vBuf[i * 2 + 1] = flat[i * 3 + 1] * invR;
            dBuf[i] = flat[i * 3 + 2];
          }
        } else {
          for (let i = 0; i < totalVerts; i++) {
            vBuf[i * 2] = flat[i * 2] * invR;
            vBuf[i * 2 + 1] = flat[i * 2 + 1] * invR;
            dBuf[i] = i < outerN ? fallbackDepth : innerDepth;
          }
        }
        idxBuf = new Uint16Array(totalIdxLen);
        idxBuf.set(outerIdx, 0);
        let ip = outerIdx.length;
        for (let c = 0; c < innerIdxList.length; c++) {
          const shift = holes[c];
          const arr = innerIdxList[c];
          for (let i = 0; i < arr.length; i++) idxBuf[ip++] = arr[i] + shift;
        }
      }

      if (geomUsable) {
        existingGeom.getBuffer("aVertexPosition").update(vBuf);
        existingGeom.getBuffer("aDepthValue").update(dBuf);
        existingGeom.getIndex().update(idxBuf);
      } else {
        this._geometry = new PIXI.Geometry()
          .addAttribute("aVertexPosition", vBuf, 2)
          .addAttribute("aTextureCoord", [0, 0, 1, 0, 1, 1, 0, 1], 2)
          .addAttribute("aDepthValue", dBuf, 1)
          .addIndex(idxBuf);
      }

      const b = shape.bounds ?? shape.getBounds?.();
      if (b) {
        const bx = (b.x - x) * invR;
        const by = (b.y - y) * invR;
        const bw = b.width * invR;
        const bh = b.height * invR;
        if (this._geometry.bounds) {
          this._geometry.bounds.x = bx;
          this._geometry.bounds.y = by;
          this._geometry.bounds.width = bw;
          this._geometry.bounds.height = bh;
        } else {
          this._geometry.bounds = new PIXI.Rectangle(bx, by, bw, bh);
        }
      }

      this.__blGeomKey = gKey;
      if (!this.__blGeomPts || this.__blGeomPts.length !== pts.length) {
        this.__blGeomPts = new Float64Array(pts.length);
      }
      this.__blGeomPts.set(pts);
      perfStats.geomFastBuilds++;
    } catch {
      this.__blGeomKey = null;
      return wrapped();
    }
  };

  const okGeoms = ["PointLightSource", "PointDarknessSource", "PointVisionSource"].map((cls) =>
    Boolean(wrapFoundryMethod(cls, "_updateGeometry", fastSourceGeometryWrapper))
  );

  // Track dynamic CanvasEdges mutations (e.g. Showstopper animated doors, Boundless Sim-Bubble)
  // so sourceInitWrapper NEVER skips sweep recalculation when edges move without an updateWall hook!
  const CanvasEdgesProto = globalThis.foundry?.canvas?.geometry?.edges?.CanvasEdges?.prototype;
  if (CanvasEdgesProto) {
    for (const m of ["set", "delete", "clear", "refresh", "initialize"]) {
      if (typeof CanvasEdgesProto[m] !== "function") continue;
      wrapTargetMethod(CanvasEdgesProto, m, `CanvasEdges.prototype.${m}`, function (wrapped, ...args) {
        _edgeVersion++;
        _losCache.clear();
        return wrapped(...args);
      });
    }
  }

  const okEnrich = wrapFoundryMethod("TextEditor", "enrichHTML", function (wrapped, content, options = {}) {
    if (!PERF_CONFIG.perfEnabled || !PERF_CONFIG.perfEnrichCache || options?.rollData || typeof content !== "string") {
      return wrapped(content, options);
    }
    const o = options ?? {};
    // Never cache immediate inline rolls [[1d20]] (non-deferred), @Embed, synthetic relativeTo without uuid,
    // or system enrichers [[/...]] tied to a relativeTo document (whose actor/item stats can change)
    if (o.relativeTo && !o.relativeTo.uuid) return wrapped(content, options);
    if (o.rolls !== false && /\[\[(?!\/)/.test(content)) return wrapped(content, options);
    if (o.custom !== false && o.relativeTo && content.includes("[[/")) return wrapped(content, options);
    if (o.embeds !== false && content.includes("@Embed[")) return wrapped(content, options);
    for (const k in o) {
      if (!_enrichAllowedKeys.has(k)) return wrapped(content, options);
    }
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

  // Cache deterministic Roll.validate(formula) grammar parsing (keyed by subclass name for D20Roll/DamageRoll)
  const okRollVal = wrapFoundryMethod("Roll", "validate", function (wrapped, formula) {
    if (!PERF_CONFIG.perfEnabled || !PERF_CONFIG.perfEnrichCache || typeof formula !== "string" || formula.length > 200) {
      return wrapped(formula);
    }
    const key = `${this?.name ?? "Roll"}|${formula}`;
    const hit = _rollValidateCache.get(key);
    if (hit !== undefined) {
      perfStats.rollValidateHits++;
      return hit;
    }
    const res = wrapped(formula);
    if (_rollValidateCache.size >= 512) _rollValidateCache.delete(_rollValidateCache.keys().next().value);
    _rollValidateCache.set(key, res);
    return res;
  }, { staticOnly: true });

  // Skip per-frame uniform/shader animation CPU work for offscreen-culled light sources
  const okLightAnim = wrapFoundryMethod("PointLightSource", "animate", function (wrapped, dt) {
    if (PERF_CONFIG.perfEnabled && PERF_CONFIG.perfAutoCulling) {
      const bg = this.layers?.background?.mesh;
      const il = this.layers?.illumination?.mesh;
      const co = this.layers?.coloration?.mesh;
      const bgOn = bg && bg.renderable !== false;
      const ilOn = il && il.renderable !== false;
      const coOn = co && co.renderable !== false;
      if ((bg || il || co) && !bgOn && !ilOn && !coOn) {
        perfStats.lightAnimSkipped++;
        return;
      }
    }
    return wrapped(dt);
  });

  // Safe partial lighting rebuild: when only vision sources moved on a light-heavy standard scene (>= 16 lights),
  // rebuild only the vision branch instead of clearing & re-adding all 50-150 static light meshes every step.
  const sourceHasLayerReset = (s) => {
    const layers = s.layers;
    if (!layers) return false;
    for (const k in layers) if (layers[k]?.reset) return true;
    return false;
  };

  const computeLightsOnlySig = (effects) => {
    const ls = effects.lightSources;
    const ds = effects.darknessSources;
    if (!ls || ls.size < 16) return null;
    const gls = canvas.environment?.globalLightSource;
    if (gls && sourceHasLayerReset(gls)) return null;
    let hasActiveVision = 0;
    if (ds?.size) {
      for (const vs of effects.visionSources ?? []) {
        if (vs.active) { hasActiveVision = 1; break; }
      }
    }
    let sig = `${ls.size}|${ds?.size ?? 0}|${canvas.environment?.darknessLevel ?? ""}|${gls?.active ? 1 : 0}:${gls?.updateId ?? 0}|v${hasActiveVision}`;
    const lv = canvas.visibility?.lightingVisibility;
    if (lv) sig += `|${lv.background},${lv.illumination},${lv.coloration},${lv.darkness}`;
    for (const s of ls) {
      if (sourceHasLayerReset(s)) return null;
      const d = s.data;
      const lb = s.layers?.background;
      const li = s.layers?.illumination;
      const lc = s.layers?.coloration;
      sig += `;${s.sourceId ?? ""}:${s.active ? 1 : 0}:${s.updateId ?? 0}:${d?.color ?? ""}:${d?.alpha ?? ""}:${d?.luminosity ?? ""}:${d?.attenuation ?? ""}:${d?.coloration ?? ""}:${d?.elevation ?? ""}:${d?.contrast ?? ""}:${d?.saturation ?? ""}:${d?.shadows ?? ""}:${d?.animation?.type ?? ""}:${lb?.active ? 1 : 0}:${li?.active ? 1 : 0}:${lc?.active ? 1 : 0}:${lb?.mesh?.shader?.program?.id ?? ""}:${li?.mesh?.shader?.program?.id ?? ""}:${lc?.mesh?.shader?.program?.id ?? ""}`;
    }
    if (ds) {
      for (const s of ds) {
        if (sourceHasLayerReset(s)) return null;
        const d = s.data;
        const ld = s.layers?.darkness;
        sig += `;D${s.sourceId ?? ""}:${s.active ? 1 : 0}:${s.updateId ?? 0}:${d?.color ?? ""}:${d?.alpha ?? ""}:${d?.luminosity ?? ""}:${d?.elevation ?? ""}:${d?.animation?.type ?? ""}:${ld?.active ? 1 : 0}:${ld?.mesh?.shader?.program?.id ?? ""}`;
      }
    }
    return sig;
  };

  let _expectedNonVisionCounts = null;
  const countNonVisionChildren = (effects) => {
    let attachedIl = 0;
    let attachedCo = 0;
    const ilLights = effects.illumination?.lights;
    const co = effects.coloration;
    for (const m of _attachedVisionMeshes) {
      if (!m || m.destroyed) continue;
      if (m.parent === ilLights) attachedIl++;
      else if (m.parent === co) attachedCo++;
    }
    return {
      bg: effects.background?.lighting?.children?.length ?? 0,
      il: (ilLights?.children?.length ?? 0) - attachedIl,
      co: (co?.children?.length ?? 0) - attachedCo
    };
  };

  const okClearFx = wrapFoundryMethod("EffectsCanvasGroup", "clearEffects", function (wrapped) {
    _lastLightSig = null;
    _expectedNonVisionCounts = null;
    _attachedVisionMeshes.clear();
    return wrapped();
  }, { type: "WRAPPER" });

  const okPartialLight = wrapFoundryMethod("EffectsCanvasGroup", "refreshLighting", function (wrapped) {
    if (!PERF_CONFIG.perfEnabled || !PERF_CONFIG.perfCpuPerception || globalThis.Boundless?.active) {
      _lastLightSig = null;
      _expectedNonVisionCounts = null;
      _attachedVisionMeshes.clear();
      return wrapped();
    }
    const sig = computeLightsOnlySig(this);
    const counts = sig && _expectedNonVisionCounts ? countNonVisionChildren(this) : null;
    const countsMatch = Boolean(
      counts &&
      counts.bg === _expectedNonVisionCounts.bg &&
      counts.il === _expectedNonVisionCounts.il &&
      counts.co === _expectedNonVisionCounts.co
    );
    if (sig && sig === _lastLightSig && countsMatch && this.background?.vision && this.illumination?.lights && this.coloration) {
      try {
        const { background, illumination, coloration } = this;
        if (illumination.filter) illumination.filter.uniforms.replacementColor = canvas.colors.background.rgb;
        if (illumination.darknessLevelMeshes?.clearColor && illumination.darknessLevelMeshes.clearColor[0] !== canvas.environment.darknessLevel) {
          illumination.darknessLevelMeshes.clearColor[0] = canvas.environment.darknessLevel;
          illumination.invalidateDarknessLevelContainer?.(true);
        }
        const v = canvas.visibility?.filter;
        if (v) {
          v.uniforms.visionTexture = canvas.masks.vision.renderTexture;
          v.uniforms.primaryTexture = canvas.primary.renderTexture;
          canvas.colors.fogExplored.applyRGB(v.uniforms.exploredColor);
          canvas.colors.fogUnexplored.applyRGB(v.uniforms.unexploredColor);
          canvas.colors.background.applyRGB(v.uniforms.backgroundColor);
        }
        background.vision.removeChildren();
        background.visionPreferred.removeChildren();
        // Remove all vision meshes attached during the previous rebuild so deselected/deleted tokens never stick
        for (const prevMesh of _attachedVisionMeshes) {
          if (prevMesh && !prevMesh.destroyed && prevMesh.parent) {
            prevMesh.parent.removeChild(prevMesh);
          }
        }
        _attachedVisionMeshes.clear();
        for (const vs of this.visionSources) {
          if (!vs.active || (vs.radius <= 0)) continue;
          const meshes = vs.drawMeshes?.() ?? {};
          if (meshes.background) {
            (vs.preferred ? background.visionPreferred : background.vision).addChild(meshes.background);
          }
          if (meshes.illumination) {
            illumination.lights.addChild(meshes.illumination);
            _attachedVisionMeshes.add(meshes.illumination);
          }
          if (meshes.coloration) {
            coloration.addChild(meshes.coloration);
            _attachedVisionMeshes.add(meshes.coloration);
          }
        }
        if (background.vision.filter) background.vision.filter.enabled = background.vision.children.length > 0;
        if (background.visionPreferred.filter) background.visionPreferred.filter.enabled = background.visionPreferred.children.length > 0;
        const lightingOptions = canvas.visibility?.visionModeData?.activeLightingOptions ?? {};
        background.vision.visible = background.vision.children.length > 0;
        background.visionPreferred.visible = background.visionPreferred.children.length > 0;
        background.lighting.visible = (background.lighting.children.length > 0)
          || (lightingOptions.background?.postProcessingModes?.length > 0);
        coloration.visible = (coloration.children.length > 1)
          || (lightingOptions.coloration?.postProcessingModes?.length > 0);
        perfStats.lightingPartialRebuilds++;
        Hooks.callAll("lightingRefresh", this);
        // If a third-party lightingRefresh hook injected custom children, force a clean full rebuild next time
        if (_expectedNonVisionCounts) {
          const afterCounts = countNonVisionChildren(this);
          if (
            afterCounts.bg !== _expectedNonVisionCounts.bg ||
            afterCounts.il !== _expectedNonVisionCounts.il ||
            afterCounts.co !== _expectedNonVisionCounts.co
          ) {
            _expectedNonVisionCounts = null;
          }
        }
        return;
      } catch {
        _lastLightSig = null;
        _expectedNonVisionCounts = null;
        _attachedVisionMeshes.clear();
      }
    }
    _attachedVisionMeshes.clear();
    const res = wrapped();
    // Record vision meshes attached by the full core refresh so the next partial rebuild cleans them up
    for (const vs of this.visionSources ?? []) {
      const il = vs.layers?.illumination?.mesh;
      const co = vs.layers?.coloration?.mesh;
      if (il && il.parent) _attachedVisionMeshes.add(il);
      if (co && co.parent) _attachedVisionMeshes.add(co);
    }
    // Recompute signature AFTER wrapped() so lights whose layer.reset just cleared can hit partial rebuild on the next tick
    _lastLightSig = computeLightsOnlySig(this);
    _expectedNonVisionCounts = _lastLightSig ? countNonVisionChildren(this) : null;
    return res;
  });

  return [Boolean(okNp), Boolean(okTt), Boolean(okDet), Boolean(okFields), ...okSources, ...okGeoms, Boolean(okEnrich), Boolean(okRollVal), Boolean(okLightAnim), Boolean(okClearFx), Boolean(okPartialLight)];
}

// ---------------------------------------------------------------------------
// 5b. Edge Y-AABB Pruning + O(k) Quadtree#remove & Zero-Alloc Quadtree#getObjects
// ---------------------------------------------------------------------------

function patchGeometryStructures() {
  const results = [];

  // 1. Edge.identifyEdgeIntersections: v14 sweeps by X but omits Y-AABB check, causing distant edges at different Y to call getIntersection
  const EdgeCls = globalThis.foundry?.canvas?.geometry?.edges?.Edge;
  if (EdgeCls && typeof EdgeCls.identifyEdgeIntersections === "function") {
    results.push(wrapTargetMethod(EdgeCls, "identifyEdgeIntersections", "Edge.identifyEdgeIntersections", function (wrapped, edges, levelId) {
      if (!PERF_CONFIG.perfEnabled || !PERF_CONFIG.perfCpuPerception) return wrapped(edges, levelId);
      const arr = Array.from(edges);
      const n = arr.length;
      if (n < 2) return;
      arr.sort((a, b) => a.nw.x - b.nw.x);
      for (let i = 0; i < n; i++) {
        const e1 = arr[i];
        const e1MaxX = e1.se.x;
        const e1MinY = e1.nw.y;
        const e1MaxY = e1.se.y;
        const a1x = e1.a.x, a1y = e1.a.y, b1x = e1.b.x, b1y = e1.b.y;
        for (let j = i + 1; j < n; j++) {
          const e2 = arr[j];
          if (e2.nw.x > e1MaxX) break;
          // Y-interval rejection (missing in v14 core)
          if (e2.nw.y > e1MaxY || e2.se.y < e1MinY) continue;
          // Fast shared-endpoint rejection without Point#equals call overhead
          const a2x = e2.a.x, a2y = e2.a.y, b2x = e2.b.x, b2y = e2.b.y;
          if ((a1x === a2x && a1y === a2y) || (a1x === b2x && a1y === b2y) || (b1x === a2x && b1y === a2y) || (b1x === b2x && b1y === b2y)) continue;
          e1.recordIntersections(e2, levelId);
        }
      }
    }));
  }

  // 2. Quadtree#remove (O(k) via root entry Map instead of full-tree walk) + zero-alloc Quadtree#getObjects
  const QT = globalThis.foundry?.canvas?.geometry?.Quadtree ?? globalThis.Quadtree;
  if (QT?.prototype) {
    const okIns = wrapTargetMethod(QT.prototype, "insert", "Quadtree.prototype.insert", function (wrapped, obj) {
      const res = wrapped(obj);
      if (this.depth === 0 && obj?.t !== undefined) {
        if (!this._blEntries) this._blEntries = new Map();
        this._blEntries.set(obj.t, obj);
      }
      return res;
    });

    const okRem = wrapTargetMethod(QT.prototype, "remove", "Quadtree.prototype.remove", function (wrapped, target) {
      if (PERF_CONFIG.perfEnabled && PERF_CONFIG.perfCpuPerception && this.depth === 0 && this._blEntries) {
        const entry = this._blEntries.get(target);
        if (entry) {
          this._blEntries.delete(target);
          if (entry.n?.size) {
            for (const leaf of entry.n) {
              const arr = leaf.objects;
              const idx = arr.indexOf(entry);
              if (idx !== -1) arr.splice(idx, 1);
            }
            entry.n.clear();
          }
          return this;
        }
      }
      if (this.depth === 0 && this._blEntries) this._blEntries.delete(target);
      return wrapped(target);
    });

    const okClr = wrapTargetMethod(QT.prototype, "clear", "Quadtree.prototype.clear", function (wrapped) {
      if (this._blEntries) this._blEntries.clear();
      return wrapped();
    });

    const okGet = wrapTargetMethod(QT.prototype, "getObjects", "Quadtree.prototype.getObjects", function (wrapped, rect, opts = {}) {
      if (!PERF_CONFIG.perfEnabled || !PERF_CONFIG.perfCpuPerception || !rect || !this.bounds || opts._s) {
        return wrapped(rect, opts);
      }
      const out = new Set();
      const test = opts.collisionTest || null;
      const rx = rect.x;
      const ry = rect.y;
      const rr = rx + rect.width;
      const rb = ry + rect.height;
      // Attach rect briefly only if collisionTest expects (o, rect); fallback-safe via closure-free helper
      const visit = (node) => {
        const objs = node.objects;
        for (let i = 0, len = objs.length; i < len; i++) {
          const o = objs[i];
          if (out.has(o.t)) continue;
          if (!test || test(o, rect)) out.add(o.t);
        }
        const subs = node.nodes;
        if (!subs || subs.length === 0) return;
        const midX = node.bounds.x + node.bounds.width * 0.5;
        const midY = node.bounds.y + node.bounds.height * 0.5;
        const top = ry < midY;
        const bottom = rb >= midY;
        const left = rx < midX;
        const right = rr >= midX;
        if (right && top && subs[0]) visit(subs[0]);
        if (left && top && subs[1]) visit(subs[1]);
        if (left && bottom && subs[2]) visit(subs[2]);
        if (right && bottom && subs[3]) visit(subs[3]);
      };
      visit(this);
      return out;
    });

    results.push(okIns, okRem, okClr, okGet);
  }

  return results;
}

// ---------------------------------------------------------------------------
// 6. Optional Idle FPS Limiter (battery/laptop saver)
// ---------------------------------------------------------------------------

const _idle = { listenersAttached: false, ticker: null, tickerFn: null, last: 0, throttled: false, savedMax: undefined };

function restoreIdleFps() {
  if (!_idle.throttled) return;
  _idle.throttled = false;
  try {
    const settingMax = _idle.savedMax !== undefined ? _idle.savedMax : (game.settings.get("core", "maxFPS") || 0);
    const ticker = globalThis.canvas?.app?.ticker;
    if (ticker) ticker.maxFPS = settingMax;
  } catch {}
  _idle.savedMax = undefined;
}

export function syncIdleFpsLimiter() {
  if (PERF_CONFIG.perfEnabled && PERF_CONFIG.perfIdleFpsLimit) {
    attachIdleFpsLimiter();
  } else {
    restoreIdleFps();
    if (_idle.ticker && _idle.tickerFn) {
      try { _idle.ticker.remove(_idle.tickerFn); } catch {}
      _idle.ticker = null;
      _idle.tickerFn = null;
    }
  }
}

function attachIdleFpsLimiter() {
  if (!PERF_CONFIG.perfEnabled || !PERF_CONFIG.perfIdleFpsLimit) return;
  const ticker = globalThis.canvas?.app?.ticker;
  if (!ticker) return;
  if (!_idle.listenersAttached) {
    _idle.listenersAttached = true;
    _idle.last = performance.now();
    const bump = () => {
      if (!PERF_CONFIG.perfEnabled || !PERF_CONFIG.perfIdleFpsLimit) return;
      _idle.last = performance.now();
      restoreIdleFps();
    };
    window.addEventListener("pointermove", bump, { passive: true });
    window.addEventListener("pointerdown", bump, { passive: true });
    window.addEventListener("wheel", bump, { passive: true });
    window.addEventListener("keydown", bump);
    window.addEventListener("focus", bump);
    if (typeof document !== "undefined") {
      document.addEventListener("visibilitychange", () => {
        if (!document.hidden) bump();
      });
    }
    Hooks.on("sightRefresh", bump);
    Hooks.on("canvasPan", bump);
  }
  if (_idle.ticker === ticker) return;
  if (_idle.ticker && _idle.tickerFn) {
    try { _idle.ticker.remove(_idle.tickerFn); } catch {}
  }
  _idle.ticker = ticker;
  _idle.tickerFn = () => {
    if (!PERF_CONFIG.perfEnabled || !PERF_CONFIG.perfIdleFpsLimit) {
      restoreIdleFps();
      return;
    }
    if (!_idle.throttled && (performance.now() - _idle.last >= 6000)) {
      const curMax = ticker.maxFPS || 0;
      if (curMax > 0 && curMax <= 20) return;
      _idle.throttled = true;
      _idle.savedMax = curMax;
      perfStats.idleThrottles++;
      ticker.maxFPS = 20;
    }
  };
  ticker.add(_idle.tickerFn);
}

// ---------------------------------------------------------------------------
// Lifecycle Installer
// ---------------------------------------------------------------------------

let _fogExploredTarget = null;
const _onFogExplored = () => {
  _exploredVer++;
  _cellExploredCache.clear();
};

function bindFogExploredListener() {
  if (_fogExploredTarget && _fogExploredTarget !== globalThis.canvas?.fog) {
    try { _fogExploredTarget.removeEventListener("explored", _onFogExplored); } catch {}
    _fogExploredTarget = null;
  }
  const fog = globalThis.canvas?.fog;
  if (fog && typeof fog.addEventListener === "function" && _fogExploredTarget !== fog) {
    fog.addEventListener("explored", _onFogExplored);
    _fogExploredTarget = fog;
  }
}

export function invalidateCpuGeometry() {
  _geometryVersion++;
}

export function resetCpuCaches() {
  _losCache.clear();
  _perceptionVer++;
  _exploredVer++;
  _cellVisCache.clear();
  _cellExploredCache.clear();
  _enrichCache.clear();
  _measureCaches = new WeakMap();
  _fogGuardSnap.clear();
  _lastLightSig = null;
  _attachedVisionMeshes.clear();
  _dragQ.last = 0;
  clearDragPending();
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
  patchGeometryStructures();

  Hooks.on("initializeVisionMode", () => { _lastLightSig = null; });
  Hooks.on("canvasReady", () => {
    resetCpuCaches();
    bindFogExploredListener();
    syncIdleFpsLimiter();
  });
  Hooks.on("canvasTearDown", () => {
    if (_fogExploredTarget) {
      try { _fogExploredTarget.removeEventListener("explored", _onFogExplored); } catch {}
      _fogExploredTarget = null;
    }
    resetCpuCaches();
    restoreIdleFps();
  });

  for (const h of ["createWall", "updateWall", "deleteWall", "createRegion", "updateRegion", "deleteRegion", "createLevel", "updateLevel", "deleteLevel", "updateScene"]) {
    Hooks.on(h, () => {
      _geometryVersion++;
      _perceptionVer++;
      _losCache.clear();
      _cellVisCache.clear();
      if (h === "updateScene" || h === "updateLevel" || h === "createLevel" || h === "deleteLevel") {
        _exploredVer++;
        _cellExploredCache.clear();
      }
    });
  }
  for (const h of ["lightingRefresh", "visibilityRefresh", "initializeVisionSources", "createActiveEffect", "updateActiveEffect", "deleteActiveEffect"]) {
    Hooks.on(h, () => {
      _perceptionVer++;
      _cellVisCache.clear();
      if (h !== "lightingRefresh" && h !== "visibilityRefresh") _losCache.clear();
    });
  }
  for (const h of ["createWall", "updateWall", "deleteWall", "updateScene", "updateLevel", "createRegion", "updateRegion", "deleteRegion", "createRegionBehavior", "updateRegionBehavior", "deleteRegionBehavior", "createToken", "updateToken", "deleteToken", "controlToken", "updateActor", "updateActiveEffect", "createActiveEffect", "deleteActiveEffect", "updateSetting"]) {
    Hooks.on(h, () => { _measureCaches = new WeakMap(); });
  }
  Hooks.on("updateActor", (_doc, changes) => {
    // Do not wipe the entire enrichHTML cache on routine HP/resource ticks during combat
    if (changes && ("name" in changes || "img" in changes || "ownership" in changes)) {
      _enrichCache.clear();
    }
  });
  for (const h of ["deleteActor", "createItem", "updateItem", "deleteItem", "createActiveEffect", "updateActiveEffect", "deleteActiveEffect", "updateJournalEntry", "updateJournalEntryPage", "deleteJournalEntry", "updateScene", "updateMacro", "updateRollTable", "updateUser"]) {
    Hooks.on(h, () => { _enrichCache.clear(); });
  }

  const lightAddsEdges = (cfg) => Boolean(cfg?.negative || ((cfg?.priority ?? 0) > 0));
  const posOrCfgChanged = (ch) => Boolean(ch && ("config" in ch || "x" in ch || "y" in ch || "hidden" in ch || "elevation" in ch || "rotation" in ch || "level" in ch));
  Hooks.on("createAmbientLight", (l) => { if (lightAddsEdges(l?.config)) _edgeVersion++; });
  Hooks.on("updateAmbientLight", (l, ch) => { if (ch && ("config" in ch || (lightAddsEdges(l?.config) && posOrCfgChanged(ch)))) _edgeVersion++; });
  Hooks.on("deleteAmbientLight", (l) => { if (lightAddsEdges(l?.config)) _edgeVersion++; });
  Hooks.on("createToken", (t) => { if (t?.light && lightAddsEdges(t.light)) _edgeVersion++; });
  Hooks.on("updateToken", (t, ch) => { if (ch && ("light" in ch || (t?.light && lightAddsEdges(t.light) && posOrCfgChanged(ch)))) _edgeVersion++; });
  Hooks.on("deleteToken", (t) => { if (t?.light && lightAddsEdges(t.light)) _edgeVersion++; });
}
