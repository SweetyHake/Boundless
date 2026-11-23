import { MODULE_ID } from "./utils.mjs";

/**
 * Shared safe method-patching utility and live diagnostics registry
 * for the Boundless zero-config Performance Engine (Foundry VTT v14+).
 *
 * Uses `libWrapper` when installed and active; falls back cleanly to direct
 * prototype/static wrapping with original-reference tracking when absent.
 */

const DIRECT_WRAPPED = new WeakMap();

export const PERF_CONFIG = {
  // Master switch
  perfEnabled: true,

  // GPU Render Engine (Prime Performance class)
  perfTokenUiBatching: true,
  perfTokenUiCache: true,
  perfWallSprites: true,
  perfControlIconCache: true,
  perfLightShaders: true,
  perfLightingScale: "auto", // "auto" | "full" | "balanced" | "performance"
  perfDisableUiBlur: false,

  // CPU & Perception Engine
  perfCpuPerception: true,
  perfDragCoalesce: true,
  perfFogOcclusionThrottle: true,
  perfEnrichCache: true,
  perfIdleFpsLimit: false,

  // Standard Scene Auto-Optimizer
  perfAutoCulling: true,
  perfVramCleanup: true,
  perfIdleLevelPrewarm: true,
  perfHeavySceneHint: true
};

export const perfStats = {
  // GPU
  tokenBatchedFrames: 0,
  tokenCulledUi: 0,
  tokenBarsCached: 0,
  tokenEffectsCached: 0,
  wallSpritesUpdated: 0,
  controlIconsBatched: 0,
  lightShadersOptimized: 0,

  // CPU
  flagsDeduped: 0,
  tokensPruned: 0,
  notesPruned: 0,
  losHits: 0,
  losMisses: 0,
  cellVisHits: 0,
  cellVisMisses: 0,
  cellFogHits: 0,
  cellFogMisses: 0,
  fogCommitted: 0,
  fogSkipped: 0,
  fogTrailing: 0,
  fogGuardCommitted: 0,
  fogSaveFlushed: 0,
  occlusionRun: 0,
  occlusionSkipped: 0,
  occlusionTrailing: 0,
  occObjRun: 0,
  occObjSkipped: 0,
  occObjTrailing: 0,
  occlusionGuardSkipped: 0,
  textSkipped: 0,
  sweepSkipped: 0,
  sweepRun: 0,
  detFilterSkipped: 0,
  enrichHits: 0,
  enrichMisses: 0,
  dragDestRun: 0,
  dragDestSkipped: 0,
  dragDestFlushed: 0,
  measureHits: 0,
  measureRuns: 0,
  emulatedSkipped: 0,
  lightFieldsSkipped: 0,
  idleThrottles: 0,

  // Auto-optimizer (standard scenes)
  autoCulledTiles: 0,
  autoCulledLights: 0,
  autoCulledSounds: 0,
  vramTexturesDisposed: 0,
  vramBytesFreed: 0,
  standardLevelsPrewarmed: 0
};

export const activePatches = new Map();

export function resetPerfStats() {
  for (const k of Object.keys(perfStats)) perfStats[k] = 0;
}

export function isPrimePerfActive() {
  return Boolean(globalThis.game?.modules?.get?.("fvtt-perf-optim")?.active);
}

export function isAgPerfCoreActive() {
  return Boolean(globalThis.game?.modules?.get?.("ag-perf-core")?.active);
}

export function resolveFoundryClass(className) {
  const roots = [];
  if (globalThis.foundry) {
    for (const [topName, top] of [["canvas", foundry.canvas], ["applications", foundry.applications]]) {
      if (!top || typeof top !== "object") continue;
      for (const [ns, mod] of Object.entries(top)) {
        if (mod && typeof mod === "object") roots.push([`foundry.${topName}.${ns}`, mod]);
      }
    }
  }
  roots.push(["", globalThis]);
  for (const [prefix, mod] of roots) {
    if (!mod?.[className]) continue;
    const base = prefix ? `${prefix}.${className}` : className;
    return { cls: mod[className], path: base };
  }
  return { cls: null, path: null };
}

