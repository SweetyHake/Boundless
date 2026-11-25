import {
  isTextureUsable,
  getLevelBaseElevation,
  getLevelRoofElevation,
  smoothstep,
  getEffectiveScale,
  buildEdgeThresholdPx,
  hasSpecOverlays,
  isPointUnderRoofSpec
} from "./utils.mjs";
import {
  loadLevelPolysFromDB,
  saveLevelPolysToDB,
  clearPolyCacheDB as clearPolyCacheStorage
} from "./poly-cache-db.mjs";

/**
 * Fast deterministic FNV-1a fingerprint of a level's wall/door geometry so persisted
 * IndexedDB shadow polygons auto-invalidate whenever the manifest walls change.
 */
export function hashLevelWallGeometry(sectors) {
  if (!sectors || typeof sectors !== "object") return "0";
  let h = 2166136261 >>> 0;
  let count = 0;
  const keys = Object.keys(sectors).sort();
  for (let ki = 0; ki < keys.length; ki++) {
    const sec = sectors[keys[ki]];
    if (!sec) continue;
    const wList = sec.w;
    if (wList?.length) {
      for (let i = 0; i < wList.length; i++) {
        const w = wList[i];
        count++;
        h = Math.imul(h ^ (w[0] | 0), 16777619) >>> 0;
        h = Math.imul(h ^ (w[1] | 0), 16777619) >>> 0;
        h = Math.imul(h ^ (w[2] | 0), 16777619) >>> 0;
        h = Math.imul(h ^ (w[3] | 0), 16777619) >>> 0;
        h = Math.imul(h ^ ((w[6] ?? 20) | 0), 16777619) >>> 0;
        h = Math.imul(h ^ ((w[8] ?? 0) | 0), 16777619) >>> 0;
        const th = w[9]?.threshold;
        if (th?.light) h = Math.imul(h ^ Math.round(th.light * 10), 16777619) >>> 0;
      }
    }
    const dList = sec.d;
    if (dList?.length) {
      for (let i = 0; i < dList.length; i++) {
        const d = dList[i];
        count++;
        h = Math.imul(h ^ (d[0] | 0), 16777619) >>> 0;
        h = Math.imul(h ^ (d[1] | 0), 16777619) >>> 0;
        h = Math.imul(h ^ (d[2] | 0), 16777619) >>> 0;
        h = Math.imul(h ^ (d[3] | 0), 16777619) >>> 0;
        h = Math.imul(h ^ ((d[4] ?? 1) | 0), 16777619) >>> 0;
        h = Math.imul(h ^ ((d[5] ?? 0) | 0), 16777619) >>> 0;
        const ex = d[6];
        if (ex) {
          h = Math.imul(h ^ ((ex.light ?? 20) | 0), 16777619) >>> 0;
          h = Math.imul(h ^ ((ex.dir ?? 0) | 0), 16777619) >>> 0;
          if (ex.threshold?.light) h = Math.imul(h ^ Math.round(ex.threshold.light * 10), 16777619) >>> 0;
        }
      }
    }
  }
  return `${count}:${h.toString(36)}`;
}

/**
 * Yield back to the browser event loop (preferring idle callback when available)
 * so background polygon prewarming never drops a frame.
 */
function yieldIdleSlice(timeoutMs = 50) {
  return new Promise((resolve) => {
    if (typeof globalThis.requestIdleCallback === "function") {
      globalThis.requestIdleCallback(() => resolve(), { timeout: timeoutMs });
    } else if (typeof globalThis.requestAnimationFrame === "function") {
      globalThis.requestAnimationFrame(() => resolve());
    } else {
      setTimeout(resolve, 0);
    }
  });
}

function buildFallbackOuterBounds(worldPx, EdgeCls) {
  const w = Math.max(1000, Number(worldPx) || 100000);
  return [
    new EdgeCls({ x: 0, y: 0 }, { x: w, y: 0 }, { id: "ob_top", type: "outerBounds" }),
    new EdgeCls({ x: w, y: 0 }, { x: w, y: w }, { id: "ob_right", type: "outerBounds" }),
    new EdgeCls({ x: w, y: w }, { x: 0, y: w }, { id: "ob_bottom", type: "outerBounds" }),
    new EdgeCls({ x: 0, y: w }, { x: 0, y: 0 }, { id: "ob_left", type: "outerBounds" })
  ];
}

function indexEdgeByAabb(sectorEdges, fallbackSk, edge, simSectorPx) {
  if (simSectorPx > 0) {
    const sx0 = Math.max(0, Math.floor(Math.min(edge.a.x, edge.b.x) / simSectorPx));
    const sy0 = Math.max(0, Math.floor(Math.min(edge.a.y, edge.b.y) / simSectorPx));
    const sx1 = Math.max(0, Math.floor(Math.max(edge.a.x, edge.b.x) / simSectorPx));
    const sy1 = Math.max(0, Math.floor(Math.max(edge.a.y, edge.b.y) / simSectorPx));
    if ((sx1 - sx0) <= 16 && (sy1 - sy0) <= 16) {
      for (let sy = sy0; sy <= sy1; sy++) {
        for (let sx = sx0; sx <= sx1; sx++) {
          const tSk = `${sx}_${sy}`;
          let arr = sectorEdges.get(tSk);
          if (!arr) { arr = []; sectorEdges.set(tSk, arr); }
          arr.push(edge);
        }
      }
      return;
    }
    // For ultra-long walls (> 16 sectors), walk along the segment (O(steps)) so every crossed sector indexes the edge
    const steps = Math.min(256, Math.max(Math.abs(sx1 - sx0), Math.abs(sy1 - sy0)) * 2 + 1);
    const visited = new Set();
    for (let i = 0; i <= steps; i++) {
      const t = i / steps;
      const sx = Math.max(0, Math.floor((edge.a.x + (edge.b.x - edge.a.x) * t) / simSectorPx));
      const sy = Math.max(0, Math.floor((edge.a.y + (edge.b.y - edge.a.y) * t) / simSectorPx));
      const tSk = `${sx}_${sy}`;
      if (visited.has(tSk)) continue;
      visited.add(tSk);
      let arr = sectorEdges.get(tSk);
      if (!arr) { arr = []; sectorEdges.set(tSk, arr); }
      arr.push(edge);
    }
    return;
  }
  let arr = sectorEdges.get(fallbackSk);
  if (!arr) { arr = []; sectorEdges.set(fallbackSk, arr); }
  arr.push(edge);
}

function collectEdgesInRadius(sectorEdges, nativeEdges, lx, ly, dimPx, simSectorPx, fallbackSx, fallbackSy) {
  const out = nativeEdges.length ? nativeEdges.slice() : [];
  let sx0, sy0, sx1, sy1;
  if (simSectorPx > 0) {
    sx0 = Math.max(0, Math.floor((lx - dimPx) / simSectorPx));
    sy0 = Math.max(0, Math.floor((ly - dimPx) / simSectorPx));
    sx1 = Math.max(sx0, Math.floor((lx + dimPx) / simSectorPx));
    sy1 = Math.max(sy0, Math.floor((ly + dimPx) / simSectorPx));
    if ((sx1 - sx0) > 24 || (sy1 - sy0) > 24) {
      const cx = Math.floor(lx / simSectorPx);
      const cy = Math.floor(ly / simSectorPx);
      sx0 = Math.max(0, cx - 12); sy0 = Math.max(0, cy - 12);
      sx1 = cx + 12; sy1 = cy + 12;
    }
  } else {
    sx0 = fallbackSx - 1; sy0 = fallbackSy - 1;
    sx1 = fallbackSx + 1; sy1 = fallbackSy + 1;
  }
  const seen = (sx1 > sx0 || sy1 > sy0) ? new Set() : null;
  for (let sy = sy0; sy <= sy1; sy++) {
    for (let sx = sx0; sx <= sx1; sx++) {
      const arr = sectorEdges.get(`${sx}_${sy}`);
      if (!arr) continue;
      for (let i = 0; i < arr.length; i++) {
        const e = arr[i];
        if (seen) {
          if (seen.has(e)) continue;
          seen.add(e);
        }
        out.push(e);
      }
    }
  }
  return out;
}

function buildSectorEdgeMap(sectors, levelId, pxPerFt, EdgeCls, resolveWallFn = null, simSectorPx = 0) {
  const sectorEdges = new Map();
  for (const [sk, sec] of Object.entries(sectors || {})) {
    if (sec?.w) {
      for (let wi = 0; wi < sec.w.length; wi++) {
        const seg = resolveWallFn
          ? resolveWallFn(levelId, "w", sk, wi, sec.w[wi])
          : {
              c: sec.w[wi].slice(0, 4),
              move: sec.w[wi][4], sight: sec.w[wi][5], light: sec.w[wi][6], sound: sec.w[wi][7],
              dir: sec.w[wi][8] || 0, door: 0, ds: 0,
              threshold: sec.w[wi][9]?.threshold || null
            };
        if (!seg || seg.light === 0 || (seg.door && seg.ds === 1)) continue;
        const [x1, y1, x2, y2] = seg.c;
        const threshold = buildEdgeThresholdPx(seg.threshold, pxPerFt);
        const edge = new EdgeCls({ x: x1, y: y1 }, { x: x2, y: y2 }, {
          id: `bw_${levelId}_${sk}_${wi}`, type: "wall",
          move: seg.move, sight: seg.sight, light: seg.light, darkness: seg.darkness ?? seg.light, sound: seg.sound, direction: seg.dir || 0,
          ...(threshold ? { threshold } : {})
        });
        indexEdgeByAabb(sectorEdges, sk, edge, simSectorPx);
      }
    }
    if (sec?.d) {
      for (let di = 0; di < sec.d.length; di++) {
        const rawD = sec.d[di];
        const ex = rawD[6] && typeof rawD[6] === "object" ? rawD[6] : null;
        const seg = resolveWallFn
          ? resolveWallFn(levelId, "d", sk, di, rawD)
          : {
              c: rawD.slice(0, 4),
              move: ex?.move ?? 20, sight: ex?.sight ?? 20, light: ex?.light ?? 20, sound: ex?.sound ?? 20,
              dir: ex?.dir || 0, door: rawD[4] || 1, ds: rawD[5] || 0,
              threshold: ex?.threshold || null
            };
        if (!seg || seg.light === 0 || (seg.door && seg.ds === 1)) continue;
        const [x1, y1, x2, y2] = seg.c;
        const threshold = buildEdgeThresholdPx(seg.threshold, pxPerFt);
        const edge = new EdgeCls({ x: x1, y: y1 }, { x: x2, y: y2 }, {
          id: `bd_${levelId}_${sk}_${di}`, type: "wall",
          move: seg.move, sight: seg.sight, light: seg.light, darkness: seg.darkness ?? seg.light, sound: seg.sound, direction: seg.dir || 0,
          ...(threshold ? { threshold } : {})
        });
        indexEdgeByAabb(sectorEdges, sk, edge, simSectorPx);
      }
    }
  }
  return sectorEdges;
}

function createLocalFakeLevel(level, worldPx, levelId, EdgeCls) {
  const emptyRect = new PIXI.Rectangle(-1e9, -1e9, 1, 1);
  let outerBounds = [];
  let innerBounds = [];
  if (level?.edges?.getEdges) {
    outerBounds = Array.from(
      level.edges.getEdges(emptyRect, { includeOuterBounds: true, includeInnerBounds: false })
    ).filter(e => e.type === "outerBounds").map(e => e.clone());
    innerBounds = Array.from(
      level.edges.getEdges(emptyRect, { includeOuterBounds: false, includeInnerBounds: true })
    ).filter(e => e.type === "innerBounds").map(e => e.clone());
  }
  if (!outerBounds.length) {
    outerBounds = buildFallbackOuterBounds(worldPx, EdgeCls);
  }

  const localEdgeStore = {
    _list: [],
    getEdges(bbox, { includeInnerBounds = false, includeOuterBounds = true, collisionTest, collisionTestBounds = false } = {}) {
      const out = new Set();
      for (const e of this._list) {
        if (bbox && (Math.max(e.a.x, e.b.x) < bbox.x || Math.min(e.a.x, e.b.x) > bbox.right ||
            Math.max(e.a.y, e.b.y) < bbox.y || Math.min(e.a.y, e.b.y) > bbox.bottom)) continue;
        if (!collisionTest || collisionTest(e)) out.add(e);
      }
      const boundsTest = collisionTestBounds ? collisionTest : null;
      if (includeInnerBounds) {
        for (const inner of innerBounds) {
          if (!boundsTest || boundsTest(inner)) out.add(inner);
        }
      }
      if (includeOuterBounds) {
        for (const outer of outerBounds) {
          if (!boundsTest || boundsTest(outer)) out.add(outer);
        }
      }
      if (out.size > 1 && EdgeCls.identifyEdgeIntersections) {
        EdgeCls.identifyEdgeIntersections(out, levelId);
      }
      return out;
    }
  };
  const fakeLevel = level
    ? Object.create(level, { edges: { value: localEdgeStore, enumerable: true } })
    : { id: levelId, edges: localEdgeStore };
  return { localEdgeStore, fakeLevel };
}

function computeSingleLightPoly(lx, ly, dimPx, angle, rotation, useWalls, localEdges, fakeLevel, CSP) {
  let hasNearbyWall = false;
  if (useWalls) {
    for (const e of localEdges) {
      if (Math.max(e.a.x, e.b.x) >= lx - dimPx && Math.min(e.a.x, e.b.x) <= lx + dimPx &&
          Math.max(e.a.y, e.b.y) >= ly - dimPx && Math.min(e.a.y, e.b.y) <= ly + dimPx) {
        hasNearbyWall = true;
        break;
      }
    }
  }
  let offsets = null;
  if ((useWalls && hasNearbyWall) || angle < 360) {
    const poly = new CSP();
    poly.initialize({ x: lx, y: ly }, {
      type: "light",
      level: fakeLevel,
      edgeTypes: { wall: useWalls },
      radius: dimPx,
      angle,
      rotation,
      density: 32,
      hasLimitedRadius: true,
      useThreshold: true
    });
    poly.compute();
    const pts = poly.points;
    const nPts = pts.length >> 1;
    if (nPts >= 3) {
      offsets = new Float32Array(nPts * 2);
      const invR = 1 / dimPx;
      for (let i = 0; i < nPts; i++) {
        let ox = (pts[i * 2] - lx) * invR;
        let oy = (pts[i * 2 + 1] - ly) * invR;
        const len = Math.hypot(ox, oy);
        if (len > 1.001) {
          ox /= len;
          oy /= len;
        }
        offsets[i * 2] = ox;
        offsets[i * 2 + 1] = oy;
      }
    }
  }
  return { offsets, hasNearbyWall };
}

/**
 * Precompute compact wall-shadowed light polygons for a level manifest spec (`spec.bakedPolys`)
 * so every first-time player loads the scene with zero `ClockwiseSweepPolygon` raycasts.
 */
export function computeLevelBakedPolys(spec, pxPerFt, { level = null, maxLights = 2500 } = {}) {
  const sectors = spec?.sectors;
  const EdgeCls = globalThis.foundry?.canvas?.geometry?.edges?.Edge;
  const CSP = globalThis.foundry?.canvas?.geometry?.ClockwiseSweepPolygon;
  if (!sectors || !EdgeCls || !CSP || !Number.isFinite(pxPerFt) || pxPerFt <= 0) return null;

  let totalLights = 0;
  for (const sec of Object.values(sectors)) {
    totalLights += sec?.l?.length || 0;
    if (totalLights > maxLights) return null;
  }
  if (totalLights === 0) return null;

  const levelId = level?.id || "baked";
  const simSectorPx = spec.simSectorPx || ((spec.worldPx && spec.simGrid) ? (spec.worldPx / spec.simGrid) : 0);
  const sectorEdges = buildSectorEdgeMap(sectors, levelId, pxPerFt, EdgeCls, null, simSectorPx);
  const { localEdgeStore, fakeLevel } = createLocalFakeLevel(level, spec.worldPx || 100000, levelId, EdgeCls);
  const polys = {};

  for (const [sk, sec] of Object.entries(sectors)) {
    if (!sec?.l?.length) continue;
    const [sx, sy] = sk.split("_").map(Number);
    const localEdges = collectEdgesInRadius(sectorEdges, [], (sx + 0.5) * (simSectorPx || 1), (sy + 0.5) * (simSectorPx || 1), simSectorPx || 1, 0, sx, sy);

    for (let li = 0; li < sec.l.length; li++) {
      const raw = sec.l[li];
      const extra = raw[8] && typeof raw[8] === "object" ? raw[8] : null;
      if (extra?.hidden) continue;
      const lx = raw[0], ly = raw[1];
      const dimPx = Math.max(raw[2] || 0, raw[3] || 0) * pxPerFt;
      const angle = extra?.angle ?? 360;
      const rotation = extra?.rotation ?? 0;
      const useWalls = extra?.walls !== false;
      if (dimPx <= 0 || angle <= 0) continue;

      const lightEdges = (simSectorPx > 0 && (dimPx > simSectorPx || Math.floor(lx / simSectorPx) !== sx || Math.floor(ly / simSectorPx) !== sy))
        ? collectEdgesInRadius(sectorEdges, [], lx, ly, dimPx, simSectorPx, sx, sy)
        : localEdges;
      localEdgeStore._list = lightEdges;

      const { offsets } = computeSingleLightPoly(lx, ly, dimPx, angle, rotation, useWalls, lightEdges, fakeLevel, CSP);
      if (offsets && offsets.length >= 6) {
        const compact = new Array(offsets.length);
        for (let i = 0; i < offsets.length; i++) {
          compact[i] = Math.round(offsets[i] * 1000) / 1000;
        }
        polys[`${sk}_${li}`] = compact;
      }
    }
  }

  return {
    wg: hashLevelWallGeometry(sectors),
    pxPerFt: Math.round(pxPerFt * 1000) / 1000,
    polys
  };
}

export const LIGHT_PAD_WORLD_PX = 900; // > max 40ft (800px) light radius so lights never pop on viewport edge
export const FOUNDRY_DEFAULT_ATTENUATION = 0.277992; // Exact Foundry v14 computedAttenuation for data.attenuation = 0.5
export function computeShaderAttenuation(att = 0.5) {
  const a = Math.max(0, Math.min(1, Number.isFinite(att) ? att : 0.5));
  return (1 - Math.cos(Math.PI * Math.pow(a, 1.5))) * 0.5;
}