/**
 * Safely wrap a prototype or static method on a Foundry class.
 * @param {string} className
 * @param {string} method
 * @param {Function} wrapperFn  Receives `(wrapped, ...args)` with `this` bound.
 * @param {{ type?: "MIXED"|"WRAPPER"|"OVERRIDE", staticOnly?: boolean, protoOnly?: boolean }} [opts]
 * @returns {{ original: Function, fullPath: string, viaLibWrapper: boolean } | null}
 */
export function wrapFoundryMethod(className, method, wrapperFn, opts = {}) {
  const { cls, path } = resolveFoundryClass(className);
  if (!cls) return null;

  const isProto = !opts.staticOnly && cls.prototype && typeof cls.prototype[method] === "function";
  const isStatic = !isProto && !opts.protoOnly && typeof cls[method] === "function";
  if (!isProto && !isStatic) return null;

  const targetObj = isProto ? cls.prototype : cls;
  const fullPath = isProto ? `${path}.prototype.${method}` : `${path}.${method}`;
  const original = targetObj[method];

  const hasLibWrapper = Boolean(globalThis.libWrapper?.register && globalThis.game?.modules?.get?.("lib-wrapper")?.active);
  if (hasLibWrapper) {
    try {
      globalThis.libWrapper.register(MODULE_ID, fullPath, wrapperFn, opts.type || "MIXED");
      activePatches.set(fullPath, { via: "libWrapper", active: true });
      return { original, fullPath, viaLibWrapper: true };
    } catch (err) {
      console.warn(`${MODULE_ID} | libWrapper.register failed for ${fullPath}, falling back to direct wrap:`, err);
    }
  }

  let wrappedSet = DIRECT_WRAPPED.get(targetObj);
  if (!wrappedSet) {
    wrappedSet = new Set();
    DIRECT_WRAPPED.set(targetObj, wrappedSet);
  }
  if (wrappedSet.has(method)) {
    return { original, fullPath, viaLibWrapper: false };
  }
  wrappedSet.add(method);

  const prev = original;
  targetObj[method] = function (...args) {
    const boundWrapped = (...innerArgs) => prev.apply(this, innerArgs);
    return wrapperFn.call(this, boundWrapped, ...args);
  };
  activePatches.set(fullPath, { via: "direct", active: true });
  return { original: prev, fullPath, viaLibWrapper: false };
}

/**
 * Wrap a method directly on an object/prototype (for classes not in `foundry.canvas.*` namespaces).
 */
export function wrapTargetMethod(targetObj, method, label, wrapperFn) {
  if (!targetObj || typeof targetObj[method] !== "function") return null;
  let wrappedSet = DIRECT_WRAPPED.get(targetObj);
  if (!wrappedSet) {
    wrappedSet = new Set();
    DIRECT_WRAPPED.set(targetObj, wrappedSet);
  }
  if (wrappedSet.has(method)) return { original: targetObj[method], fullPath: label };
  wrappedSet.add(method);

  const prev = targetObj[method];
  targetObj[method] = function (...args) {
    const boundWrapped = (...innerArgs) => prev.apply(this, innerArgs);
    return wrapperFn.call(this, boundWrapped, ...args);
  };
  activePatches.set(label, { via: "direct", active: true });
  return { original: prev, fullPath: label };
}

export function getPerfStatus() {
  return {
    enabled: PERF_CONFIG.perfEnabled,
    conflicts: {
      primePerformance: isPrimePerfActive(),
      agPerfCore: isAgPerfCoreActive()
    },
    config: { ...PERF_CONFIG },
    patches: Object.fromEntries(activePatches.entries()),
    stats: { ...perfStats }
  };
}