export function extractLightStyle(src) {
  const s = src && typeof src === "object" ? src : null;
  const num = (v, fb) => (v !== undefined && v !== null && Number.isFinite(Number(v)) ? Number(v) : fb);
  return {
    speed: num(s?.speed, 3),
    intensity: num(s?.intensity, 3),
    attenuation: num(s?.attenuation, 0.5),
    luminosity: num(s?.luminosity, 0.5),
    coloration: (s?.coloration !== undefined && s?.coloration !== null && Number.isFinite(Number(s.coloration)))
      ? Number(s.coloration)
      : null
  };
}

const PULSE_ANIM_TYPES = new Set([
  "pulse", "reactivepulse", "wave", "witchwave", "bewitchingwave",
  "emanation", "energy", "grid", "forcegrid", "siren",
  "hexa", "ghost", "fog", "fairy", "starlight", "smokepatch"
]);
const ROTATE_ANIM_TYPES = new Set([
  "sunburst", "revolving", "vortex", "dome", "roiling",
  "radialrainbow", "rainbowswirl", "swirlingrainbow"
]);
const CHROMA_ANIM_TYPES = new Set(["chroma", "rainbow"]);

/**
 * Average coloration fill factor of Foundry's procedural animated coloration shaders.
 * Pattern shaders like `energy` (`voronoi3d` raised to `c.x^3`) leave ~85-90% of the disk black,
 * so drawing them at full 1.0 solid fill in `MegaLightBatch` causes a jarring brightness drop
 * whenever a door opens and nearby lights promote to native `PointLightSource`.
 */
const PATTERN_ANIM_COLOR_GAIN = {
  energy: 0.16,
  grid: 0.22,
  forcegrid: 0.22,
  starlight: 0.24,
  smokepatch: 0.35,
  fog: 0.38,
  witchwave: 0.42,
  bewitchingwave: 0.42,
  fairy: 0.40,
  ghost: 0.42,
  emanation: 0.40,
  hexa: 0.38,
  dome: 0.45,
  revolving: 0.55,
  siren: 0.58,
  vortex: 0.52,
  sunburst: 0.65,
  rainbowswirl: 0.60,
  radialrainbow: 0.62
};

export function getAnimColorationGain(anim) {
  if (!anim) return 1.0;
  if (globalThis.canvas?.effects?.animateLightSources === false) return 1.0;
  const key = String(anim).trim().toLowerCase();
  return PATTERN_ANIM_COLOR_GAIN[key] ?? 1.0;
}

/**
 * Encode animation mode and per-light phase offset into the single `aParams.w` float:
 *  - `< -1.5`      : macro orbital glow
 *  - `-1.5 .. <0`  : static light (no animation)
 *  - `0 .. <1000`  : Mode 0 — torch/flame flickering
 *  - `1000.. <2000`: Mode 1 — pulse/wave sinusoidal breathing
 *  - `2000.. <3000`: Mode 2 — rotating rays inside shadowed polygon (sunburst/vortex/revolving)
 *  - `3000.. <4000`: Mode 3 — chroma/rainbow hue rotation
 *  - `4000.. <5000`: Mode 4 — rotating directional spotlight cone (`angle < 360`, no walls blocking rotation)
 */
export function encodeLightAnimPhase(anim, basePhase = 0, canRotateCone = false) {
  if (!anim) return -1.0;
  const type = String(anim).trim().toLowerCase();
  if (!type) return -1.0;
  const ph = Math.abs(Number(basePhase) || 0) % 100.0;
  if (CHROMA_ANIM_TYPES.has(type)) return 3000.0 + ph;
  if (ROTATE_ANIM_TYPES.has(type)) return (canRotateCone ? 4000.0 : 2000.0) + ph;
  if (PULSE_ANIM_TYPES.has(type)) return 1000.0 + ph;
  return ph;
}

export const LIGHT_BATCH_VERT = `
precision highp float;

attribute vec2 aCenter;
attribute vec2 aOffset;   // Normalized local offset from center in dimPx units
attribute vec4 aParams;   // x: dimPx, y: ratio, z: alpha, w: encoded anim mode + phase (< 0 static, < -1.5 macro)
attribute vec3 aColor;
attribute vec4 aStyle;    // x: attenuation, y: luminosity, z: speed, w: intensity
attribute float aWeight;
attribute float aDepthElev; // Mapped Foundry depthElevation [0..1] for multi-level floor occlusion

uniform mat3 translationMatrix;
uniform mat3 projectionMatrix;
uniform vec2 uScreenDimensions;
uniform float uTime;
uniform float uStageScale;
uniform float uMinScreenRadius;
uniform vec2 uBakedRoofOrigin;
uniform vec2 uBakedRoofRegion;

varying vec2 vOffset;
varying vec2 vSamplerUvs;
varying vec2 vRoofUv;
varying vec3 vColor;
varying float vRatio;
varying float vColorAlpha;
varying float vWeight;
varying float vDepthElev;
varying float vIsMacro;
varying float vAttenuation;
varying float vLuminosity;
varying float vAnimRot;
varying float vAnimAmp;

vec3 rotateHue(vec3 col, float angle) {
  const vec3 k = vec3(0.57735027);
  float c = cos(angle);
  return clamp(col * c + cross(k, col) * sin(angle) + k * dot(k, col) * (1.0 - c), 0.0, 1.0);
}

void main() {
  if (aWeight <= 0.001 || aParams.x <= 0.0) {
    vWeight = 0.0;
    vColorAlpha = 0.0;
    vOffset = vec2(2.0);
    vSamplerUvs = vec2(0.0);
    vRoofUv = vec2(0.0);
    vColor = vec3(0.0);
    vRatio = 0.5;
    vDepthElev = 1.0;
    vIsMacro = 0.0;
    vAttenuation = 0.5;
    vLuminosity = 0.5;
    vAnimRot = 0.0;
    vAnimAmp = 0.0;
    gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
    return;
  }

  float effectiveRadius = max(aParams.x, uMinScreenRadius / max(uStageScale, 0.001));
  vec2 effOffset = aOffset;
  vec3 effColor = aColor;
  float pulse = 1.0;
  float effRatio = aParams.y;
  float animRot = 0.0;
  float animAmp = 0.0;

  if (uTime >= 0.0) {
    if (aParams.w >= 4000.0) {
      // Mode 4: Rotating internal rays inside directional cone (preserve configured cone rotation)
      float ph = aParams.w - 4000.0;
      animRot = uTime * (max(aStyle.z, 0.0) * 0.35) + ph;
      animAmp = clamp(aStyle.w * 0.08, 0.0, 0.85);
      pulse = 0.85 + animAmp * 0.15 * sin(animRot);
    } else if (aParams.w >= 3000.0) {
      // Mode 3: Chroma / Rainbow hue cycle
      float ph = aParams.w - 3000.0;
      float ang = uTime * (max(aStyle.z, 0.0) * 0.45) + ph;
      effColor = rotateHue(aColor, ang);
      float amp = clamp(aStyle.w * 0.05, 0.0, 0.4);
      pulse = 0.82 + amp * (0.5 + 0.5 * sin(ang * 2.0));
    } else if (aParams.w >= 2000.0) {
      // Mode 2: Rotating angular rays inside shadowed polygon (sunburst / vortex / revolving)
      float ph = aParams.w - 2000.0;
      animRot = uTime * (max(aStyle.z, 0.0) * 0.35) + ph;
      animAmp = clamp(aStyle.w * 0.08, 0.0, 0.85);
      pulse = 0.82 + animAmp * 0.15 * sin(animRot);
    } else if (aParams.w >= 1000.0) {
      // Mode 1: Smooth pulse / wave breathing
      float ph = aParams.w - 1000.0;
      float t = uTime * (max(aStyle.z, 0.0) * 0.55) + ph;
      float amp = clamp(aStyle.w * 0.085, 0.0, 0.85);
      float wave = 0.5 + 0.5 * sin(t);
      pulse = clamp(0.86 - amp * 0.65, 0.2, 0.95) + wave * amp * 0.65;
      effRatio = aParams.y > 0.001 ? clamp(aParams.y * (1.0 - amp * 0.35) + wave * amp * 0.35, 0.0, 1.0) : 0.0;
    } else if (aParams.w >= 0.0) {
      // Mode 0: Match Foundry v14 Torch flickering with per-light speed & intensity
      float t = uTime * (max(aStyle.z, 0.0) * 0.6) + aParams.w;
      float s = 0.5
        + 0.28 * sin(t)
        + 0.14 * sin(t * 2.37 + 1.1)
        + 0.08 * sin(t * 4.13 + 2.7);
      float amp = clamp(aStyle.w * 0.09, 0.0, 0.9);
      float pulseBase = clamp(0.82 - amp, 0.15, 0.95);
      float n = clamp(s, 0.0, 1.0) * amp;
      pulse = pulseBase + n;
      effRatio = aParams.y > 0.001 ? clamp(aParams.y * (1.0 - amp * 0.37) + n * 0.222, 0.0, 1.0) : 0.0;
    }
  }

  vec2 worldPos = aCenter + effOffset * effectiveRadius;
  vec3 tPos = translationMatrix * vec3(worldPos, 1.0);

  vOffset = effOffset;
  vSamplerUvs = tPos.xy / uScreenDimensions;
  vRoofUv = (worldPos - uBakedRoofOrigin) / max(uBakedRoofRegion, vec2(1.0));
  vColor = effColor;
  vRatio = effRatio;
  vColorAlpha = aParams.z * 2.0 * pulse * aWeight;
  vWeight = aWeight;
  vDepthElev = aDepthElev;
  vIsMacro = aParams.w < -1.5 ? 1.0 : 0.0;
  vAttenuation = aStyle.x;
  vLuminosity = aStyle.y;
  vAnimRot = animRot;
  vAnimAmp = animAmp;

  gl_Position = vec4((projectionMatrix * tPos).xy, 0.0, 1.0);
}
`;

export const LIGHT_ILLUM_FRAG = `
precision highp float;

uniform sampler2D uDarknessLevelTexture;
uniform bool uHasDarknessTexture;
uniform sampler2D uDepthTexture;
uniform bool uUseDepthTexture;
uniform sampler2D uBakedRoofMask;
uniform bool uUseBakedRoofMask;
uniform bool uBakedRoofRepeat;
uniform vec3 uStaticBg;
uniform vec3 uStaticBright;
uniform vec3 uStaticDim;
uniform vec3 uAmbientDaylight;
uniform vec3 uAmbientDarkness;
uniform vec3 uAmbientBrightest;
uniform vec4 uWeights;

varying vec2 vOffset;
varying vec2 vSamplerUvs;
varying vec2 vRoofUv;
varying vec3 vColor;
varying float vRatio;
varying float vColorAlpha;
varying float vWeight;
varying float vDepthElev;
varying float vIsMacro;
varying float vAttenuation;
varying float vLuminosity;
varying float vAnimRot;
varying float vAnimAmp;

vec3 switchColor(vec3 innerColor, vec3 outerColor, float dist, float ratio, float att) {
  float attStr = att * 0.7;
  float lowerEdge = 0.99 - attStr;
  float upperEdge = 1.01 + attStr;
  return mix(innerColor, outerColor, smoothstep(ratio * lowerEdge, clamp(ratio * upperEdge, 0.0001, 1.0), dist));
}

void main() {
  if (vWeight <= 0.001) discard;
  float distSq = dot(vOffset, vOffset);
  if (distSq >= 1.0) discard;
  float dist = sqrt(distSq);

  float depthMask = 1.0;
  bool aboveBakedRoof = vDepthElev > 2.0;
  float depthElev = aboveBakedRoof ? (vDepthElev - 10.0) : vDepthElev;
  if (uUseDepthTexture && vIsMacro < 0.5) {
    vec4 depthColor = texture2D(uDepthTexture, vSamplerUvs);
    depthMask = step(depthColor.g - (0.5 / 255.0), depthElev)
              * step(depthElev, (254.5 / 255.0) - depthColor.r);
    if (depthMask <= 0.001) discard;
  }
  if (uUseBakedRoofMask && vIsMacro < 0.5 && !aboveBakedRoof) {
    vec2 rawRoofUv = vRoofUv;
    bool inRoofBounds = uBakedRoofRepeat || (rawRoofUv.x >= 0.0 && rawRoofUv.x <= 1.0 && rawRoofUv.y >= 0.0 && rawRoofUv.y <= 1.0);
    if (inRoofBounds) {
      vec2 roofUv = uBakedRoofRepeat ? fract(rawRoofUv) : rawRoofUv;
      float roofAlpha = texture2D(uBakedRoofMask, roofUv).a;
      depthMask *= (1.0 - smoothstep(0.62, 0.80, roofAlpha));
      if (depthMask <= 0.001) discard;
    }
  }

  vec3 bg;
  vec3 brightCol;
  vec3 dimCol;
  if (uHasDarknessTexture) {
    float darkness = texture2D(uDarknessLevelTexture, vSamplerUvs).r;
    bg = mix(uAmbientDaylight, uAmbientDarkness, darkness);
    brightCol = max(bg, mix(bg, uAmbientBrightest, uWeights.w * vWeight));
    dimCol = max(bg, mix(bg, brightCol, uWeights.z));
  } else {
    bg = uStaticBg;
    brightCol = vWeight >= 0.999 ? uStaticBright : mix(bg, uStaticBright, vWeight);
    dimCol = vWeight >= 0.999 ? uStaticDim : mix(bg, brightCol, uWeights.z);
  }

  vec3 outCol;
  if (vIsMacro > 0.5) {
    // Soft Gaussian orbital settlement glow (never a harsh spotlight disc over forests/lakes)
    float macroFalloff = exp(-3.6 * dist * dist) * (1.0 - smoothstep(0.72, 1.0, dist));
    outCol = mix(bg, dimCol, macroFalloff * 0.65 * vWeight);
  } else {
    float att = clamp(vAttenuation, 0.0, 1.0);
    vec3 finalCol = switchColor(brightCol, dimCol, dist, vRatio, att);
    float rayMod = 1.0;
    if (vAnimAmp > 0.001) {
      float ang = atan(vOffset.y, vOffset.x);
      rayMod = 1.0 - vAnimAmp * 0.45 * (0.5 - 0.5 * sin(ang * 6.0 - vAnimRot));
    }
    float edgeFade = (1.0 - smoothstep(1.0 - max(att, 0.0001), 1.0, dist)) * depthMask * rayMod;
    if (vLuminosity > 0.5) {
      vec3 boostedCol = clamp(finalCol * (1.0 + (vLuminosity - 0.5) * 1.4), 0.0, 1.0);
      outCol = mix(bg, boostedCol, clamp(edgeFade, 0.0, 1.0));
    } else {
      float lumScale = clamp(vLuminosity * 2.0, 0.0, 1.0);
      outCol = mix(bg, finalCol, clamp(edgeFade * lumScale, 0.0, 1.0));
    }
  }

  gl_FragColor = vec4(outCol, 1.0);
}
`;

export const LIGHT_COLOR_FRAG = `
precision highp float;

uniform sampler2D uPrimaryTexture;
uniform bool uHasPrimaryTexture;
uniform sampler2D uDepthTexture;
uniform bool uUseDepthTexture;
uniform sampler2D uBakedRoofMask;
uniform bool uUseBakedRoofMask;
uniform bool uBakedRoofRepeat;
uniform float uMacroLift;

varying vec2 vOffset;
varying vec2 vSamplerUvs;
varying vec2 vRoofUv;
varying vec3 vColor;
varying float vRatio;
varying float vColorAlpha;
varying float vWeight;
varying float vDepthElev;
varying float vIsMacro;
varying float vAttenuation;
varying float vLuminosity;
varying float vAnimRot;
varying float vAnimAmp;

const vec3 BT709 = vec3(0.2126, 0.7152, 0.0722);
float perceivedBrightness(vec3 c) { return sqrt(dot(BT709, c * c)); }

void main() {
  if (vColorAlpha <= 0.001 || dot(vColor, vColor) <= 0.0001) discard;
  float distSq = dot(vOffset, vOffset);
  if (distSq >= 1.0) discard;
  float dist = sqrt(distSq);

  float depthMask = 1.0;
  bool aboveBakedRoof = vDepthElev > 2.0;
  float depthElev = aboveBakedRoof ? (vDepthElev - 10.0) : vDepthElev;
  if (uUseDepthTexture && vIsMacro < 0.5) {
    vec4 depthColor = texture2D(uDepthTexture, vSamplerUvs);
    depthMask = step(depthColor.g - (0.5 / 255.0), depthElev)
              * step(depthElev, (254.5 / 255.0) - depthColor.r);
    if (depthMask <= 0.001) discard;
  }
  if (uUseBakedRoofMask && vIsMacro < 0.5 && !aboveBakedRoof) {
    vec2 rawRoofUv = vRoofUv;
    bool inRoofBounds = uBakedRoofRepeat || (rawRoofUv.x >= 0.0 && rawRoofUv.x <= 1.0 && rawRoofUv.y >= 0.0 && rawRoofUv.y <= 1.0);
    if (inRoofBounds) {
      vec2 roofUv = uBakedRoofRepeat ? fract(rawRoofUv) : rawRoofUv;
      float roofAlpha = texture2D(uBakedRoofMask, roofUv).a;
      depthMask *= (1.0 - smoothstep(0.62, 0.80, roofAlpha));
      if (depthMask <= 0.001) discard;
    }
  }

  vec3 baseRgb = uHasPrimaryTexture ? texture2D(uPrimaryTexture, vSamplerUvs).rgb : vec3(0.5);
  float reflection = perceivedBrightness(baseRgb);
  // Gently prevent dark roofs from completely eating distant city glow on extreme macro zoom (<0.14)
  reflection = mix(reflection, max(reflection, 0.38), uMacroLift);

  float edgeFade;
  if (vIsMacro > 0.5) {
    edgeFade = exp(-3.6 * dist * dist) * (1.0 - smoothstep(0.72, 1.0, dist)) * 0.55;
  } else {
    float att = clamp(vAttenuation, 0.0, 1.0);
    float rayMod = 1.0;
    if (vAnimAmp > 0.001) {
      float ang = atan(vOffset.y, vOffset.x);
      rayMod = 1.0 - vAnimAmp * 0.45 * (0.5 - 0.5 * sin(ang * 6.0 - vAnimRot));
    }
    edgeFade = (1.0 - smoothstep(1.0 - max(att, 0.0001), 1.0, dist)) * depthMask * rayMod;
  }
  float lumGain = 1.0 + max(0.0, vLuminosity - 0.5);
  vec3 outCol = vColor * vColorAlpha * reflection * edgeFade * lumGain;

  gl_FragColor = vec4(outCol, 1.0);
}
`;

const _colorRgbCache = new Map();
function resolveColorRgb(colorHex) {
  if (!colorHex) return null;
  const hit = _colorRgbCache.get(colorHex);
  if (hit !== undefined) return hit;
  const c = foundry.utils.Color.from(colorHex);
  const rgb = c?.rgb ? [c.rgb[0], c.rgb[1], c.rgb[2]] : [0, 0, 0];
  if (_colorRgbCache.size >= 256) _colorRgbCache.delete(_colorRgbCache.keys().next().value);
  _colorRgbCache.set(colorHex, rgb);
  return rgb;
}

export class MegaLightBatch {
  totalLights = 0;
  totalVertices = 0;
  visibleIndexCount = 0;
  activeLightsCount = 0;
  useDepthTexture = false;

  lightMetaById = new Map(); // "${levelId}::${sk}_${li}" -> { id, levelId, elevation, sk, lx, ly, dimPx, vStart, vCount, weight, raw }
  sectorBounds = [];         // [{ levelId, sk, minX, minY, maxX, maxY, idxStart, idxCount }]
  lastVisKey = "";

  geometry = null;
  weightArray = null;
  weightBuffer = null;
  weightsDirty = false;
  hideIndoorLights = false;

  // Pixel-accurate baked roof alpha mask (2048x2048) used on macro zoom (localZ < 5) so lighting logic never changes when roofs unload
  bakedRoofMask = null;
  bakedRoofOrigin = new Float32Array([0, 0]);
  bakedRoofRegion = new Float32Array([100000, 100000]);
  bakedRoofRepeat = false;
  bakedRoofElevation = Infinity;
  useBakedRoofMask = false;

  depthElevArray = null;
  depthElevBuffer = null;
  depthElevDirty = false;

  allIndices = null;
  visibleIndices = null;
  indexBuffer = null;

  illumShader = null;
  colorShader = null;
  illumMesh = null;
  colorMesh = null;

  // Per-chunk streamed light batches + continental orbital macro glow layer (`boundless-chunked-v1`)
  chunkBatches = new Map(); // "${levelId}::${chunkKey}" -> { key, levelId, geometry, illumMesh, colorMesh, sectorBounds, allIndices, visibleIndices, visibleIndexCount, indexBuffer, weightArray, weightBuffer, weightsDirty, depthElevArray, depthElevBuffer, lightIds, activeCount, lastVisKey }
  macroBatch = null;        // { geometry, illumMesh, colorMesh, weightArray, weightBuffer, lastAlpha, count }
  _chunkBakeQueue = [];
  _chunkBakeGen = 0;
  _chunkBakeRaf = null;
  _lastVp = null;
  _effects = null;
  _buildPxPerFt = 20;
  _resolveWallFn = null;
  _resolveLightFn = null;
  _isSuppressedFn = null;
  _hasLevelEditsFn = null;
  _getLevelCacheSigFn = null;

  // Cross-level polygon cache: persists across same-scene level switches (cleared on scene change via clearPolyCache)
  // and hydrated/persisted across full reloads via IndexedDB (`poly-cache-db.mjs`).
  _polyCache = new Map(); // lightId -> { sig: string, offsets: Float32Array | null, hasNearbyWall: boolean }
  _polyCacheSceneId = null;
  _hydratedPolyLevels = new Set();
  _deferredBakeGen = 0;
  _deferredBakeRaf = null;
  lastPolyCacheHits = 0;
  lastPolyCacheMisses = 0;
  lastPolyCacheHydrated = 0;
  lastPolyCacheBakedHits = 0;

  clearPolyCache() {
    this._polyCache.clear();
    this._polyCacheSceneId = null;
    this._hydratedPolyLevels.clear();
    this._deferredBakeGen++;
    this.lastPolyCacheHits = 0;
    this.lastPolyCacheMisses = 0;
    this.lastPolyCacheHydrated = 0;
    this.lastPolyCacheBakedHits = 0;
  }

  async hydratePolyCacheFromDB(worldId, sceneId, levelIds) {
    if (!sceneId || !Array.isArray(levelIds) || !levelIds.length) return 0;
    if (this._polyCacheSceneId && this._polyCacheSceneId !== sceneId) {
      this._polyCache.clear();
      this._hydratedPolyLevels.clear();
    }
    this._polyCacheSceneId = sceneId;

    const missingLevels = levelIds.filter(lid => lid && !this._hydratedPolyLevels.has(lid));
    if (!missingLevels.length) {
      this.lastPolyCacheHydrated = 0;
      return 0;
    }

    const loaded = await loadLevelPolysFromDB(worldId, sceneId, missingLevels);
    // Abort hydration if another scene mounted while awaiting IndexedDB
    if (this._polyCacheSceneId !== sceneId) return 0;

    for (const lid of missingLevels) this._hydratedPolyLevels.add(lid);
    let added = 0;
    for (const [lightId, entry] of loaded) {
      if (!this._polyCache.has(lightId)) {
        this._polyCache.set(lightId, entry);
        added++;
      }
    }
    this.lastPolyCacheHydrated = added;
    return added;
  }

  async persistPolyCacheToDB(worldId, sceneId, levelIds = null) {
    if (!sceneId || this._polyCacheSceneId !== sceneId || !this._polyCache.size) return false;
    const filterSet = Array.isArray(levelIds) && levelIds.length ? new Set(levelIds) : null;
    const byLevel = new Map();
    for (const [lightId, entry] of this._polyCache) {
      const sep = lightId.indexOf("::");
      if (sep <= 0) continue;
      const lid = lightId.slice(0, sep);
      if (filterSet && !filterSet.has(lid)) continue;
      let list = byLevel.get(lid);
      if (!list) {
        list = [];
        byLevel.set(lid, list);
      }
      list.push([lightId, entry.sig, entry.offsets, Boolean(entry.hasNearbyWall)]);
    }
    if (!byLevel.size) return false;
    return saveLevelPolysToDB(worldId, sceneId, byLevel);
  }

  async clearPolyCacheDB(sceneId = null, worldId = null) {
    if (!sceneId || sceneId === this._polyCacheSceneId) {
      this.clearPolyCache();
    }
    return clearPolyCacheStorage(sceneId, worldId);
  }

  _buildNativeEdgesSig(nativeEdges) {
    if (!nativeEdges?.length) return "0";
    let h = 2166136261 >>> 0;
    for (let i = 0; i < nativeEdges.length; i++) {
      const e = nativeEdges[i];
      h = Math.imul(h ^ Math.round(e.a.x), 16777619) >>> 0;
      h = Math.imul(h ^ Math.round(e.a.y), 16777619) >>> 0;
      h = Math.imul(h ^ Math.round(e.b.x), 16777619) >>> 0;
      h = Math.imul(h ^ Math.round(e.b.y), 16777619) >>> 0;
      h = Math.imul(h ^ (e.light || 0), 16777619) >>> 0;
      h = Math.imul(h ^ (e.direction || 0), 16777619) >>> 0;
      h = Math.imul(h ^ (e.threshold?.light ? Math.round(e.threshold.light * 10) : 0), 16777619) >>> 0;
      h = Math.imul(h ^ (e.threshold?.attenuation ? 1 : 0), 16777619) >>> 0;
    }
    return `${nativeEdges.length}:${h.toString(36)}`;
  }
  _onBatchChanged = null;
  _depthElevCheckMap = new Map(); // elevation -> last mapped depthElevation [0..1]
  _currentDarkness = 0;
  _hasDarknessRangedLights = false;
  _frozenTime = 0;

  _ensureShaders() {
    if (this.illumShader && this.colorShader) return;
    const screenDims = new Float32Array([
      canvas.screenDimensions?.[0] || 1,
      canvas.screenDimensions?.[1] || 1
    ]);
    this.illumShader = PIXI.Shader.from(LIGHT_BATCH_VERT, LIGHT_ILLUM_FRAG, {
      uScreenDimensions: screenDims,
      uTime: 0,
      uStageScale: 1,
      uMinScreenRadius: 2.5,
      uDarknessLevelTexture: PIXI.Texture.WHITE,
      uHasDarknessTexture: false,
      uDepthTexture: PIXI.Texture.WHITE,
      uUseDepthTexture: false,
      uBakedRoofMask: PIXI.Texture.EMPTY,
      uUseBakedRoofMask: false,
      uBakedRoofOrigin: this.bakedRoofOrigin,
      uBakedRoofRegion: this.bakedRoofRegion,
      uBakedRoofRepeat: false,
      uStaticBg: new Float32Array([0.89, 0.89, 0.89]),
      uStaticBright: new Float32Array([1, 1, 1]),
      uStaticDim: new Float32Array([0.92, 0.92, 0.92]),
      uAmbientDaylight: new Float32Array([0.933, 0.933, 0.933]),
      uAmbientDarkness: new Float32Array([0.188, 0.188, 0.188]),
      uAmbientBrightest: new Float32Array([1, 1, 1]),
      uWeights: new Float32Array([0, 0.5, 0.25, 1]),
      uAttenuation: FOUNDRY_DEFAULT_ATTENUATION
    });
    this.illumShader.update = () => this._updateIllumUniforms();

    this.colorShader = PIXI.Shader.from(LIGHT_BATCH_VERT, LIGHT_COLOR_FRAG, {
      uScreenDimensions: screenDims,
      uTime: 0,
      uStageScale: 1,
      uMinScreenRadius: 3.2,
      uPrimaryTexture: PIXI.Texture.WHITE,
      uHasPrimaryTexture: false,
      uDepthTexture: PIXI.Texture.WHITE,
      uUseDepthTexture: false,
      uBakedRoofMask: PIXI.Texture.EMPTY,
      uUseBakedRoofMask: false,
      uBakedRoofOrigin: this.bakedRoofOrigin,
      uBakedRoofRegion: this.bakedRoofRegion,
      uBakedRoofRepeat: false,
      uAttenuation: FOUNDRY_DEFAULT_ATTENUATION,
      uMacroLift: 0
    });
    this.colorShader.update = () => this._updateColorUniforms();
  }

  _buildMacroBatch(macroLightsList) {
    if (!Array.isArray(macroLightsList) || macroLightsList.length === 0) return;
    this._ensureShaders();
    const centers = [];
    const offsets = [];
    const params = [];
    const colors = [];
    const styles = [];
    const indices = [];
    let vc = 0;

    for (let i = 0; i < macroLightsList.length; i++) {
      const m = macroLightsList[i];
      if (!m || m.length < 3) continue;
      const lx = m[0], ly = m[1], rad = m[2] * 0.68;
      const colorHex = m[3] || "#ffaa44";
      const alpha = Math.min(0.45, (m[4] ?? 0.45) * 0.55);
      let r = 1, g = 0.72, b = 0.35;
      if (colorHex) {
        const rgb = resolveColorRgb(colorHex);
        r = rgb[0]; g = rgb[1]; b = rgb[2];
      }
      const v0 = vc++;
      const v1 = vc++;
      const v2 = vc++;
      const v3 = vc++;
      const corners = [[-1, -1], [1, -1], [1, 1], [-1, 1]];
      for (const [ox, oy] of corners) {
        centers.push(lx, ly);
        offsets.push(ox, oy);
        params.push(rad, 0.0, alpha, -2.0);
        colors.push(r, g, b);
        styles.push(FOUNDRY_DEFAULT_ATTENUATION, 0.5, 3, 3);
      }
      indices.push(v0, v1, v2, v0, v2, v3);
    }
    if (vc === 0) return;

    const weights = new Float32Array(vc);
    weights.fill(1.0);
    const weightBuffer = new PIXI.Buffer(weights, false, false);
    const depthElevs = new Float32Array(vc);
    depthElevs.fill(1.0);
    const IdxArr = vc > 65535 ? Uint32Array : Uint16Array;

    const geometry = new PIXI.Geometry()
      .addAttribute("aCenter", new Float32Array(centers), 2)
      .addAttribute("aOffset", new Float32Array(offsets), 2)
      .addAttribute("aParams", new Float32Array(params), 4)
      .addAttribute("aColor", new Float32Array(colors), 3)
      .addAttribute("aStyle", new Float32Array(styles), 4)
      .addAttribute("aWeight", weightBuffer, 1)
      .addAttribute("aDepthElev", new PIXI.Buffer(depthElevs, false, false), 1)
      .addIndex(new IdxArr(indices));

    const illumMesh = new PIXI.Mesh(geometry, this.illumShader);
    illumMesh.blendMode = PIXI.BLEND_MODES.MAX_COLOR;
    illumMesh.zIndex = -11;
    illumMesh.eventMode = "none";
    illumMesh.cullable = false;
    illumMesh.visible = false;

    const colorMesh = new PIXI.Mesh(geometry, this.colorShader);
    colorMesh.blendMode = PIXI.BLEND_MODES.SCREEN;
    colorMesh.zIndex = -11;
    colorMesh.eventMode = "none";
    colorMesh.cullable = false;
    colorMesh.visible = false;

    this.macroBatch = {
      geometry, illumMesh, colorMesh,
      weightArray: weights, weightBuffer, lastAlpha: 1.0,
      count: macroLightsList.length
    };
  }

  _collectNativeWallEdges(levelId, EdgeCls, pxPerFt = this._buildPxPerFt || 20) {
    const nativeEdges = [];
    if (canvas.scene?.walls) {
      for (const w of canvas.scene.walls) {
        if (w.light === 0) continue;
        if (w.door && w.ds === 1) continue;
        if (w.levels?.size && !w.levels.has(levelId)) continue;
        const [x1, y1, x2, y2] = w.c;
        const threshold = buildEdgeThresholdPx(w.threshold, pxPerFt);
        nativeEdges.push(new EdgeCls({ x: x1, y: y1 }, { x: x2, y: y2 }, {
          id: `nw_${levelId}_${w.id}`, type: "wall",
          move: w.move, sight: w.sight, light: w.light, darkness: w.darkness ?? w.light, sound: w.sound, direction: w.dir || 0,
          ...(threshold ? { threshold } : {})
        }));
      }
    }
    return nativeEdges;
  }

  _computeEffectiveWeight(meta) {
    if (this.hideIndoorLights && meta.isIndoor) return 0.0;
    const d = this._currentDarkness;
    if (d < meta.darkMin || d > meta.darkMax) return 0.0;
    return meta.baseWeight;
  }

  /**
   * Build a single unified GPU mesh covering all lights across all currently visible Boundless levels.
   * Each light's wall visibility polygon is computed strictly against its own Level's walls (+ native WallDocuments on that Level).
   * @param {Array<{level: Level, spec: object}>} visibleLevelLayers
   * @param {number} pxPerFt
   */
  build(visibleLevelLayers, pxPerFt, resolveWallFn = null, resolveLightFn = null, opts = {}) {
    const prevHideIndoor = this.hideIndoorLights;
    this.destroy();
    this.hideIndoorLights = prevHideIndoor;
    if (!visibleLevelLayers?.length || !canvas?.level) return;

    this._buildPxPerFt = pxPerFt;
    this._resolveWallFn = resolveWallFn;
    this._resolveLightFn = resolveLightFn;
    this._isSuppressedFn = opts.isSuppressedFn || null;
    this._hasLevelEditsFn = opts.hasLevelEditsFn || null;
    this._getLevelCacheSigFn = opts.getLevelCacheSigFn || null;
    this._onBatchChanged = opts.onBatchChanged || null;
    this._onChunkBaked = opts.onChunkBaked || null;
    this._currentDarkness = canvas.environment?.darknessLevel ?? 0;

    const curSceneId = canvas.scene?.id || null;
    if (this._polyCacheSceneId && curSceneId && this._polyCacheSceneId !== curSceneId) {
      this._polyCache.clear();
      this._hydratedPolyLevels.clear();
    }
    this._polyCacheSceneId = curSceneId;
    this.lastPolyCacheHits = 0;
    this.lastPolyCacheMisses = 0;
    this.lastPolyCacheBakedHits = 0;
    const deferredJobs = [];
    const timeSliceThreshold = Number.isFinite(opts.timeSliceThreshold) ? opts.timeSliceThreshold : 0;
    const syncBudgetMs = Number.isFinite(opts.syncBudgetMs) ? opts.syncBudgetMs : 14;
    const syncBakeStartMs = performance.now();
    let syncComputedCount = 0;

    const EdgeCls = foundry.canvas.geometry.edges.Edge;
    const CSP = foundry.canvas.geometry.ClockwiseSweepPolygon;

    const centersArr = [];
    const offsetsArr = [];
    const paramsArr = [];
    const colorsArr = [];
    const stylesArr = [];
    const indicesArr = [];
    const combinedMacroLights = [];
    let vertCursor = 0;
    let lightCount = 0;

    const pushVertex = (lx, ly, ox, oy, dimPx, ratio, alpha, phase, r, g, b, att = FOUNDRY_DEFAULT_ATTENUATION, lum = 0.5, spd = 3, inten = 3) => {
      centersArr.push(lx, ly);
      offsetsArr.push(ox, oy);
      paramsArr.push(dimPx, ratio, alpha, phase);
      colorsArr.push(r, g, b);
      stylesArr.push(att, lum, spd, inten);
      return vertCursor++;
    };

    const emptyRect = new PIXI.Rectangle(-1e9, -1e9, 1, 1);
    const seenSharedLightKeys = visibleLevelLayers.length > 1 ? new Set() : null;

    for (const layerEntry of visibleLevelLayers) {
      const { level, spec } = layerEntry;
      if (!spec || !level) continue;
      // Chunked worlds stream detailed lights per-chunk via non-blocking time-sliced baking + lightweight orbital macroLights
      if (spec.chunks?.baseUrl) {
        if (Array.isArray(spec.macroLights) && spec.macroLights.length) {
          for (let i = 0; i < spec.macroLights.length; i++) combinedMacroLights.push(spec.macroLights[i]);
        }
        continue;
      }
      const sectors = spec.sectors;
      if (!sectors) continue;

      const levelId = level.id;
      const defaultLightElev = getLevelBaseElevation(level) + 6;
      const nativeEdges = this._collectNativeWallEdges(levelId, EdgeCls);
      const rawExtraSig = this._getLevelCacheSigFn ? String(this._getLevelCacheSigFn(levelId) ?? "") : "";
      // Strip transient openDoors (`|od:...`) from static polygon cache signature: open doors are handled via dynamicLights, never baked static walls!
      const extraLevelSig = rawExtraSig.replace(/\|od:[^|]*/g, "");
      const hasSigWallEdits = Boolean(extraLevelSig && /(?:^|\|)we:(?!0(?:\||$))/.test(extraLevelSig));
      const hasEditsOnLevel = Boolean(this._hasLevelEditsFn?.(levelId)) || hasSigWallEdits || nativeEdges.length > 0;
      let wallGeomHash = "sg";
      if (!spec._superGridBase) {
        if (spec._wallGeomHashRef === sectors && typeof spec._wallGeomHash === "string") {
          wallGeomHash = spec._wallGeomHash;
        } else {
          wallGeomHash = hashLevelWallGeometry(sectors);
          spec._wallGeomHash = wallGeomHash;
          spec._wallGeomHashRef = sectors;
        }
      }
      const levelCacheSig = `${levelId}|e:${hasEditsOnLevel ? 1 : 0}|${extraLevelSig}|nw:${this._buildNativeEdgesSig(nativeEdges)}|wg:${wallGeomHash}`;

      // Fast instanced light baking for unmodified superGrid worlds (only when regionPx divides evenly by baseSimSectorPx)
      const sgBaseSectorPx = spec._superGridBase ? (spec._superGridBase.simSectorPx || Math.ceil((spec.superGrid?.regionPx || 100000) / (spec._superGridBase.simGrid || 40))) : 1;
      const sgExactDiv = Boolean(spec._superGridBase && spec.superGrid && ((spec.superGrid.regionPx || 100000) % sgBaseSectorPx) === 0);
      if (sgExactDiv && !hasEditsOnLevel) {
        const sg = spec.superGrid;
        const baseSpec = spec._superGridBase;
        const baseSectors = baseSpec.sectors || {};
        const baseSimGrid = baseSpec.simGrid || 40;
        const cols = sg.cols || 1;
        const rows = sg.rows || 1;
        const regionPx = sg.regionPx || 100000;

        const baseSectorEdges = new Map();
        for (const [bsk, bsec] of Object.entries(baseSectors)) {
          const arr = [];
          if (bsec.w) {
            for (let wi = 0; wi < bsec.w.length; wi++) {
              const w = bsec.w[wi];
              if (w[6] === 0) continue;
              const wEx = w[9] && typeof w[9] === "object" ? w[9] : null;
              const threshold = buildEdgeThresholdPx(wEx?.threshold, pxPerFt);
              arr.push(new EdgeCls({ x: w[0], y: w[1] }, { x: w[2], y: w[3] }, {
                id: `sgw_${levelId}_${bsk}_${wi}`, type: "wall",
                move: w[4], sight: w[5], light: w[6], darkness: w[6], sound: w[7], direction: w[8] || 0,
                ...(threshold ? { threshold } : {})
              }));
            }
          }
          if (bsec.d) {
            for (let di = 0; di < bsec.d.length; di++) {
              const d = bsec.d[di];
              if (d[5] === 1) continue;
              const dEx = d[6] && typeof d[6] === "object" ? d[6] : null;
              const dLight = dEx?.light ?? 20;
              if (dLight === 0) continue;
              const threshold = buildEdgeThresholdPx(dEx?.threshold, pxPerFt);
              arr.push(new EdgeCls({ x: d[0], y: d[1] }, { x: d[2], y: d[3] }, {
                id: `sgd_${levelId}_${bsk}_${di}`, type: "wall",
                move: dEx?.move ?? 20, sight: dEx?.sight ?? 20, light: dLight, darkness: dLight, sound: dEx?.sound ?? 20, direction: dEx?.dir ?? 0,
                ...(threshold ? { threshold } : {})
              }));
            }
          }
          if (arr.length) baseSectorEdges.set(bsk, arr);
        }

        const baseOuterBounds = [
          new EdgeCls({ x: 0, y: 0 }, { x: regionPx, y: 0 }, { id: "sgb_t", type: "outerBounds" }),
          new EdgeCls({ x: regionPx, y: 0 }, { x: regionPx, y: regionPx }, { id: "sgb_r", type: "outerBounds" }),
          new EdgeCls({ x: regionPx, y: regionPx }, { x: 0, y: regionPx }, { id: "sgb_b", type: "outerBounds" }),
          new EdgeCls({ x: 0, y: regionPx }, { x: 0, y: 0 }, { id: "sgb_l", type: "outerBounds" })
        ];
        const baseEdgeStore = {
          _list: [],
          getEdges(bbox, { includeOuterBounds = true, collisionTest, collisionTestBounds = false } = {}) {
            const out = new Set();
            for (const e of this._list) {
              if (bbox && (Math.max(e.a.x, e.b.x) < bbox.x || Math.min(e.a.x, e.b.x) > bbox.right ||
                  Math.max(e.a.y, e.b.y) < bbox.y || Math.min(e.a.y, e.b.y) > bbox.bottom)) continue;
              if (!collisionTest || collisionTest(e)) out.add(e);
            }
            if (includeOuterBounds) {
              const boundsTest = collisionTestBounds ? collisionTest : null;
              for (const outer of baseOuterBounds) {
                if (!boundsTest || boundsTest(outer)) out.add(outer);
              }
            }
            if (out.size > 1 && EdgeCls.identifyEdgeIntersections) {
              EdgeCls.identifyEdgeIntersections(out, levelId);
            }
            return out;
          }
        };
        const fakeBaseLevel = Object.create(level, { edges: { value: baseEdgeStore, enumerable: true } });

        // Bake shadow polygons ONCE for the base province (e.g. 635 lights)
        const bakedBaseSectors = [];
        const topElev = getLevelRoofElevation(level);
        for (const [bsk, bsec] of Object.entries(baseSectors)) {
          if (!bsec?.l?.length) continue;
          const [bsx, bsy] = bsk.split("_").map(Number);
          const localEdges = [];
          for (let dy = -1; dy <= 1; dy++) {
            for (let dx = -1; dx <= 1; dx++) {
              const arr = baseSectorEdges.get(`${bsx + dx}_${bsy + dy}`);
              if (arr) for (const e of arr) localEdges.push(e);
            }
          }
          baseEdgeStore._list = localEdges;

          const bakedLights = [];
          for (let li = 0; li < bsec.l.length; li++) {
            const raw = bsec.l[li];
            const extra = raw[8] && typeof raw[8] === "object" ? raw[8] : null;
            if (extra?.hidden) continue;
            const lx = raw[0], ly = raw[1];
            const dimFt = raw[2], brightFt = raw[3];
            const colorHex = raw[4], alpha = raw[5] ?? 0.5, anim = raw[6] || "";
            const elevation = Number.isFinite(raw[7]) ? raw[7] : defaultLightElev;
            const useWalls = extra?.walls !== false;
            const angle = extra?.angle ?? 360;
            const rotation = extra?.rotation ?? 0;
            const darkMin = extra?.darkMin ?? 0;
            const darkMax = extra?.darkMax ?? 1;
            const dimPx = Math.max(dimFt || 0, brightFt || 0) * pxPerFt;
            if (dimPx <= 0 || angle <= 0) continue;
            if (darkMin > 0 || darkMax < 1) this._hasDarknessRangedLights = true;
            const ratio = Math.min(1, ((brightFt || 0) * pxPerFt) / dimPx);
            let r = 0, g = 0, b = 0;
            if (colorHex) {
              const rgb = resolveColorRgb(colorHex);
              r = rgb[0]; g = rgb[1]; b = rgb[2];
            }
            const basePhase = Math.abs(Math.sin(lx * 0.0137 + ly * 0.0193 + elevation * 0.31) * 100.0);

            let hasNearbyWall = false;
            if (useWalls) {
              for (const e of localEdges) {
                if (Math.max(e.a.x, e.b.x) >= lx - dimPx && Math.min(e.a.x, e.b.x) <= lx + dimPx &&
                    Math.max(e.a.y, e.b.y) >= ly - dimPx && Math.min(e.a.y, e.b.y) <= ly + dimPx) {
                  hasNearbyWall = true;
                  break;
                }
              }
            }

            let offsets = null;
            if (hasNearbyWall || angle < 360) {
              const poly = new CSP();
              poly.initialize({ x: lx, y: ly }, {
                type: "light",
                level: fakeBaseLevel,
                edgeTypes: { wall: useWalls },
                radius: dimPx,
                angle,
                rotation,
                density: 32,
                hasLimitedRadius: true,
                useThreshold: true
              });
              poly.compute();
              const pts = poly.points;
              const nPts = pts.length >> 1;
              if (nPts >= 3) {
                offsets = new Float32Array(nPts * 2);
                const invR = 1 / dimPx;
                for (let i = 0; i < nPts; i++) {
                  let ox = (pts[i * 2] - lx) * invR;
                  let oy = (pts[i * 2 + 1] - ly) * invR;
                  const len = Math.hypot(ox, oy);
                  if (len > 1.001) { ox /= len; oy /= len; }
                  offsets[i * 2] = ox;
                  offsets[i * 2 + 1] = oy;
                }
              }
            }

            let isIndoor = false;
            if (elevation < topElev && hasSpecOverlays(baseSpec.overlays)) {
              for (let dy = -1; dy <= 1 && !isIndoor; dy++) {
                for (let dx = -1; dx <= 1 && !isIndoor; dx++) {
                  const oList = baseSectors[`${bsx + dx}_${bsy + dy}`]?.o;
                  if (!oList?.length) continue;
                  for (const oid of oList) {
                    if (isPointUnderRoofSpec(lx, ly, baseSpec.overlays[oid])) {
                      isIndoor = true;
                      break;
                    }
                  }
                }
              }
            }

            const style = extractLightStyle(extra);
            const canRotateCone = angle < 360 && !(useWalls && hasNearbyWall);
            bakedLights.push({
              li, lx, ly, dimFt, brightFt, colorHex, alpha, anim, elevation,
              dimPx, ratio, r, g, b, basePhase, canRotateCone, offsets, isIndoor,
              walls: useWalls, angle, rotation, darkMin, darkMax, extra,
              ...style,
              shaderAtt: computeShaderAttenuation(style.attenuation)
            });
          }
          if (bakedLights.length) {
            bakedBaseSectors.push({ bsx, bsy, bakedLights });
          }
        }

        // Stamp baked lights across all cols x rows provinces with real world coordinates
        for (let gy = 0; gy < rows; gy++) {
          const offY = gy * regionPx;
          const secOffY = gy * baseSimGrid;
          for (let gx = 0; gx < cols; gx++) {
            const offX = gx * regionPx;
            const secOffX = gx * baseSimGrid;
            const phaseShift = (gx * 7.13 + gy * 13.71);
            for (let si = 0; si < bakedBaseSectors.length; si++) {
              const { bsx, bsy, bakedLights } = bakedBaseSectors[si];
              const sk = `${secOffX + bsx}_${secOffY + bsy}`;
              const idxStart = indicesArr.length;
              let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;

              for (let bi = 0; bi < bakedLights.length; bi++) {
                const bl = bakedLights[bi];
                const lx = bl.lx + offX;
                const ly = bl.ly + offY;
                const ph = encodeLightAnimPhase(bl.anim, bl.basePhase + phaseShift, bl.canRotateCone);
                const effAlpha = bl.alpha * getAnimColorationGain(bl.anim);
                const vStart = vertCursor;

                if (bl.offsets) {
                  const nPts = bl.offsets.length >> 1;
                  const centerIdx = pushVertex(lx, ly, 0, 0, bl.dimPx, bl.ratio, effAlpha, ph, bl.r, bl.g, bl.b, bl.shaderAtt, bl.luminosity, bl.speed, bl.intensity);
                  const ringStart = vertCursor;
                  for (let i = 0; i < nPts; i++) {
                    pushVertex(lx, ly, bl.offsets[i * 2], bl.offsets[i * 2 + 1], bl.dimPx, bl.ratio, effAlpha, ph, bl.r, bl.g, bl.b, bl.shaderAtt, bl.luminosity, bl.speed, bl.intensity);
                  }
                  for (let i = 0; i < nPts; i++) {
                    indicesArr.push(centerIdx, ringStart + i, ringStart + ((i + 1) % nPts));
                  }
                } else {
                  const v0 = pushVertex(lx, ly, -1, -1, bl.dimPx, bl.ratio, effAlpha, ph, bl.r, bl.g, bl.b, bl.shaderAtt, bl.luminosity, bl.speed, bl.intensity);
                  const v1 = pushVertex(lx, ly, 1, -1, bl.dimPx, bl.ratio, effAlpha, ph, bl.r, bl.g, bl.b, bl.shaderAtt, bl.luminosity, bl.speed, bl.intensity);
                  const v2 = pushVertex(lx, ly, 1, 1, bl.dimPx, bl.ratio, effAlpha, ph, bl.r, bl.g, bl.b, bl.shaderAtt, bl.luminosity, bl.speed, bl.intensity);
                  const v3 = pushVertex(lx, ly, -1, 1, bl.dimPx, bl.ratio, effAlpha, ph, bl.r, bl.g, bl.b, bl.shaderAtt, bl.luminosity, bl.speed, bl.intensity);
                  indicesArr.push(v0, v1, v2, v0, v2, v3);
                }

                const vCount = vertCursor - vStart;
                const lightId = `${levelId}::${sk}_${bl.li}`;
                const suppressed = Boolean(this._isSuppressedFn?.(lightId));
                const rawEntry = [lx, ly, bl.dimFt, bl.brightFt, bl.colorHex, bl.alpha, bl.anim, bl.elevation];
                if (bl.extra) rawEntry.push(bl.extra);
                this.lightMetaById.set(lightId, {
                  id: lightId, levelId, elevation: bl.elevation, sk, lx, ly, dimPx: bl.dimPx, vStart, vCount,
                  weight: 1.0, baseWeight: suppressed ? 0.0 : 1.0, isIndoor: bl.isIndoor,
                  walls: bl.walls, angle: bl.angle, rotation: bl.rotation, darkMin: bl.darkMin, darkMax: bl.darkMax,
                  speed: bl.speed, intensity: bl.intensity, coloration: bl.coloration,
                  attenuation: bl.attenuation, luminosity: bl.luminosity,
                  raw: rawEntry
                });
                if (lx - bl.dimPx < minX) minX = lx - bl.dimPx;
                if (ly - bl.dimPx < minY) minY = ly - bl.dimPx;
                if (lx + bl.dimPx > maxX) maxX = lx + bl.dimPx;
                if (ly + bl.dimPx > maxY) maxY = ly + bl.dimPx;
                lightCount++;
              }

              const idxCount = indicesArr.length - idxStart;
              if (idxCount > 0) {
                this.sectorBounds.push({ levelId, sk, minX, minY, maxX, maxY, idxStart, idxCount });
              }
            }
          }
        }
        continue;
      }

      // Pre-build static light-blocking Edge arrays per sector for this level
      const bp = spec.bakedPolys;
      const canUseSpecBakedPolys = Boolean(
        bp && typeof bp === "object" && bp.polys && typeof bp.polys === "object" &&
        bp.wg === wallGeomHash &&
        (!bp.pxPerFt || Math.abs(bp.pxPerFt - pxPerFt) < 0.01) &&
        !hasEditsOnLevel
      );

      let sectorEdges = null;
      let localEdgeStore = null;
      let fakeLevel = null;
      const simSectorPx = layerEntry.simSectorPx || spec.simSectorPx || ((spec.worldPx && spec.simGrid) ? (spec.worldPx / spec.simGrid) : 0);
      const ensureLevelEdgeContext = () => {
        if (sectorEdges) return;
        sectorEdges = buildSectorEdgeMap(sectors, levelId, pxPerFt, EdgeCls, resolveWallFn, simSectorPx);
        const built = createLocalFakeLevel(level, spec.worldPx || 100000, levelId, EdgeCls);
        localEdgeStore = built.localEdgeStore;
        fakeLevel = built.fakeLevel;
      };

      const topElev = getLevelRoofElevation(level);
      const layerHasOverlays = hasSpecOverlays(spec.overlays);

      for (const [sk, sec] of Object.entries(sectors)) {
        if (!sec?.l?.length) continue;
        const [sx, sy] = sk.split("_").map(Number);
        let localEdges = null;
        const ensureLocalEdges = () => {
          if (localEdges) {
            localEdgeStore._list = localEdges;
            return localEdges;
          }
          ensureLevelEdgeContext();
          localEdges = collectEdgesInRadius(sectorEdges, nativeEdges, 0, 0, 0, 0, sx, sy);
          localEdgeStore._list = localEdges;
          return localEdges;
        };
        const getEdgesForLight = (lxVal, lyVal, dimVal) => {
          if (simSectorPx > 0 && (dimVal > simSectorPx || Math.floor(lxVal / simSectorPx) !== sx || Math.floor(lyVal / simSectorPx) !== sy)) {
            ensureLevelEdgeContext();
            const customEdges = collectEdgesInRadius(sectorEdges, nativeEdges, lxVal, lyVal, dimVal, simSectorPx, sx, sy);
            localEdgeStore._list = customEdges;
            return customEdges;
          }
          return ensureLocalEdges();
        };

        const idxStart = indicesArr.length;
        let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;

        for (let li = 0; li < sec.l.length; li++) {
          const raw = sec.l[li];
          const extra = raw[8] && typeof raw[8] === "object" ? raw[8] : null;
          const resolved = resolveLightFn
            ? resolveLightFn(levelId, sk, li, raw, level)
            : {
                x: raw[0], y: raw[1], dim: raw[2], bright: raw[3],
                color: raw[4], alpha: raw[5] ?? 0.5, anim: raw[6] || "",
                elevation: Number.isFinite(raw[7]) ? raw[7] : defaultLightElev,
                hidden: Boolean(extra?.hidden),
                walls: extra?.walls !== false,
                angle: extra?.angle ?? 360,
                rotation: extra?.rotation ?? 0,
                darkMin: extra?.darkMin ?? 0,
                darkMax: extra?.darkMax ?? 1,
                ...extractLightStyle(extra)
              };
          if (!resolved || resolved.hidden) continue;
          const lx = resolved.x, ly = resolved.y;
          const dimFt = resolved.dim, brightFt = resolved.bright;
          const colorHex = resolved.color, alpha = resolved.alpha, anim = resolved.anim;
          const dimPx = Math.max(dimFt || 0, brightFt || 0) * pxPerFt;
          const angle = resolved.angle ?? 360;
          const rotation = resolved.rotation ?? 0;
          const useWalls = resolved.walls !== false;
          const darkMin = resolved.darkMin ?? 0;
          const darkMax = resolved.darkMax ?? 1;
          const style = extractLightStyle(resolved);
          const shaderAtt = computeShaderAttenuation(style.attenuation);
          if (dimPx <= 0 || angle <= 0) continue;

          const elevation = Number.isFinite(resolved.elevation) ? resolved.elevation : defaultLightElev;
          if (seenSharedLightKeys) {
            const lk = extra?.gid
              ? `g:${extra.gid}`
              : `f:${lx}|${ly}|${dimFt}|${brightFt}|${elevation}|${colorHex || ""}|${alpha ?? 0.5}`;
            if (seenSharedLightKeys.has(lk)) continue;
            seenSharedLightKeys.add(lk);
          }
          const effectiveRaw = [lx, ly, dimFt, brightFt, colorHex, alpha, anim, elevation];
          if (extra) effectiveRaw.push(extra);
          const ratio = Math.min(1, ((brightFt || 0) * pxPerFt) / dimPx);
          const aVal = alpha ?? 0.5;
          let r = 0, g = 0, b = 0;
          if (colorHex) {
            const rgb = resolveColorRgb(colorHex);
            r = rgb[0]; g = rgb[1]; b = rgb[2];
          }
          const basePhase = Math.abs(Math.sin(lx * 0.0137 + ly * 0.0193 + elevation * 0.31) * 100.0);
          const vStart = vertCursor;
          const lightId = `${levelId}::${sk}_${li}`;
          const polySig = `${lx},${ly},${dimPx},${angle},${rotation},${useWalls ? 1 : 0}|${levelCacheSig}`;
          const cachedPoly = this._polyCache.get(lightId);

          let hasNearbyWall = false;
          let offsets = null;
          if (cachedPoly && cachedPoly.sig === polySig) {
            hasNearbyWall = cachedPoly.hasNearbyWall;
            offsets = cachedPoly.offsets;
            this.lastPolyCacheHits++;
          } else if (canUseSpecBakedPolys) {
            const pre = bp.polys[`${sk}_${li}`];
            if (Array.isArray(pre) && pre.length >= 6) {
              offsets = Float32Array.from(pre);
              const animNorm = String(anim || "").trim().toLowerCase();
              if (useWalls && angle < 360 && ROTATE_ANIM_TYPES.has(animNorm)) {
                const edges = getEdgesForLight(lx, ly, dimPx);
                for (let ei = 0; ei < edges.length; ei++) {
                  const e = edges[ei];
                  if (Math.max(e.a.x, e.b.x) >= lx - dimPx && Math.min(e.a.x, e.b.x) <= lx + dimPx &&
                      Math.max(e.a.y, e.b.y) >= ly - dimPx && Math.min(e.a.y, e.b.y) <= ly + dimPx) {
                    hasNearbyWall = true;
                    break;
                  }
                }
              } else {
                hasNearbyWall = useWalls;
              }
            }
            this._polyCache.set(lightId, { sig: polySig, offsets, hasNearbyWall });
            this.lastPolyCacheHits++;
            this.lastPolyCacheBakedHits++;
          } else if (timeSliceThreshold > 0 && syncComputedCount >= timeSliceThreshold && (performance.now() - syncBakeStartMs) >= syncBudgetMs) {
            // Defer remaining heavy ClockwiseSweepPolygon computations to non-blocking rAF slices
            this.lastPolyCacheMisses++;
            deferredJobs.push({
              lightId, polySig, lx, ly, dimPx, angle, rotation, useWalls,
              ensureLocalEdges: () => getEdgesForLight(lx, ly, dimPx),
              getFakeLevel: () => { ensureLevelEdgeContext(); return fakeLevel; }
            });
          } else {
            this.lastPolyCacheMisses++;
            syncComputedCount++;
            const edges = getEdgesForLight(lx, ly, dimPx);
            const computed = computeSingleLightPoly(lx, ly, dimPx, angle, rotation, useWalls, edges, fakeLevel, CSP);
            offsets = computed.offsets;
            hasNearbyWall = computed.hasNearbyWall;
            this._polyCache.set(lightId, { sig: polySig, offsets, hasNearbyWall });
          }

          const canRotateCone = angle < 360 && !(useWalls && hasNearbyWall);
          const phase = encodeLightAnimPhase(anim, basePhase, canRotateCone);
          const effAlpha = aVal * getAnimColorationGain(anim);

          if (offsets && offsets.length >= 6) {
            const nPts = offsets.length >> 1;
            const centerIdx = pushVertex(lx, ly, 0, 0, dimPx, ratio, effAlpha, phase, r, g, b, shaderAtt, style.luminosity, style.speed, style.intensity);
            const ringStart = vertCursor;
            for (let i = 0; i < nPts; i++) {
              pushVertex(lx, ly, offsets[i * 2], offsets[i * 2 + 1], dimPx, ratio, effAlpha, phase, r, g, b, shaderAtt, style.luminosity, style.speed, style.intensity);
            }
            for (let i = 0; i < nPts; i++) {
              indicesArr.push(centerIdx, ringStart + i, ringStart + ((i + 1) % nPts));
            }
          } else {
            const v0 = pushVertex(lx, ly, -1, -1, dimPx, ratio, effAlpha, phase, r, g, b, shaderAtt, style.luminosity, style.speed, style.intensity);
            const v1 = pushVertex(lx, ly, 1, -1, dimPx, ratio, effAlpha, phase, r, g, b, shaderAtt, style.luminosity, style.speed, style.intensity);
            const v2 = pushVertex(lx, ly, 1, 1, dimPx, ratio, effAlpha, phase, r, g, b, shaderAtt, style.luminosity, style.speed, style.intensity);
            const v3 = pushVertex(lx, ly, -1, 1, dimPx, ratio, effAlpha, phase, r, g, b, shaderAtt, style.luminosity, style.speed, style.intensity);
            indicesArr.push(v0, v1, v2, v0, v2, v3);
          }

          const vCount = vertCursor - vStart;
          let isIndoor = false;
          if (elevation < topElev && layerHasOverlays) {
            const lsx = simSectorPx > 0 ? Math.floor(lx / simSectorPx) : sx;
            const lsy = simSectorPx > 0 ? Math.floor(ly / simSectorPx) : sy;
            for (let dy = -1; dy <= 1 && !isIndoor; dy++) {
              for (let dx = -1; dx <= 1 && !isIndoor; dx++) {
                const oList = sectors[`${lsx + dx}_${lsy + dy}`]?.o;
                if (!oList?.length) continue;
                for (const oid of oList) {
                  if (isPointUnderRoofSpec(lx, ly, spec.overlays[oid])) {
                    isIndoor = true;
                    break;
                  }
                }
              }
            }
          }
          if (darkMin > 0 || darkMax < 1) this._hasDarknessRangedLights = true;
          const suppressed = Boolean(this._isSuppressedFn?.(lightId));
          this.lightMetaById.set(lightId, {
            id: lightId, levelId, elevation, sk, lx, ly, dimPx, vStart, vCount,
            weight: 1.0, baseWeight: suppressed ? 0.0 : 1.0, isIndoor,
            walls: useWalls, angle, rotation, darkMin, darkMax,
            speed: style.speed, intensity: style.intensity, coloration: style.coloration,
            attenuation: style.attenuation, luminosity: style.luminosity,
            raw: effectiveRaw
          });

          if (lx - dimPx < minX) minX = lx - dimPx;
          if (ly - dimPx < minY) minY = ly - dimPx;
          if (lx + dimPx > maxX) maxX = lx + dimPx;
          if (ly + dimPx > maxY) maxY = ly + dimPx;
          lightCount++;
        }

        const idxCount = indicesArr.length - idxStart;
        if (idxCount > 0) {
          this.sectorBounds.push({ levelId, sk, minX, minY, maxX, maxY, idxStart, idxCount });
        }
      }
    }

    if (combinedMacroLights.length > 0) {
      this._buildMacroBatch(combinedMacroLights);
    }

    this.totalLights = lightCount;
    this.activeLightsCount = lightCount;
    this.totalVertices = vertCursor;
    if (this.totalLights === 0 || vertCursor === 0) return;

    const weights = new Float32Array(vertCursor);
    weights.fill(1.0);
    const depthElevs = new Float32Array(vertCursor);
    depthElevs.fill(1.0);

    // Apply initial effective weights (suppressed dynamicLights, hideIndoorLights, darkness range) before GPU upload
    let initialActive = 0;
    for (const meta of this.lightMetaById.values()) {
      const eff = this._computeEffectiveWeight(meta);
      meta.weight = eff;
      if (eff !== 1.0) weights.fill(eff, meta.vStart, meta.vStart + meta.vCount);
      if (eff > 0.001) initialActive++;
    }
    this.activeLightsCount = initialActive;

    const IdxArray = vertCursor > 65535 ? Uint32Array : Uint16Array;
    this.allIndices = new IdxArray(indicesArr);
    this.visibleIndices = new IdxArray(indicesArr);
    this.visibleIndexCount = this.allIndices.length;

    this.weightArray = weights;
    this.weightBuffer = new PIXI.Buffer(weights, false, false);
    this.depthElevArray = depthElevs;
    this.depthElevBuffer = new PIXI.Buffer(depthElevs, false, false);
    this.indexBuffer = new PIXI.Buffer(this.visibleIndices, false, true);

    this.geometry = new PIXI.Geometry()
      .addAttribute("aCenter", new Float32Array(centersArr), 2)
      .addAttribute("aOffset", new Float32Array(offsetsArr), 2)
      .addAttribute("aParams", new Float32Array(paramsArr), 4)
      .addAttribute("aColor", new Float32Array(colorsArr), 3)
      .addAttribute("aStyle", new Float32Array(stylesArr), 4)
      .addAttribute("aWeight", this.weightBuffer, 1)
      .addAttribute("aDepthElev", this.depthElevBuffer, 1)
      .addIndex(this.indexBuffer);

    this._ensureShaders();

    this.illumMesh = new PIXI.Mesh(this.geometry, this.illumShader);
    this.illumMesh.blendMode = PIXI.BLEND_MODES.MAX_COLOR;
    this.illumMesh.zIndex = -10;
    this.illumMesh.eventMode = "none";
    this.illumMesh.cullable = false;
    this.illumMesh.size = this.visibleIndexCount;

    this.colorMesh = new PIXI.Mesh(this.geometry, this.colorShader);
    this.colorMesh.blendMode = PIXI.BLEND_MODES.SCREEN;
    this.colorMesh.zIndex = -10;
    this.colorMesh.eventMode = "none";
    this.colorMesh.cullable = false;
    this.colorMesh.size = this.visibleIndexCount;

    const hasVis = this.visibleIndexCount > 0 && this.activeLightsCount > 0;
    this.illumMesh.visible = hasVis;
    this.colorMesh.visible = hasVis;

    this.syncDepthElevations(false);

    if (deferredJobs.length > 0) {
      this._startDeferredPolyBake(
        deferredJobs,
        CSP,
        opts.onDeferredPolysReady || null,
        Number(opts.deferredBudgetMs) || 8
      );
    }
  }

  _startDeferredPolyBake(jobs, CSP, onReady, budgetMs = 8) {
    const gen = ++this._deferredBakeGen;
    let cursor = 0;
    const schedule = (fn) => {
      if (typeof globalThis.requestAnimationFrame === "function") {
        this._deferredBakeIsTimer = false;
        this._deferredBakeRaf = globalThis.requestAnimationFrame(fn);
      } else {
        this._deferredBakeIsTimer = true;
        this._deferredBakeRaf = setTimeout(fn, 0);
      }
    };

    const step = () => {
      this._deferredBakeRaf = null;
      if (this._deferredBakeGen !== gen) return;
      const t0 = performance.now();
      while (cursor < jobs.length) {
        const job = jobs[cursor++];
        const edges = job.ensureLocalEdges();
        const fakeLevel = job.getFakeLevel();
        const { offsets, hasNearbyWall } = computeSingleLightPoly(
          job.lx, job.ly, job.dimPx, job.angle, job.rotation, job.useWalls,
          edges, fakeLevel, CSP
        );
        this._polyCache.set(job.lightId, { sig: job.polySig, offsets, hasNearbyWall });
        if ((performance.now() - t0) >= budgetMs) break;
      }
      if (cursor < jobs.length) {
        schedule(step);
      } else if (this._deferredBakeGen === gen) {
        onReady?.();
      }
    };
    schedule(step);
  }

  /**
   * Background time-sliced light polygon prewarmer for adjacent (currently unviewed) levels.
   * Runs inside small idle slices (`<= budgetMs`) so 120 FPS never drops, populates `_polyCache`,
   * and persists finished level polygons into IndexedDB.
   */
  async prewarmLevelPolysTimeSliced(layerEntry, pxPerFt, resolveWallFn = null, resolveLightFn = null, {
    worldId = "world",
    sceneId = null,
    budgetMs = 5,
    shouldAbort = null,
    hasLevelEditsFn = null,
    getLevelCacheSigFn = null
  } = {}) {
    const { level, spec } = layerEntry || {};
    if (!level || !spec?.sectors || spec.chunks?.baseUrl || spec._superGridBase) {
      return { computed: 0, skipped: 0, aborted: false };
    }
    const EdgeCls = globalThis.foundry?.canvas?.geometry?.edges?.Edge;
    const CSP = globalThis.foundry?.canvas?.geometry?.ClockwiseSweepPolygon;
    if (!EdgeCls || !CSP) return { computed: 0, skipped: 0, aborted: false };

    const curSceneId = sceneId || canvas?.scene?.id || null;
    if (this._polyCacheSceneId && curSceneId && this._polyCacheSceneId !== curSceneId) {
      return { computed: 0, skipped: 0, aborted: true };
    }
    if (curSceneId) this._polyCacheSceneId = curSceneId;

    const levelId = level.id;
    const sectors = spec.sectors;
    const defaultLightElev = getLevelBaseElevation(level) + 6;
    const prevPxPerFt = this._buildPxPerFt;
    this._buildPxPerFt = pxPerFt;
    const nativeEdges = this._collectNativeWallEdges(levelId, EdgeCls);
    this._buildPxPerFt = prevPxPerFt;
    const rawExtraSig = getLevelCacheSigFn ? String(getLevelCacheSigFn(levelId) ?? "") : "";
    const extraLevelSig = rawExtraSig.replace(/\|od:[^|]*/g, "");
    const hasSigWallEdits = Boolean(extraLevelSig && /(?:^|\|)we:(?!0(?:\||$))/.test(extraLevelSig));
    const hasEditsOnLevel = Boolean(hasLevelEditsFn?.(levelId)) || hasSigWallEdits || nativeEdges.length > 0;
    const wallGeomHash = hashLevelWallGeometry(sectors);
    const levelCacheSig = `${levelId}|e:${hasEditsOnLevel ? 1 : 0}|${extraLevelSig}|nw:${this._buildNativeEdgesSig(nativeEdges)}|wg:${wallGeomHash}`;

    const bp = spec.bakedPolys;
    const canUseSpecBakedPolys = Boolean(
      bp && typeof bp === "object" && bp.polys && typeof bp.polys === "object" &&
      bp.wg === wallGeomHash &&
      (!bp.pxPerFt || Math.abs(bp.pxPerFt - pxPerFt) < 0.01) &&
      !hasEditsOnLevel
    );

    const simSectorPx = layerEntry.simSectorPx || spec.simSectorPx || ((spec.worldPx && spec.simGrid) ? (spec.worldPx / spec.simGrid) : 0);
    let sectorEdges = null;
    let localEdgeStore = null;
    let fakeLevel = null;
    const ensureEdgeCtx = () => {
      if (sectorEdges) return;
      sectorEdges = buildSectorEdgeMap(sectors, levelId, pxPerFt, EdgeCls, resolveWallFn, simSectorPx);
      const built = createLocalFakeLevel(level, spec.worldPx || 100000, levelId, EdgeCls);
      localEdgeStore = built.localEdgeStore;
      fakeLevel = built.fakeLevel;
    };

    let computed = 0;
    let skipped = 0;
    let sliceStart = performance.now();

    for (const [sk, sec] of Object.entries(sectors)) {
      if (shouldAbort?.() || (curSceneId && this._polyCacheSceneId !== curSceneId)) {
        return { computed, skipped, aborted: true };
      }
      if (!sec?.l?.length) continue;
      const [sx, sy] = sk.split("_").map(Number);
      let localEdges = null;
      const ensureLocalEdges = () => {
        if (localEdges) {
          localEdgeStore._list = localEdges;
          return localEdges;
        }
        ensureEdgeCtx();
        localEdges = collectEdgesInRadius(sectorEdges, nativeEdges, 0, 0, 0, 0, sx, sy);
        localEdgeStore._list = localEdges;
        return localEdges;
      };
      const getEdgesForLight = (lxVal, lyVal, dimVal) => {
        if (simSectorPx > 0 && (dimVal > simSectorPx || Math.floor(lxVal / simSectorPx) !== sx || Math.floor(lyVal / simSectorPx) !== sy)) {
          ensureEdgeCtx();
          const customEdges = collectEdgesInRadius(sectorEdges, nativeEdges, lxVal, lyVal, dimVal, simSectorPx, sx, sy);
          localEdgeStore._list = customEdges;
          return customEdges;
        }
        return ensureLocalEdges();
      };

      for (let li = 0; li < sec.l.length; li++) {
        if (shouldAbort?.() || (curSceneId && this._polyCacheSceneId !== curSceneId)) {
          return { computed, skipped, aborted: true };
        }
        const raw = sec.l[li];
        const extra = raw[8] && typeof raw[8] === "object" ? raw[8] : null;
        const resolved = resolveLightFn
          ? resolveLightFn(levelId, sk, li, raw, level)
          : {
              x: raw[0], y: raw[1], dim: raw[2], bright: raw[3],
              anim: raw[6] || "",
              hidden: Boolean(extra?.hidden),
              walls: extra?.walls !== false,
              angle: extra?.angle ?? 360,
              rotation: extra?.rotation ?? 0,
              elevation: Number.isFinite(raw[7]) ? raw[7] : defaultLightElev
            };
        if (!resolved || resolved.hidden) continue;
        const lx = resolved.x, ly = resolved.y;
        const dimPx = Math.max(resolved.dim || 0, resolved.bright || 0) * pxPerFt;
        const angle = resolved.angle ?? 360;
        const rotation = resolved.rotation ?? 0;
        const useWalls = resolved.walls !== false;
        if (dimPx <= 0 || angle <= 0) continue;

        const lightId = `${levelId}::${sk}_${li}`;
        const polySig = `${lx},${ly},${dimPx},${angle},${rotation},${useWalls ? 1 : 0}|${levelCacheSig}`;
        const existing = this._polyCache.get(lightId);
        if (existing && existing.sig === polySig) {
          skipped++;
          continue;
        }
        if (canUseSpecBakedPolys) {
          const pre = bp.polys[`${sk}_${li}`];
          const offsets = (Array.isArray(pre) && pre.length >= 6) ? Float32Array.from(pre) : null;
          let hasNearbyWall = false;
          if (offsets) {
            const animNorm = String(resolved.anim || "").trim().toLowerCase();
            if (useWalls && angle < 360 && ROTATE_ANIM_TYPES.has(animNorm)) {
              const edges = getEdgesForLight(lx, ly, dimPx);
              for (let ei = 0; ei < edges.length; ei++) {
                const e = edges[ei];
                if (Math.max(e.a.x, e.b.x) >= lx - dimPx && Math.min(e.a.x, e.b.x) <= lx + dimPx &&
                    Math.max(e.a.y, e.b.y) >= ly - dimPx && Math.min(e.a.y, e.b.y) <= ly + dimPx) {
                  hasNearbyWall = true;
                  break;
                }
              }
            } else {
              hasNearbyWall = useWalls;
            }
          }
          this._polyCache.set(lightId, { sig: polySig, offsets, hasNearbyWall });
          skipped++;
          continue;
        }

        const edges = getEdgesForLight(lx, ly, dimPx);
        const { offsets, hasNearbyWall } = computeSingleLightPoly(lx, ly, dimPx, angle, rotation, useWalls, edges, fakeLevel, CSP);
        this._polyCache.set(lightId, { sig: polySig, offsets, hasNearbyWall });
        computed++;

        if ((performance.now() - sliceStart) >= budgetMs) {
          await yieldIdleSlice();
          sliceStart = performance.now();
        }
      }
    }

    if (computed > 0 && curSceneId && !shouldAbort?.()) {
      this._hydratedPolyLevels.add(levelId);
      await this.persistPolyCacheToDB(worldId, curSceneId, [levelId]).catch(() => {});
    }
    return { computed, skipped, aborted: false };
  }

  _encodeDepthElev(meta, baseDepth = 1.0) {
    const aboveRoof = Number.isFinite(this.bakedRoofElevation) && (meta.elevation >= this.bakedRoofElevation);
    return aboveRoof ? (baseDepth + 10.0) : baseDepth;
  }

  /**
   * Re-map per-light elevations into Foundry v14's depthTexture [0..1] space
   * (encoding `aboveBakedRoof` as +10.0 so rooftop & upper-level lights are never cut by a lower level's bakedRoofMask).
   */
  syncDepthElevations(useDepth) {
    this.useDepthTexture = Boolean(useDepth);
    const hasMonolithic = Boolean(this.depthElevArray && this.depthElevBuffer);
    const hasChunks = this.chunkBatches.size > 0;
    if (!hasMonolithic && !hasChunks) return;

    const depthMask = this.useDepthTexture ? canvas.masks?.depth : null;
    if (depthMask) {
      // Ensure Foundry's primary children are sorted and depth mask elevation table is up to date before mapping
      if (canvas.primary?.sortDirty) canvas.primary.sortChildren();
      depthMask._elevationDirty = true;
      depthMask._update?.();
    }

    this._depthElevCheckMap.clear();
    let monoChanged = false;
    const dirtyChunkBatches = new Set();
    for (const meta of this.lightMetaById.values()) {
      const baseMapped = depthMask ? depthMask.mapElevation(meta.elevation) : 1.0;
      if (depthMask) this._depthElevCheckMap.set(meta.elevation, baseMapped);
      const encoded = this._encodeDepthElev(meta, baseMapped);
      if (meta.batch) {
        const arr = meta.batch.depthElevArray;
        if (arr && Math.abs(arr[meta.vStart] - encoded) > 0.0001) {
          arr.fill(encoded, meta.vStart, meta.vStart + meta.vCount);
          dirtyChunkBatches.add(meta.batch);
        }
      } else if (hasMonolithic) {
        if (Math.abs(this.depthElevArray[meta.vStart] - encoded) > 0.0001) {
          this.depthElevArray.fill(encoded, meta.vStart, meta.vStart + meta.vCount);
          monoChanged = true;
        }
      }
    }
    if (monoChanged) {
      this.depthElevBuffer.update();
    }
    for (const batch of dirtyChunkBatches) {
      batch.depthElevBuffer?.update();
    }
  }

  _checkDepthElevationsDirty() {
    if (!this.useDepthTexture || this._depthElevCheckMap.size === 0) return;
    const depthMask = canvas.masks?.depth;
    if (!depthMask) return;
    for (const [elev, lastMapped] of this._depthElevCheckMap) {
      if (Math.abs(depthMask.mapElevation(elev) - lastMapped) > 0.0001) {
        this.syncDepthElevations(true);
        return;
      }
    }
  }

  _cullBatch(batch, x0, y0, x1, y1, allowVisible) {
    if (!batch?.indexBuffer || !batch.illumMesh || !batch.colorMesh) return;
    if (!allowVisible) {
      batch.illumMesh.visible = false;
      batch.colorMesh.visible = false;
      return;
    }
    const cb = batch._lastCullBox;
    const vw = x1 - x0;
    const vh = y1 - y0;
    if (
      cb && batch._hasVisKey &&
      x0 >= cb.x0 && y0 >= cb.y0 && x1 <= cb.x1 && y1 <= cb.y1 &&
      (cb.x1 - cb.x0) <= vw * 1.5 + 1800 && (cb.y1 - cb.y0) <= vh * 1.5 + 1800
    ) {
      const hasVisible = batch.visibleIndexCount > 0 && batch.activeCount > 0;
      batch.illumMesh.visible = hasVisible;
      batch.colorMesh.visible = hasVisible;
      return;
    }
    const HYST_PX = 450;
    const cx0 = x0 - HYST_PX;
    const cy0 = y0 - HYST_PX;
    const cx1 = x1 + HYST_PX;
    const cy1 = y1 + HYST_PX;
    batch._lastCullBox = { x0: cx0, y0: cy0, x1: cx1, y1: cy1 };

    const sectors = batch.sectorBounds;
    const totalSec = sectors.length;
    let visCount = 0;
    let h1 = 2166136261 >>> 0;
    let h2 = 0;
    for (let i = 0; i < totalSec; i++) {
      const s = sectors[i];
      if (s.maxX >= cx0 && s.minX <= cx1 && s.maxY >= cy0 && s.minY <= cy1) {
        visCount++;
        h1 = Math.imul(h1 ^ i, 16777619) >>> 0;
        h2 = ((h2 << 5) - h2 + i + 1) | 0;
      }
    }
    if (!batch._hasVisKey || visCount !== batch._lastVisCount || h1 !== batch._lastVisH1 || h2 !== batch._lastVisH2) {
      batch._hasVisKey = true;
      batch._lastVisCount = visCount;
      batch._lastVisH1 = h1;
      batch._lastVisH2 = h2;
      let cursor = 0;
      if (visCount === totalSec && totalSec > 0) {
        batch.visibleIndices.set(batch.allIndices, 0);
        cursor = batch.allIndices.length;
      } else if (visCount > 0) {
        for (let i = 0; i < totalSec; i++) {
          const s = sectors[i];
          if (s.maxX >= cx0 && s.minX <= cx1 && s.maxY >= cy0 && s.minY <= cy1) {
            batch.visibleIndices.set(
              batch.allIndices.subarray(s.idxStart, s.idxStart + s.idxCount),
              cursor
            );
            cursor += s.idxCount;
          }
        }
      }
      batch.visibleIndexCount = cursor;
      batch.illumMesh.size = cursor;
      batch.colorMesh.size = cursor;
      if (cursor > 0) batch.indexBuffer.update();
    }
    const hasVisible = batch.visibleIndexCount > 0 && batch.activeCount > 0;
    batch.illumMesh.visible = hasVisible;
    batch.colorMesh.visible = hasVisible;
  }

  /**
   * Queue a loaded world chunk for non-blocking time-sliced GPU light baking (<= 6ms per animation frame).
   * If `chunkData.bakedPolys` is precomputed, skips `ClockwiseSweepPolygon` entirely (< 1ms upload).
   */
  queueChunkBake(layer, chunkKey, chunkData) {
    if (!layer?.level || !chunkData?.sectors) return;
    const level = layer.level;
    const levelId = level.id;
    const fullKey = `${levelId}::${chunkKey}`;
    this.detachChunk(levelId, chunkKey);

    const EdgeCls = foundry.canvas.geometry.edges.Edge;
    const sectors = chunkData.sectors;
    const allLevelSectors = layer.spec?.sectors || sectors;
    const overlays = layer.spec?.overlays || chunkData.overlays || {};
    const sectorEntries = Object.entries(sectors).filter(([, s]) => s?.l?.length);
    if (sectorEntries.length === 0) return;

    const nativeEdges = this._collectNativeWallEdges(levelId, EdgeCls);
    const hasEditsOnLevel = Boolean(this._hasLevelEditsFn?.(levelId));

    const pxPerFt = this._buildPxPerFt || 20;
    const simSectorPx = layer.simSectorPx || layer.spec?.simSectorPx || ((layer.worldPx && layer.simGrid) ? (layer.worldPx / layer.simGrid) : 0);
    // Avoid rebuilding walls across all 8 chunks when there are no wallEdits on this level:
    // index this chunk's sectors + a neighbor ring sized to cover the widest light in the chunk (min 2 sectors)
    let maxLightDimPx = 0;
    for (let si = 0; si < sectorEntries.length; si++) {
      const lights = sectorEntries[si][1]?.l;
      if (!lights) continue;
      for (let li = 0; li < lights.length; li++) {
        const raw = lights[li];
        const dPx = Math.max(raw[2] || 0, raw[3] || 0) * pxPerFt;
        if (dPx > maxLightDimPx) maxLightDimPx = dPx;
      }
    }
    const wallRing = simSectorPx > 0 ? Math.max(2, Math.ceil(maxLightDimPx / simSectorPx)) : 2;
    let wallSourceSectors;
    if (hasEditsOnLevel || allLevelSectors === sectors || wallRing >= 4) {
      wallSourceSectors = allLevelSectors === sectors ? sectors : { ...allLevelSectors, ...sectors };
    } else {
      wallSourceSectors = { ...sectors };
      for (const [sk] of sectorEntries) {
        const [sx, sy] = sk.split("_").map(Number);
        for (let dy = -wallRing; dy <= wallRing; dy++) {
          for (let dx = -wallRing; dx <= wallRing; dx++) {
            const nsk = `${sx + dx}_${sy + dy}`;
            if (!wallSourceSectors[nsk] && allLevelSectors[nsk]) wallSourceSectors[nsk] = allLevelSectors[nsk];
          }
        }
      }
    }
    const sectorEdges = buildSectorEdgeMap(wallSourceSectors, levelId, pxPerFt, EdgeCls, this._resolveWallFn, simSectorPx);

    const worldSpan = layer.worldPx || 100000;
    const b = chunkData.bounds || { x: 0, y: 0, w: worldSpan, h: worldSpan };
    const padB = LIGHT_PAD_WORLD_PX;
    const obMinX = Math.min(-padB, b.x - padB);
    const obMinY = Math.min(-padB, b.y - padB);
    const obMaxX = Math.max(worldSpan + padB, b.x + b.w + padB);
    const obMaxY = Math.max(worldSpan + padB, b.y + b.h + padB);
    const outerBounds = [
      new EdgeCls({ x: obMinX, y: obMinY }, { x: obMaxX, y: obMinY }, { id: "cb_t", type: "outerBounds" }),
      new EdgeCls({ x: obMaxX, y: obMinY }, { x: obMaxX, y: obMaxY }, { id: "cb_r", type: "outerBounds" }),
      new EdgeCls({ x: obMaxX, y: obMaxY }, { x: obMinX, y: obMaxY }, { id: "cb_b", type: "outerBounds" }),
      new EdgeCls({ x: obMinX, y: obMaxY }, { x: obMinX, y: obMinY }, { id: "cb_l", type: "outerBounds" })
    ];
    const localEdgeStore = {
      _list: [],
      getEdges(bbox, { includeOuterBounds = true, collisionTest, collisionTestBounds = false } = {}) {
        const out = new Set();
        for (const e of this._list) {
          if (bbox && (Math.max(e.a.x, e.b.x) < bbox.x || Math.min(e.a.x, e.b.x) > bbox.right ||
              Math.max(e.a.y, e.b.y) < bbox.y || Math.min(e.a.y, e.b.y) > bbox.bottom)) continue;
          if (!collisionTest || collisionTest(e)) out.add(e);
        }
        if (includeOuterBounds) {
          const boundsTest = collisionTestBounds ? collisionTest : null;
          for (const outer of outerBounds) {
            if (!boundsTest || boundsTest(outer)) out.add(outer);
          }
        }
        if (out.size > 1 && EdgeCls.identifyEdgeIntersections) {
          EdgeCls.identifyEdgeIntersections(out, levelId);
        }
        return out;
      }
    };
    const fakeLevel = Object.create(level, { edges: { value: localEdgeStore, enumerable: true } });

    this._chunkBakeQueue.push({
      gen: this._chunkBakeGen,
      fullKey,
      chunkKey,
      levelId,
      level,
      simSectorPx,
      sectors,
      allLevelSectors,
      overlays,
      nativeEdges,
      hasEditsOnLevel,
      bakedPolys: chunkData.bakedPolys || null,
      sectorEntries,
      sectorEdges,
      localEdgeStore,
      fakeLevel,
      secIdx: 0,
      centersArr: [],
      offsetsArr: [],
      paramsArr: [],
      colorsArr: [],
      stylesArr: [],
      indicesArr: [],
      sectorBounds: [],
      metas: [],
      vertCursor: 0
    });
    this._scheduleChunkBakePump();
  }

  _scheduleChunkBakePump() {
    if (this._chunkBakeRaf !== null || this._chunkBakeQueue.length === 0) return;
    const useRaf = typeof requestAnimationFrame === "function";
    this._chunkBakeIsTimer = !useRaf;
    const sched = useRaf ? requestAnimationFrame : (fn) => setTimeout(fn, 0);
    this._chunkBakeRaf = sched(() => {
      this._chunkBakeRaf = null;
      this._chunkBakeIsTimer = false;
      this._pumpChunkBakeQueue();
    });
  }

  _pumpChunkBakeQueue() {
    const isMoving = Boolean(globalThis.Boundless?.isActivelyMoving?.());
    const budgetMs = isMoving ? 1.5 : 2.5; // Keep chunk shadow baking well inside a 120 FPS (8.33ms) frame
    const startMs = performance.now();
    const CSP = foundry.canvas.geometry.ClockwiseSweepPolygon;
    const pxPerFt = this._buildPxPerFt || 20;
    let didWork = false;

    while (this._chunkBakeQueue.length > 0 && (!didWork || (performance.now() - startMs) < budgetMs)) {
      const job = this._chunkBakeQueue[0];
      if (job.gen !== this._chunkBakeGen) {
        this._chunkBakeQueue.shift();
        continue;
      }

      const defaultLightElev = getLevelBaseElevation(job.level) + 6;
      const topElev = getLevelRoofElevation(job.level);

      while ((job.curSec || job.secIdx < job.sectorEntries.length) && (!didWork || (performance.now() - startMs) < budgetMs)) {
        if (!job.curSec) {
          const [sk, sec] = job.sectorEntries[job.secIdx++];
          const [sx, sy] = sk.split("_").map(Number);
          job.curSec = {
            sk,
            sec,
            sx,
            sy,
            localEdges: collectEdgesInRadius(job.sectorEdges, job.nativeEdges, 0, 0, 0, 0, sx, sy),
            idxStart: job.indicesArr.length,
            minX: Infinity,
            minY: Infinity,
            maxX: -Infinity,
            maxY: -Infinity,
            lightIdx: 0
          };
        }
        const cs = job.curSec;
        const { sk, sec, sx, sy, localEdges } = cs;

        for (; cs.lightIdx < sec.l.length; cs.lightIdx++) {
          if (didWork && (performance.now() - startMs) >= budgetMs) break;
          didWork = true;
          const li = cs.lightIdx;
          const raw = sec.l[li];
          const extra = raw[8] && typeof raw[8] === "object" ? raw[8] : null;
          const resolved = this._resolveLightFn
            ? this._resolveLightFn(job.levelId, sk, li, raw, job.level)
            : {
                x: raw[0], y: raw[1], dim: raw[2], bright: raw[3],
                color: raw[4], alpha: raw[5] ?? 0.5, anim: raw[6] || "",
                elevation: Number.isFinite(raw[7]) ? raw[7] : defaultLightElev,
                hidden: Boolean(extra?.hidden),
                walls: extra?.walls !== false,
                angle: extra?.angle ?? 360,
                rotation: extra?.rotation ?? 0,
                darkMin: extra?.darkMin ?? 0,
                darkMax: extra?.darkMax ?? 1,
                ...extractLightStyle(extra)
              };
          if (!resolved || resolved.hidden) continue;
          const lx = resolved.x, ly = resolved.y;
          const dimPx = Math.max(resolved.dim || 0, resolved.bright || 0) * pxPerFt;
          const angle = resolved.angle ?? 360;
          const rotation = resolved.rotation ?? 0;
          const useWalls = resolved.walls !== false;
          const darkMin = resolved.darkMin ?? 0;
          const darkMax = resolved.darkMax ?? 1;
          const style = extractLightStyle(resolved);
          const shaderAtt = computeShaderAttenuation(style.attenuation);
          if (dimPx <= 0 || angle <= 0) continue;

          const elevation = Number.isFinite(resolved.elevation) ? resolved.elevation : defaultLightElev;
          const ratio = Math.min(1, ((resolved.bright || 0) * pxPerFt) / dimPx);
          const aVal = resolved.alpha ?? 0.5;
          let r = 0, g = 0, b = 0;
          if (resolved.color) {
            const rgb = resolveColorRgb(resolved.color);
            r = rgb[0]; g = rgb[1]; b = rgb[2];
          }
          const basePhase = Math.abs(Math.sin(lx * 0.0137 + ly * 0.0193 + elevation * 0.31) * 100.0);
          let hasNearbyWall = false;
          let prebaked = null;
          const canUsePrebaked = !job.hasEditsOnLevel && job.nativeEdges.length === 0 && useWalls && angle >= 360;
          if (canUsePrebaked) prebaked = job.bakedPolys?.[`${sk}_${li}`] || null;
          const lightEdges = (job.simSectorPx > 0 && (dimPx > job.simSectorPx || Math.floor(lx / job.simSectorPx) !== sx || Math.floor(ly / job.simSectorPx) !== sy))
            ? collectEdgesInRadius(job.sectorEdges, job.nativeEdges, lx, ly, dimPx, job.simSectorPx, sx, sy)
            : localEdges;
          job.localEdgeStore._list = lightEdges;
          if (!(Array.isArray(prebaked) && prebaked.length >= 6) && useWalls) {
            for (let ei = 0; ei < lightEdges.length; ei++) {
              const e = lightEdges[ei];
              if (Math.max(e.a.x, e.b.x) >= lx - dimPx && Math.min(e.a.x, e.b.x) <= lx + dimPx &&
                  Math.max(e.a.y, e.b.y) >= ly - dimPx && Math.min(e.a.y, e.b.y) <= ly + dimPx) {
                hasNearbyWall = true;
                break;
              }
            }
          }
          const canRotateCone = angle < 360 && !(useWalls && hasNearbyWall);
          const phase = encodeLightAnimPhase(resolved.anim, basePhase, canRotateCone);
          const effAlpha = aVal * getAnimColorationGain(resolved.anim);

          const vStart = job.vertCursor;
          const pushV = (ox, oy) => {
            job.centersArr.push(lx, ly);
            job.offsetsArr.push(ox, oy);
            job.paramsArr.push(dimPx, ratio, effAlpha, phase);
            job.colorsArr.push(r, g, b);
            job.stylesArr.push(shaderAtt, style.luminosity, style.speed, style.intensity);
            return job.vertCursor++;
          };

          let builtPoly = false;
          if (Array.isArray(prebaked) && prebaked.length >= 6) {
            const nPts = prebaked.length >> 1;
            const cIdx = pushV(0, 0);
            const rStart = job.vertCursor;
            for (let i = 0; i < nPts; i++) pushV(prebaked[i * 2], prebaked[i * 2 + 1]);
            for (let i = 0; i < nPts; i++) job.indicesArr.push(cIdx, rStart + i, rStart + ((i + 1) % nPts));
            builtPoly = true;
          } else {
            if ((useWalls && hasNearbyWall) || angle < 360) {
              const poly = new CSP();
              poly.initialize({ x: lx, y: ly }, {
                type: "light",
                level: job.fakeLevel,
                edgeTypes: { wall: useWalls },
                radius: dimPx,
                angle,
                rotation,
                density: 32,
                hasLimitedRadius: true,
                useThreshold: true
              });
              poly.compute();
              const pts = poly.points;
              const nPts = pts.length >> 1;
              if (nPts >= 3) {
                const cIdx = pushV(0, 0);
                const rStart = job.vertCursor;
                const invR = 1 / dimPx;
                for (let i = 0; i < nPts; i++) {
                  let ox = (pts[i * 2] - lx) * invR;
                  let oy = (pts[i * 2 + 1] - ly) * invR;
                  const len = Math.hypot(ox, oy);
                  if (len > 1.001) { ox /= len; oy /= len; }
                  pushV(ox, oy);
                }
                for (let i = 0; i < nPts; i++) job.indicesArr.push(cIdx, rStart + i, rStart + ((i + 1) % nPts));
                builtPoly = true;
              }
            }
          }

          if (!builtPoly) {
            const v0 = pushV(-1, -1);
            const v1 = pushV(1, -1);
            const v2 = pushV(1, 1);
            const v3 = pushV(-1, 1);
            job.indicesArr.push(v0, v1, v2, v0, v2, v3);
          }

          let isIndoor = false;
          if (elevation < topElev && job.overlays) {
            const lsx = job.simSectorPx > 0 ? Math.floor(lx / job.simSectorPx) : sx;
            const lsy = job.simSectorPx > 0 ? Math.floor(ly / job.simSectorPx) : sy;
            for (let dy = -1; dy <= 1 && !isIndoor; dy++) {
              for (let dx = -1; dx <= 1 && !isIndoor; dx++) {
                const oList = (job.sectors[`${lsx + dx}_${lsy + dy}`] || job.allLevelSectors[`${lsx + dx}_${lsy + dy}`])?.o;
                if (!oList?.length) continue;
                for (const oid of oList) {
                  if (isPointUnderRoofSpec(lx, ly, job.overlays[oid])) {
                    isIndoor = true;
                    break;
                  }
                }
              }
            }
          }

          if (darkMin > 0 || darkMax < 1) this._hasDarknessRangedLights = true;
          const lightId = `${job.levelId}::${sk}_${li}`;
          const suppressed = Boolean(this._isSuppressedFn?.(lightId));
          const rawEntry = [lx, ly, resolved.dim, resolved.bright, resolved.color, aVal, resolved.anim, elevation];
          if (extra) rawEntry.push(extra);
          job.metas.push({
            id: lightId,
            levelId: job.levelId,
            elevation, sk, lx, ly, dimPx,
            vStart, vCount: job.vertCursor - vStart,
            weight: 1.0, baseWeight: suppressed ? 0.0 : 1.0, isIndoor,
            walls: useWalls, angle, rotation, darkMin, darkMax,
            speed: style.speed, intensity: style.intensity, coloration: style.coloration,
            attenuation: style.attenuation, luminosity: style.luminosity,
            raw: rawEntry
          });
          if (lx - dimPx < cs.minX) cs.minX = lx - dimPx;
          if (ly - dimPx < cs.minY) cs.minY = ly - dimPx;
          if (lx + dimPx > cs.maxX) cs.maxX = lx + dimPx;
          if (ly + dimPx > cs.maxY) cs.maxY = ly + dimPx;
        }

        if (cs.lightIdx >= sec.l.length) {
          const idxCount = job.indicesArr.length - cs.idxStart;
          if (idxCount > 0) {
            job.sectorBounds.push({
              levelId: job.levelId, sk,
              minX: cs.minX, minY: cs.minY, maxX: cs.maxX, maxY: cs.maxY,
              idxStart: cs.idxStart, idxCount
            });
          }
          job.curSec = null;
        }
      }

      if (!job.curSec && job.secIdx >= job.sectorEntries.length) {
        if (didWork && (performance.now() - startMs) >= budgetMs) {
          // Defer GPU geometry finalization & perception hook to the next animation frame
          break;
        }
        this._chunkBakeQueue.shift();
        this._finalizeChunkBatch(job);
        didWork = true;
      }
    }

    if (this._chunkBakeQueue.length > 0) {
      this._scheduleChunkBakePump();
    }
  }

  _finalizeChunkBatch(job) {
    if (job.gen !== this._chunkBakeGen || job.vertCursor === 0 || job.indicesArr.length === 0) return;
    this._ensureShaders();

    const weights = new Float32Array(job.vertCursor);
    weights.fill(1.0);
    const depthElevs = new Float32Array(job.vertCursor);
    const depthMask = this.useDepthTexture ? canvas.masks?.depth : null;
    let otherBatchesStale = false;
    if (depthMask) {
      if (canvas.primary?.sortDirty) canvas.primary.sortChildren();
      depthMask._elevationDirty = true;
      depthMask._update?.();
      const hadOtherBatches = this.chunkBatches.size > 0 || Boolean(this.depthElevArray && this.depthElevBuffer);
      for (const meta of job.metas) {
        const mapped = depthMask.mapElevation(meta.elevation);
        const prev = this._depthElevCheckMap.get(meta.elevation);
        if (hadOtherBatches && prev !== undefined && Math.abs(prev - mapped) > 0.0001) {
          otherBatchesStale = true;
        }
        this._depthElevCheckMap.set(meta.elevation, mapped);
        depthElevs.fill(this._encodeDepthElev(meta, mapped), meta.vStart, meta.vStart + meta.vCount);
      }
    } else {
      for (const meta of job.metas) {
        depthElevs.fill(this._encodeDepthElev(meta, 1.0), meta.vStart, meta.vStart + meta.vCount);
      }
    }
    const IdxArr = job.vertCursor > 65535 ? Uint32Array : Uint16Array;
    const allIndices = new IdxArr(job.indicesArr);
    const visibleIndices = new IdxArr(job.indicesArr);

    const weightBuffer = new PIXI.Buffer(weights, false, false);
    const depthElevBuffer = new PIXI.Buffer(depthElevs, false, false);
    const indexBuffer = new PIXI.Buffer(visibleIndices, false, true);

    const geometry = new PIXI.Geometry()
      .addAttribute("aCenter", new Float32Array(job.centersArr), 2)
      .addAttribute("aOffset", new Float32Array(job.offsetsArr), 2)
      .addAttribute("aParams", new Float32Array(job.paramsArr), 4)
      .addAttribute("aColor", new Float32Array(job.colorsArr), 3)
      .addAttribute("aStyle", new Float32Array(job.stylesArr), 4)
      .addAttribute("aWeight", weightBuffer, 1)
      .addAttribute("aDepthElev", depthElevBuffer, 1)
      .addIndex(indexBuffer);

    const illumMesh = new PIXI.Mesh(geometry, this.illumShader);
    illumMesh.blendMode = PIXI.BLEND_MODES.MAX_COLOR;
    illumMesh.zIndex = -10;
    illumMesh.eventMode = "none";
    illumMesh.cullable = false;
    illumMesh.size = allIndices.length;

    const colorMesh = new PIXI.Mesh(geometry, this.colorShader);
    colorMesh.blendMode = PIXI.BLEND_MODES.SCREEN;
    colorMesh.zIndex = -10;
    colorMesh.eventMode = "none";
    colorMesh.cullable = false;
    colorMesh.size = allIndices.length;

    const batch = {
      key: job.fullKey,
      levelId: job.levelId,
      geometry,
      illumMesh,
      colorMesh,
      sectorBounds: job.sectorBounds,
      allIndices,
      visibleIndices,
      visibleIndexCount: allIndices.length,
      indexBuffer,
      weightArray: weights,
      weightBuffer,
      weightsDirty: false,
      depthElevArray: depthElevs,
      depthElevBuffer,
      lightIds: [],
      activeCount: 0,
      lastVisKey: ""
    };

    for (const meta of job.metas) {
      meta.batch = batch;
      meta.baseWeight = this._isSuppressedFn?.(meta.id) ? 0.0 : 1.0;
      batch.lightIds.push(meta.id);
      this.lightMetaById.set(meta.id, meta);
      const eff = this._computeEffectiveWeight(meta);
      meta.weight = eff;
      if (eff > 0.001) {
        batch.activeCount++;
      }
      if (eff !== 1.0) {
        weights.fill(eff, meta.vStart, meta.vStart + meta.vCount);
        batch.weightsDirty = true;
      }
    }
    if (batch.weightsDirty) {
      weightBuffer.update();
      batch.weightsDirty = false;
    }

    this.chunkBatches.set(job.fullKey, batch);
    if (otherBatchesStale) this.syncDepthElevations(true);
    this.totalLights += job.metas.length;
    this.activeLightsCount += batch.activeCount;
    this.totalVertices += job.vertCursor;

    const initVis = batch.activeCount > 0 && Boolean(this._lastVp);
    illumMesh.visible = initVis;
    colorMesh.visible = initVis;

    const effects = this._effects || canvas?.effects;
    if (effects) this._attachSingleBatch(batch, effects);
    if (this._lastVp) {
      const vp = this._lastVp;
      const effScale = getEffectiveScale(vp.scale);
      const showDetail = !this.macroBatch || effScale >= 0.020;
      this._cullBatch(batch, vp.x0 - LIGHT_PAD_WORLD_PX, vp.y0 - LIGHT_PAD_WORLD_PX, vp.x1 + LIGHT_PAD_WORLD_PX, vp.y1 + LIGHT_PAD_WORLD_PX, showDetail);
      this._updateMacroCrossfade(vp.scale);
    }
    this._onBatchChanged?.();
    this._onChunkBaked?.(job.levelId, job.chunkKey);
  }

  detachChunk(levelId, chunkKey) {
    const fullKey = `${levelId}::${chunkKey}`;
    // Cancel queued bake if still pending
    this._chunkBakeQueue = this._chunkBakeQueue.filter(j => j.fullKey !== fullKey);

    const batch = this.chunkBatches.get(fullKey);
    if (!batch) return;
    this.chunkBatches.delete(fullKey);

    for (const lid of batch.lightIds) {
      const meta = this.lightMetaById.get(lid);
      if (meta && meta.batch === batch) {
        if (meta.weight > 0.001) this.activeLightsCount = Math.max(0, this.activeLightsCount - 1);
        this.totalLights = Math.max(0, this.totalLights - 1);
        this.lightMetaById.delete(lid);
      }
    }
    this.totalVertices = Math.max(0, this.totalVertices - (batch.weightArray?.length || 0));

    batch.illumMesh?.parent?.removeChild(batch.illumMesh);
    batch.illumMesh?.destroy({ children: false });
    batch.colorMesh?.parent?.removeChild(batch.colorMesh);
    batch.colorMesh?.destroy({ children: false });
    this._destroyGeometry(batch.geometry);
    if (this._lastVp) this._updateMacroCrossfade(this._lastVp.scale);
    this._onBatchChanged?.();
  }

  _updateMacroCrossfade(scale) {
    const mb = this.macroBatch;
    if (!mb) return;
    const effScale = getEffectiveScale(scale);
    const showMacro = effScale < 0.036;
    if (!showMacro) {
      mb.illumMesh.visible = false;
      mb.colorMesh.visible = false;
      return;
    }
    // Smoothly fade orbital glow out across [0.018..0.035] (in 100-PPI equivalent scale) once detailed chunks are mounted
    const targetAlpha = this.chunkBatches.size > 0
      ? (1.0 - smoothstep(0.018, 0.035, effScale))
      : 1.0;
    if (Math.abs(targetAlpha - mb.lastAlpha) > 0.015) {
      mb.lastAlpha = targetAlpha;
      mb.weightArray.fill(targetAlpha);
      mb.weightBuffer.update();
    }
    const vis = targetAlpha > 0.01;
    mb.illumMesh.visible = vis;
    mb.colorMesh.visible = vis;
  }

  hasVisibleLights() {
    if (this.illumMesh?.visible || this.colorMesh?.visible) return true;
    if (this.macroBatch?.illumMesh?.visible || this.macroBatch?.colorMesh?.visible) return true;
    for (const batch of this.chunkBatches.values()) {
      if (batch.illumMesh?.visible || batch.colorMesh?.visible) return true;
    }
    return false;
  }

  countAttachedColorMeshes(coloration) {
    if (!coloration) return 0;
    let count = 0;
    if (this.colorMesh?.parent === coloration) count++;
    if (this.macroBatch?.colorMesh?.parent === coloration) count++;
    for (const batch of this.chunkBatches.values()) {
      if (batch.colorMesh?.parent === coloration) count++;
    }
    return count;
  }

  updateViewport(vp) {
    this._lastVp = vp;
    const x0 = vp.x0 - LIGHT_PAD_WORLD_PX;
    const y0 = vp.y0 - LIGHT_PAD_WORLD_PX;
    const x1 = vp.x1 + LIGHT_PAD_WORLD_PX;
    const y1 = vp.y1 + LIGHT_PAD_WORLD_PX;

    // 1. Orbital macro glow layer for chunked continental worlds (smooth crossfade out over [0.035..0.068])
    if (this.macroBatch) {
      this._updateMacroCrossfade(vp.scale);
    }

    // 2. Streamed per-chunk detailed shadowed light batches (active when zoomed below orbital scale)
    if (this.chunkBatches.size > 0) {
      const showDetail = !this.macroBatch || getEffectiveScale(vp.scale) >= 0.020;
      for (const batch of this.chunkBatches.values()) {
        this._cullBatch(batch, x0, y0, x1, y1, showDetail);
      }
    }

    // 3. Monolithic single-buffer batch (classic 1000x1000 scenes)
    if (!this.indexBuffer || !this.illumMesh || !this.colorMesh) return;
    // O(1) hysteresis box check: skip sector scan & GPU indexBuffer re-pack while camera stays inside buffered cull box
    // Also rebuild when viewport shrinks significantly on Zoom-In so frustum culling stays tight!
    const cb = this._lastCullBox;
    const vw = x1 - x0;
    const vh = y1 - y0;
    if (
      cb && this.lastVisKey &&
      x0 >= cb.x0 && y0 >= cb.y0 && x1 <= cb.x1 && y1 <= cb.y1 &&
      (cb.x1 - cb.x0) <= vw * 1.5 + 1800 && (cb.y1 - cb.y0) <= vh * 1.5 + 1800
    ) {
      return;
    }
    const HYST_PX = 450;
    const cx0 = x0 - HYST_PX;
    const cy0 = y0 - HYST_PX;
    const cx1 = x1 + HYST_PX;
    const cy1 = y1 + HYST_PX;
    this._lastCullBox = { x0: cx0, y0: cy0, x1: cx1, y1: cy1 };

    const sectors = this.sectorBounds;
    const totalSec = sectors.length;
    let visCount = 0;
    let h1 = 2166136261 >>> 0;
    let h2 = 0;
    for (let i = 0; i < totalSec; i++) {
      const s = sectors[i];
      if (s.maxX >= cx0 && s.minX <= cx1 && s.maxY >= cy0 && s.minY <= cy1) {
        visCount++;
        h1 = Math.imul(h1 ^ i, 16777619) >>> 0;
        h2 = ((h2 << 5) - h2 + i + 1) | 0;
      }
    }
    if (this.lastVisKey && visCount === this._lastVisCount && h1 === this._lastVisH1 && h2 === this._lastVisH2) {
      return;
    }
    this._lastVisCount = visCount;
    this._lastVisH1 = h1;
    this._lastVisH2 = h2;
    this.lastVisKey = `${visCount}:${h1}:${h2}`;

    let cursor = 0;
    if (visCount === totalSec && totalSec > 0) {
      this.visibleIndices.set(this.allIndices, 0);
      cursor = this.allIndices.length;
    } else if (visCount > 0) {
      for (let i = 0; i < totalSec; i++) {
        const s = sectors[i];
        if (s.maxX >= cx0 && s.minX <= cx1 && s.maxY >= cy0 && s.minY <= cy1) {
          this.visibleIndices.set(
            this.allIndices.subarray(s.idxStart, s.idxStart + s.idxCount),
            cursor
          );
          cursor += s.idxCount;
        }
      }
    }

    this.visibleIndexCount = cursor;
    this.illumMesh.size = cursor;
    this.colorMesh.size = cursor;
    const hasVisible = cursor > 0 && this.activeLightsCount > 0;
    this.illumMesh.visible = hasVisible;
    this.colorMesh.visible = hasVisible;
    if (cursor > 0) {
      this.indexBuffer.update();
    }
  }

  _getEffectiveShaderTime() {
    if (canvas.effects?.animateLightSources === false) return -1.0;
    this._frozenTime = (canvas.app?.ticker?.lastTime || 0) * 0.001;
    return this._frozenTime;
  }

  _updateIllumUniforms() {
    const u = this.illumShader?.uniforms;
    if (!u || !canvas?.ready) return;
    const tickTime = canvas.app?.ticker?.lastTime ?? -1;
    const scale = canvas.stage?.scale?.x || 1;
    const sw = canvas.screenDimensions?.[0] || 1;
    const sh = canvas.screenDimensions?.[1] || 1;
    const dark = canvas.environment?.darknessLevel ?? 0;
    const animOn = canvas.effects?.animateLightSources !== false;
    const dynDark = Boolean(canvas.effects?.illumination?.hasDynamicDarknessLevel);
    // Deduplicate across up to 9 chunk meshes sharing the same illumShader in a single render frame
    if (
      tickTime > 0 &&
      this._lastIllumShader === this.illumShader &&
      tickTime === this._lastIllumTick &&
      scale === this._lastIllumScale &&
      sw === this._lastIllumSw &&
      sh === this._lastIllumSh &&
      dark === this._lastIllumDark &&
      animOn === this._lastIllumAnim &&
      dynDark === this._lastIllumDyn &&
      this.useDepthTexture === this._lastIllumDepth &&
      this.useBakedRoofMask === this._lastIllumRoof &&
      this.bakedRoofMask === this._lastIllumRoofTex
    ) {
      return;
    }
    this._lastIllumShader = this.illumShader;
    this._lastIllumTick = tickTime;
    this._lastIllumScale = scale;
    this._lastIllumSw = sw;
    this._lastIllumSh = sh;
    this._lastIllumDark = dark;
    this._lastIllumAnim = animOn;
    this._lastIllumDyn = dynDark;
    this._lastIllumDepth = this.useDepthTexture;
    this._lastIllumRoof = this.useBakedRoofMask;
    this._lastIllumRoofTex = this.bakedRoofMask;

    this._checkDepthElevationsDirty();
    u.uTime = this._getEffectiveShaderTime();
    u.uStageScale = scale;
    u.uScreenDimensions[0] = sw;
    u.uScreenDimensions[1] = sh;

    const illum = canvas.effects?.illumination;
    const isDynamic = Boolean(illum?.hasDynamicDarknessLevel && isTextureUsable(illum?.renderTexture));
    u.uHasDarknessTexture = isDynamic;
    u.uDarknessLevelTexture = isDynamic ? illum.renderTexture : PIXI.Texture.EMPTY;

    const depthTex = canvas.masks?.depth?.renderTexture;
    u.uUseDepthTexture = Boolean(this.useDepthTexture && isTextureUsable(depthTex));
    u.uDepthTexture = u.uUseDepthTexture ? depthTex : PIXI.Texture.EMPTY;

    const hasRoofMask = Boolean(this.useBakedRoofMask && isTextureUsable(this.bakedRoofMask));
    u.uUseBakedRoofMask = hasRoofMask;
    u.uBakedRoofMask = hasRoofMask ? this.bakedRoofMask : PIXI.Texture.EMPTY;
    if (hasRoofMask) {
      u.uBakedRoofRepeat = this.bakedRoofRepeat;
    }

    const c = canvas.colors;
    const dl = u.uAmbientDaylight;
    const dk = u.uAmbientDarkness;
    const br = u.uAmbientBrightest;
    if (c?.ambientDaylight) c.ambientDaylight.applyRGB(dl);
    if (c?.ambientDarkness) c.ambientDarkness.applyRGB(dk);
    if (c?.ambientBrightest) c.ambientBrightest.applyRGB(br);

    const w = canvas.environment?.weights;
    if (w) {
      u.uWeights[0] = w.dark;
      u.uWeights[1] = w.halfdark;
      u.uWeights[2] = w.dim;
      u.uWeights[3] = w.bright;
    }

    if (!isDynamic) {
      const d = canvas.environment?.darknessLevel ?? 0;
      const wBright = u.uWeights[3];
      const wDim = u.uWeights[2];
      const sBg = u.uStaticBg;
      const sBr = u.uStaticBright;
      const sDm = u.uStaticDim;
      for (let i = 0; i < 3; i++) {
        const bg = dl[i] + (dk[i] - dl[i]) * d;
        const bright = Math.max(bg, bg + (br[i] - bg) * wBright);
        const dim = Math.max(bg, bg + (bright - bg) * wDim);
        sBg[i] = bg;
        sBr[i] = bright;
        sDm[i] = dim;
      }
    }
  }

  _updateColorUniforms() {
    const u = this.colorShader?.uniforms;
    if (!u || !canvas?.ready) return;
    const tickTime = canvas.app?.ticker?.lastTime ?? -1;
    const scale = canvas.stage?.scale?.x || 1;
    const sw = canvas.screenDimensions?.[0] || 1;
    const sh = canvas.screenDimensions?.[1] || 1;
    const animOn = canvas.effects?.animateLightSources !== false;
    if (
      tickTime > 0 &&
      this._lastColorShader === this.colorShader &&
      tickTime === this._lastColorTick &&
      scale === this._lastColorScale &&
      sw === this._lastColorSw &&
      sh === this._lastColorSh &&
      animOn === this._lastColorAnim &&
      this.useDepthTexture === this._lastColorDepth &&
      this.useBakedRoofMask === this._lastColorRoof &&
      this.bakedRoofMask === this._lastColorRoofTex
    ) {
      return;
    }
    this._lastColorShader = this.colorShader;
    this._lastColorTick = tickTime;
    this._lastColorScale = scale;
    this._lastColorSw = sw;
    this._lastColorSh = sh;
    this._lastColorAnim = animOn;
    this._lastColorDepth = this.useDepthTexture;
    this._lastColorRoof = this.useBakedRoofMask;
    this._lastColorRoofTex = this.bakedRoofMask;

    this._checkDepthElevationsDirty();
    u.uTime = this._getEffectiveShaderTime();
    u.uStageScale = scale;
    u.uScreenDimensions[0] = sw;
    u.uScreenDimensions[1] = sh;

    const primTex = canvas.primary?.renderTexture;
    const hasPrim = isTextureUsable(primTex);
    u.uHasPrimaryTexture = hasPrim;
    u.uPrimaryTexture = hasPrim ? primTex : PIXI.Texture.WHITE;

    const depthTex = canvas.masks?.depth?.renderTexture;
    u.uUseDepthTexture = Boolean(this.useDepthTexture && isTextureUsable(depthTex));
    u.uDepthTexture = u.uUseDepthTexture ? depthTex : PIXI.Texture.EMPTY;

    const hasRoofMask = Boolean(this.useBakedRoofMask && isTextureUsable(this.bakedRoofMask));
    u.uUseBakedRoofMask = hasRoofMask;
    u.uBakedRoofMask = hasRoofMask ? this.bakedRoofMask : PIXI.Texture.EMPTY;
    if (hasRoofMask) {
      u.uBakedRoofRepeat = this.bakedRoofRepeat;
    }

    u.uMacroLift = smoothstep(0.14, 0.025, getEffectiveScale(scale));
  }

  _applyMetaEffectiveWeight(meta) {
    const eff = this._computeEffectiveWeight(meta);
    if (Math.abs(meta.weight - eff) <= 0.0005) return;
    const wasActive = meta.weight > 0.001;
    const isActive = eff > 0.001;
    if (wasActive !== isActive) {
      const delta = isActive ? 1 : -1;
      this.activeLightsCount += delta;
      if (meta.batch) meta.batch.activeCount += delta;
    }
    meta.weight = eff;
    if (meta.batch) {
      meta.batch.weightArray.fill(eff, meta.vStart, meta.vStart + meta.vCount);
      meta.batch.weightsDirty = true;
    } else if (this.weightArray) {
      this.weightArray.fill(eff, meta.vStart, meta.vStart + meta.vCount);
      this.weightsDirty = true;
    }
  }

  syncDarknessLevel(darkness) {
    const next = Number.isFinite(darkness) ? darkness : 0;
    const prev = this._currentDarkness;
    if (Math.abs(next - prev) <= 0.0001) return false;
    this._currentDarkness = next;
    if (!this._hasDarknessRangedLights) return false;
    if (!this.weightArray && this.chunkBatches.size === 0) return false;
    let thresholdCrossed = false;
    for (const meta of this.lightMetaById.values()) {
      if (meta.darkMin > 0 || meta.darkMax < 1) {
        const wasActive = prev >= meta.darkMin && prev <= meta.darkMax;
        const isActive = next >= meta.darkMin && next <= meta.darkMax;
        if (wasActive !== isActive) {
          thresholdCrossed = true;
          this._applyMetaEffectiveWeight(meta);
        }
      }
    }
    if (thresholdCrossed) this.flushWeights();
    return thresholdCrossed;
  }

  setLightWeight(lightId, weight) {
    const meta = this.lightMetaById.get(lightId);
    if (!meta || (!meta.batch && !this.weightArray)) return;
    meta.baseWeight = Math.max(0, Math.min(1, weight));
    this._applyMetaEffectiveWeight(meta);
  }

  setBakedRoofMask(rt, { originX = 0, originY = 0, regionW = 100000, regionH = 100000, repeat = false, roofElevation = Infinity } = {}) {
    if (this.bakedRoofMask && this.bakedRoofMask !== rt && !this.bakedRoofMask.destroyed) {
      this.bakedRoofMask.destroy(true);
    }
    this.bakedRoofMask = rt || null;
    this.bakedRoofOrigin[0] = originX;
    this.bakedRoofOrigin[1] = originY;
    this.bakedRoofRegion[0] = Math.max(1, regionW);
    this.bakedRoofRegion[1] = Math.max(1, regionH);
    this.bakedRoofRepeat = Boolean(repeat);
    this.bakedRoofElevation = Number.isFinite(roofElevation) ? roofElevation : Infinity;
    this.syncDepthElevations(this.useDepthTexture);
  }

  setUseBakedRoofMask(enabled) {
    this.useBakedRoofMask = Boolean(enabled && isTextureUsable(this.bakedRoofMask));
  }

  disposeBakedRoofMask() {
    this.useBakedRoofMask = false;
    this.bakedRoofElevation = Infinity;
    if (this.bakedRoofMask && !this.bakedRoofMask.destroyed) {
      this.bakedRoofMask.destroy(true);
    }
    this.bakedRoofMask = null;
  }

  setIndoorLightsHidden(hidden) {
    const next = Boolean(hidden);
    if (next === this.hideIndoorLights) return;
    this.hideIndoorLights = next;
    if (!this.weightArray && this.chunkBatches.size === 0) return;
    for (const meta of this.lightMetaById.values()) {
      if (meta.isIndoor) this._applyMetaEffectiveWeight(meta);
    }
    this.flushWeights();
  }

  flushWeights() {
    let visChanged = false;
    if (this.weightsDirty && this.weightBuffer) {
      this.weightBuffer.update();
      this.weightsDirty = false;
      const hasVisible = this.visibleIndexCount > 0 && this.activeLightsCount > 0;
      if (this.illumMesh && this.illumMesh.visible !== hasVisible) {
        this.illumMesh.visible = hasVisible;
        visChanged = true;
      }
      if (this.colorMesh && this.colorMesh.visible !== hasVisible) {
        this.colorMesh.visible = hasVisible;
        visChanged = true;
      }
    }
    const showDetail = !this.macroBatch || !this._lastVp || getEffectiveScale(this._lastVp.scale) >= 0.020;
    for (const batch of this.chunkBatches.values()) {
      if (!batch.weightsDirty || !batch.weightBuffer) continue;
      batch.weightBuffer.update();
      batch.weightsDirty = false;
      const hasVisible = showDetail && batch.visibleIndexCount > 0 && batch.activeCount > 0;
      if (batch.illumMesh.visible !== hasVisible) {
        batch.illumMesh.visible = hasVisible;
        visChanged = true;
      }
      if (batch.colorMesh.visible !== hasVisible) {
        batch.colorMesh.visible = hasVisible;
        visChanged = true;
      }
    }
    if (visChanged) this._onBatchChanged?.();
  }

  _attachSingleBatch(batch, effects) {
    if (!batch || !effects) return;
    const illumLights = effects.illumination?.lights;
    if (illumLights && batch.illumMesh && batch.illumMesh.parent !== illumLights) {
      illumLights.addChildAt(batch.illumMesh, 0);
    }
    const coloration = effects.coloration;
    if (coloration && batch.colorMesh) {
      if (batch.colorMesh.parent !== coloration) {
        const insertIdx = Math.min(1, coloration.children.length);
        coloration.addChildAt(batch.colorMesh, insertIdx);
      }
      if (batch.colorMesh.visible) coloration.visible = true;
    }
  }

  attachTo(effects) {
    if (!effects) return;
    this._effects = effects;
    this.flushWeights();

    if (this.macroBatch) {
      this._attachSingleBatch(this.macroBatch, effects);
    }
    for (const batch of this.chunkBatches.values()) {
      this._attachSingleBatch(batch, effects);
    }

    if (this.illumMesh && this.colorMesh) {
      const illumLights = effects.illumination?.lights;
      if (illumLights && this.illumMesh.parent !== illumLights) {
        illumLights.addChildAt(this.illumMesh, 0);
      }
      const coloration = effects.coloration;
      if (coloration) {
        if (this.colorMesh.parent !== coloration) {
          const insertIdx = Math.min(1, coloration.children.length);
          coloration.addChildAt(this.colorMesh, insertIdx);
        }
      }
    }
    if (effects.coloration && this.hasVisibleLights()) {
      effects.coloration.visible = true;
    }
  }

  _destroyGeometry(geom) {
    if (!geom) return;
    if (Array.isArray(geom.buffers)) {
      for (const b of geom.buffers) {
        try { b?.destroy?.(); } catch {}
      }
    }
    try { geom.destroy(); } catch {}
  }

  destroy() {
    this._chunkBakeGen++;
    this._deferredBakeGen++;
    if (this._deferredBakeRaf !== null) {
      try {
        if (this._deferredBakeIsTimer) clearTimeout(this._deferredBakeRaf);
        else if (typeof cancelAnimationFrame === "function") cancelAnimationFrame(this._deferredBakeRaf);
      } catch {}
      this._deferredBakeRaf = null;
      this._deferredBakeIsTimer = false;
    }
    this._chunkBakeQueue = [];
    if (this._chunkBakeRaf !== null) {
      try {
        if (this._chunkBakeIsTimer) clearTimeout(this._chunkBakeRaf);
        else if (typeof cancelAnimationFrame === "function") cancelAnimationFrame(this._chunkBakeRaf);
      } catch {}
    }
    this._chunkBakeRaf = null;
    this._chunkBakeIsTimer = false;
    this._effects = null;
    this._lastVp = null;
    this._depthElevCheckMap.clear();
    this._hasDarknessRangedLights = false;
    this._isSuppressedFn = null;
    this._hasLevelEditsFn = null;
    this._onBatchChanged = null;
    this._onChunkBaked = null;

    if (this.macroBatch) {
      this.macroBatch.illumMesh?.parent?.removeChild(this.macroBatch.illumMesh);
      this.macroBatch.illumMesh?.destroy({ children: false });
      this.macroBatch.colorMesh?.parent?.removeChild(this.macroBatch.colorMesh);
      this.macroBatch.colorMesh?.destroy({ children: false });
      this._destroyGeometry(this.macroBatch.geometry);
      this.macroBatch = null;
    }

    for (const batch of this.chunkBatches.values()) {
      batch.illumMesh?.parent?.removeChild(batch.illumMesh);
      batch.illumMesh?.destroy({ children: false });
      batch.colorMesh?.parent?.removeChild(batch.colorMesh);
      batch.colorMesh?.destroy({ children: false });
      this._destroyGeometry(batch.geometry);
    }
    this.chunkBatches.clear();

    if (this.illumMesh) {
      this.illumMesh.parent?.removeChild(this.illumMesh);
      this.illumMesh.destroy({ children: false });
      this.illumMesh = null;
    }
    if (this.colorMesh) {
      this.colorMesh.parent?.removeChild(this.colorMesh);
      this.colorMesh.destroy({ children: false });
      this.colorMesh = null;
    }
    if (this.geometry) {
      this._destroyGeometry(this.geometry);
      this.geometry = null;
    }
    if (this.illumShader) {
      try { this.illumShader.destroy?.(); } catch {}
      this.illumShader = null;
    }
    if (this.colorShader) {
      try { this.colorShader.destroy?.(); } catch {}
      this.colorShader = null;
    }
    this.weightArray = null;
    this.weightBuffer = null;
    this.weightsDirty = false;
    this.depthElevArray = null;
    this.depthElevBuffer = null;
    this.depthElevDirty = false;
    this.allIndices = null;
    this.visibleIndices = null;
    this.indexBuffer = null;
    this.lightMetaById.clear();
    this.sectorBounds = [];
    this.lastVisKey = "";
    this._lastCullBox = null;
    this._lastIllumTick = -1;
    this._lastColorTick = -1;
    this._lastIllumShader = null;
    this._lastColorShader = null;
    this.totalLights = 0;
    this.totalVertices = 0;
    this.visibleIndexCount = 0;
    this.activeLightsCount = 0;
    this.useDepthTexture = false;
  }
}

