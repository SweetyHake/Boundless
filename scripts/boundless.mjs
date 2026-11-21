import { PoiManager, registerPoiControls } from "./poi.mjs";
import { CharacterPinManager, installCharacterSwitchPatch } from "./character-pins.mjs";
import { ChunkedFogManager, registerFogControls } from "./chunked-fog.mjs";
import { MegaAudioStreamer } from "./audio-streamer.mjs";
import { VirtualWallEditor, registerWallEditorControls } from "./wall-editor.mjs";
import { VirtualLayerEditors, registerLayerEditorControls } from "./layer-editors.mjs";
import { TokenStreamer, installLazyTokenLayerPatch } from "./token-streamer.mjs";
import { ChunkStreamer } from "./chunk-streamer.mjs";
import { TileWorkerPool, isWorkerDecodableUrl } from "./tile-worker-pool.mjs";
import { registerConfigUI } from "./config-ui.mjs";
import { bakeSceneToBoundless } from "./scene-baker.mjs";

const MODULE_ID = "boundless";
const SOCKET_NAME = `module.${MODULE_ID}`;
const MAX_LOS_RADIUS_PX = 4500; // 45 cells (225 ft) horizon prevents 100kpx full-world raycasts
const MAX_VRAM_TEXTURES = 1024; // High entry cap so small 256px prop textures across multi-level scenes don't evict pyramid/roof textures
const MAX_VRAM_BYTES = 1536 * 1024 * 1024; // ~1.5 GB VRAM budget (mipmapped RGBA estimate) for high-PPI multi-level LRU cache
const MAX_GPU_UPLOAD_BYTES_PER_FRAME = 16 * 1024 * 1024; // ~16 MB/frame fresh WebGL texture upload cap to avoid mipmap stalls
const CROSSFADE_MS = 160;       // Smooth invisible LOD blend duration
const LIGHT_PAD_WORLD_PX = 900; // > max 40ft (800px) light radius so lights never pop on viewport edge
const FOUNDRY_DEFAULT_ATTENUATION = 0.277992; // Exact Foundry v14 computedAttenuation for data.attenuation = 0.5
const WORLD_MIN_SCALE = 0.008;        // Seamless full-world zoom-out
const CAMERA_STORAGE_PREFIX = "boundless.camera";
const CAMERA_SAVE_DEBOUNCE_MS = 250;
const SHOWSTOPPER_ID = "showstopper";
const NOOP_TRANSFORM = () => {};
const SUPPORT_SOLE_KERNEL = [
  [0, 0, 4],
  [-0.7, -0.7, 1.5],
  [0.7, -0.7, 1.5],
  [0.7, 0.7, 1.5],
  [-0.7, 0.7, 1.5]
];

function getShowstopperMovementApi() {
  try {
    const mod = globalThis.game?.modules?.get?.(SHOWSTOPPER_ID);
    if (mod && !mod.active) return null;
    return mod?.api?.tokenMovement
      || globalThis.showstopper?.tokenMovement
      || globalThis.showstopper?.api?.tokenMovement
      || null;
  } catch {
    return null;
  }
}

function isTextureUsable(tex) {
  return Boolean(tex && !tex.destroyed && tex.baseTexture && !tex.baseTexture.destroyed);
}

/**
 * In Foundry v14, unset `level.elevation.bottom` resolves to `-Infinity` and `top` to `Infinity` (ExtendedNumberField).
 * Always fall back to finite `base` -> finite `bottom` -> `0` when a finite default elevation is required (lights/sounds/tiles/Showstopper).
 */
function getLevelBaseElevation(level) {
  const base = Number(level?.elevation?.base);
  if (Number.isFinite(base)) return base;
  const bottom = Number(level?.elevation?.bottom);
  if (Number.isFinite(bottom)) return bottom;
  return 0;
}

/**
 * Preserve Foundry v14's exact `level.elevation.bottom` (including `-Infinity` for basements/undercrofts)
 * for level ordering, `isUpper` checks, pyramid ground mesh elevation, and depth comparisons.
 */
function getLevelBottomElevation(level) {
  const bottom = level?.elevation?.bottom;
  if (typeof bottom === "number" && !Number.isNaN(bottom)) return bottom;
  return getLevelBaseElevation(level);
}

/**
 * In Foundry v14, unset `level.elevation.top` resolves to `Infinity` at runtime (ExtendedNumberField).
 * Always fall back to `base/bottom + 20` when `top` is non-finite so roof occlusion, indoor lights, and Showstopper stay consistent.
 */
function getLevelRoofElevation(level) {
  const top = Number(level?.elevation?.top);
  if (Number.isFinite(top)) return top;
  return getLevelBaseElevation(level) + 20;
}

/** Convert Foundry v14 wall threshold (in scene distance units) into pixel-scaled Edge threshold (including darkness). */
function buildEdgeThresholdPx(threshold, pxPerFt) {
  if (!threshold || typeof threshold !== "object") return undefined;
  const light = Number.isFinite(Number(threshold.light)) ? Number(threshold.light) * pxPerFt : null;
  const sight = Number.isFinite(Number(threshold.sight)) ? Number(threshold.sight) * pxPerFt : null;
  const sound = Number.isFinite(Number(threshold.sound)) ? Number(threshold.sound) * pxPerFt : null;
  if (light === null && sight === null && sound === null) return undefined;
  return {
    light,
    darkness: light,
    sight,
    sound,
    attenuation: Boolean(threshold.attenuation)
  };
}

function meshContainsPointPixelSafe(mesh, x, y, alphaThreshold = 0.25) {
  if (!mesh || mesh.destroyed) return false;
  if (typeof mesh.containsCanvasPoint === "function") {
    try {
      return Boolean(mesh.containsCanvasPoint({ x, y }, alphaThreshold));
    } catch {}
  }
  if (typeof mesh.containsPixel === "function") {
    try {
      return Boolean(mesh.containsPixel(x, y, alphaThreshold));
    } catch {}
  }
  const b = mesh.canvasBounds;
  if (b) {
    const minX = Number.isFinite(b.x) ? b.x : b.minX;
    const minY = Number.isFinite(b.y) ? b.y : b.minY;
    const maxX = Number.isFinite(b.x) && Number.isFinite(b.width) ? (b.x + b.width) : b.maxX;
    const maxY = Number.isFinite(b.y) && Number.isFinite(b.height) ? (b.y + b.height) : b.maxY;
    if (Number.isFinite(minX) && Number.isFinite(maxX)) {
      return x >= minX && x <= maxX && y >= minY && y <= maxY;
    }
  }
  return false;
}

function smoothstep(edge0, edge1, x) {
  const t = Math.max(0, Math.min(1, (x - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
}

function getEffectiveScale(scale) {
  const grid = canvas?.grid?.size || canvas?.dimensions?.size || 100;
  return (Number(scale) || 0) * (grid / 100);
}

function hasSpecOverlays(overlays) {
  if (!overlays) return false;
  if (Array.isArray(overlays)) return overlays.length > 0;
  for (const k in overlays) {
    if (Object.prototype.hasOwnProperty.call(overlays, k)) return true;
  }
  return false;
}

function isPointUnderRoofSpec(px, py, ov) {
  if (!ov?.roof || ov.walls?.includes("anchor_")) return false;
  const dx = px - ov.cx;
  const dy = py - ov.cy;
  const rot = ((ov.rot || 0) % 360 + 360) % 360;
  if (rot === 0 || rot === 180) {
    return Math.abs(dx) <= ov.w * 0.5 && Math.abs(dy) <= ov.h * 0.5;
  }
  if (rot === 90 || rot === 270) {
    return Math.abs(dx) <= ov.h * 0.5 && Math.abs(dy) <= ov.w * 0.5;
  }
  const rad = -rot * (Math.PI / 180);
  const c = Math.cos(rad);
  const s = Math.sin(rad);
  const lx = dx * c - dy * s;
  const ly = dx * s + dy * c;
  return Math.abs(lx) <= ov.w * 0.5 && Math.abs(ly) <= ov.h * 0.5;
}

function resolveSortLayer(value, fallback) {
  if (typeof value === "number") return value;
  const layers = foundry.canvas?.groups?.PrimaryCanvasGroup?.SORT_LAYERS;
  if (layers && typeof value === "string" && value in layers) return layers[value];
  return fallback;
}

function resolveOcclusionMode(modeSpec, fallback = CONST.OCCLUSION_MODES.NONE) {
  if (typeof modeSpec === "number") return modeSpec;
  if (Array.isArray(modeSpec)) {
    return modeSpec.reduce((acc, m) => {
      if (typeof m === "number") return acc | m;
      if (typeof m === "string" && m in CONST.OCCLUSION_MODES) return acc | CONST.OCCLUSION_MODES[m];
      return acc;
    }, CONST.OCCLUSION_MODES.NONE);
  }
  if (typeof modeSpec === "string" && modeSpec in CONST.OCCLUSION_MODES) {
    return CONST.OCCLUSION_MODES[modeSpec];
  }
  return fallback;
}

const LIGHT_BATCH_VERT = `
precision highp float;

attribute vec2 aCenter;
attribute vec2 aOffset;   // Normalized local offset from center in dimPx units
attribute vec4 aParams;   // x: dimPx, y: ratio, z: alpha, w: phase (< 0 means static)
attribute vec3 aColor;
attribute float aWeight;
attribute float aDepthElev; // Mapped Foundry depthElevation [0..1] for multi-level floor occlusion

uniform mat3 translationMatrix;
uniform mat3 projectionMatrix;
uniform vec2 uScreenDimensions;
uniform float uTime;
uniform float uStageScale;
uniform float uMinScreenRadius;

varying vec2 vOffset;
varying vec2 vSamplerUvs;
varying vec2 vWorldPos;
varying vec3 vColor;
varying float vRatio;
varying float vColorAlpha;
varying float vWeight;
varying float vDepthElev;
varying float vDimPx;
varying float vIsMacro;

void main() {
  if (aWeight <= 0.001 || aParams.x <= 0.0) {
    vWeight = 0.0;
    vColorAlpha = 0.0;
    vOffset = vec2(2.0);
    vSamplerUvs = vec2(0.0);
    vWorldPos = vec2(0.0);
    vColor = vec3(0.0);
    vRatio = 0.5;
    vDepthElev = 1.0;
    vDimPx = 0.0;
    vIsMacro = 0.0;
    gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
    return;
  }

  float effectiveRadius = max(aParams.x, uMinScreenRadius / max(uStageScale, 0.001));
  vec2 worldPos = aCenter + aOffset * effectiveRadius;
  vec3 tPos = translationMatrix * vec3(worldPos, 1.0);

  // Match Foundry v14 Torch (animateFlickering: speed=3, intensity=3 -> amp=0.27, pulse in [0.55..0.82])
  float pulse = 1.0;
  float effRatio = aParams.y;
  if (aParams.w >= 0.0) {
    float t = uTime * 1.8 + aParams.w;
    float s = 0.5
      + 0.28 * sin(t)
      + 0.14 * sin(t * 2.37 + 1.1)
      + 0.08 * sin(t * 4.13 + 2.7);
    float n = clamp(s, 0.0, 1.0) * 0.27;
    pulse = 0.55 + n;
    effRatio = aParams.y > 0.001 ? clamp(aParams.y * 0.9 + n * 0.222, 0.0, 1.0) : 0.0;
  }

  vOffset = aOffset;
  vSamplerUvs = tPos.xy / uScreenDimensions;
  vWorldPos = worldPos;
  vColor = aColor;
  vRatio = effRatio;
  vColorAlpha = aParams.z * 2.0 * pulse * aWeight;
  vWeight = aWeight;
  vDepthElev = aDepthElev;
  vDimPx = aParams.x;
  vIsMacro = aParams.w < -1.5 ? 1.0 : 0.0;

  gl_Position = vec4((projectionMatrix * tPos).xy, 0.0, 1.0);
}
`;

const LIGHT_ILLUM_FRAG = `
precision highp float;

uniform sampler2D uDarknessLevelTexture;
uniform bool uHasDarknessTexture;
uniform sampler2D uDepthTexture;
uniform bool uUseDepthTexture;
uniform sampler2D uBakedRoofMask;
uniform bool uUseBakedRoofMask;
uniform vec2 uBakedRoofOrigin;
uniform vec2 uBakedRoofRegion;
uniform bool uBakedRoofRepeat;
uniform vec3 uStaticBg;
uniform vec3 uStaticBright;
uniform vec3 uStaticDim;
uniform vec3 uAmbientDaylight;
uniform vec3 uAmbientDarkness;
uniform vec3 uAmbientBrightest;
uniform vec4 uWeights;
uniform float uAttenuation;

varying vec2 vOffset;
varying vec2 vSamplerUvs;
varying vec2 vWorldPos;
varying vec3 vColor;
varying float vRatio;
varying float vColorAlpha;
varying float vWeight;
varying float vDepthElev;
varying float vDimPx;
varying float vIsMacro;

vec3 switchColor(vec3 innerColor, vec3 outerColor, float dist, float ratio, float att) {
  float attStr = att * 0.7;
  float lowerEdge = 0.99 - attStr;
  float upperEdge = 1.01 + attStr;
  return mix(innerColor, outerColor, smoothstep(ratio * lowerEdge, clamp(ratio * upperEdge, 0.0001, 1.0), dist));
}

void main() {
  if (vWeight <= 0.001) discard;
  float dist = length(vOffset);
  if (dist >= 1.0) discard;

  float depthMask = 1.0;
  if (uUseDepthTexture && vIsMacro < 0.5) {
    vec4 depthColor = texture2D(uDepthTexture, vSamplerUvs);
    depthMask = step(depthColor.g - (0.5 / 255.0), vDepthElev)
              * step(vDepthElev, (254.5 / 255.0) - depthColor.r);
    if (depthMask <= 0.001) discard;
  }
  if (uUseBakedRoofMask && vIsMacro < 0.5) {
    vec2 rawRoofUv = (vWorldPos - uBakedRoofOrigin) / max(uBakedRoofRegion, vec2(1.0));
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
    vec3 finalCol = switchColor(brightCol, dimCol, dist, vRatio, uAttenuation);
    float edgeFade = (1.0 - smoothstep(1.0 - max(uAttenuation, 0.0001), 1.0, dist)) * depthMask;
    outCol = mix(bg, finalCol, edgeFade);
  }

  gl_FragColor = vec4(outCol, 1.0);
}
`;

const LIGHT_COLOR_FRAG = `
precision highp float;

uniform sampler2D uPrimaryTexture;
uniform bool uHasPrimaryTexture;
uniform sampler2D uDepthTexture;
uniform bool uUseDepthTexture;
uniform sampler2D uBakedRoofMask;
uniform bool uUseBakedRoofMask;
uniform vec2 uBakedRoofOrigin;
uniform vec2 uBakedRoofRegion;
uniform bool uBakedRoofRepeat;
uniform float uAttenuation;
uniform float uMacroLift;

varying vec2 vOffset;
varying vec2 vSamplerUvs;
varying vec2 vWorldPos;
varying vec3 vColor;
varying float vRatio;
varying float vColorAlpha;
varying float vWeight;
varying float vDepthElev;
varying float vDimPx;
varying float vIsMacro;

const vec3 BT709 = vec3(0.2126, 0.7152, 0.0722);
float perceivedBrightness(vec3 c) { return sqrt(dot(BT709, c * c)); }

void main() {
  if (vColorAlpha <= 0.001 || dot(vColor, vColor) <= 0.0001) discard;
  float dist = length(vOffset);
  if (dist >= 1.0) discard;

  float depthMask = 1.0;
  if (uUseDepthTexture && vIsMacro < 0.5) {
    vec4 depthColor = texture2D(uDepthTexture, vSamplerUvs);
    depthMask = step(depthColor.g - (0.5 / 255.0), vDepthElev)
              * step(vDepthElev, (254.5 / 255.0) - depthColor.r);
    if (depthMask <= 0.001) discard;
  }
  if (uUseBakedRoofMask && vIsMacro < 0.5) {
    vec2 rawRoofUv = (vWorldPos - uBakedRoofOrigin) / max(uBakedRoofRegion, vec2(1.0));
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
    edgeFade = (1.0 - smoothstep(1.0 - max(uAttenuation, 0.0001), 1.0, dist)) * depthMask;
  }
  vec3 outCol = vColor * vColorAlpha * reflection * edgeFade;

  gl_FragColor = vec4(outCol, 1.0);
}
`;

class MegaLightBatch {
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
        const c = foundry.utils.Color.from(colorHex);
        [r, g, b] = c.rgb;
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
    this._onBatchChanged = opts.onBatchChanged || null;
    this._onChunkBaked = opts.onChunkBaked || null;
    this._currentDarkness = canvas.environment?.darknessLevel ?? 0;

    const EdgeCls = foundry.canvas.geometry.edges.Edge;
    const CSP = foundry.canvas.geometry.ClockwiseSweepPolygon;

    const centersArr = [];
    const offsetsArr = [];
    const paramsArr = [];
    const colorsArr = [];
    const indicesArr = [];
    const combinedMacroLights = [];
    let vertCursor = 0;
    let lightCount = 0;

    const pushVertex = (lx, ly, ox, oy, dimPx, ratio, alpha, phase, r, g, b) => {
      centersArr.push(lx, ly);
      offsetsArr.push(ox, oy);
      paramsArr.push(dimPx, ratio, alpha, phase);
      colorsArr.push(r, g, b);
      return vertCursor++;
    };

    const emptyRect = new PIXI.Rectangle(-1e9, -1e9, 1, 1);

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
      const hasEditsOnLevel = Boolean(this._hasLevelEditsFn?.(levelId)) || nativeEdges.length > 0;

      // Fast instanced light baking for unmodified superGrid worlds (e.g. 6000x6000 = 6x6 provinces -> 22,860 shadowed lights in ~120ms)
      if (spec._superGridBase && spec.superGrid && !hasEditsOnLevel) {
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
              const c = foundry.utils.Color.from(colorHex);
              [r, g, b] = c.rgb;
            }
            const phase = anim
              ? Math.abs(Math.sin(lx * 0.0137 + ly * 0.0193 + elevation * 0.31) * 100.0)
              : -1.0;

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

            bakedLights.push({
              li, lx, ly, dimFt, brightFt, colorHex, alpha, anim, elevation,
              dimPx, ratio, r, g, b, phase, offsets, isIndoor,
              walls: useWalls, angle, rotation, darkMin, darkMax, extra
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
                const ph = bl.phase >= 0 ? (bl.phase + phaseShift) : -1.0;
                const vStart = vertCursor;

                if (bl.offsets) {
                  const nPts = bl.offsets.length >> 1;
                  const centerIdx = pushVertex(lx, ly, 0, 0, bl.dimPx, bl.ratio, bl.alpha, ph, bl.r, bl.g, bl.b);
                  const ringStart = vertCursor;
                  for (let i = 0; i < nPts; i++) {
                    pushVertex(lx, ly, bl.offsets[i * 2], bl.offsets[i * 2 + 1], bl.dimPx, bl.ratio, bl.alpha, ph, bl.r, bl.g, bl.b);
                  }
                  for (let i = 0; i < nPts; i++) {
                    indicesArr.push(centerIdx, ringStart + i, ringStart + ((i + 1) % nPts));
                  }
                } else {
                  const v0 = pushVertex(lx, ly, -1, -1, bl.dimPx, bl.ratio, bl.alpha, ph, bl.r, bl.g, bl.b);
                  const v1 = pushVertex(lx, ly, 1, -1, bl.dimPx, bl.ratio, bl.alpha, ph, bl.r, bl.g, bl.b);
                  const v2 = pushVertex(lx, ly, 1, 1, bl.dimPx, bl.ratio, bl.alpha, ph, bl.r, bl.g, bl.b);
                  const v3 = pushVertex(lx, ly, -1, 1, bl.dimPx, bl.ratio, bl.alpha, ph, bl.r, bl.g, bl.b);
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
      const sectorEdges = new Map();
      for (const [sk, sec] of Object.entries(sectors)) {
        const arr = [];
        if (sec.w) {
          for (let wi = 0; wi < sec.w.length; wi++) {
            const seg = resolveWallFn
              ? resolveWallFn(levelId, "w", sk, wi, sec.w[wi])
              : {
                  c: sec.w[wi].slice(0, 4),
                  move: sec.w[wi][4], sight: sec.w[wi][5], light: sec.w[wi][6], sound: sec.w[wi][7],
                  dir: sec.w[wi][8] || 0, door: 0, ds: 0
                };
            if (!seg || seg.light === 0 || (seg.door && seg.ds === 1)) continue;
            const [x1, y1, x2, y2] = seg.c;
            const threshold = buildEdgeThresholdPx(seg.threshold, pxPerFt);
            arr.push(new EdgeCls({ x: x1, y: y1 }, { x: x2, y: y2 }, {
              id: `bw_${levelId}_${sk}_${wi}`, type: "wall",
              move: seg.move, sight: seg.sight, light: seg.light, darkness: seg.darkness ?? seg.light, sound: seg.sound, direction: seg.dir || 0,
              ...(threshold ? { threshold } : {})
            }));
          }
        }
        if (sec.d) {
          for (let di = 0; di < sec.d.length; di++) {
            const seg = resolveWallFn
              ? resolveWallFn(levelId, "d", sk, di, sec.d[di])
              : {
                  c: sec.d[di].slice(0, 4),
                  move: 20, sight: 20, light: 20, sound: 20,
                  dir: 0, door: sec.d[di][4] || 1, ds: sec.d[di][5] || 0
                };
            if (!seg || seg.light === 0 || (seg.door && seg.ds === 1)) continue;
            const [x1, y1, x2, y2] = seg.c;
            const threshold = buildEdgeThresholdPx(seg.threshold, pxPerFt);
            arr.push(new EdgeCls({ x: x1, y: y1 }, { x: x2, y: y2 }, {
              id: `bd_${levelId}_${sk}_${di}`, type: "wall",
              move: seg.move, sight: seg.sight, light: seg.light, darkness: seg.darkness ?? seg.light, sound: seg.sound, direction: seg.dir || 0,
              ...(threshold ? { threshold } : {})
            }));
          }
        }
        if (arr.length) sectorEdges.set(sk, arr);
      }

      const outerBounds = Array.from(
        level.edges.getEdges(emptyRect, { includeOuterBounds: true, includeInnerBounds: false })
      ).filter(e => e.type === "outerBounds").map(e => e.clone());
      const innerBounds = Array.from(
        level.edges.getEdges(emptyRect, { includeOuterBounds: false, includeInnerBounds: true })
      ).filter(e => e.type === "innerBounds").map(e => e.clone());

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
      const fakeLevel = Object.create(level, {
        edges: { value: localEdgeStore, enumerable: true }
      });

      for (const [sk, sec] of Object.entries(sectors)) {
        if (!sec?.l?.length) continue;
        const [sx, sy] = sk.split("_").map(Number);
        const localEdges = nativeEdges.length ? nativeEdges.slice() : [];
        for (let dy = -1; dy <= 1; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            const arr = sectorEdges.get(`${sx + dx}_${sy + dy}`);
            if (arr) for (const e of arr) localEdges.push(e);
          }
        }
        localEdgeStore._list = localEdges;

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
                darkMax: extra?.darkMax ?? 1
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
          if (dimPx <= 0 || angle <= 0) continue;

          const elevation = Number.isFinite(resolved.elevation) ? resolved.elevation : defaultLightElev;
          const effectiveRaw = [lx, ly, dimFt, brightFt, colorHex, alpha, anim, elevation];
          const ratio = Math.min(1, ((brightFt || 0) * pxPerFt) / dimPx);
          const aVal = alpha ?? 0.5;
          let r = 0, g = 0, b = 0;
          if (colorHex) {
            const c = foundry.utils.Color.from(colorHex);
            [r, g, b] = c.rgb;
          }
          const phase = anim
            ? Math.abs(Math.sin(lx * 0.0137 + ly * 0.0193 + elevation * 0.31) * 100.0)
            : -1.0;

          const vStart = vertCursor;

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

          let builtPoly = false;
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
              const centerIdx = pushVertex(lx, ly, 0, 0, dimPx, ratio, aVal, phase, r, g, b);
              const ringStart = vertCursor;
              const invR = 1 / dimPx;
              for (let i = 0; i < nPts; i++) {
                let ox = (pts[i * 2] - lx) * invR;
                let oy = (pts[i * 2 + 1] - ly) * invR;
                const len = Math.hypot(ox, oy);
                if (len > 1.001) {
                  ox /= len;
                  oy /= len;
                }
                pushVertex(lx, ly, ox, oy, dimPx, ratio, aVal, phase, r, g, b);
              }
              for (let i = 0; i < nPts; i++) {
                indicesArr.push(centerIdx, ringStart + i, ringStart + ((i + 1) % nPts));
              }
              builtPoly = true;
            }
          }

          if (!builtPoly) {
            const v0 = pushVertex(lx, ly, -1, -1, dimPx, ratio, aVal, phase, r, g, b);
            const v1 = pushVertex(lx, ly, 1, -1, dimPx, ratio, aVal, phase, r, g, b);
            const v2 = pushVertex(lx, ly, 1, 1, dimPx, ratio, aVal, phase, r, g, b);
            const v3 = pushVertex(lx, ly, -1, 1, dimPx, ratio, aVal, phase, r, g, b);
            indicesArr.push(v0, v1, v2, v0, v2, v3);
          }

          const vCount = vertCursor - vStart;
          const lightId = `${levelId}::${sk}_${li}`;
          const topElev = getLevelRoofElevation(level);
          let isIndoor = false;
          if (elevation < topElev && hasSpecOverlays(spec.overlays)) {
            for (let dy = -1; dy <= 1 && !isIndoor; dy++) {
              for (let dx = -1; dx <= 1 && !isIndoor; dx++) {
                const oList = sectors[`${sx + dx}_${sy + dy}`]?.o;
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
  }

  /**
   * Re-map per-light elevations into Foundry v14's depthTexture [0..1] space.
   * Only enables depthTexture sampling when multiple elevations/restrictsLight floors actually exist!
   */
  syncDepthElevations(useDepth) {
    this.useDepthTexture = Boolean(useDepth);
    const hasMonolithic = Boolean(this.depthElevArray && this.depthElevBuffer);
    const hasChunks = this.chunkBatches.size > 0;
    if (!hasMonolithic && !hasChunks) return;
    if (!this.useDepthTexture) {
      this._depthElevCheckMap.clear();
      return;
    }

    const depthMask = canvas.masks?.depth;
    if (!depthMask) return;
    // Ensure Foundry's primary children are sorted and depth mask elevation table is up to date before mapping
    if (canvas.primary?.sortDirty) canvas.primary.sortChildren();
    depthMask._elevationDirty = true;
    depthMask._update?.();

    this._depthElevCheckMap.clear();
    let monoChanged = false;
    const dirtyChunkBatches = new Set();
    for (const meta of this.lightMetaById.values()) {
      const mapped = depthMask.mapElevation(meta.elevation);
      this._depthElevCheckMap.set(meta.elevation, mapped);
      if (meta.batch) {
        const arr = meta.batch.depthElevArray;
        if (arr && Math.abs(arr[meta.vStart] - mapped) > 0.0001) {
          arr.fill(mapped, meta.vStart, meta.vStart + meta.vCount);
          dirtyChunkBatches.add(meta.batch);
        }
      } else if (hasMonolithic) {
        if (Math.abs(this.depthElevArray[meta.vStart] - mapped) > 0.0001) {
          this.depthElevArray.fill(mapped, meta.vStart, meta.vStart + meta.vCount);
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
    const sectors = batch.sectorBounds;
    const totalSec = sectors.length;
    let visCount = 0;
    let h1 = 2166136261 >>> 0;
    let h2 = 0;
    for (let i = 0; i < totalSec; i++) {
      const s = sectors[i];
      if (s.maxX >= x0 && s.minX <= x1 && s.maxY >= y0 && s.minY <= y1) {
        visCount++;
        h1 = Math.imul(h1 ^ i, 16777619) >>> 0;
        h2 = ((h2 << 5) - h2 + i + 1) | 0;
      }
    }
    const key = `${visCount}:${h1}:${h2}`;
    if (key !== batch.lastVisKey) {
      batch.lastVisKey = key;
      let cursor = 0;
      if (visCount === totalSec && totalSec > 0) {
        batch.visibleIndices.set(batch.allIndices, 0);
        cursor = batch.allIndices.length;
      } else if (visCount > 0) {
        for (let i = 0; i < totalSec; i++) {
          const s = sectors[i];
          if (s.maxX >= x0 && s.minX <= x1 && s.maxY >= y0 && s.minY <= y1) {
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

    // Include walls from chunk sectors AND already-loaded neighboring sectors so chunk borders stay seamless
    const neededWallSectors = new Set(Object.keys(sectors));
    for (const [sk] of sectorEntries) {
      const [sx, sy] = sk.split("_").map(Number);
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const nsk = `${sx + dx}_${sy + dy}`;
          if (allLevelSectors[nsk]) neededWallSectors.add(nsk);
        }
      }
    }

    const pxPerFt = this._buildPxPerFt || 20;
    const sectorEdges = new Map();
    for (const sk of neededWallSectors) {
      const sec = sectors[sk] || allLevelSectors[sk];
      if (!sec) continue;
      const arr = [];
      if (sec.w) {
        for (let wi = 0; wi < sec.w.length; wi++) {
          const seg = this._resolveWallFn
            ? this._resolveWallFn(levelId, "w", sk, wi, sec.w[wi])
            : { c: sec.w[wi].slice(0, 4), move: sec.w[wi][4], sight: sec.w[wi][5], light: sec.w[wi][6], sound: sec.w[wi][7], dir: sec.w[wi][8] || 0, door: 0, ds: 0 };
          if (!seg || seg.light === 0 || (seg.door && seg.ds === 1)) continue;
          const [x1, y1, x2, y2] = seg.c;
          const threshold = buildEdgeThresholdPx(seg.threshold, pxPerFt);
          arr.push(new EdgeCls({ x: x1, y: y1 }, { x: x2, y: y2 }, {
            id: `cw_${levelId}_${sk}_${wi}`, type: "wall",
            move: seg.move, sight: seg.sight, light: seg.light, darkness: seg.darkness ?? seg.light, sound: seg.sound, direction: seg.dir || 0,
            ...(threshold ? { threshold } : {})
          }));
        }
      }
      if (sec.d) {
        for (let di = 0; di < sec.d.length; di++) {
          const seg = this._resolveWallFn
            ? this._resolveWallFn(levelId, "d", sk, di, sec.d[di])
            : { c: sec.d[di].slice(0, 4), move: 20, sight: 20, light: 20, sound: 20, dir: 0, door: sec.d[di][4] || 1, ds: sec.d[di][5] || 0 };
          if (!seg || seg.light === 0 || (seg.door && seg.ds === 1)) continue;
          const [x1, y1, x2, y2] = seg.c;
          const threshold = buildEdgeThresholdPx(seg.threshold, pxPerFt);
          arr.push(new EdgeCls({ x: x1, y: y1 }, { x: x2, y: y2 }, {
            id: `cd_${levelId}_${sk}_${di}`, type: "wall",
            move: seg.move, sight: seg.sight, light: seg.light, darkness: seg.darkness ?? seg.light, sound: seg.sound, direction: seg.dir || 0,
            ...(threshold ? { threshold } : {})
          }));
        }
      }
      if (arr.length) sectorEdges.set(sk, arr);
    }

    const b = chunkData.bounds || { x: 0, y: 0, w: layer.worldPx || 100000, h: layer.worldPx || 100000 };
    const padB = LIGHT_PAD_WORLD_PX;
    const outerBounds = [
      new EdgeCls({ x: b.x - padB, y: b.y - padB }, { x: b.x + b.w + padB, y: b.y - padB }, { id: "cb_t", type: "outerBounds" }),
      new EdgeCls({ x: b.x + b.w + padB, y: b.y - padB }, { x: b.x + b.w + padB, y: b.y + b.h + padB }, { id: "cb_r", type: "outerBounds" }),
      new EdgeCls({ x: b.x + b.w + padB, y: b.y + b.h + padB }, { x: b.x - padB, y: b.y + b.h + padB }, { id: "cb_b", type: "outerBounds" }),
      new EdgeCls({ x: b.x - padB, y: b.y + b.h + padB }, { x: b.x - padB, y: b.y - padB }, { id: "cb_l", type: "outerBounds" })
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
    const budgetMs = 6.0; // Never stall main thread > 6ms while streaming chunk light shadows
    const startMs = performance.now();
    const CSP = foundry.canvas.geometry.ClockwiseSweepPolygon;
    const pxPerFt = this._buildPxPerFt || 20;

    while (this._chunkBakeQueue.length > 0 && (performance.now() - startMs) < budgetMs) {
      const job = this._chunkBakeQueue[0];
      if (job.gen !== this._chunkBakeGen) {
        this._chunkBakeQueue.shift();
        continue;
      }

      const defaultLightElev = getLevelBaseElevation(job.level) + 6;
      const topElev = getLevelRoofElevation(job.level);

      while (job.secIdx < job.sectorEntries.length && (performance.now() - startMs) < budgetMs) {
        const [sk, sec] = job.sectorEntries[job.secIdx++];
        const [sx, sy] = sk.split("_").map(Number);
        const localEdges = job.nativeEdges.length ? job.nativeEdges.slice() : [];
        for (let dy = -1; dy <= 1; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            const arr = job.sectorEdges.get(`${sx + dx}_${sy + dy}`);
            if (arr) for (const e of arr) localEdges.push(e);
          }
        }
        job.localEdgeStore._list = localEdges;

        const idxStart = job.indicesArr.length;
        let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;

        for (let li = 0; li < sec.l.length; li++) {
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
                darkMax: extra?.darkMax ?? 1
              };
          if (!resolved || resolved.hidden) continue;
          const lx = resolved.x, ly = resolved.y;
          const dimPx = Math.max(resolved.dim || 0, resolved.bright || 0) * pxPerFt;
          const angle = resolved.angle ?? 360;
          const rotation = resolved.rotation ?? 0;
          const useWalls = resolved.walls !== false;
          const darkMin = resolved.darkMin ?? 0;
          const darkMax = resolved.darkMax ?? 1;
          if (dimPx <= 0 || angle <= 0) continue;

          const elevation = Number.isFinite(resolved.elevation) ? resolved.elevation : defaultLightElev;
          const ratio = Math.min(1, ((resolved.bright || 0) * pxPerFt) / dimPx);
          const aVal = resolved.alpha ?? 0.5;
          let r = 0, g = 0, b = 0;
          if (resolved.color) {
            const c = foundry.utils.Color.from(resolved.color);
            [r, g, b] = c.rgb;
          }
          const phase = resolved.anim
            ? Math.abs(Math.sin(lx * 0.0137 + ly * 0.0193 + elevation * 0.31) * 100.0)
            : -1.0;

          const vStart = job.vertCursor;
          const pushV = (ox, oy) => {
            job.centersArr.push(lx, ly);
            job.offsetsArr.push(ox, oy);
            job.paramsArr.push(dimPx, ratio, aVal, phase);
            job.colorsArr.push(r, g, b);
            return job.vertCursor++;
          };

          let builtPoly = false;
          const canUsePrebaked = !job.hasEditsOnLevel && job.nativeEdges.length === 0 && useWalls && angle >= 360;
          const prebaked = canUsePrebaked ? job.bakedPolys?.[`${sk}_${li}`] : null;
          if (Array.isArray(prebaked) && prebaked.length >= 6) {
            const nPts = prebaked.length >> 1;
            const cIdx = pushV(0, 0);
            const rStart = job.vertCursor;
            for (let i = 0; i < nPts; i++) pushV(prebaked[i * 2], prebaked[i * 2 + 1]);
            for (let i = 0; i < nPts; i++) job.indicesArr.push(cIdx, rStart + i, rStart + ((i + 1) % nPts));
            builtPoly = true;
          } else {
            let hasNearbyWall = false;
            if (useWalls) {
              for (let ei = 0; ei < localEdges.length; ei++) {
                const e = localEdges[ei];
                if (Math.max(e.a.x, e.b.x) >= lx - dimPx && Math.min(e.a.x, e.b.x) <= lx + dimPx &&
                    Math.max(e.a.y, e.b.y) >= ly - dimPx && Math.min(e.a.y, e.b.y) <= ly + dimPx) {
                  hasNearbyWall = true;
                  break;
                }
              }
            }
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
            for (let dy = -1; dy <= 1 && !isIndoor; dy++) {
              for (let dx = -1; dx <= 1 && !isIndoor; dx++) {
                const oList = (job.sectors[`${sx + dx}_${sy + dy}`] || job.allLevelSectors[`${sx + dx}_${sy + dy}`])?.o;
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
          job.metas.push({
            id: lightId,
            levelId: job.levelId,
            elevation, sk, lx, ly, dimPx,
            vStart, vCount: job.vertCursor - vStart,
            weight: 1.0, baseWeight: suppressed ? 0.0 : 1.0, isIndoor,
            walls: useWalls, angle, rotation, darkMin, darkMax,
            raw: [lx, ly, resolved.dim, resolved.bright, resolved.color, aVal, resolved.anim, elevation]
          });
          if (lx - dimPx < minX) minX = lx - dimPx;
          if (ly - dimPx < minY) minY = ly - dimPx;
          if (lx + dimPx > maxX) maxX = lx + dimPx;
          if (ly + dimPx > maxY) maxY = ly + dimPx;
        }

        const idxCount = job.indicesArr.length - idxStart;
        if (idxCount > 0) {
          job.sectorBounds.push({ levelId: job.levelId, sk, minX, minY, maxX, maxY, idxStart, idxCount });
        }
      }

      if (job.secIdx >= job.sectorEntries.length) {
        this._chunkBakeQueue.shift();
        this._finalizeChunkBatch(job);
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
        depthElevs.fill(mapped, meta.vStart, meta.vStart + meta.vCount);
      }
    } else {
      depthElevs.fill(1.0);
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
      if (meta) {
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
    batch.geometry?.destroy();
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
    const sectors = this.sectorBounds;
    const totalSec = sectors.length;
    let visCount = 0;
    let h1 = 2166136261 >>> 0;
    let h2 = 0;
    for (let i = 0; i < totalSec; i++) {
      const s = sectors[i];
      if (s.maxX >= x0 && s.minX <= x1 && s.maxY >= y0 && s.minY <= y1) {
        visCount++;
        h1 = Math.imul(h1 ^ i, 16777619) >>> 0;
        h2 = ((h2 << 5) - h2 + i + 1) | 0;
      }
    }
    const key = `${visCount}:${h1}:${h2}`;
    if (key === this.lastVisKey) return;
    this.lastVisKey = key;

    let cursor = 0;
    if (visCount === totalSec && totalSec > 0) {
      this.visibleIndices.set(this.allIndices, 0);
      cursor = this.allIndices.length;
    } else if (visCount > 0) {
      for (let i = 0; i < totalSec; i++) {
        const s = sectors[i];
        if (s.maxX >= x0 && s.minX <= x1 && s.maxY >= y0 && s.minY <= y1) {
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
    if (canvas.effects?.animateLightSources === false) return this._frozenTime;
    this._frozenTime = (canvas.app?.ticker?.lastTime || 0) * 0.001;
    return this._frozenTime;
  }

  _updateIllumUniforms() {
    const u = this.illumShader?.uniforms;
    if (!u || !canvas?.ready) return;
    this._checkDepthElevationsDirty();
    u.uTime = this._getEffectiveShaderTime();
    u.uStageScale = canvas.stage?.scale?.x || 1;
    u.uScreenDimensions[0] = canvas.screenDimensions?.[0] || 1;
    u.uScreenDimensions[1] = canvas.screenDimensions?.[1] || 1;

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
    this._checkDepthElevationsDirty();
    const scale = canvas.stage?.scale?.x || 1;
    u.uTime = this._getEffectiveShaderTime();
    u.uStageScale = scale;
    u.uScreenDimensions[0] = canvas.screenDimensions?.[0] || 1;
    u.uScreenDimensions[1] = canvas.screenDimensions?.[1] || 1;

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
    const changed = Math.abs(next - this._currentDarkness) > 0.0001;
    this._currentDarkness = next;
    if (!changed || !this._hasDarknessRangedLights) return false;
    if (!this.weightArray && this.chunkBatches.size === 0) return false;
    for (const meta of this.lightMetaById.values()) {
      if (meta.darkMin > 0 || meta.darkMax < 1) {
        this._applyMetaEffectiveWeight(meta);
      }
    }
    this.flushWeights();
    return true;
  }

  setLightWeight(lightId, weight) {
    const meta = this.lightMetaById.get(lightId);
    if (!meta || (!meta.batch && !this.weightArray)) return;
    meta.baseWeight = Math.max(0, Math.min(1, weight));
    this._applyMetaEffectiveWeight(meta);
  }

  setBakedRoofMask(rt, { originX = 0, originY = 0, regionW = 100000, regionH = 100000, repeat = false } = {}) {
    if (this.bakedRoofMask && this.bakedRoofMask !== rt && !this.bakedRoofMask.destroyed) {
      this.bakedRoofMask.destroy(true);
    }
    this.bakedRoofMask = rt || null;
    this.bakedRoofOrigin[0] = originX;
    this.bakedRoofOrigin[1] = originY;
    this.bakedRoofRegion[0] = Math.max(1, regionW);
    this.bakedRoofRegion[1] = Math.max(1, regionH);
    this.bakedRoofRepeat = Boolean(repeat);
  }

  setUseBakedRoofMask(enabled) {
    this.useBakedRoofMask = Boolean(enabled && isTextureUsable(this.bakedRoofMask));
  }

  disposeBakedRoofMask() {
    this.useBakedRoofMask = false;
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

  destroy() {
    this._chunkBakeGen++;
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
      this.macroBatch.geometry?.destroy();
      this.macroBatch = null;
    }

    for (const batch of this.chunkBatches.values()) {
      batch.illumMesh?.parent?.removeChild(batch.illumMesh);
      batch.illumMesh?.destroy({ children: false });
      batch.colorMesh?.parent?.removeChild(batch.colorMesh);
      batch.colorMesh?.destroy({ children: false });
      batch.geometry?.destroy();
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
      this.geometry.destroy();
      this.geometry = null;
    }
    this.illumShader = null;
    this.colorShader = null;
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
    this.totalLights = 0;
    this.totalVertices = 0;
    this.visibleIndexCount = 0;
    this.activeLightsCount = 0;
    this.useDepthTexture = false;
  }
}

let losPatchInstalled = false;
function installLosHorizonPatch() {
  if (losPatchInstalled) return;
  const PVS = foundry.canvas?.sources?.PointVisionSource ?? CONFIG.Canvas.visionSourceClass;
  if (!PVS?.prototype?._getPolygonConfiguration) return;
  const orig = PVS.prototype._getPolygonConfiguration;
  PVS.prototype._getPolygonConfiguration = function (...args) {
    const cfg = orig.apply(this, args);
    const megaCfg = canvas?.scene?.flags?.[MODULE_ID];
    if (megaCfg?.enabled && cfg.radius > (megaCfg.maxLosPx || MAX_LOS_RADIUS_PX)) {
      cfg.radius = megaCfg.maxLosPx || MAX_LOS_RADIUS_PX;
    }
    return cfg;
  };
  losPatchInstalled = true;
}

/**
 * Eliminate Foundry v14's O(K^2) vision-polygon storm during marquee box-selection (`selectObjects`)
 * and `releaseAll`: normally every `Token#_onControl` / `_onRelease` loops over ALL `placeables`
 * calling `initializeVisionSource()`, recomputing K*(K+1)/2 vision polygons in one frame.
 * Batching defers vision source initialization to ONE single pass after the marquee loop finishes.
 */
let bulkSelectPatchInstalled = false;
let _bulkSelectDepth = 0;
let _bulkVisionDirty = false;
function installBulkSelectionPatch() {
  if (bulkSelectPatchInstalled) return;
  const TokenLayerCls = foundry.canvas?.layers?.TokenLayer ?? CONFIG.Token?.layerClass;
  const TokenCls = foundry.canvas?.placeables?.Token ?? CONFIG.Token?.objectClass;
  if (!TokenLayerCls?.prototype || !TokenCls?.prototype?.initializeVisionSource) return;

  const origInitVision = TokenCls.prototype.initializeVisionSource;
  TokenCls.prototype.initializeVisionSource = function (...args) {
    if (_bulkSelectDepth > 0 && controller?.active) {
      _bulkVisionDirty = true;
      return;
    }
    return origInitVision.apply(this, args);
  };

  const wrapBulk = (methodName) => {
    const orig = TokenLayerCls.prototype[methodName];
    if (typeof orig !== "function") return;
    TokenLayerCls.prototype[methodName] = function (...args) {
      if (!controller?.active) return orig.apply(this, args);
      _bulkSelectDepth++;
      let result;
      try {
        result = orig.apply(this, args);
      } finally {
        _bulkSelectDepth--;
        if (_bulkSelectDepth === 0 && _bulkVisionDirty) {
          _bulkVisionDirty = false;
          const placeables = this.placeables;
          if (Array.isArray(placeables)) {
            for (let i = 0; i < placeables.length; i++) {
              const t = placeables[i];
              if (t && !t.destroyed) origInitVision.call(t);
            }
          }
          canvas.perception?.update?.({
            refreshVision: true,
            refreshSounds: true,
            refreshOcclusion: this.occlusionMode & CONST.TOKEN_OCCLUSION_MODES.CONTROLLED
          });
        }
      }
      return result;
    };
  };

  wrapBulk("selectObjects");
  wrapBulk("releaseAll");
  bulkSelectPatchInstalled = true;
}

/**
 * Prevent Foundry v14's `PrimaryCanvasGroup#_onMouseMove` (`#updateHoveredObjects`) from triggering
 * synchronous `gl.readPixels()` alpha-map extraction (`TextureLoader.getTextureAlphaData`, 10-30ms GPU stalls)
 * on every Boundless pyramid tile / static prop (which all carry a default `_hoverFadeState` class field even when `hoverFade = false`)
 * and while the camera is actively zooming/panning.
 */
let hoverFadeHitTestPatchInstalled = false;
let _inHoverFadeHitTest = false;
function installHoverFadeHitTestPatch() {
  if (hoverFadeHitTestPatchInstalled) return;
  const PCG = foundry.canvas?.groups?.PrimaryCanvasGroup;
  const PSM = foundry.canvas?.primary?.PrimarySpriteMesh;
  if (!PCG?.prototype?._onMouseMove || !PSM?.prototype?.containsCanvasPoint) return;

  const origOnMouseMove = PCG.prototype._onMouseMove;
  PCG.prototype._onMouseMove = function (...args) {
    if (!controller?.active) return origOnMouseMove.apply(this, args);
    _inHoverFadeHitTest = true;
    try {
      return origOnMouseMove.apply(this, args);
    } finally {
      _inHoverFadeHitTest = false;
    }
  };

  const origContainsCanvasPoint = PSM.prototype.containsCanvasPoint;
  PSM.prototype.containsCanvasPoint = function (...args) {
    if (_inHoverFadeHitTest && controller?.active && this._boundlessMesh) {
      if (!this.hoverFade && !this.occlusionMode) return false;
      if (this._boundlessTile && !this.hoverFade) return false;
      if (controller.isActivelyMoving()) return false;
    }
    return origContainsCanvasPoint.apply(this, args);
  };

  hoverFadeHitTestPatchInstalled = true;
}

class LRUTextureManager {
  promises = new Map();     // src -> Promise<PIXI.Texture>
  lru = new Map();          // src -> PIXI.Texture (insertion order = LRU -> MRU)
  bytesBySrc = new Map();   // src -> estimated VRAM bytes (RGBA + mipmaps)
  totalBytes = 0;
  pinned = new Set();       // Static icons + z0..z2 low-level pyramid stay resident
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
    if (!src) return Promise.resolve(null);
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
        } catch (err) {
          try { bitmap.close(); } catch {}
          if (gen !== this._gen) return null;
          return this._loadFallback(src, mipmap, gen);
        }
      }).catch(err => {
        if (err?.aborted || gen !== this._gen) return null;
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
    this.promises.clear();
  }

  getStats() {
    return {
      lruSize: this.lru.size,
      vramMB: +(this.totalBytes / (1024 * 1024)).toFixed(1),
      pinnedSize: this.pinned.size,
      workerOwned: this.workerOwned.size,
      pending: this.promises.size,
      ...this.workerPool.getStats()
    };
  }
}

class MegaWorld1000 {
  active = false;
  manifest = null;            // Legacy/primary manifest reference (for backwards compatibility)
  manifestCache = new Map();  // manifestUrl -> parsed manifest JSON
  levelLayers = new Map();    // levelId -> { level, spec, hasPyramid, pyramidBaseUrl, maxZoomZ, worldPx, tilePx, simGrid, simSectorPx, bounds, isUpper, lastPyramidKey, lastOverlayKey, lastTileKey, lastTargetZ }
  visibleLevelLayers = [];    // Sorted ascending by level.elevation.bottom

  texMgr = new LRUTextureManager();

  // Multi-Level Quadtree Pyramid Streamer
  tilesByKey = new Map(); // "${levelId}::${z}_${x}_${y}" -> entry
  meshPool = [];
  tickerFn = null;
  lastTargetZ = -1;
  _tilesDirty = true;
  _lastOverlayAlpha = -1;
  _occlusionDirty = false;
  _depthDirty = true;
  _depthElevSyncNeeded = false;
  _lastDepthRenderMs = 0;
  _depthDeferred = false;
  _origDepthAutoRender = null;
  pendingTileMounts = []; // Frame-budgeted queue (max 4 tile GPU uploads/frame)
  pendingOverlayMounts = []; // Frame-budgeted queue for building roofs/walls on zoom-in
  _pendingOverlayKeys = new Set();
  pendingVirtualTileMounts = []; // Frame-budgeted queue for virtual tile GPU uploads
  _pendingVirtualTileKeys = new Set();
  _mountGen = 0;
  _mountPromise = null;
  _mounting = false;
  _inUpdatePyramid = false;
  _roofTokenOccDirty = false;
  _waitingForRoofsBeforeIndoor = false;
  _roofMaskBaking = false;
  _roofMaskGen = 0;

  // Interactive House & Anchor Overlays (per level: "${levelId}::${oid}")
  activeOverlays = new Map();
  overlayPending = new Set();
  _roofHiddenTokens = new Set();
  _lastRoofOccSig = "";
  _revealTileKeys = new Set();

  // Virtual Streamed Tiles (per level: "${levelId}::${tid}", supports all Foundry v14 Tile properties)
  activeVirtualTiles = new Map();
  virtualTilePending = new Set();

  // Physics Sim-Bubble (Walls in per-level `level.edges`: ONLY around active tokens & open doors)
  simSectors = new Map(); // "${levelId}::${sx}_${sy}" -> { level, edgeIds }
  doorStates = new Map(); // dKey -> ds (0: closed, 1: open, 2: locked)
  openDoors = new Map();  // dKey -> { levelId, x, y, sx, sy, eid }
  lastSimKey = "";

  // Hybrid Multi-Level Lighting: GPU MegaLightBatch (2 draw calls) + dynamic PointLightSources ONLY near open doors / active visionSources
  lightBatch = new MegaLightBatch();
  dynamicLights = new Map(); // "${levelId}::${sk}_${li}" -> PointLightSource
  lastDynLightKey = "";
  _updatingBubbles = false;
  _patchedFilters = new Map();
  _origSmaaEnabled = null;
  _origIfVoidEnabled = null;
  _origTextureGcMode = null;
  _hiddenNativeLevelBg = new Map(); // levelId -> PrimarySpriteMesh

  // Subsystems: POI fast-travel pins, character avatar tracker, high-res chunked Fog of War, spatial ambient audio, door socket sync
  poiManager = new PoiManager(this);
  charPins = new CharacterPinManager(this);
  fogManager = new ChunkedFogManager();
  audioStreamer = new MegaAudioStreamer();
  wallEditor = new VirtualWallEditor(this);
  layerEditors = new VirtualLayerEditors(this);
  tokenStreamer = new TokenStreamer(this);
  chunkStreamer = new ChunkStreamer(this);
  wallEdits = new Map();  // levelId -> Map<wKey, null | wallData>
  wallEditsRev = 0;
  lightEdits = new Map(); // levelId -> Map<lKey, null | lightData>
  lightEditsRev = 0;
  soundEdits = new Map(); // levelId -> Map<sKey, null | soundData>
  soundEditsRev = 0;
  tileEdits = new Map();  // levelId -> Map<tKey, null | tileData>
  tileEditsRev = 0;
  _socketRegistered = false;

  // Camera persistence (F5), cinematic POI flight & controlled-token zoom clamp
  _worldMinScale = WORLD_MIN_SCALE;
  _camSaveTimer = null;
  _beforeUnloadFn = null;
  _restoringCamera = false;
  _zoomSyncQueued = false;
  isCameraFlying = false;
  _lastPanMs = 0;
  _pruneNeeded = false;
  _lastOccRefreshMs = 0;
  _showstopperDirty = false;
  _lastShowstopperMs = 0;
  _vtIdleCleanupNeeded = false;
  _prewarmGen = 0;

  isActivelyMoving() {
    return this.isCameraFlying || (this._lastPanMs > 0 && (performance.now() - this._lastPanMs) < 160);
  }

  _getCameraStorageKey(scene = canvas.scene, levelId = canvas.level?.id) {
    if (!scene?.id) return null;
    const worldId = game.world?.id || "world";
    return `${CAMERA_STORAGE_PREFIX}.${worldId}.${scene.id}.${levelId || "default"}`;
  }

  _saveCameraNow() {
    if (!this.active || this._restoringCamera || !canvas?.ready || !canvas.stage?.pivot) return;
    const key = this._getCameraStorageKey();
    if (!key) return;
    const x = canvas.stage.pivot.x;
    const y = canvas.stage.pivot.y;
    const scale = canvas.stage.scale.x;
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(scale) || scale <= 0) return;
    try {
      localStorage.setItem(key, JSON.stringify({
        x: Math.round(x),
        y: Math.round(y),
        scale: Number(scale.toFixed(5))
      }));
    } catch {}
  }

  scheduleCameraSave() {
    if (!this.active || this._restoringCamera || this.isCameraFlying) return;
    if (this._camSaveTimer !== null) clearTimeout(this._camSaveTimer);
    this._camSaveTimer = setTimeout(() => {
      this._camSaveTimer = null;
      this._saveCameraNow();
    }, CAMERA_SAVE_DEBOUNCE_MS);
  }

  setCameraFlying(flying) {
    const next = Boolean(flying);
    if (this.isCameraFlying === next) return;
    this.isCameraFlying = next;
    if (!next && this.active && canvas?.ready) {
      this.syncZoomLimits({ animate: false });
      this.updatePyramid();
      this._saveCameraNow();
    }
  }

  prewarmArea(worldX, worldY, targetScale) {
    if (!this.active || !this.visibleLevelLayers.length || !canvas?.ready) return;
    this.chunkStreamer.prewarmPoint(worldX, worldY);
    this.tokenStreamer.prewarmTarget(worldX, worldY, targetScale);
    const [sw = 1600, sh = 1000] = canvas.screenDimensions || [];
    const safeScale = Math.max(0.01, targetScale || 0.45);
    const halfW = (sw / safeScale) * 0.55;
    const halfH = (sh / safeScale) * 0.55;

    const urls = [];
    const queued = new Set();
    const maxBudget = 12;

    for (const layer of this.visibleLevelLayers) {
      if (!layer.hasPyramid || layer.maxZoomZ < 1 || urls.length >= maxBudget) continue;
      const { bounds } = layer;
      const destZ = Math.max(1, this._computeTargetZ(layer, safeScale));
      // Warm intermediate levels first (closest in time during descent), then destination level
      const levelsToWarm = [];
      if (destZ - 2 >= 1) levelsToWarm.push(destZ - 2);
      if (destZ - 1 >= 1) levelsToWarm.push(destZ - 1);
      levelsToWarm.push(destZ);

      for (const z of levelsToWarm) {
        if (urls.length >= maxBudget) break;
        const { nx, ny } = this._getPyramidGridDims(layer, z);
        const tileWorldSize = this._getPyramidTileSize(layer, z);
        const padFactor = z === destZ ? 0.9 : 0.4;
        const bx0 = Math.max(bounds.x, worldX - halfW * padFactor);
        const by0 = Math.max(bounds.y, worldY - halfH * padFactor);
        const bx1 = Math.min(bounds.x + bounds.w, worldX + halfW * padFactor);
        const by1 = Math.min(bounds.y + bounds.h, worldY + halfH * padFactor);
        if (bx0 >= bx1 || by0 >= by1) continue;

        const tx0 = Math.max(0, Math.floor((bx0 - bounds.x) / tileWorldSize));
        const ty0 = Math.max(0, Math.floor((by0 - bounds.y) / tileWorldSize));
        const tx1 = Math.min(nx - 1, Math.floor((bx1 - 0.001 - bounds.x) / tileWorldSize));
        const ty1 = Math.min(ny - 1, Math.floor((by1 - 0.001 - bounds.y) / tileWorldSize));

        for (let ty = ty0; ty <= ty1 && urls.length < maxBudget; ty++) {
          for (let tx = tx0; tx <= tx1 && urls.length < maxBudget; tx++) {
            const spec = this.resolvePyramidTile(layer, z, tx, ty);
            if (!spec?.src || queued.has(spec.src) || this.texMgr.getSync(spec.src)) continue;
            queued.add(spec.src);
            urls.push(spec.src);
          }
        }
      }
    }

    if (!urls.length) return;
    // Cancel stale background prewarm jobs and queue new ones at low priority (2) in off-main-thread workers
    this.texMgr.cancelPrewarm();
    const gen = ++this._prewarmGen;
    let idx = 0;
    const pump = () => {
      if (!this.active || this._prewarmGen !== gen || idx >= urls.length) return;
      const batch = Math.min(2, urls.length - idx);
      let done = 0;
      for (let i = 0; i < batch; i++) {
        const src = urls[idx++];
        this.texMgr.load(src, { mipmap: true, priority: 2 }).finally(() => {
          done++;
          if (done === batch && this.active && this._prewarmGen === gen && idx < urls.length) {
            requestAnimationFrame(pump);
          }
        });
      }
    };
    requestAnimationFrame(pump);
  }

  _restoreCamera(scene) {
    const key = this._getCameraStorageKey(scene, canvas.level?.id);
    if (!key) return false;
    try {
      const raw = localStorage.getItem(key);
      if (!raw) return false;
      const saved = JSON.parse(raw);
      if (!Number.isFinite(saved?.x) || !Number.isFinite(saved?.y) || !Number.isFinite(saved?.scale) || saved.scale <= 0) {
        return false;
      }
      this._restoringCamera = true;
      try {
        canvas.pan({ x: saved.x, y: saved.y, scale: saved.scale });
      } finally {
        this._restoringCamera = false;
      }
      return true;
    } catch {
      return false;
    }
  }

  syncZoomLimits() {
    if (!this.active || !canvas?.dimensions?.scale) return;
    canvas.dimensions.scale.min = this._worldMinScale;
  }

  queueZoomLimitSync() {
    this.syncZoomLimits();
  }

  _getPyramidGridDims(layer, z) {
    const sg = layer.superGrid;
    if (sg) {
      const macroMaxZ = sg.macroMaxZ ?? 2;
      if (z <= macroMaxZ) {
        const n = 1 << z;
        return { nx: n, ny: n };
      }
      const localN = 1 << (z - (macroMaxZ + 1));
      return { nx: (sg.cols || 6) * localN, ny: (sg.rows || 6) * localN };
    }
    const n = 1 << z;
    return { nx: n, ny: n };
  }

  _getPyramidGridSize(layer, z) {
    const { nx, ny } = this._getPyramidGridDims(layer, z);
    return Math.max(nx, ny);
  }

  _getPyramidTileSize(layer, z) {
    const sg = layer.superGrid;
    if (sg) {
      const macroMaxZ = sg.macroMaxZ ?? 2;
      if (z > macroMaxZ) {
        const localN = 1 << (z - (macroMaxZ + 1));
        return (sg.regionPx || 100000) / localN;
      }
    }
    const span = Math.max(layer.bounds?.w || layer.worldPx || 100000, layer.bounds?.h || layer.worldPx || 100000);
    return span / (1 << z);
  }

  _shouldMountRoofs(layer, scale = canvas?.stage?.scale?.x ?? 1) {
    if (!layer) return false;
    if (!layer.hasPyramid) return true;
    const effScale = getEffectiveScale(scale);
    const threshold = layer._roofsMountedMode ? 0.21 : 0.24;
    const active = effScale >= threshold;
    layer._roofsMountedMode = active;
    return active;
  }

  _shouldMountInteriorTiles(layer, scale = canvas?.stage?.scale?.x ?? 1) {
    if (!layer) return false;
    if (!layer.hasPyramid) return true;
    const effScale = getEffectiveScale(scale);
    const threshold = layer._interiorTilesMounted ? 0.40 : 0.45;
    const active = effScale >= threshold;
    layer._interiorTilesMounted = active;
    return active;
  }

  _computeTargetZ(layer, scale, { hysteresis = false } = {}) {
    const { worldPx, tilePx, maxZoomZ, superGrid } = layer;
    const prevZ = hysteresis && Number.isInteger(layer.lastTargetZ) && layer.lastTargetZ >= 0 ? layer.lastTargetZ : -1;
    const applyHyst = (exact) => {
      const z = Math.ceil(exact);
      if (prevZ >= 0 && prevZ <= maxZoomZ) {
        if (z === prevZ + 1 && exact < prevZ + 0.08) return prevZ;
        if (z === prevZ - 1 && exact > prevZ - 1 - 0.08) return prevZ;
      }
      return z;
    };
    if (superGrid) {
      const macroMaxZ = superGrid.macroMaxZ ?? 2;
      const regionPx = superGrid.regionPx || 100000;
      const localRatio = (regionPx * scale) / tilePx;
      if (localRatio >= 0.92) {
        const localZ = Math.max(0, Math.ceil(Math.log2(Math.max(1, localRatio))));
        return Math.min(maxZoomZ, (macroMaxZ + 1) + localZ);
      }
      const macroExact = Math.log2(Math.max(0.5, (worldPx * scale) / tilePx));
      return Math.max(0, Math.min(macroMaxZ, applyHyst(macroExact)));
    }
    const exactZ = Math.log2((worldPx * scale) / tilePx);
    return Math.max(0, Math.min(maxZoomZ, applyHyst(exactZ)));
  }

  async _expandSuperGridManifest(raw) {
    const sg = raw?.superGrid;
    if (!sg?.baseManifestUrl) return raw;
    const base = await this._fetchManifest(sg.baseManifestUrl);
    if (!base) return raw;

    const cols = sg.cols || 6;
    const rows = sg.rows || 6;
    const regionPx = sg.regionPx || base.worldPx || 100000;
    const baseSimGrid = base.simGrid || 40;
    const baseSimSectorPx = base.simSectorPx || Math.ceil(regionPx / baseSimGrid);
    const baseOverlays = base.overlays || [];
    const baseSectors = base.sectors || {};
    const parsedTints = Array.isArray(sg.tints)
      ? sg.tints.map(row => row.map(hex => (typeof hex === "number" ? hex : parseInt(String(hex).replace("#", ""), 16) || 0xffffff)))
      : null;

    const overlays = [];
    const sectors = {};
    let totalWalls = 0, totalDoors = 0, totalLights = 0;

    for (let gy = 0; gy < rows; gy++) {
      const offY = gy * regionPx;
      const secOffY = gy * baseSimGrid;
      for (let gx = 0; gx < cols; gx++) {
        const offX = gx * regionPx;
        const secOffX = gx * baseSimGrid;
        const ovOffset = overlays.length;
        const tint = parsedTints?.[gy]?.[gx] ?? 0xffffff;

        for (let oi = 0; oi < baseOverlays.length; oi++) {
          const bo = baseOverlays[oi];
          overlays.push({
            ...bo,
            cx: bo.cx + offX,
            cy: bo.cy + offY,
            tint
          });
        }

        for (const [bsk, bsec] of Object.entries(baseSectors)) {
          const [bsx, bsy] = bsk.split("_").map(Number);
          const sk = `${secOffX + bsx}_${secOffY + bsy}`;
          const sec = { w: [], d: [], l: [], o: [] };
          if (bsec.w?.length) {
            for (let i = 0; i < bsec.w.length; i++) {
              const w = bsec.w[i];
              const row = [w[0] + offX, w[1] + offY, w[2] + offX, w[3] + offY, w[4], w[5], w[6], w[7], w[8]];
              if (w[9] !== undefined) row.push(w[9]);
              sec.w.push(row);
            }
            totalWalls += sec.w.length;
          }
          if (bsec.d?.length) {
            for (let i = 0; i < bsec.d.length; i++) {
              const d = bsec.d[i];
              const row = [d[0] + offX, d[1] + offY, d[2] + offX, d[3] + offY, d[4], d[5]];
              if (d[6] !== undefined) row.push(d[6]);
              sec.d.push(row);
            }
            totalDoors += sec.d.length;
          }
          if (bsec.l?.length) {
            for (let i = 0; i < bsec.l.length; i++) {
              const l = bsec.l[i];
              const row = [l[0] + offX, l[1] + offY, l[2], l[3], l[4], l[5], l[6], l[7]];
              if (l[8] !== undefined) row.push(l[8]);
              sec.l.push(row);
            }
            totalLights += sec.l.length;
          }
          if (bsec.o?.length) {
            for (let i = 0; i < bsec.o.length; i++) {
              sec.o.push(bsec.o[i] + ovOffset);
            }
          }
          sectors[sk] = sec;
        }
      }
    }

    return {
      ...raw,
      worldPx: raw.worldPx || regionPx * Math.max(cols, rows),
      worldCells: raw.worldCells || Math.round((regionPx * Math.max(cols, rows)) / 100),
      tilePx: raw.tilePx || base.tilePx || 1024,
      simGrid: baseSimGrid * Math.max(cols, rows),
      simSectorPx: baseSimSectorPx,
      blockFlags: base.blockFlags,
      overlays,
      sectors,
      superGrid: { ...sg, parsedTints },
      _superGridBase: base,
      stats: {
        totalWalls,
        totalDoors,
        totalLights,
        overlays: overlays.length,
        provinces: cols * rows
      }
    };
  }

  async _fetchManifest(url) {
    if (!url) return null;
    url = String(url).replaceAll("modules/sh-megamap/", `modules/${MODULE_ID}/`);
    if (this.manifestCache.has(url)) {
      const cached = this.manifestCache.get(url);
      if (cached?.chunks?.baseUrl) {
        return { ...cached, sectors: {}, overlays: {} };
      }
      return cached;
    }
    const sep = url.includes("?") ? "&" : "?";
    const resp = await fetch(`${url}${sep}v=${Date.now()}`);
    if (!resp.ok) throw new Error(`HTTP ${resp.status} loading manifest ${url}`);
    let data = await resp.json();
    // Chunked world manifests (`boundless-chunked-v1`) stream sectors/overlays lazily per-chunk; never expand all 36 provinces into RAM upfront!
    if (data?.chunks?.baseUrl) {
      if (Array.isArray(data.superGrid?.tints) && !data.superGrid.parsedTints) {
        data.superGrid.parsedTints = data.superGrid.tints.map(row =>
          row.map(hex => (typeof hex === "number" ? hex : parseInt(String(hex).replace("#", ""), 16) || 0xffffff))
        );
      }
      if (!data.sectors) data.sectors = {};
      if (!data.overlays) data.overlays = {};
      this.manifestCache.set(url, data);
      return { ...data, sectors: {}, overlays: {} };
    } else if (data?.superGrid?.baseManifestUrl) {
      data = await this._expandSuperGridManifest(data);
    }
    this.manifestCache.set(url, data);
    return data;
  }

  _normalizeLevelSpec(rawSpec, level, levelCfg = {}) {
    if (!rawSpec) return null;
    const superGrid = rawSpec.superGrid || null;
    const sgRegionPx = superGrid?.regionPx || 100000;
    const sgW = superGrid ? (superGrid.cols || 6) * sgRegionPx : 0;
    const sgH = superGrid ? (superGrid.rows || 6) * sgRegionPx : 0;
    const worldPx = rawSpec.worldPx || Math.max(sgW, sgH, canvas.dimensions?.width || 100000, canvas.dimensions?.height || 100000);
    const tilePx = rawSpec.tilePx || 1024;
    const simGrid = rawSpec.simGrid || 40;
    const simSectorPx = rawSpec.simSectorPx || Math.ceil(worldPx / simGrid);
    const zOffset = superGrid ? ((superGrid.macroMaxZ ?? 2) + 1) : 0;
    const cfgBaseUrl = typeof levelCfg.pyramidBaseUrl === "string" ? levelCfg.pyramidBaseUrl.trim() : levelCfg.pyramidBaseUrl;
    const pyramidBaseUrl = cfgBaseUrl
      ? cfgBaseUrl
      : (rawSpec.pyramidBaseUrl !== undefined
          ? rawSpec.pyramidBaseUrl
          : (rawSpec.blockFlags || rawSpec.maxZoomZ !== undefined ? `modules/${MODULE_ID}/assets/pyramid` : null));

    const hasPyramid = Boolean(pyramidBaseUrl);
    const maxZoomZ = rawSpec.maxZoomZ ?? (hasPyramid ? (7 + zOffset) : 0);
    const defaultBounds = superGrid
      ? { x: 0, y: 0, w: sgW || worldPx, h: sgH || worldPx }
      : { x: 0, y: 0, w: worldPx, h: worldPx };
    const bounds = levelCfg.bounds || rawSpec.bounds || defaultBounds;

    return {
      level,
      spec: rawSpec,
      hasPyramid,
      pyramidBaseUrl,
      superGrid,
      zOffset,
      maxZoomZ,
      worldPx,
      tilePx,
      simGrid,
      simSectorPx,
      bounds,
      isUpper: !level.isView && (getLevelBottomElevation(level) > getLevelBottomElevation(canvas.level)),
      lastPyramidKey: "",
      lastOverlayKey: "",
      lastTileKey: "",
      lastTargetZ: -1
    };
  }

  /**
   * Resolve which visible Foundry v14 Levels have Boundless layers attached.
   * Supports:
   *  1. Per-level flags: `level.flags["boundless"]` (`manifestUrl` or `inlineManifest`)
   *  2. Multi-level scene manifest: `manifest.levels[level.id]`
   *  3. Legacy single-level scene manifest: attached to `scene.flags["boundless"].levelId || scene.initialLevel || scene.firstLevel.id`
   */
  async _resolveVisibleLevelLayers(scene, sceneCfg) {
    const visibleLevels = (scene.levels?.sorted || (canvas.level ? [canvas.level] : []))
      .filter(l => l.isVisible);
    if (!visibleLevels.length && canvas.level) visibleLevels.push(canvas.level);

    const defaultLevelId = sceneCfg.levelId
      || (typeof scene.initialLevel === "string" ? scene.initialLevel : scene.initialLevel?.id)
      || scene.firstLevel?.id
      || visibleLevels[0]?.id;
    let sceneManifest = null;
    if (sceneCfg.manifestUrl || sceneCfg.enabled) {
      const mUrl = sceneCfg.manifestUrl || `modules/${MODULE_ID}/assets/pyramid/pyramid_manifest.json`;
      try {
        sceneManifest = await this._fetchManifest(mUrl);
      } catch (err) {
        console.warn(`${MODULE_ID} | Could not load scene manifest ${mUrl}:`, err);
      }
    }

    const layers = [];
    for (const level of visibleLevels) {
      const lCfg = level.flags?.[MODULE_ID] || {};
      if (lCfg.enabled === false) continue;

      let rawSpec = null;
      if (lCfg.inlineManifest) {
        rawSpec = lCfg.inlineManifest;
      } else if (lCfg.manifestUrl) {
        try {
          rawSpec = await this._fetchManifest(lCfg.manifestUrl);
        } catch (err) {
          console.warn(`${MODULE_ID} | Could not load level manifest ${lCfg.manifestUrl}:`, err);
        }
      } else if (sceneManifest?.levels && sceneManifest.levels[level.id]) {
        rawSpec = sceneManifest.levels[level.id];
      } else if (sceneManifest && !sceneManifest.levels && level.id === defaultLevelId) {
        rawSpec = sceneManifest;
      }

      if (rawSpec) {
        const entry = this._normalizeLevelSpec(rawSpec, level, lCfg);
        if (entry) layers.push(entry);
      }
    }

    layers.sort((a, b) => {
      const ea = getLevelBottomElevation(a.level);
      const eb = getLevelBottomElevation(b.level);
      return ea < eb ? -1 : (ea > eb ? 1 : (a.level.index ?? 0) - (b.level.index ?? 0));
    });
    return { layers, sceneManifest };
  }

  _capFilterResolution(filter, maxRes = 1.0) {
    if (!filter || this._patchedFilters.has(filter)) return;
    const rendererRes = canvas.app?.renderer?.resolution || 1;
    const effectiveRes = filter.resolution ?? rendererRes;
    if (effectiveRes <= maxRes) return;
    const desc = Object.getOwnPropertyDescriptor(filter, "resolution");
    this._patchedFilters.set(filter, desc || null);
    const origGet = desc?.get;
    Object.defineProperty(filter, "resolution", {
      configurable: true,
      get() {
        const raw = origGet ? origGet.call(this) : null;
        const v = raw ?? (canvas.app?.renderer?.resolution || 1);
        return Math.min(v, maxRes);
      },
      set() {}
    });
  }

  _syncInterfaceVoidFilter() {
    const ifVoid = canvas.interface?.filters?.find(f => f?.constructor?.name === "VoidFilter");
    if (!ifVoid) return;
    if (this._origIfVoidEnabled === null) this._origIfVoidEnabled = ifVoid.enabled;
    const needVoid = (canvas.tokens?.placeables?.length || 0) > 0;
    ifVoid.enabled = needVoid ? this._origIfVoidEnabled : false;
  }

  _hasMultiElevationDepth() {
    const visibleLevels = (canvas.scene?.levels?.sorted || []).filter(l => l.isVisible);
    if (visibleLevels.length > 1) return true;
    const baseElev = getLevelBottomElevation(canvas.level);

    // Check native TileDocuments that restrict light above base elevation
    if (canvas.tiles?.placeables) {
      for (const t of canvas.tiles.placeables) {
        if (t.visible && t.document?.restrictions?.light && (t.document.elevation ?? 0) > baseElev) {
          return true;
        }
      }
    }
    // Check active streamed virtual tiles that restrict light above base elevation
    for (const [, vt] of this.activeVirtualTiles) {
      if (vt.mesh?.restrictsLight && (vt.mesh.elevation ?? 0) > baseElev) {
        return true;
      }
    }
    // Check active interactive building roofs that restrict indoor light above base elevation
    for (const [, ov] of this.activeOverlays) {
      if (ov.roofMesh?.visible && ov.roofMesh.restrictsLight && (ov.roofMesh.elevation ?? 0) > baseElev) {
        return true;
      }
    }
    return false;
  }

  _optimizeEffectsLayers(effects) {
    if (!effects) return;
    const lightingOpts = canvas.visibility?.visionModeData?.activeLightingOptions;

    if (effects.darkness) {
      effects.darkness.visible = effects.darkness.children.length > 0;
    }

    const bgLight = effects.background?.lighting;
    if (bgLight && bgLight.visible) {
      const hasPost = Boolean(lightingOpts?.background?.postProcessingModes?.length);
      if (!hasPost) {
        let hasEffect = false;
        for (const ch of bgLight.children) {
          const u = ch.shader?.uniforms;
          if (!u || u.luminosity || u.saturation || u.contrast || u.shadows) {
            hasEffect = true;
            break;
          }
        }
        if (!hasEffect) bgLight.visible = false;
      }
    }

    const col = effects.coloration;
    if (col) {
      const hasPost = Boolean(lightingOpts?.coloration?.postProcessingModes?.length);
      const ourMeshes = this.lightBatch.countAttachedColorMeshes(col);
      // Foundry's CanvasColorationEffects always keeps 1 internal #background child
      const hasOtherSources = col.children.length > (1 + ourMeshes);
      const hasBatchLights = this.lightBatch.hasVisibleLights();
      col.visible = hasBatchLights || hasOtherSources || hasPost;
    }
  }

  _getLightBatchBuildOpts() {
    return {
      isSuppressedFn: (lid) => this.dynamicLights.has(lid),
      hasLevelEditsFn: (levelId) =>
        Boolean(this.wallEdits.get(levelId)?.size) || Boolean(this.lightEdits.get(levelId)?.size),
      onBatchChanged: () => {
        if (this.active && canvas?.effects) this._optimizeEffectsLayers(canvas.effects);
      },
      onChunkBaked: () => {
        if (this.active) this.updateSimAndLightBubbles(false);
      }
    };
  }

  mount(scene) {
    this.unmount();
    const mountGen = ++this._mountGen;
    this._mounting = true;
    const p = this._mountImpl(scene, mountGen).finally(() => {
      if (this._mountGen === mountGen) this._mounting = false;
      if (this._mountPromise === p) this._mountPromise = null;
    });
    this._mountPromise = p;
    return p;
  }

  async _mountImpl(scene, mountGen) {
    const cfg = scene?.flags?.[MODULE_ID];
    const anyLevelFlag = scene?.levels?.some?.(l => l.flags?.[MODULE_ID]?.enabled);
    if (!cfg?.enabled && !anyLevelFlag) return;

    installLosHorizonPatch();
    installBulkSelectionPatch();
    installHoverFadeHitTestPatch();
    installLazyTokenLayerPatch();
    this._ensureSocket();
    const mountedLevelId = canvas.level?.id;

    const { layers, sceneManifest } = await this._resolveVisibleLevelLayers(scene, cfg || {});
    if (this._mountGen !== mountGen) return;
    if (canvas.scene?.id !== scene.id || canvas.level?.id !== mountedLevelId) {
      this.unmount();
      return;
    }

    // If the currently viewed level (and its visible sub-levels) have NO Boundless layers, leave Foundry 100% native!
    if (layers.length === 0) {
      this.unmount();
      console.log(`${MODULE_ID} | Active level "${canvas.level?.name}" has no Boundless layers; running native Foundry rendering.`);
      return;
    }

    this.manifest = sceneManifest;
    this.active = true;
    this.visibleLevelLayers = layers;
    this.levelLayers.clear();
    for (const l of layers) this.levelLayers.set(l.level.id, l);

    // Allow full seamless zoom-out across giant worlds (including 6000x6000 continents) and deep 2.5x combat zoom-in
    if (canvas.dimensions?.scale) {
      const [sw = 1600, sh = 1000] = canvas.screenDimensions || [];
      const worldMax = Math.max(canvas.dimensions.width || 100000, canvas.dimensions.height || 100000);
      const fitScale = Math.min(sw, sh) / (worldMax * 1.25);
      this._worldMinScale = Math.min(canvas.dimensions.scale.min, WORLD_MIN_SCALE, fitScale);
      canvas.dimensions.scale.min = this._worldMinScale;
      canvas.dimensions.scale.max = Math.max(canvas.dimensions.scale.max, 2.5);
    }

    // Persist camera on F5 / tab close and restore last saved view immediately before tile streaming starts
    this._beforeUnloadFn = () => this._saveCameraNow();
    window.addEventListener("beforeunload", this._beforeUnloadFn);
    this._restoreCamera(scene);
    this.syncZoomLimits({ animate: false });

    // Soft lighting/coloration/fog blur does not need 2x HiDPI FBO fill-rate (4x fewer shaded pixels at 144Hz)
    this._capFilterResolution(canvas.effects?.coloration?.filter, 1.0);
    this._capFilterResolution(canvas.effects?.illumination?.filter, 1.0);
    for (const f of canvas.visibility?.filters || []) {
      this._capFilterResolution(f, 1.0);
    }

    // Disable heavy 3-pass fullscreen SMAAFilter on Boundless (mipmapped 2D tiles look sharper without it)
    const smaa = canvas.stage?.filters?.find(f => f?.constructor?.name === "SMAAFilter");
    if (smaa) {
      this._origSmaaEnabled = smaa.enabled;
      smaa.enabled = false;
    }
    this._syncInterfaceVoidFilter();

    // Pause redundant per-frame CanvasDepthMask full-scene re-renders while camera & tokens are idle
    if (canvas.masks?.depth) {
      this._origDepthAutoRender = canvas.masks.depth.autoRender;
      canvas.masks.depth.autoRender = false;
      this._depthDirty = true;
    if (canvas.masks?.depth) canvas.masks.depth.renderDirty = true;
    }

    // Prevent PIXI TextureGCSystem from silently evicting _glTextures out from under our byte-budgeted LRUTextureManager every 60s
    if (canvas.app?.renderer?.textureGC && PIXI?.GC_MODES?.MANUAL !== undefined) {
      this._origTextureGcMode = canvas.app.renderer.textureGC.mode;
      canvas.app.renderer.textureGC.mode = PIXI.GC_MODES.MANUAL;
    }

    // Load virtual wall/light/sound/tile edits and persisted doorStates before mounting chunkStreamer & GPU light batch
    this._loadWallEdits(scene);
    this._loadLightEdits(scene);
    this._loadSoundEdits(scene);
    this._loadTileEdits(scene);
    this._restoreDoorStates(scene);

    // Mount chunked world streamer BEFORE lightBatch & first updateAll so active token/viewport chunks stream smoothly
    this.chunkStreamer.mount(layers);

    // Build unified GPU light batch across all visible Boundless levels (monolithic or chunked macroLights)
    const pxPerFt = canvas.dimensions.size / canvas.dimensions.distance;
    const hasAnyOverlays = layers.some(l => l.spec?.overlays && (Array.isArray(l.spec.overlays) ? l.spec.overlays.length > 0 : Object.keys(l.spec.overlays).length > 0));
    // Keep indoor lights suppressed briefly until pixel-accurate bakedRoofMask finishes (or roofs mount in depthMask)
    this._waitingForRoofsBeforeIndoor = hasAnyOverlays;
    this.lightBatch.hideIndoorLights = hasAnyOverlays;
    this.lightBatch.build(
      layers,
      pxPerFt,
      (lid, kind, sk, idx, raw) => this.resolveVirtualWall(lid, kind, sk, idx, raw),
      (lid, sk, idx, raw, lvl) => this.resolveVirtualLight(lid, sk, idx, raw, lvl),
      this._getLightBatchBuildOpts()
    );
    this.lightBatch.attachTo(canvas.effects);

    // Asynchronously bake 2048x2048 pixel-accurate roof alpha mask so macro lighting (localZ < 5) matches depthMask 1:1
    this._bakeRoofMask(layers, scene.id, mountedLevelId);

    const preloadTasks = [];
    for (const layer of layers) {
      if (layer.hasPyramid) {
        const mBase = layer.superGrid?.macroPyramidUrl || layer.pyramidBaseUrl;
        preloadTasks.push(this.texMgr.load(`${mBase}/0/0_0.webp`, { mipmap: true, isPinned: true }));
      }
    }
    await Promise.all(preloadTasks);
    if (this._mountGen !== mountGen) return;
    if (!this.active || canvas.scene?.id !== scene.id || canvas.level?.id !== mountedLevelId) {
      this.unmount();
      return;
    }

    // Warm z=1 tiles silently in background for every visible pyramid layer (clipped to actual bounds for non-square maps)
    for (const layer of layers) {
      if (!layer.hasPyramid || layer.maxZoomZ < 1) continue;
      const mBase = layer.superGrid?.macroPyramidUrl || layer.pyramidBaseUrl;
      const z1TileSz = this._getPyramidTileSize(layer, 1);
      const maxX1 = Math.min(1, Math.floor((Math.max(1, layer.bounds?.w || layer.worldPx) - 0.001) / z1TileSz));
      const maxY1 = Math.min(1, Math.floor((Math.max(1, layer.bounds?.h || layer.worldPx) - 0.001) / z1TileSz));
      for (let y = 0; y <= maxY1; y++) for (let x = 0; x <= maxX1; x++) {
        this.texMgr.load(`${mBase}/1/${x}_${y}.webp`, { mipmap: true, isPinned: true });
      }
    }

    // Mount permanent z=0 base layer for every visible pyramid level
    for (const layer of layers) {
      if (layer.hasPyramid) {
        const baseKey = `${layer.level.id}::0_0_0`;
        if (this.tilesByKey.has(baseKey)) continue;
        const mBase = layer.superGrid?.macroPyramidUrl || layer.pyramidBaseUrl;
        this.ensureTile(layer, {
          key: baseKey,
          levelId: layer.level.id,
          z: 0, x: 0, y: 0,
          src: `${mBase}/0/0_0.webp`
        }, true);
      }
    }

    // Ticker drives buttery-smooth 160ms alpha crossfades & lazy depth updates
    this.tickerFn = () => this.stepCrossfades(canvas.app.ticker.deltaMS || 16.6);
    canvas.app.ticker.add(this.tickerFn);

    // Mount POI fast-travel pins, character avatar tracker, high-res chunked Fog of War, native wall/door/layer editors, token virtualization streamer, and spatial ambient audio
    this.poiManager.mount(scene, this.manifest);
    this.charPins.mount(scene);
    this.fogManager.mount(scene);
    this.wallEditor.mount();
    this.layerEditors.mount();
    this.tokenStreamer.mount(scene);

    this.updateAll(true);
    this.syncZoomLimits({ animate: false });
    this._depthElevSyncNeeded = true;

    const lvlSummary = layers.map(l => `${l.level.name}[${l.level.elevation?.bottom}..${l.level.elevation?.top}]`).join(", ");
    console.log(
      `${MODULE_ID} | Mounted level "${canvas.level?.name}" | Visible Boundless layers: ${lvlSummary} | ` +
      `GPU light batch: ${this.lightBatch.totalLights} lights (${this.lightBatch.totalVertices} verts).`
    );
  }

  acquireMesh() {
    if (this.meshPool.length > 0) {
      const m = this.meshPool.pop();
      m.name = null;
      m.visible = true;
      m.occluded = false;
      m.angle = 0;
      m.scale.set(1, 1);
      m.tint = 0xffffff;
      m.textureAlphaThreshold = 0.75;
      m._occludedBySameElevationSurfaces = true;
      m._ssDofBlurPx = 0;
      m._boundlessMesh = true;
      m._boundlessTile = false;
      if (Object.prototype.hasOwnProperty.call(m, "updateCanvasTransform")) delete m.updateCanvasTransform;
      m.pluginName = m.constructor?.classPluginName || "batchOcclusion";
      return m;
    }
    const PrimarySpriteMesh = foundry.canvas.primary.PrimarySpriteMesh;
    const m = new PrimarySpriteMesh({ texture: PIXI.Texture.WHITE });
    m.anchor.set(0, 0);
    m.eventMode = "none";
    m.textureAlphaThreshold = 0.75;
    m._boundlessMesh = true;
    m._boundlessTile = false;
    return m;
  }

  retireMesh(m) {
    if (!m) return;
    // Clear any Showstopper Depth-of-Field filter & occlusion state before pooling so reused meshes never inherit stale state
    m.name = null;
    m._boundlessTile = false;
    if (Object.prototype.hasOwnProperty.call(m, "updateCanvasTransform")) delete m.updateCanvasTransform;
    m.pluginName = m.constructor?.classPluginName || "batchOcclusion";
    m.texture = PIXI.Texture.EMPTY;
    m.debounceSetOcclusion?.cancel?.();
    m.hoverFade = false;
    m.occlusionMode = CONST.OCCLUSION_MODES.NONE;
    m.occluded = false;
    if (m._occlusionState) {
      m._occlusionState.fade = 0;
      m._occlusionState.radial = 0;
      m._occlusionState.vision = 0;
      m._occlusionState.surface = 0;
    }
    if (m._hoverFadeState) {
      m._hoverFadeState.hovered = false;
      m._hoverFadeState.faded = false;
      m._hoverFadeState.fading = false;
      m._hoverFadeState.hoveredTime = 0;
      m._hoverFadeState._hoveredTime = 0;
      m._hoverFadeState.fadingTime = 0;
      m._hoverFadeState.occlusion = 0;
    }
    m._ssDofBlurPx = 0;
    if (m._ssDofBlurFilter) {
      try { m._ssDofBlurFilter.blur = 0; } catch {}
      if (Array.isArray(m.filters)) {
        const next = m.filters.filter(f => f !== m._ssDofBlurFilter);
        m.filters = next.length > 0 ? next : null;
      }
    }
    if (m._ssSetFilterArea) {
      m.filterArea = null;
      m._ssSetFilterArea = false;
    }
    m.parent?.removeChild(m);
    if (this.meshPool.length < 1024) {
      this.meshPool.push(m);
    } else {
      try { m._ssDofBlurFilter?.destroy?.(); } catch {}
      m._ssDofBlurFilter = null;
      m.destroy();
    }
  }

  /**
   * Apply Showstopper elevation Depth-of-Field blur immediately to a newly streamed mesh
   * and queue a coalesced perspective sync so meshes streamed mid-flight match the focal plane on frame 1.
   */
  _syncShowstopperMeshDof(m) {
    if (!m || m.destroyed) return;
    const ssApi = getShowstopperMovementApi();
    if (!ssApi) return;
    try {
      if (!ssApi.getTokenMovementSetting?.("vertical") || !ssApi.getTokenMovementSetting?.("verticalBlur")) return;
      const baseElev = getLevelBaseElevation(canvas?.level);
      const obsElev = Number(ssApi.getObserverElevation?.());
      if (!Number.isFinite(obsElev) || obsElev <= baseElev + 0.05) return;
      if (typeof ssApi.computeElevationPerspective === "function") {
        const grid = canvas?.grid?.size ?? 100;
        const sceneDist = Number(canvas?.scene?.grid?.distance ?? canvas?.grid?.distance) || 5;
        const obsPersp = ssApi.computeElevationPerspective(obsElev, obsElev, {
          gridSize: grid, gridDistance: sceneDist, tokenSize: grid, hoverBlend: 1, baseElevation: baseElev
        });
        const mElev = Number.isFinite(Number(m.elevation)) ? Number(m.elevation) : baseElev;
        const mPersp = ssApi.computeElevationPerspective(mElev, obsElev, {
          gridSize: grid, gridDistance: sceneDist, tokenSize: grid, hoverBlend: 0, baseElevation: baseElev
        });
        const occAlpha = Number.isFinite(Number(obsPersp?.cameraOcclusionAlpha)) ? Number(obsPersp.cameraOcclusionAlpha) : 1;
        const blurPx = (Number(mPersp?.dofBlurPx) || 0) * occAlpha;
        m._ssDofBlurPx = blurPx > 0.22 ? blurPx : 0;
      }
      this._scheduleShowstopperDofSync();
    } catch {}
  }

  _scheduleShowstopperDofSync() {
    if (this._ssDofSyncQueued) return;
    const ssApi = getShowstopperMovementApi();
    if (!ssApi?.syncElevationPerspective) return;
    this._ssDofSyncQueued = true;
    queueMicrotask(() => {
      this._ssDofSyncQueued = false;
      if (!this.active || !canvas?.ready) return;
      try {
        ssApi.syncElevationPerspective({ immediate: true });
      } catch {}
    });
  }

  invalidateShowstopperSurfaces(immediate = false) {
    const ssApi = getShowstopperMovementApi();
    if (!ssApi?.invalidateSupportingSurfaces) return;
    if (!immediate && this.isActivelyMoving()) {
      const now = performance.now();
      if ((now - this._lastShowstopperMs) < 200) {
        this._showstopperDirty = true;
        return;
      }
    }
    this._showstopperDirty = false;
    this._lastShowstopperMs = performance.now();
    try {
      ssApi.invalidateSupportingSurfaces();
    } catch {}
  }

  resolvePyramidTile(layer, z, x, y) {
    const lid = layer.level.id;
    const flags = layer.spec.blockFlags;
    const sg = layer.superGrid;

    if (sg) {
      const macroMaxZ = sg.macroMaxZ ?? 2;
      if (z <= macroMaxZ) {
        const mBase = sg.macroPyramidUrl || layer.pyramidBaseUrl;
        return { levelId: lid, z, x, y, key: `${lid}::${z}_${x}_${y}`, src: `${mBase}/${z}/${x}_${y}.webp`, tint: 0xffffff };
      }
      const localZ = z - (macroMaxZ + 1);
      const localN = 1 << localZ;
      const gx = Math.max(0, Math.min((sg.cols || 6) - 1, Math.floor(x / localN)));
      const gy = Math.max(0, Math.min((sg.rows || 6) - 1, Math.floor(y / localN)));
      const lx = x - gx * localN;
      const ly = y - gy * localN;
      const tint = sg.parsedTints?.[gy]?.[gx] ?? 0xffffff;
      const bBase = sg.basePyramidUrl || `modules/${MODULE_ID}/assets/pyramid`;

      if (!flags || localZ <= 4) {
        return { levelId: lid, z, x, y, key: `${lid}::${z}_${x}_${y}`, src: `${bBase}/${localZ}/${lx}_${ly}.webp`, tint };
      }
      if (localZ === 5) {
        const ch = flags[ly]?.[lx] || "6";
        const src = ch === "F" ? `${bBase}/forest/5_${lx % 4}_${ly % 4}.webp` : `${bBase}/5/${lx}_${ly}.webp`;
        return { levelId: lid, z, x, y, key: `${lid}::${z}_${x}_${y}`, src, tint };
      }
      if (localZ === 6) {
        const bx = lx >> 1, by = ly >> 1;
        const ch = flags[by]?.[bx] || "6";
        const src = ch === "F"
          ? `${bBase}/forest/6_${bx % 4}_${by % 4}_${lx % 2}_${ly % 2}.webp`
          : `${bBase}/6/${lx}_${ly}.webp`;
        return { levelId: lid, z, x, y, key: `${lid}::${z}_${x}_${y}`, src, tint };
      }
      // localZ === 7
      const bx = lx >> 2, by = ly >> 2;
      const ch = flags[by]?.[bx] || "6";
      if (ch === "6" || ch === "F") {
        const px = lx >> 1, py = ly >> 1;
        const pGlobalX = gx * (localN >> 1) + px;
        const pGlobalY = gy * (localN >> 1) + py;
        const pZ = z - 1;
        const src = ch === "F"
          ? `${bBase}/forest/6_${bx % 4}_${by % 4}_${px % 2}_${py % 2}.webp`
          : `${bBase}/6/${px}_${py}.webp`;
        return { levelId: lid, z: pZ, x: pGlobalX, y: pGlobalY, key: `${lid}::${pZ}_${pGlobalX}_${pGlobalY}`, src, tint };
      }
      return { levelId: lid, z, x, y, key: `${lid}::${z}_${x}_${y}`, src: `${bBase}/7/${lx}_${ly}.webp`, tint };
    }

    const base = layer.pyramidBaseUrl;
    if (!flags || z <= 4) {
      return { levelId: lid, z, x, y, key: `${lid}::${z}_${x}_${y}`, src: `${base}/${z}/${x}_${y}.webp` };
    }
    if (z === 5) {
      const ch = flags[y]?.[x] || "6";
      const src = ch === "F" ? `${base}/forest/5_${x % 4}_${y % 4}.webp` : `${base}/5/${x}_${y}.webp`;
      return { levelId: lid, z: 5, x, y, key: `${lid}::5_${x}_${y}`, src };
    }
    if (z === 6) {
      const bx = x >> 1, by = y >> 1;
      const ch = flags[by]?.[bx] || "6";
      const src = ch === "F"
        ? `${base}/forest/6_${bx % 4}_${by % 4}_${x % 2}_${y % 2}.webp`
        : `${base}/6/${x}_${y}.webp`;
      return { levelId: lid, z: 6, x, y, key: `${lid}::6_${x}_${y}`, src };
    }
    // z === 7
    const bx = x >> 2, by = y >> 2;
    const ch = flags[by]?.[bx] || "6";
    if (ch === "6" || ch === "F") {
      const px = x >> 1, py = y >> 1;
      const src = ch === "F"
        ? `${base}/forest/6_${bx % 4}_${by % 4}_${px % 2}_${py % 2}.webp`
        : `${base}/6/${px}_${py}.webp`;
      return { levelId: lid, z: 6, x: px, y: py, key: `${lid}::6_${px}_${py}`, src };
    }
    return { levelId: lid, z: 7, x, y, key: `${lid}::7_${x}_${y}`, src: `${base}/7/${x}_${y}.webp` };
  }

  getViewportWorldRect(padFraction = 0.25, worldPx = null) {
    const scale = canvas.stage.scale.x || 1;
    const pivot = canvas.stage.pivot;
    const [sw, sh] = canvas.screenDimensions;
    const wWorld = sw / scale;
    const hWorld = sh / scale;
    const padX = wWorld * padFraction;
    const padY = hWorld * padFraction;
    const maxW = worldPx || canvas.dimensions?.width || 100000;
    const maxH = worldPx || canvas.dimensions?.height || 100000;
    return {
      scale,
      x0: Math.max(0, pivot.x - wWorld * 0.5 - padX),
      y0: Math.max(0, pivot.y - hWorld * 0.5 - padY),
      x1: Math.min(maxW, pivot.x + wWorld * 0.5 + padX),
      y1: Math.min(maxH, pivot.y + hWorld * 0.5 + padY)
    };
  }

  updatePyramid() {
    if (!this.active || !this.visibleLevelLayers.length || !canvas?.ready || this._inUpdatePyramid) return;
    this._inUpdatePyramid = true;
    try {
    const vp = this.getViewportWorldRect(0.28);

    // Update GPU light frustum culling, spatial chunk streaming, POI pin scale, chunked fog culling, spatial audio, and native streamed walls/doors
    this.chunkStreamer.update(vp);
    this.lightBatch.updateViewport(vp);
    this._optimizeEffectsLayers(canvas.effects);
    this.poiManager.updateViewport(vp);
    this.charPins.updateViewport();
    this.fogManager.updateViewportCulling(vp);
    // Keep token frustum culling & GPU Impostor Atlas synced even during camera flight (<0.05ms)
    this.tokenStreamer.scheduleSync(vp);
    if (!this.isCameraFlying) {
      this.audioStreamer.update(
        this.visibleLevelLayers,
        vp,
        (lid, sk, idx, raw, lvl) => this.resolveVirtualSound(lid, sk, idx, raw, lvl)
      );
      this.wallEditor.syncViewport(false, vp);
      this.layerEditors.syncViewport(false, vp);
    }
    this._depthDirty = true;
    if (canvas.masks?.depth) canvas.masks.depth.renderDirty = true;

    let anyTilesOrOverlaysChanged = false;
    let maxTargetZ = 0;

    // Process currently viewed level FIRST so its pyramid tiles & virtual props always jump ahead of hidden lower levels (e.g. basement)
    const orderedLayers = this.visibleLevelLayers.length > 1
      ? this.visibleLevelLayers.slice().sort((a, b) => (b.level?.isView ? 1 : 0) - (a.level?.isView ? 1 : 0))
      : this.visibleLevelLayers;

    for (const layer of orderedLayers) {
      const { bounds } = layer;
      const targetZ = this._computeTargetZ(layer, vp.scale, { hysteresis: true });
      layer.lastTargetZ = targetZ;
      if (targetZ > maxTargetZ) maxTargetZ = targetZ;

      // 1. Quadtree Pyramid streaming for this level (if it has a pyramid)
      if (layer.hasPyramid) {
        const bx0 = Math.max(bounds.x, vp.x0);
        const by0 = Math.max(bounds.y, vp.y0);
        const bx1 = Math.min(bounds.x + bounds.w, vp.x1);
        const by1 = Math.min(bounds.y + bounds.h, vp.y1);
        const overlapsBounds = bx0 < bx1 && by0 < by1;

        let tx0 = 0, ty0 = 0, tx1 = 0, ty1 = 0;
        if (targetZ > 0 && overlapsBounds) {
          const { nx, ny } = this._getPyramidGridDims(layer, targetZ);
          const tileWorldSize = this._getPyramidTileSize(layer, targetZ);
          tx0 = Math.max(0, Math.floor((bx0 - bounds.x) / tileWorldSize));
          ty0 = Math.max(0, Math.floor((by0 - bounds.y) / tileWorldSize));
          tx1 = Math.min(nx - 1, Math.floor((bx1 - 0.001 - bounds.x) / tileWorldSize));
          ty1 = Math.min(ny - 1, Math.floor((by1 - 0.001 - bounds.y) / tileWorldSize));
        }

        const pyrKey = `${overlapsBounds ? 1 : 0}_${targetZ}_${tx0}_${ty0}_${tx1}_${ty1}`;
        if (pyrKey !== layer.lastPyramidKey) {
          layer.lastPyramidKey = pyrKey;
          anyTilesOrOverlaysChanged = true;

          const lid = layer.level.id;
          const baseKey = `${lid}::0_0_0`;
          const mBase = layer.superGrid?.macroPyramidUrl || layer.pyramidBaseUrl;
          const desiredMap = new Map();
          if (overlapsBounds) {
            desiredMap.set(baseKey, { levelId: lid, z: 0, x: 0, y: 0, key: baseKey, src: `${mBase}/0/0_0.webp` });
            if (targetZ > 0) {
              for (let ty = ty0; ty <= ty1; ty++) {
                for (let tx = tx0; tx <= tx1; tx++) {
                  const spec = this.resolvePyramidTile(layer, targetZ, tx, ty);
                  desiredMap.set(spec.key, spec);
                }
              }
            }
          }

          const desiredSrcs = new Set();
          for (const spec of desiredMap.values()) desiredSrcs.add(spec.src);

          for (const [k, entry] of this.tilesByKey) {
            if (entry.levelId !== lid) continue;
            const inDesired = desiredMap.has(k);
            const keepReveal = Boolean(entry.isReveal && this._revealTileKeys.has(k));
            if (!keepReveal && entry.isReveal) {
              entry.isReveal = false;
              this._revealTileKeys.delete(k);
            }
            entry.desired = inDesired || keepReveal;
            if (entry.desired) {
              entry.fadingOut = false;
              desiredSrcs.add(entry.src);
            } else {
              if (!entry.ready && entry.z > 2) {
                this.tilesByKey.delete(k);
                if (!desiredSrcs.has(entry.src)) this.texMgr.cancel(entry.src);
              }
            }
          }

          for (const [k, spec] of desiredMap) {
            if (!this.tilesByKey.has(k)) {
              this.ensureTile(layer, spec, spec.z === 0);
            }
          }
          this._tilesDirty = true;
        }
      }

      // 2. Interactive House Overlays (roofs stay mounted at all zoom levels for seamless depth/light & token occlusion; walls show at targetZ >= 6)
      if (this.syncOverlayMeshes(layer, targetZ, vp)) {
        anyTilesOrOverlaysChanged = true;
      }

      // 3. Virtual Streamed Tiles (`spec.tiles` + `sectors[sk].t`) for this level
      if (this.syncVirtualTiles(layer, targetZ, vp)) {
        anyTilesOrOverlaysChanged = true;
      }
    }

    this.lastTargetZ = maxTargetZ;
    // Synchronously reveal z=0 fallback BEFORE this frame renders whenever zoom-out/pan exposes any edge outside mounted z>0 tiles
    this._syncBaseLayerVisibility(this.getViewportWorldRect(0.0));
    this._syncIndoorLightVisibility();
    if (anyTilesOrOverlaysChanged) {
      this._roofTokenOccDirty = true;
      if (this.texMgr.needsPrune()) {
        this._pruneNeeded = true;
      }
    }
    } finally {
      this._inUpdatePyramid = false;
    }
  }

  _collectInUseTextures() {
    const inUse = new Set();
    for (const [, entry] of this.tilesByKey) inUse.add(entry.src);
    for (const [, ov] of this.activeOverlays) {
      if (ov.srcWalls) inUse.add(ov.srcWalls);
      if (ov.srcRoof) inUse.add(ov.srcRoof);
    }
    for (let i = 0; i < this.pendingOverlayMounts.length; i++) {
      const po = this.pendingOverlayMounts[i];
      if (po?.ovSpec?.walls) inUse.add(po.ovSpec.walls);
      if (po?.ovSpec?.roof) inUse.add(po.ovSpec.roof);
    }
    for (const fullKey of this.overlayPending) {
      const cleanKey = fullKey.endsWith(":w") ? fullKey.slice(0, -2) : fullKey;
      const sep = cleanKey.indexOf("::");
      if (sep > 0) {
        const l = this.levelLayers.get(cleanKey.slice(0, sep));
        const rawOid = cleanKey.slice(sep + 2);
        const ovSpec = l?.spec?.overlays?.[rawOid];
        if (ovSpec?.walls) inUse.add(ovSpec.walls);
        if (ovSpec?.roof) inUse.add(ovSpec.roof);
      }
    }
    for (const [, vt] of this.activeVirtualTiles) {
      if (vt.src) inUse.add(vt.src);
    }
    for (let i = 0; i < this.pendingVirtualTileMounts.length; i++) {
      const pv = this.pendingVirtualTileMounts[i];
      if (pv?.tSpec?.src) inUse.add(pv.tSpec.src);
    }
    for (const fullId of this.virtualTilePending) {
      const sep = fullId.indexOf("::");
      if (sep > 0) {
        const lid = fullId.slice(0, sep);
        const tid = Number(fullId.slice(sep + 2));
        const l = this.levelLayers.get(lid);
        const tSpec = l ? this.resolveVirtualTile(lid, tid, l.spec?.tiles?.[tid], l.level) : null;
        if (tSpec?.src) inUse.add(tSpec.src);
      }
    }
    return inUse;
  }

  ensureTile(layer, spec, instant = false) {
    const { bounds } = layer;
    const sizePx = this._getPyramidTileSize(layer, spec.z);
    const x0 = bounds.x + spec.x * sizePx;
    const y0 = bounds.y + spec.y * sizePx;

    const prevEntry = this.tilesByKey.get(spec.key);
    if (prevEntry?.mesh) this.retireMesh(prevEntry.mesh);

    const entry = {
      key: spec.key,
      levelId: layer.level.id,
      layer,
      z: spec.z,
      x: spec.x,
      y: spec.y,
      src: spec.src,
      tint: spec.tint ?? 0xffffff,
      x0,
      y0,
      sizePx,
      ready: false,
      mesh: null,
      alpha: instant ? 1.0 : 0.0,
      fadingOut: false,
      desired: true
    };
    this.tilesByKey.set(spec.key, entry);
    this._tilesDirty = true;

    const isPinned = spec.z <= 1;
    const isViewedLayer = Boolean(layer.level?.isView);
    const visVp = this.getViewportWorldRect(0.0);
    const onVisScreen = !(x0 + sizePx < visVp.x0 || x0 > visVp.x1 || y0 + sizePx < visVp.y0 || y0 > visVp.y1);
    const loadPriority = (isPinned || (isViewedLayer && onVisScreen)) ? 0 : 1;
    this.texMgr.load(spec.src, { mipmap: true, isPinned, priority: loadPriority }).then(tex => {
      if (!this.active) return;
      const e = this.tilesByKey.get(spec.key);
      if (e !== entry) return;
      if (!tex || !isTextureUsable(tex)) {
        if (!e.ready) this.tilesByKey.delete(spec.key);
        return;
      }
      if (e.fadingOut || (!e.desired && e.z > 0)) {
        if (!e.ready) this.tilesByKey.delete(spec.key);
        return;
      }
      if (instant || e.z <= 1) {
        this._mountTileMesh(e, tex, instant);
      } else {
        const qItem = { key: spec.key, entry, tex, instant };
        if (isViewedLayer && onVisScreen) this.pendingTileMounts.unshift(qItem);
        else this.pendingTileMounts.push(qItem);
        this._tilesDirty = true;
      }
    });
  }

  _mountTileMesh(e, tex, instant) {
    if (!e || e.ready || e.fadingOut || (!e.desired && e.z > 0)) return false;
    if (!isTextureUsable(tex)) {
      if (this.tilesByKey.get(e.key) === e) {
        this.tilesByKey.delete(e.key);
        if (e.layer) e.layer.lastPyramidKey = "";
      }
      return false;
    }
    const PrimaryCanvasGroup = foundry.canvas.groups.PrimaryCanvasGroup;
    const layer = e.layer;
    const levelElev = getLevelBottomElevation(layer.level);

    const m = this.acquireMesh();
    m._boundlessTile = true;
    m.name = `Level.${layer.level?.index ?? 0}.BoundlessTile.${e.key}`;
    m.anchor.set(0, 0);
    m.texture = tex;
    m.tint = e.tint ?? 0xffffff;
    m.position.set(e.x0, e.y0);
    m.width = e.sizePx + 0.5;
    m.height = e.sizePx + 0.5;
    m.elevation = levelElev;
    m.sortLayer = PrimaryCanvasGroup.SORT_LAYERS.SCENE;
    m.sort = 1 + e.z * 10;
    m.occlusionMode = layer.isUpper
      ? (CONST.OCCLUSION_MODES.FADE | CONST.OCCLUSION_MODES.RADIAL | CONST.OCCLUSION_MODES.SURFACE)
      : CONST.OCCLUSION_MODES.SURFACE;
    m.occludedAlpha = layer.isUpper ? 0.08 : 1.0;
    m.hoverFade = layer.isUpper;
    // Never write coarse z=0 fallback (64px/texel blur) into CanvasDepthMask so rapid zoom-outs never shift lighting edges
    m.restrictsLight = e.z > 0;
    m.restrictsWeather = e.z > 0;

    // Only defer visibility (`awaitingSwap`) when zooming IN (`other.z < e.z`, coarser ancestor fully covers this tile).
    // When zooming OUT (`e.z < other.z`), the new coarser tile sorts BEHIND old finer tiles (`m.sort = 1 + e.z * 10`)
    // so making it immediately visible fills surrounding space around old tiles with zero black borders!
    let hasOtherZCovering = false;
    if (!instant && e.z > 0 && !e.isReveal) {
      for (const [, other] of this.tilesByKey) {
        if (other.levelId === e.levelId && other.ready && !other.awaitingSwap && other.z > 0 && other.z < e.z && other.mesh?.visible && other.alpha >= 0.9 &&
            this.rectsOverlap(e.x0, e.y0, e.sizePx, other.x0, other.y0, other.sizePx)) {
          hasOtherZCovering = true;
          break;
        }
      }
    }
    // Keep replacement LOD tiles hidden at alpha=1.0 until all visible tiles of the new LOD are ready,
    // then swap atomically in 1 frame so semi-transparent floors/shadows never double-blend or flicker CanvasDepthMask!
    e.alpha = 1.0;
    e.awaitingSwap = hasOtherZCovering;
    m.unoccludedAlpha = 1.0;
    m.visible = !hasOtherZCovering;
    e.mesh = m;
    e.ready = true;
    canvas.primary.addChild(m);
    m.updateCanvasTransform?.();
    // Static ground/lower pyramid tiles never fade on occlusion or move, so use fast PIXI batch shader & skip per-frame quadtree churn
    if (!layer.isUpper) {
      m.pluginName = "batch";
      m.updateCanvasTransform = NOOP_TRANSFORM;
    }
    this._syncShowstopperMeshDof(m);
    canvas.primary.sortDirty = true;
    this._tilesDirty = true;
    if (m.visible) {
      this._depthDirty = true;
      if (canvas.masks?.depth) {
        canvas.masks.depth.renderDirty = true;
        canvas.masks.depth._elevationDirty = true;
      }
    }
    return true;
  }

  _isViewportCoveredByHigherTiles(layer, visVp) {
    if (!layer?.bounds || !visVp) return false;
    const lid = layer.level.id;
    const rx0 = Math.max(layer.bounds.x, visVp.x0);
    const ry0 = Math.max(layer.bounds.y, visVp.y0);
    const rx1 = Math.min(layer.bounds.x + layer.bounds.w, visVp.x1);
    const ry1 = Math.min(layer.bounds.y + layer.bounds.h, visVp.y1);
    if (rx1 <= rx0 || ry1 <= ry0) return true;
    const visHigher = [];
    for (const [, other] of this.tilesByKey) {
      if (other.levelId === lid && other.ready && !other.awaitingSwap && other.z > 0 && other.mesh?.visible && other.alpha >= 0.98 &&
          other.x0 < rx1 && other.x0 + other.sizePx > rx0 &&
          other.y0 < ry1 && other.y0 + other.sizePx > ry0) {
        visHigher.push(other);
      }
    }
    if (visHigher.length === 0) return false;
    const rw = rx1 - rx0;
    const rh = ry1 - ry0;
    const fracs = [0.002, 0.25, 0.5, 0.75, 0.998];
    for (let yi = 0; yi < 5; yi++) {
      const py = ry0 + rh * fracs[yi];
      for (let xi = 0; xi < 5; xi++) {
        const px = rx0 + rw * fracs[xi];
        let covered = false;
        for (let i = 0; i < visHigher.length; i++) {
          const o = visHigher[i];
          if (px >= o.x0 && px <= o.x0 + o.sizePx && py >= o.y0 && py <= o.y0 + o.sizePx) {
            covered = true;
            break;
          }
        }
        if (!covered) return false;
      }
    }
    return true;
  }

  _syncBaseLayerVisibility(visVp, levelReadyState = null) {
    let anyChanged = false;
    for (const layer of this.visibleLevelLayers) {
      if (!layer.hasPyramid) continue;
      const lid = layer.level.id;
      const st = levelReadyState?.get?.(lid);
      const z0 = this.tilesByKey.get(`${lid}::0_0_0`);
      const fullyCovered = Boolean(st?.visDesiredReady && st?.hasVisDesiredNonZero)
        || this._isViewportCoveredByHigherTiles(layer, visVp);
      if (z0?.mesh) {
        const shouldShowBase = !fullyCovered;
        if (z0.mesh.visible !== shouldShowBase) {
          z0.mesh.visible = shouldShowBase;
          anyChanged = true;
        }
      }
      this._setNativeLevelBgVisible(layer.level, !fullyCovered);
    }
    if (anyChanged) {
      canvas.primary.sortDirty = true;
      this._depthDirty = true;
      if (canvas.masks?.depth) canvas.masks.depth.renderDirty = true;
    }
    return anyChanged;
  }

  rectsOverlap(ax, ay, asz, bx, by, bsz) {
    return !(ax + asz <= bx + 1 || ax + 1 >= bx + bsz || ay + asz <= by + 1 || ay + 1 >= by + bsz);
  }

  hasReadyOtherZCovering(e) {
    for (const [, other] of this.tilesByKey) {
      if (other.levelId === e.levelId && other.ready && !other.awaitingSwap && other.z > 0 && other.z < e.z && other.mesh?.visible && other.alpha >= 0.9 &&
          this.rectsOverlap(e.x0, e.y0, e.sizePx, other.x0, other.y0, other.sizePx)) {
        return true;
      }
    }
    return false;
  }

  hasReadyAncestorCovering(e) {
    for (const [, other] of this.tilesByKey) {
      if (other.levelId === e.levelId && other.ready && other.z > 0 && other.z < e.z && other.alpha >= 0.9 &&
          this.rectsOverlap(e.x0, e.y0, e.sizePx, other.x0, other.y0, other.sizePx)) {
        return true;
      }
    }
    return false;
  }

  isTileFullyReplacedByDesired(e, vp = null) {
    const s = e.sizePx;
    let rx0 = e.x0;
    let ry0 = e.y0;
    let rx1 = e.x0 + s;
    let ry1 = e.y0 + s;
    const b = e.layer?.bounds;
    if (b) {
      rx0 = Math.max(rx0, b.x);
      ry0 = Math.max(ry0, b.y);
      rx1 = Math.min(rx1, b.x + b.w);
      ry1 = Math.min(ry1, b.y + b.h);
    }
    if (vp) {
      rx0 = Math.max(rx0, vp.x0);
      ry0 = Math.max(ry0, vp.y0);
      rx1 = Math.min(rx1, vp.x1);
      ry1 = Math.min(ry1, vp.y1);
    }
    if (rx1 <= rx0 || ry1 <= ry0) return true;
    const rw = rx1 - rx0;
    const rh = ry1 - ry0;
    const pts = [
      [rx0 + rw * 0.25, ry0 + rh * 0.25],
      [rx0 + rw * 0.75, ry0 + rh * 0.25],
      [rx0 + rw * 0.25, ry0 + rh * 0.75],
      [rx0 + rw * 0.75, ry0 + rh * 0.75],
    ];
    for (const [px, py] of pts) {
      let covered = false;
      for (const [, other] of this.tilesByKey) {
        if (other.levelId === e.levelId && other.desired && other.ready && !other.awaitingSwap && other.mesh?.visible && other.z > 0 && other.alpha >= 0.98 &&
            px >= other.x0 && px <= other.x0 + other.sizePx &&
            py >= other.y0 && py <= other.y0 + other.sizePx) {
          covered = true;
          break;
        }
      }
      if (!covered) return false;
    }
    return true;
  }

  _hasPendingVisibleRoofs(layer, visVp) {
    if (!layer?.hasPyramid || !visVp) return false;
    const localZ = layer.lastTargetZ - layer.zOffset;
    if (localZ < 5 || !this._shouldMountRoofs(layer, visVp.scale)) return false;
    const overlays = layer.spec?.overlays;
    if (!hasSpecOverlays(overlays)) return false;
    const topElev = getLevelRoofElevation(layer.level);
    const viewedBottom = getLevelBottomElevation(canvas.level);
    if (!layer.level.isView && viewedBottom >= topElev) return false;

    const lid = layer.level.id;
    const overlapsVis = (ovSpec) => {
      if (!ovSpec?.roof) return false;
      const halfDiag = Math.hypot(ovSpec.w || 0, ovSpec.h || 0) * 0.5;
      return ovSpec.cx + halfDiag >= visVp.x0 && ovSpec.cx - halfDiag <= visVp.x1 &&
             ovSpec.cy + halfDiag >= visVp.y0 && ovSpec.cy - halfDiag <= visVp.y1;
    };
    for (let i = 0; i < this.pendingOverlayMounts.length; i++) {
      const po = this.pendingOverlayMounts[i];
      if (po?.lid === lid && overlapsVis(po.ovSpec)) return true;
    }
    const prefix = `${lid}::`;
    for (const fullKey of this.overlayPending) {
      if (!fullKey.startsWith(prefix) || fullKey.endsWith(":w")) continue;
      const rawOid = fullKey.slice(prefix.length);
      if (overlapsVis(overlays[rawOid])) return true;
    }
    return false;
  }

  hasAnyReadyDesiredUnderneath(e) {
    for (const [, other] of this.tilesByKey) {
      if (other.levelId === e.levelId && other.desired && other.ready && other.z < e.z && other.alpha >= 0.99 &&
          this.rectsOverlap(e.x0, e.y0, e.sizePx, other.x0, other.y0, other.sizePx)) {
        return true;
      }
    }
    return false;
  }

  _setNativeLevelBgVisible(level, visible) {
    const lt = canvas.primary?.levelTextures?.find(m => m.name === `Level.${level.index}.background`);
    if (!lt) return;
    if (!visible) {
      if (lt.visible) {
        lt.visible = false;
        this._hiddenNativeLevelBg.set(level.id, lt);
      }
    } else if (this._hiddenNativeLevelBg.has(level.id)) {
      lt.visible = true;
      this._hiddenNativeLevelBg.delete(level.id);
    }
  }

  _isRoofRevealed(rm, occSurfaces) {
    if (!rm || !rm.visible || rm.occlusionMode === CONST.OCCLUSION_MODES.NONE) return false;
    if (rm.occluded) return true;
    if ((rm._occlusionState?.fade ?? 0) > 0.02) return true;
    if ((rm._hoverFadeState?.occlusion ?? 0) > 0.02) return true;
    if (occSurfaces?.size > 0 && rm.canvasBounds) {
      for (const s of occSurfaces) {
        if (s.elevation < rm.elevation && s.region?.bounds?.intersects(rm.canvasBounds)) return true;
      }
    }
    return false;
  }

  _ensureOverlayWallsMesh(fullId, layer, ovSpec) {
    const existing = this.activeOverlays.get(fullId);
    if (!existing || existing.wallsMesh || !existing.srcWalls || this.overlayPending.has(`${fullId}:w`)) return;
    const PrimaryCanvasGroup = foundry.canvas.groups.PrimaryCanvasGroup;
    const topElev = getLevelRoofElevation(layer.level);
    const lid = layer.level.id;
    const gen = this._mountGen;
    this.overlayPending.add(`${fullId}:w`);
    this.texMgr.load(existing.srcWalls, { mipmap: true }).then((tWalls) => {
      if (this._mountGen === gen && this.levelLayers.get(lid) === layer) {
        this.overlayPending.delete(`${fullId}:w`);
      }
      const cur = this.activeOverlays.get(fullId);
      if (!this.active || this._mountGen !== gen || this.levelLayers.get(lid) !== layer || !cur || cur.wallsMesh || !isTextureUsable(tWalls)) return;
      const wallsMesh = this.acquireMesh();
      wallsMesh.name = `Tile.BoundlessWalls.${fullId}`;
      wallsMesh.anchor.set(0.5, 0.5);
      wallsMesh.texture = tWalls;
      wallsMesh.tint = ovSpec.tint ?? 0xffffff;
      wallsMesh.position.set(ovSpec.cx, ovSpec.cy);
      wallsMesh.width = ovSpec.w;
      wallsMesh.height = ovSpec.h;
      wallsMesh.angle = ovSpec.rot || 0;
      wallsMesh.elevation = topElev;
      wallsMesh.sortLayer = PrimaryCanvasGroup.SORT_LAYERS.TILES;
      wallsMesh.sort = 15;
      wallsMesh.occlusionMode = CONST.OCCLUSION_MODES.NONE;
      wallsMesh.unoccludedAlpha = 1.0;
      wallsMesh.occludedAlpha = 1.0;
      wallsMesh.hoverFade = false;
      wallsMesh.restrictsLight = false;
      wallsMesh.restrictsWeather = false;
      const localZ = layer.lastTargetZ - layer.zOffset;
      const revealOnZ5 = localZ === 5 && this._isRoofRevealed(cur.roofMesh, canvas.masks?.occlusion?.occludedSurfaces);
      wallsMesh.visible = localZ >= 6 || revealOnZ5;
      canvas.primary.addChild(wallsMesh);
      wallsMesh.updateCanvasTransform?.();
      this._syncShowstopperMeshDof(wallsMesh);
      cur.wallsMesh = wallsMesh;
      canvas.primary.sortDirty = true;
      this._tilesDirty = true;
    });
  }

  stepCrossfades(dtMs) {
    if (!this.active || !canvas?.ready) return;

    this.tokenStreamer.step(dtMs);

    // Keep CanvasDepthMask synced whenever any mounted roof fades in/out (hoverFade, ALT, token inside, or v14 Region Surface)
    // Also dynamically reveal interior z=6 tiles + wallsMesh on z=5 when a roof is occluded so ALT / tokens / Regions expose real interiors instead of baked pyramid roofs
    const occSurfaces = canvas.masks?.occlusion?.occludedSurfaces;
    const nextRevealSpecs = new Map();
    if (this.activeOverlays.size > 0) {
      let sig = `s:${occSurfaces?.size ?? 0}|`;
      for (const [k, ov] of this.activeOverlays) {
        const rm = ov.roofMesh;
        if (!rm?.visible) continue;
        const fadeAmt = Math.round((rm._occlusionState?.fade ?? 0) * 10);
        const hoverAmt = Math.round((rm._hoverFadeState?.occlusion ?? 0) * 10);
        const revealed = this._isRoofRevealed(rm, occSurfaces);
        sig += `${k}:${rm.occluded ? 1 : 0}:${fadeAmt}:${hoverAmt}:${revealed ? 1 : 0},`;

        const layer = this.levelLayers.get(ov.levelId);
        const localZ = layer ? (layer.lastTargetZ - layer.zOffset) : -1;
        const needRevealSubtile = Boolean(layer && ((localZ < 5) || (localZ === 5 && ov.srcWalls)));
        if (needRevealSubtile) {
          if (revealed) {
            if (ov.wallsMesh) {
              if (!ov.wallsMesh.visible) ov.wallsMesh.visible = true;
              if (ov.wallsMesh.unoccludedAlpha !== 1.0) ov.wallsMesh.unoccludedAlpha = 1.0;
            } else if (ov.ovSpec && ov.srcWalls) {
              this._ensureOverlayWallsMesh(k, layer, ov.ovSpec);
            }
            const revealZ = Math.min(layer.maxZoomZ, layer.zOffset + (ov.srcWalls ? 6 : 5));
            if (layer.hasPyramid && revealZ > layer.lastTargetZ && ov.ovSpec) {
              const { bounds } = layer;
              const { nx, ny } = this._getPyramidGridDims(layer, revealZ);
              const tileWorldSize = this._getPyramidTileSize(layer, revealZ);
              const w = ov.ovSpec.w || 0;
              const h = ov.ovSpec.h || 0;
              const rot = ov.ovSpec.rot || 0;
              let halfW = w * 0.55;
              let halfH = h * 0.55;
              if (rot) {
                const rad = (rot * Math.PI) / 180;
                const c = Math.abs(Math.cos(rad));
                const s = Math.abs(Math.sin(rad));
                halfW = (w * c + h * s) * 0.55;
                halfH = (w * s + h * c) * 0.55;
              }
              const tx0 = Math.max(0, Math.floor((ov.ovSpec.cx - halfW - bounds.x) / tileWorldSize));
              const ty0 = Math.max(0, Math.floor((ov.ovSpec.cy - halfH - bounds.y) / tileWorldSize));
              const tx1 = Math.min(nx - 1, Math.floor((ov.ovSpec.cx + halfW - bounds.x) / tileWorldSize));
              const ty1 = Math.min(ny - 1, Math.floor((ov.ovSpec.cy + halfH - bounds.y) / tileWorldSize));
              for (let ty = ty0; ty <= ty1; ty++) {
                for (let tx = tx0; tx <= tx1; tx++) {
                  const spec = this.resolvePyramidTile(layer, revealZ, tx, ty);
                  nextRevealSpecs.set(spec.key, { layer, spec });
                }
              }
            }
          } else if (ov.wallsMesh?.visible) {
            ov.wallsMesh.visible = false;
          }
        }
      }
      if (sig !== this._lastRoofOccSig) {
        this._lastRoofOccSig = sig;
        this._depthDirty = true;
    if (canvas.masks?.depth) canvas.masks.depth.renderDirty = true;
      }
    } else if (this._lastRoofOccSig) {
      this._lastRoofOccSig = "";
      this._depthDirty = true;
    if (canvas.masks?.depth) canvas.masks.depth.renderDirty = true;
    }

    // Reconcile localized z=6 interior reveal tiles on z=5
    if (nextRevealSpecs.size > 0 || this._revealTileKeys.size > 0) {
      for (const oldKey of this._revealTileKeys) {
        if (nextRevealSpecs.has(oldKey)) continue;
        const e = this.tilesByKey.get(oldKey);
        if (e) {
          e.isReveal = false;
          if (e.layer && e.z !== e.layer.lastTargetZ) {
            e.desired = false;
            this._tilesDirty = true;
          }
        }
        this._revealTileKeys.delete(oldKey);
      }
      for (const [key, { layer, spec }] of nextRevealSpecs) {
        this._revealTileKeys.add(key);
        const existing = this.tilesByKey.get(key);
        if (existing) {
          existing.isReveal = true;
          existing.desired = true;
          existing.fadingOut = false;
          if (existing.ready && existing.alpha < 1.0) {
            existing.alpha = 1.0;
            if (existing.mesh) existing.mesh.unoccludedAlpha = 1.0;
          }
        } else {
          this.ensureTile(layer, spec, false);
          const created = this.tilesByKey.get(key);
          if (created) created.isReveal = true;
        }
      }
    }

    const estimateFreshUploadBytes = (tex) => {
      const bt = tex?.baseTexture;
      if (!bt || (bt._glTextures && Object.keys(bt._glTextures).length > 0)) return 0;
      return this.texMgr._estimateBytes(tex);
    };
    const isMoving = this.isActivelyMoving();
    const gpuUploadBudget = isMoving ? (10 * 1024 * 1024) : MAX_GPU_UPLOAD_BYTES_PER_FRAME;
    const maxFreshUploads = isMoving ? 2 : 4;
    let frameGpuUploadBytes = 0;
    let frameFreshUploads = 0;

    const bindTextureNow = (tex) => {
      const bt = tex?.baseTexture;
      if (bt && !bt.destroyed && canvas.app?.renderer?.texture?.bind) {
        try { canvas.app.renderer.texture.bind(bt); } catch {}
      }
    };

    // 1. Pyramid tiles FIRST so zoom/pan never starves background chunks behind heavy 4K roofs or hundreds of props!
    if (this.pendingTileMounts.length > 0) {
      const maxMounts = isMoving ? 12 : 24;
      let mounted = 0;
      while (this.pendingTileMounts.length > 0 && mounted < maxMounts) {
        const peek = this.pendingTileMounts[0];
        const estBytes = estimateFreshUploadBytes(peek?.tex);
        if (estBytes > 0 && (frameFreshUploads >= maxFreshUploads || (frameGpuUploadBytes > 0 && (frameGpuUploadBytes + estBytes) > gpuUploadBudget))) break;
        const item = this.pendingTileMounts.shift();
        const e = this.tilesByKey.get(item.key);
        if (!e || e !== item.entry || e.ready || e.fadingOut || (!e.desired && e.z > 0)) continue;
        const tex = isTextureUsable(item.tex) ? item.tex : this.texMgr.getSync(e.src);
        if (!isTextureUsable(tex)) {
          this.tilesByKey.delete(item.key);
          if (e.layer) e.layer.lastPyramidKey = "";
          continue;
        }
        if (this._mountTileMesh(e, tex, item.instant)) {
          mounted++;
          if (estBytes > 0) {
            // Pre-upload EVERY fresh tile (visible, awaitingSwap, AND offscreen-padded!) within this frame's 2-tile budget
            // so zooming out into the 28% padding never bursts 8-11 deferred gl.texImage2D uploads in a single render frame!
            bindTextureNow(tex);
            frameGpuUploadBytes += estBytes;
            frameFreshUploads++;
          }
        }
      }
      if (this.pendingTileMounts.length > 0) this._tilesDirty = true;
    }

    // 2. Frame-budgeted overlay mounting: cached GPU roofs mount instantly; fresh roofs cap at 1/frame
    //    (allow mounting even while pyramid tiles queue if visible z>=5 tiles are waiting on these roofs so interiors never flash!)
    if (this.pendingOverlayMounts.length > 0) {
      const maxCachedOvMounts = isMoving ? 8 : 16;
      let mountedOv = 0;
      let freshHeavyOv = 0;
      const curVp = this.getViewportWorldRect(0.35);
      const visNow = this.getViewportWorldRect(0.0);
      const roofsBlockingZ5 = this.visibleLevelLayers.some(l => this._hasPendingVisibleRoofs(l, visNow));
      while (this.pendingOverlayMounts.length > 0 && mountedOv < maxCachedOvMounts) {
        const peek = this.pendingOverlayMounts[0];
        const estBytes = estimateFreshUploadBytes(peek?.tRoof) + estimateFreshUploadBytes(peek?.tWalls);
        if (estBytes > 0) {
          if (frameFreshUploads >= maxFreshUploads) break;
          if (frameGpuUploadBytes > 0 && (frameGpuUploadBytes + estBytes) > gpuUploadBudget) break;
          if (estBytes > 8 * 1024 * 1024 && (freshHeavyOv > 0 || (!roofsBlockingZ5 && isMoving && this.pendingTileMounts.length > 0))) break;
        }
        const item = this.pendingOverlayMounts.shift();
        if (item?.fullId) this._pendingOverlayKeys.delete(item.fullId);
        if (this._mountOverlayMeshes(item, curVp)) {
          mountedOv++;
          if (estBytes > 0) {
            if (estimateFreshUploadBytes(item.tRoof) > 0) bindTextureNow(item.tRoof);
            if (estimateFreshUploadBytes(item.tWalls) > 0) bindTextureNow(item.tWalls);
            frameGpuUploadBytes += estBytes;
            frameFreshUploads++;
            if (estBytes > 8 * 1024 * 1024) freshHeavyOv++;
          }
        }
      }
      if (mountedOv > 0) {
        canvas.primary.sortDirty = true;
        this._tilesDirty = true;
        this._occlusionDirty = true;
        this._depthDirty = true;
        if (canvas.masks?.depth) canvas.masks.depth.renderDirty = true;
        this._depthElevSyncNeeded = true;
        this._roofTokenOccDirty = true;
        this.invalidateShowstopperSurfaces();
      }
      if (this.pendingOverlayMounts.length > 0) this._tilesDirty = true;
    }

    // 3. Frame-budgeted virtual tile mounting (strict time, count & fresh-upload budget during zoom/pan so hundreds of props never stall frames)
    if (this.pendingVirtualTileMounts.length > 0) {
      const maxVtMounts = isMoving ? 16 : 48;
      const vtTimeBudgetMs = isMoving ? 1.5 : 3.5;
      let mountedVt = 0;
      let anyVtLight = false;
      let anyVtOcc = false;
      const curVp = this.getViewportWorldRect(0.28);
      const tStart = performance.now();
      while (this.pendingVirtualTileMounts.length > 0 && mountedVt < maxVtMounts) {
        if (mountedVt > 0 && (performance.now() - tStart) > vtTimeBudgetMs) break;
        const peek = this.pendingVirtualTileMounts[0];
        const estBytes = estimateFreshUploadBytes(peek?.tex);
        if (estBytes > 0 && (frameFreshUploads >= maxFreshUploads || (frameGpuUploadBytes > 0 && (frameGpuUploadBytes + estBytes) > gpuUploadBudget))) break;
        const item = this.pendingVirtualTileMounts.shift();
        if (item?.fullId) this._pendingVirtualTileKeys.delete(item.fullId);
        const m = this._mountVirtualTileMesh(item, curVp);
        if (m) {
          mountedVt++;
          if (estBytes > 0) {
            bindTextureNow(item.tex);
            frameGpuUploadBytes += estBytes;
            frameFreshUploads++;
          }
          if (m.restrictsLight || m.restrictsWeather) anyVtLight = true;
          if (m.occlusionMode !== CONST.OCCLUSION_MODES.NONE) anyVtOcc = true;
        }
      }
      if (mountedVt > 0) {
        canvas.primary.sortDirty = true;
        this.invalidateShowstopperSurfaces();
        if (anyVtOcc) this._occlusionDirty = true;
        if (anyVtLight) {
          this._depthDirty = true;
          if (canvas.masks?.depth) canvas.masks.depth.renderDirty = true;
          this._depthElevSyncNeeded = true;
        }
      }
      if (this.pendingVirtualTileMounts.length > 0) this._tilesDirty = true;
    }

    if (this._depthElevSyncNeeded) {
      this._depthElevSyncNeeded = false;
      this.lightBatch.syncDepthElevations(this._hasMultiElevationDepth());
      if (canvas.masks?.depth) canvas.masks.depth._elevationDirty = true;
      this._depthDirty = true;
      if (canvas.masks?.depth) canvas.masks.depth.renderDirty = true;
    }

    if (this._depthDirty || this._depthDeferred) {
      this._depthDirty = false;
      this._depthDeferred = false;
      this._lastDepthRenderMs = performance.now();
      if (canvas.masks?.depth) {
        canvas.masks.depth.renderDirty = true;
      }
    }

    if (this._occlusionDirty) {
      const nowOcc = performance.now();
      if (!isMoving || (nowOcc - this._lastOccRefreshMs) >= 120) {
        this._occlusionDirty = false;
        this._lastOccRefreshMs = nowOcc;
        canvas.perception.update({ refreshOcclusion: true, refreshOcclusionStates: true, refreshOcclusionMask: true });
      }
    }

    if (this._showstopperDirty && (!isMoving || (performance.now() - this._lastShowstopperMs) >= 200)) {
      this.invalidateShowstopperSurfaces(true);
    }

    if (this._waitingForRoofsBeforeIndoor) {
      this._syncIndoorLightVisibility();
    }

    if (this._roofTokenOccDirty) {
      this._roofTokenOccDirty = false;
      this.syncRoofTokenOcclusion();
    }

    // Once camera settles after zoom/pan, perform a single clean pass to trim far-offscreen virtual tiles & fill padding
    if (this._vtIdleCleanupNeeded && !isMoving && this.pendingTileMounts.length === 0) {
      this._vtIdleCleanupNeeded = false;
      const idleVp = this.getViewportWorldRect(0.28);
      for (const layer of this.visibleLevelLayers) {
        if (!layer.spec?.tiles?.length) continue;
        layer.lastTileKey = "";
        this.syncVirtualTiles(layer, layer.lastTargetZ >= 0 ? layer.lastTargetZ : this._computeTargetZ(layer, idleVp.scale), idleVp);
      }
    }

    // Incremental VRAM pruning strictly while camera is idle (max 4 textures/frame) to prevent D3D11/WebGL texture-delete pipeline stalls during zoom
    if (this._pruneNeeded && !isMoving && this.pendingTileMounts.length === 0) {
      if (!this.texMgr.needsPrune()) {
        this._pruneNeeded = false;
      } else {
        const evicted = this.texMgr.prune(this._collectInUseTextures(), 4);
        if (evicted === 0 || !this.texMgr.needsPrune()) {
          this._pruneNeeded = false;
        }
      }
    }

    if (!this._tilesDirty) return;

    const step = dtMs / CROSSFADE_MS;
    const vp = this.getViewportWorldRect(0.28);
    const visVp = this.getViewportWorldRect(0.0);
    const toDelete = [];
    let stillActive = false;
    let anyPyramidSwapped = false;

    const levelReadyState = new Map();
    for (const layer of this.visibleLevelLayers) {
      levelReadyState.set(layer.level.id, {
        allReadyOpaque: layer.lastTargetZ > 0,
        visDesiredReady: layer.lastTargetZ > 0,
        hasDesiredNonZero: false,
        hasVisDesiredNonZero: false,
        finestZ6Alpha: 0.0
      });
    }

    // Pass 1: inspect readiness of desired tiles per level (both full padded rect and exact visible screen)
    for (const [, e] of this.tilesByKey) {
      if (e.z === 0 || !e.desired || e.isReveal) continue;
      const st = levelReadyState.get(e.levelId);
      if (!st) continue;
      st.hasDesiredNonZero = true;
      const inVis = !(e.x0 + e.sizePx < visVp.x0 || e.x0 > visVp.x1 || e.y0 + e.sizePx < visVp.y0 || e.y0 > visVp.y1);
      if (inVis) {
        st.hasVisDesiredNonZero = true;
        if (!e.ready) st.visDesiredReady = false;
      }
      if (!e.ready || e.alpha < 0.99 || e.awaitingSwap) {
        st.allReadyOpaque = false;
        stillActive = true;
      }
    }

    // Hold z>=5 interior-cutout swap until all visible roofs for that level are mounted so bare interiors never flash on zoom-in!
    for (const layer of this.visibleLevelLayers) {
      const st = levelReadyState.get(layer.level.id);
      if (st && st.visDesiredReady && this._hasPendingVisibleRoofs(layer, visVp)) {
        st.visDesiredReady = false;
        stillActive = true;
      }
    }

    // Pass 2: atomic 1-frame LOD swap once all visible desired tiles are ready (zero double-alpha blending & zero depth flicker!)
    for (const [k, e] of this.tilesByKey) {
      const st = levelReadyState.get(e.levelId);
      if (e.z === 0) continue;

      if (e.desired) {
        if (e.ready && e.awaitingSwap) {
          const canSwapNow = Boolean(st?.visDesiredReady)
            || !this.hasReadyOtherZCovering(e);
          if (canSwapNow) {
            e.awaitingSwap = false;
            e.alpha = 1.0;
            if (e.mesh) {
              e.mesh.unoccludedAlpha = 1.0;
              e.mesh.visible = true;
            }
            anyPyramidSwapped = true;
          } else {
            stillActive = true;
          }
        } else if (e.ready && e.alpha < 1.0) {
          e.alpha = Math.min(1.0, e.alpha + step);
          if (e.mesh) e.mesh.unoccludedAlpha = e.alpha;
          if (e.alpha < 1.0) stillActive = true;
        }
        if (st && e.layer && (e.z - e.layer.zOffset) >= 6 && !e.isReveal && e.ready && !e.awaitingSwap && e.alpha > st.finestZ6Alpha) {
          st.finestZ6Alpha = e.alpha;
        }
      } else {
        stillActive = true;
        const onScreen = !(e.x0 + e.sizePx < vp.x0 || e.x0 > vp.x1 || e.y0 + e.sizePx < vp.y0 || e.y0 > vp.y1);
        if (!onScreen || !e.ready) {
          toDelete.push(k);
          continue;
        }
        if (st?.visDesiredReady && st?.hasVisDesiredNonZero) {
          toDelete.push(k);
          anyPyramidSwapped = true;
        } else if (e.z < e.layer.lastTargetZ) {
          if (this.isTileFullyReplacedByDesired(e, vp)) {
            toDelete.push(k);
            anyPyramidSwapped = true;
          }
        } else if (e.fadingOut) {
          e.alpha = Math.max(0.0, e.alpha - step);
          if (e.mesh) e.mesh.unoccludedAlpha = e.alpha;
          if (e.alpha <= 0.01) toDelete.push(k);
        }
      }
    }

    // Hide z=0 base mesh & native Foundry background mesh whenever ANY sharper tiles (z > 0, including outgoing LOD) cover the full visible screen!
    if (this._syncBaseLayerVisibility(visVp, levelReadyState)) {
      anyPyramidSwapped = true;
    }

    if (anyPyramidSwapped) {
      canvas.primary.sortDirty = true;
      if (canvas.masks?.depth) {
        canvas.masks.depth._elevationDirty = true;
        canvas.masks.depth.renderDirty = true;
      }
    }

    const retiringOvKeys = [];
    for (const [ovKey, ov] of this.activeOverlays) {
      const layer = this.levelLayers.get(ov.levelId);
      const localZ = layer ? (layer.lastTargetZ - layer.zOffset) : -1;
      const roofsMounted = this._shouldMountRoofs(layer, vp.scale);
      const st = levelReadyState.get(ov.levelId);
      if (ov.retiring) {
        const z4Ready = !layer?.hasPyramid || Boolean(st?.visDesiredReady && st?.hasVisDesiredNonZero) || Boolean(st?.allReadyOpaque) || localZ === 0;
        const spec = ov.ovSpec;
        const halfDiag = spec ? Math.hypot(spec.w || 0, spec.h || 0) * 0.5 : 0;
        const offScreen = !spec || (spec.cx + halfDiag < vp.x0 || spec.cx - halfDiag > vp.x1 || spec.cy + halfDiag < vp.y0 || spec.cy - halfDiag > vp.y1);
        if (!roofsMounted && (z4Ready || offScreen)) {
          retiringOvKeys.push(ovKey);
        } else if (!roofsMounted) {
          stillActive = true;
        }
        continue;
      }
      const isZ6 = localZ >= 6;
      const canReveal = roofsMounted;
      const revealOnLowerZ = Boolean(!isZ6 && ov.roofMesh && this._isRoofRevealed(ov.roofMesh, occSurfaces));
      const a = isZ6 ? (st ? st.finestZ6Alpha : 1.0) : (revealOnLowerZ ? 1.0 : 0.0);
      if (ov.wallsMesh) {
        ov.wallsMesh.visible = a > 0.02;
        if (Math.abs(ov.wallsMesh.unoccludedAlpha - a) > 0.001) {
          ov.wallsMesh.unoccludedAlpha = a;
        }
      }
      if (ov.roofMesh) {
        const wantOcc = canReveal
          ? (CONST.OCCLUSION_MODES.FADE | CONST.OCCLUSION_MODES.RADIAL | CONST.OCCLUSION_MODES.SURFACE)
          : CONST.OCCLUSION_MODES.NONE;
        if (ov.roofMesh.occlusionMode !== wantOcc) {
          ov.roofMesh.occlusionMode = wantOcc;
          if (!canReveal) {
            ov.roofMesh.debounceSetOcclusion?.cancel?.();
            ov.roofMesh.occluded = false;
          }
          this._occlusionDirty = true;
        }
        ov.roofMesh.hoverFade = canReveal;
        if (ov.roofMesh.unoccludedAlpha !== 1.0) ov.roofMesh.unoccludedAlpha = 1.0;
      }
    }

    if (retiringOvKeys.length > 0) {
      let retiredRoof = false;
      for (const ovKey of retiringOvKeys) {
        const ov = this.activeOverlays.get(ovKey);
        if (!ov) continue;
        if (ov.wallsMesh) this.retireMesh(ov.wallsMesh);
        if (ov.roofMesh) {
          this.retireMesh(ov.roofMesh);
          retiredRoof = true;
        }
        this.activeOverlays.delete(ovKey);
      }
      if (retiredRoof) {
        this._depthDirty = true;
    if (canvas.masks?.depth) canvas.masks.depth.renderDirty = true;
        this._depthElevSyncNeeded = true;
        this.invalidateShowstopperSurfaces();
      }
    }

    for (const k of toDelete) {
      const e = this.tilesByKey.get(k);
      if (e?.mesh) this.retireMesh(e.mesh);
      this.tilesByKey.delete(k);
    }

    this._tilesDirty = stillActive;
  }

  async _bakeRoofMask(layers, sceneId, mountedLevelId) {
    const renderer = canvas?.app?.renderer;
    if (!renderer || !layers?.length) return;

    // Pick the primary layer carrying baked building roofs (supports monolithic 1000x1000, superGrid, chunked worlds, or explicit roofMaskUrl)
    let targetLayer = null;
    let ovList = null;
    for (const l of layers) {
      if (l.spec?.roofMaskUrl) {
        targetLayer = l;
        const rawOvs = l.spec?._superGridBase?.overlays || l.spec?.overlays;
        ovList = rawOvs ? (Array.isArray(rawOvs) ? rawOvs : Object.values(rawOvs)) : [];
        break;
      }
      const rawOvs = l.spec?._superGridBase?.overlays || l.spec?.overlays;
      if (!rawOvs) continue;
      const list = Array.isArray(rawOvs) ? rawOvs : Object.values(rawOvs);
      if (list.some(o => o?.roof && !o.walls?.includes("anchor_"))) {
        targetLayer = l;
        ovList = list;
        break;
      }
    }
    if (!targetLayer) return;

    const isSuperGrid = Boolean(targetLayer.spec?.superGrid);
    const originX = isSuperGrid ? 0 : (targetLayer.bounds?.x || 0);
    const originY = isSuperGrid ? 0 : (targetLayer.bounds?.y || 0);
    const regionW = isSuperGrid ? (targetLayer.spec.superGrid.regionPx || 100000) : (targetLayer.bounds?.w || 100000);
    const regionH = isSuperGrid ? (targetLayer.spec.superGrid.regionPx || 100000) : (targetLayer.bounds?.h || 100000);

    return this._bakeRoofMaskFromList(ovList, {
      originX,
      originY,
      regionW,
      regionH,
      repeat: isSuperGrid,
      roofMaskUrl: targetLayer.spec?.roofMaskUrl || null,
      sceneId,
      mountedLevelId
    });
  }

  async _bakeRoofMaskFromList(ovList, { originX = 0, originY = 0, regionW = 100000, regionH = 100000, repeat = false, roofMaskUrl = null, sceneId = canvas.scene?.id, mountedLevelId = canvas.level?.id } = {}) {
    const renderer = canvas?.app?.renderer;
    if (!renderer || (!ovList?.length && !roofMaskUrl)) return;

    const MAX_SPRITE_MASK_URLS = 24;
    const roofUrls = new Set();
    for (const ov of ovList || []) {
      if (ov?.roof && !ov.walls?.includes("anchor_")) roofUrls.add(ov.roof);
    }
    if (!roofUrls.size && !roofMaskUrl) return;

    const gen = ++this._roofMaskGen;
    this._roofMaskBaking = true;
    let rt = null;
    let container = null;
    try {
      const maxTex = renderer.gl?.getParameter?.(renderer.gl.MAX_TEXTURE_SIZE) || 2048;
      const maskSize = maxTex >= 2048 ? 2048 : 1024;

      let maskTex = null;
      let texByUrl = null;

      if (roofMaskUrl) {
        // Prebaked single-file roof alpha mask supplied by exporter (0 per-house texture loads!)
        maskTex = await this.texMgr.load(roofMaskUrl, { mipmap: false, isPinned: false });
        if (!this.active || this._roofMaskGen !== gen || canvas.scene?.id !== sceneId || canvas.level?.id !== mountedLevelId) {
          return;
        }
        if (!isTextureUsable(maskTex)) return;
      } else if (roofUrls.size <= MAX_SPRITE_MASK_URLS) {
        // Small reusable template roof set (e.g. <= 24 shared textures): load & pin for instant pixel-exact mask + z>=5 roofs
        const urlList = Array.from(roofUrls);
        const loaded = await Promise.all(urlList.map(url => this.texMgr.load(url, { mipmap: true, isPinned: true })));
        if (!this.active || this._roofMaskGen !== gen || canvas.scene?.id !== sceneId || canvas.level?.id !== mountedLevelId) {
          return;
        }
        texByUrl = new Map();
        for (let i = 0; i < urlList.length; i++) {
          if (isTextureUsable(loaded[i])) texByUrl.set(urlList[i], loaded[i]);
        }
        if (!texByUrl.size) return;
      }

      rt = PIXI.RenderTexture.create({
        width: maskSize,
        height: maskSize,
        scaleMode: PIXI.SCALE_MODES.LINEAR,
        mipmap: PIXI.MIPMAP_MODES.OFF,
        wrapMode: PIXI.WRAP_MODES.CLAMP
      });
      container = new PIXI.Container();

      if (maskTex) {
        const sp = new PIXI.Sprite(maskTex);
        sp.width = maskSize;
        sp.height = maskSize;
        container.addChild(sp);
      } else if (texByUrl) {
        container.scale.set(maskSize / Math.max(1, regionW), maskSize / Math.max(1, regionH));
        for (const ov of ovList) {
          if (!ov?.roof || ov.walls?.includes("anchor_")) continue;
          const tex = texByUrl.get(ov.roof);
          if (!isTextureUsable(tex)) continue;
          const sp = new PIXI.Sprite(tex);
          sp.anchor.set(0.5, 0.5);
          sp.position.set(ov.cx - originX, ov.cy - originY);
          sp.width = ov.w;
          sp.height = ov.h;
          sp.angle = ov.rot || 0;
          container.addChild(sp);
        }
      } else {
        // Large city with hundreds/thousands of unique roof textures (e.g. Kartograf exports):
        // NEVER preload or pin all roof textures at once (would blow VRAM!). Bake the macro roof mask
        // directly from manifest footprint geometry in ~2ms (0 network / 0 extra VRAM); individual roofs
        // stream strictly per-viewport at localZ >= 5 via syncOverlayMeshes() + LRUTextureManager.
        const sx = maskSize / Math.max(1, regionW);
        const sy = maskSize / Math.max(1, regionH);
        const gfx = new PIXI.Graphics();
        gfx.beginFill(0xffffff, 1.0);
        for (const ov of ovList) {
          if (!ov?.roof || ov.walls?.includes("anchor_")) continue;
          const poly = Array.isArray(ov.poly) && ov.poly.length >= 6 ? ov.poly
            : (Array.isArray(ov.footprint) && ov.footprint.length >= 6 ? ov.footprint : null);
          if (poly) {
            const pts = new Array(poly.length);
            for (let i = 0; i < poly.length; i += 2) {
              pts[i] = (poly[i] - originX) * sx;
              pts[i + 1] = (poly[i + 1] - originY) * sy;
            }
            gfx.drawPolygon(pts);
          } else {
            const hw = (ov.w || 0) * 0.5;
            const hh = (ov.h || 0) * 0.5;
            if (hw <= 0 || hh <= 0) continue;
            const rad = ((ov.rot || 0) * Math.PI) / 180;
            const c = Math.cos(rad);
            const s = Math.sin(rad);
            const cx = ov.cx - originX;
            const cy = ov.cy - originY;
            const c0x = (cx + (-hw * c - -hh * s)) * sx;
            const c0y = (cy + (-hw * s + -hh * c)) * sy;
            const c1x = (cx + (hw * c - -hh * s)) * sx;
            const c1y = (cy + (hw * s + -hh * c)) * sy;
            const c2x = (cx + (hw * c - hh * s)) * sx;
            const c2y = (cy + (hw * s + hh * c)) * sy;
            const c3x = (cx + (-hw * c - hh * s)) * sx;
            const c3y = (cy + (-hw * s + hh * c)) * sy;
            gfx.drawPolygon([c0x, c0y, c1x, c1y, c2x, c2y, c3x, c3y]);
          }
        }
        gfx.endFill();
        container.addChild(gfx);
      }

      renderer.render(container, { renderTexture: rt, clear: true });
      container.destroy({ children: true, texture: false, baseTexture: false });
      container = null;

      this.lightBatch.setBakedRoofMask(rt, {
        originX,
        originY,
        regionW,
        regionH,
        repeat
      });
      rt = null;
      this._syncIndoorLightVisibility();
    } catch (err) {
      if (container && !container.destroyed) {
        try { container.destroy({ children: true, texture: false, baseTexture: false }); } catch {}
      }
      if (rt && !rt.destroyed) {
        try { rt.destroy(true); } catch {}
      }
      console.warn(`${MODULE_ID} | Failed baking roof mask:`, err);
    } finally {
      if (this._roofMaskGen === gen) this._roofMaskBaking = false;
    }
  }

  _syncIndoorLightVisibility() {
    if (!this.active || !this.lightBatch) return;
    const viewedBottom = getLevelBottomElevation(canvas.level);
    const curScale = canvas.stage?.scale?.x ?? 1;
    let wantMacroRoofMask = false;
    for (const layer of this.visibleLevelLayers) {
      if (!layer.spec?.overlays) continue;
      const topElev = getLevelRoofElevation(layer.level);
      const hideRoofsForUpperView = !layer.level.isView && viewedBottom >= topElev;
      if (hideRoofsForUpperView) continue;
      if (!this._shouldMountRoofs(layer, curScale)) {
        wantMacroRoofMask = true;
        break;
      }
    }

    const prevHidden = this.lightBatch.hideIndoorLights;
    const prevBaked = this.lightBatch.useBakedRoofMask;
    const hasBakedMask = Boolean(this.lightBatch.bakedRoofMask && !this.lightBatch.bakedRoofMask.destroyed);

    let needRoofMaskNow = false;
    if (wantMacroRoofMask) {
      this._waitingForRoofsBeforeIndoor = true;
      needRoofMaskNow = true;
    } else if (this._waitingForRoofsBeforeIndoor) {
      // Wait until the first wave of interactive roof meshes is mounted and synced into CanvasDepthMask
      const roofsReady = this.overlayPending.size === 0
        && this.pendingOverlayMounts.length === 0
        && !this._depthElevSyncNeeded;
      if (roofsReady) {
        this._waitingForRoofsBeforeIndoor = false;
        needRoofMaskNow = false;
      } else {
        needRoofMaskNow = true;
      }
    }

    if (needRoofMaskNow) {
      if (hasBakedMask) {
        // Keep ALL lights (including indoor window glow!) active; baked pixel-accurate roof mask cuts roofs 1:1 with depthMask
        this.lightBatch.setUseBakedRoofMask(true);
        this.lightBatch.setIndoorLightsHidden(false);
      } else {
        // Fallback while bakedRoofMask is still loading or for chunked maps without a monolithic roof atlas
        this.lightBatch.setUseBakedRoofMask(false);
        this.lightBatch.setIndoorLightsHidden(true);
      }
    } else {
      this.lightBatch.setUseBakedRoofMask(false);
      this.lightBatch.setIndoorLightsHidden(false);
    }

    if (this.lightBatch.hideIndoorLights !== prevHidden || this.lightBatch.useBakedRoofMask !== prevBaked) {
      this.updateSimAndLightBubbles(false);
    }
  }

  syncOverlayMeshes(layer, targetZ, vp) {
    const overlays = layer.spec?.overlays;
    if (!overlays) return false;

    const PrimaryCanvasGroup = foundry.canvas.groups.PrimaryCanvasGroup;
    const { simGrid, simSectorPx, spec, level } = layer;
    const sectors = spec.sectors;
    const lid = level.id;
    const topElev = getLevelRoofElevation(level);
    const viewedBottom = getLevelBottomElevation(canvas.level);
    // If viewing an upper level above this level's top, hide lower-level roofs so upper floor tiles aren't covered
    const hideRoofsForUpperView = !level.isView && viewedBottom >= topElev;
    const localZ = targetZ - layer.zOffset;
    const showWalls = localZ >= 6;
    // Mount interactive roofs based on absolute screen cell size (pxPerCell >= 16px, with hysteresis),
    // not raw pyramid Z, so small or high-PPI (256 PPI) maps keep roofs & CanvasDepthMask lighting rock-solid across tactical zoom!
    const shouldMountRoofs = this._shouldMountRoofs(layer, vp.scale);
    const canReveal = shouldMountRoofs;

    const sx0 = Math.max(0, Math.floor(vp.x0 / simSectorPx));
    const sy0 = Math.max(0, Math.floor(vp.y0 / simSectorPx));
    const sx1 = Math.min(simGrid - 1, Math.floor(vp.x1 / simSectorPx));
    const sy1 = Math.min(simGrid - 1, Math.floor(vp.y1 / simSectorPx));

    const ovKey = shouldMountRoofs
      ? `on_${sx0}_${sy0}_${sx1}_${sy1}_${hideRoofsForUpperView ? 1 : 0}_${showWalls ? 2 : (canReveal ? 1 : 0)}`
      : `off_${hideRoofsForUpperView ? 1 : 0}`;
    if (ovKey === layer.lastOverlayKey) return false;
    layer.lastOverlayKey = ovKey;

    const neededOv = new Set();
    if (!shouldMountRoofs && this.pendingOverlayMounts.length > 0) {
      this.pendingOverlayMounts = this.pendingOverlayMounts.filter(item => {
        if (item?.lid === lid) {
          this._pendingOverlayKeys.delete(item.fullId);
          return false;
        }
        return true;
      });
    }
    if (shouldMountRoofs) {
      for (let sy = sy0; sy <= sy1; sy++) {
        for (let sx = sx0; sx <= sx1; sx++) {
          const sec = sectors?.[`${sx}_${sy}`];
          if (!sec?.o) continue;
          for (const oid of sec.o) {
            const ovSpec = overlays[oid];
            if (!ovSpec) continue;
            // At macro zoom (localZ < 6) only keep buildings that actually have a roof (no need for anchor foregrounds)
            if (!showWalls && (hideRoofsForUpperView || !ovSpec.roof)) continue;
            neededOv.add(`${lid}::${oid}`);
          }
        }
      }
    }

    const occSurfaces = canvas.masks?.occlusion?.occludedSurfaces;
    const wantOccMode = canReveal
      ? (CONST.OCCLUSION_MODES.FADE | CONST.OCCLUSION_MODES.RADIAL | CONST.OCCLUSION_MODES.SURFACE)
      : CONST.OCCLUSION_MODES.NONE;

    let changed = false;
    let retiredAnyRoof = false;
    for (const [fullId, ov] of this.activeOverlays) {
      if (ov.levelId !== lid) continue;
      if (!neededOv.has(fullId)) {
        // When zooming out from localZ >= 5 to localZ < 5 on a pyramid level, keep visible roofs mounted
        // (with occlusion disabled) until z<=4 baked-roof pyramid tiles finish covering the viewport so interiors never flash!
        if (!shouldMountRoofs && !hideRoofsForUpperView && layer.hasPyramid && ov.roofMesh && !ov.roofMesh.destroyed) {
          if (ov.wallsMesh) {
            this.retireMesh(ov.wallsMesh);
            ov.wallsMesh = null;
          }
          ov.retiring = true;
          if (ov.roofMesh.occlusionMode !== CONST.OCCLUSION_MODES.NONE) {
            ov.roofMesh.occlusionMode = CONST.OCCLUSION_MODES.NONE;
            ov.roofMesh.debounceSetOcclusion?.cancel?.();
            ov.roofMesh.occluded = false;
            this._occlusionDirty = true;
          }
          // Avoid 1-frame double light-cut (CanvasDepthMask + bakedRoofMask) while retiring roof waits for z<=4
          if (this.lightBatch?.bakedRoofMask && !this.lightBatch.bakedRoofMask.destroyed && ov.roofMesh.restrictsLight) {
            ov.roofMesh.restrictsLight = false;
            this._depthDirty = true;
            if (canvas.masks?.depth) canvas.masks.depth.renderDirty = true;
          }
          ov.roofMesh.hoverFade = false;
          ov.roofMesh.unoccludedAlpha = 1.0;
          this._tilesDirty = true;
          changed = true;
          continue;
        }
        const hadRoof = Boolean(ov.roofMesh);
        if (ov.wallsMesh) this.retireMesh(ov.wallsMesh);
        if (ov.roofMesh) this.retireMesh(ov.roofMesh);
        this.activeOverlays.delete(fullId);
        if (hadRoof) {
          this._depthDirty = true;
    if (canvas.masks?.depth) canvas.masks.depth.renderDirty = true;
          this._depthElevSyncNeeded = true;
          retiredAnyRoof = true;
        }
        changed = true;
      } else {
        ov.retiring = false;
        if (hideRoofsForUpperView && ov.roofMesh) {
          this.retireMesh(ov.roofMesh);
          ov.roofMesh = null;
          this._depthDirty = true;
    if (canvas.masks?.depth) canvas.masks.depth.renderDirty = true;
          this._depthElevSyncNeeded = true;
          retiredAnyRoof = true;
          changed = true;
        } else if (ov.roofMesh) {
          if (!ov.roofMesh.restrictsLight) {
            ov.roofMesh.restrictsLight = true;
            this._depthDirty = true;
            if (canvas.masks?.depth) canvas.masks.depth.renderDirty = true;
          }
          if (ov.roofMesh.occlusionMode !== wantOccMode) {
            ov.roofMesh.occlusionMode = wantOccMode;
            if (!canReveal) {
              ov.roofMesh.debounceSetOcclusion?.cancel?.();
              ov.roofMesh.occluded = false;
            }
            this._occlusionDirty = true;
          }
          ov.roofMesh.hoverFade = canReveal;
        }
        const revealOnZ5 = localZ === 5 && ov.roofMesh && this._isRoofRevealed(ov.roofMesh, occSurfaces);
        if (ov.wallsMesh) ov.wallsMesh.visible = showWalls || revealOnZ5;
      }
    }
    if (retiredAnyRoof) this.invalidateShowstopperSurfaces();

    for (const fullId of neededOv) {
      if (this.activeOverlays.has(fullId)) {
        // Lazily load wallsMesh if this overlay was initially mounted at macro zoom with roof only
        const existing = this.activeOverlays.get(fullId);
        if (showWalls && !existing.wallsMesh && existing.srcWalls && existing.ovSpec) {
          this._ensureOverlayWallsMesh(fullId, layer, existing.ovSpec);
        }
        continue;
      }
      if (this.overlayPending.has(fullId) || this._pendingOverlayKeys.has(fullId)) continue;
      const rawOid = fullId.slice(fullId.indexOf("::") + 2);
      const ovSpec = overlays[rawOid];
      if (!ovSpec) continue;

      const needWalls = Boolean(showWalls && ovSpec.walls);
      const needRoof = Boolean(!hideRoofsForUpperView && ovSpec.roof);
      const syncWalls = needWalls ? this.texMgr.getSync(ovSpec.walls) : null;
      const syncRoof = needRoof ? this.texMgr.getSync(ovSpec.roof) : null;

      if ((!needWalls || syncWalls) && (!needRoof || syncRoof)) {
        if (syncWalls || syncRoof) {
          this._pendingOverlayKeys.add(fullId);
          this.pendingOverlayMounts.push({ fullId, lid, oid: rawOid, layer, ovSpec, topElev, tWalls: syncWalls, tRoof: syncRoof });
          changed = true;
        }
        continue;
      }

      const gen = this._mountGen;
      this.overlayPending.add(fullId);
      Promise.all([
        needWalls ? this.texMgr.load(ovSpec.walls, { mipmap: true, priority: 0, maxDim: 2048 }) : Promise.resolve(null),
        needRoof ? this.texMgr.load(ovSpec.roof, { mipmap: true, priority: 0, maxDim: 2048 }) : Promise.resolve(null)
      ]).then(([tWalls, tRoof]) => {
        if (this._mountGen === gen && this.levelLayers.get(lid) === layer) {
          this.overlayPending.delete(fullId);
        }
        if (!this.active || this._mountGen !== gen || this.levelLayers.get(lid) !== layer || this.activeOverlays.has(fullId) || this._pendingOverlayKeys.has(fullId)) return;
        if (!tWalls && !tRoof) return;
        this._pendingOverlayKeys.add(fullId);
        this.pendingOverlayMounts.push({ fullId, lid, oid: rawOid, layer, ovSpec, topElev, tWalls, tRoof });
      });
      changed = true;
    }

    return changed;
  }

  _mountOverlayMeshes(item, curVp) {
    const { fullId, lid, oid, layer, ovSpec, topElev } = item;
    if (!this.active || this.levelLayers.get(lid) !== layer || this.activeOverlays.has(fullId)) return false;
    const halfDiag = Math.hypot(ovSpec.w || 0, ovSpec.h || 0) * 0.5;
    const { simGrid, simSectorPx } = layer;
    const curSx0 = Math.max(0, Math.floor(curVp.x0 / simSectorPx));
    const curSy0 = Math.max(0, Math.floor(curVp.y0 / simSectorPx));
    const curSx1 = Math.min(simGrid - 1, Math.floor(curVp.x1 / simSectorPx));
    const curSy1 = Math.min(simGrid - 1, Math.floor(curVp.y1 / simSectorPx));
    const secX0 = curSx0 * simSectorPx;
    const secY0 = curSy0 * simSectorPx;
    const secX1 = (curSx1 + 1) * simSectorPx;
    const secY1 = (curSy1 + 1) * simSectorPx;
    if (ovSpec.cx + halfDiag < secX0 || ovSpec.cx - halfDiag > secX1 ||
        ovSpec.cy + halfDiag < secY0 || ovSpec.cy - halfDiag > secY1) {
      layer.lastOverlayKey = "";
      return false;
    }

    const PrimaryCanvasGroup = foundry.canvas.groups.PrimaryCanvasGroup;
    const localZNow = layer.lastTargetZ - layer.zOffset;
    const roofsMountedNow = this._shouldMountRoofs(layer, curVp?.scale ?? canvas.stage?.scale?.x ?? 1);
    if (!roofsMountedNow) return false;

    const tWalls = isTextureUsable(item.tWalls) ? item.tWalls : (item.tWalls && ovSpec.walls ? this.texMgr.getSync(ovSpec.walls) : null);
    const tRoof = isTextureUsable(item.tRoof) ? item.tRoof : (item.tRoof && ovSpec.roof ? this.texMgr.getSync(ovSpec.roof) : null);
    if ((item.tWalls && !tWalls) || (item.tRoof && !tRoof)) {
      layer.lastOverlayKey = "";
      return false;
    }
    if (!tWalls && !tRoof) return false;

    const ovTint = ovSpec.tint ?? 0xffffff;
    let wallsMesh = null;
    let roofMesh = null;

    if (tWalls) {
      wallsMesh = this.acquireMesh();
      wallsMesh.name = `Tile.BoundlessWalls.${fullId}`;
      wallsMesh.anchor.set(0.5, 0.5);
      wallsMesh.texture = tWalls;
      wallsMesh.tint = ovTint;
      wallsMesh.position.set(ovSpec.cx, ovSpec.cy);
      wallsMesh.width = ovSpec.w;
      wallsMesh.height = ovSpec.h;
      wallsMesh.angle = ovSpec.rot || 0;
      wallsMesh.elevation = topElev;
      wallsMesh.sortLayer = PrimaryCanvasGroup.SORT_LAYERS.TILES;
      wallsMesh.sort = 15;
      wallsMesh.occlusionMode = CONST.OCCLUSION_MODES.NONE;
      wallsMesh.unoccludedAlpha = 1.0;
      wallsMesh.occludedAlpha = 1.0;
      wallsMesh.hoverFade = false;
      wallsMesh.restrictsLight = false;
      wallsMesh.restrictsWeather = false;
      wallsMesh.visible = localZNow >= 6;
      canvas.primary.addChild(wallsMesh);
      wallsMesh.updateCanvasTransform?.();
      this._syncShowstopperMeshDof(wallsMesh);
    }

    if (tRoof) {
      const canRevealNow = roofsMountedNow;
      roofMesh = this.acquireMesh();
      roofMesh.name = `Tile.BoundlessRoof.${fullId}`;
      roofMesh.anchor.set(0.5, 0.5);
      roofMesh.texture = tRoof;
      roofMesh.tint = ovTint;
      roofMesh.position.set(ovSpec.cx, ovSpec.cy);
      roofMesh.width = ovSpec.w;
      roofMesh.height = ovSpec.h;
      roofMesh.angle = ovSpec.rot || 0;
      roofMesh.elevation = topElev;
      roofMesh.sortLayer = PrimaryCanvasGroup.SORT_LAYERS.TILES;
      roofMesh.sort = 45;
      roofMesh.occlusionMode = canRevealNow
        ? (CONST.OCCLUSION_MODES.FADE | CONST.OCCLUSION_MODES.RADIAL | CONST.OCCLUSION_MODES.SURFACE)
        : CONST.OCCLUSION_MODES.NONE;
      // Match Foundry v14 foreground tiles: ceiling defineSurface regions at level.elevation.top must NOT occlude this level's own roofs
      roofMesh._occludedBySameElevationSurfaces = false;
      roofMesh.unoccludedAlpha = 1.0;
      roofMesh.occludedAlpha = 0.05;
      roofMesh.hoverFade = canRevealNow;
      roofMesh.restrictsLight = true;
      roofMesh.restrictsWeather = true;
      roofMesh.textureAlphaThreshold = 0.75;
      canvas.primary.addChild(roofMesh);
      roofMesh.updateCanvasTransform?.();
      this._syncShowstopperMeshDof(roofMesh);
    }

    this.activeOverlays.set(fullId, { levelId: lid, oid, ovSpec, wallsMesh, roofMesh, srcWalls: ovSpec.walls, srcRoof: ovSpec.roof, retiring: false });
    if (localZNow >= 6 && !wallsMesh && ovSpec.walls) {
      this._ensureOverlayWallsMesh(fullId, layer, ovSpec);
    }
    return true;
  }

  /**
   * Stream virtual tiles (`spec.tiles` indexed via `sectors[sk].t`) for a level.
   * Supports full Foundry v14 Tile semantics: elevation, occlusion modes, restrictsLight/Weather, sortLayer, LOD minZ.
   */
  syncVirtualTiles(layer, targetZ, vp) {
    const tiles = layer.spec?.tiles;
    if (!tiles?.length) return false;

    const PrimaryCanvasGroup = foundry.canvas.groups.PrimaryCanvasGroup;
    const { simGrid, simSectorPx, spec, level } = layer;
    const sectors = spec.sectors;
    const lid = level.id;
    const defaultElev = getLevelBaseElevation(level);

    const sx0 = Math.max(0, Math.floor(vp.x0 / simSectorPx));
    const sy0 = Math.max(0, Math.floor(vp.y0 / simSectorPx));
    const sx1 = Math.min(simGrid - 1, Math.floor(vp.x1 / simSectorPx));
    const sy1 = Math.min(simGrid - 1, Math.floor(vp.y1 / simSectorPx));

    // Evaluate interior tile minZ using absolute cell size (with hysteresis) so 564+ hidden-under-roof props
    // don't mount and flood canvas.primary / burn-living-map at macro zoom (scale 0.05..0.15)!
    const showInterior = this._shouldMountInteriorTiles(layer, vp.scale);
    const effectiveZ = Math.max(targetZ, showInterior ? (layer.zOffset + 5) : 0);

    const isMoving = this.isActivelyMoving();
    const tileKey = `${effectiveZ}_${sx0}_${sy0}_${sx1}_${sy1}_${isMoving ? "m" : "s"}_r${this.tileEditsRev}`;
    if (tileKey === layer.lastTileKey) return false;
    layer.lastTileKey = tileKey;
    if (isMoving) this._vtIdleCleanupNeeded = true;

    const secX0 = sx0 * simSectorPx;
    const secY0 = sy0 * simSectorPx;
    const secX1 = (sx1 + 1) * simSectorPx;
    const secY1 = (sy1 + 1) * simSectorPx;
    const tileIntersectsSectors = (t) => {
      const ax0 = t.anchorX !== undefined ? t.anchorX : 0.5;
      const ay0 = t.anchorY !== undefined ? t.anchorY : 0.5;
      const pivX = t.anchorX === undefined ? (t.x + t.w * 0.5) : t.x;
      const pivY = t.anchorY === undefined ? (t.y + t.h * 0.5) : t.y;
      const halfDiag = Math.hypot(t.w || 0, t.h || 0) * Math.max(ax0, 1 - ax0, ay0, 1 - ay0);
      return pivX + halfDiag >= secX0 && pivX - halfDiag <= secX1 && pivY + halfDiag >= secY0 && pivY - halfDiag <= secY1;
    };

    const needed = new Set();
    if (sectors) {
      const candidateTids = new Set();
      for (let sy = sy0; sy <= sy1; sy++) {
        for (let sx = sx0; sx <= sx1; sx++) {
          const sec = sectors[`${sx}_${sy}`];
          if (!sec?.t?.length) continue;
          for (const tid of sec.t) candidateTids.add(tid);
        }
      }
      // Include tiles edited & dragged outside their original home sector
      const lvlTileEdits = this.tileEdits.get(lid);
      if (lvlTileEdits?.size) {
        for (const [tKey, ov] of lvlTileEdits) {
          if (!ov || !tKey.startsWith("t:")) continue;
          const tid = Number(tKey.slice(2));
          if (Number.isInteger(tid) && tiles[tid]) candidateTids.add(tid);
        }
      }
      for (const tid of candidateTids) {
        const tSpec = this.resolveVirtualTile(lid, tid, tiles[tid], level);
        if (!tSpec || tSpec.hidden) continue;
        if (tSpec.minZ !== undefined && effectiveZ < tSpec.minZ) continue;
        if (tSpec.maxZ !== undefined && targetZ > tSpec.maxZ) continue;
        if (tileIntersectsSectors(tSpec)) {
          needed.add(`${lid}::${tid}`);
        }
      }
    } else {
      // Fallback for small inline tile lists without spatial sector index (matched to active sector bounds so tileKey stays exact)
      for (let tid = 0; tid < tiles.length; tid++) {
        const t = this.resolveVirtualTile(lid, tid, tiles[tid], level);
        if (!t || t.hidden) continue;
        if (t.minZ !== undefined && effectiveZ < t.minZ) continue;
        if (t.maxZ !== undefined && targetZ > t.maxZ) continue;
        if (tileIntersectsSectors(t)) {
          needed.add(`${lid}::${tid}`);
        }
      }
    }

    let changed = false;
    let removedAny = false;
    let removedAnyLight = false;
    let removedAnyOcc = false;
    for (const [fullId, vt] of this.activeVirtualTiles) {
      if (vt.levelId !== lid) continue;
      if (!needed.has(fullId)) {
        // While actively zooming/panning, keep still-valid offscreen meshes mounted (only retire ones failing minZ/maxZ/hidden)
        // to avoid mount/retire thrashing and 3rd-party shadow rebuild storms (`burn-living-map`); `_vtIdleCleanupNeeded` trims offscreen once idle.
        if (isMoving) {
          const ts = vt.tSpec;
          const stillValidByLod = Boolean(ts && !ts.hidden
            && (ts.minZ === undefined || effectiveZ >= ts.minZ)
            && (ts.maxZ === undefined || targetZ <= ts.maxZ));
          if (stillValidByLod) continue;
        }
        if (vt.mesh?.restrictsLight || vt.mesh?.restrictsWeather) removedAnyLight = true;
        if (vt.mesh && vt.mesh.occlusionMode !== CONST.OCCLUSION_MODES.NONE) removedAnyOcc = true;
        if (vt.mesh) this.retireMesh(vt.mesh);
        this.activeVirtualTiles.delete(fullId);
        removedAny = true;
        changed = true;
      }
    }
    if (removedAny) {
      this.invalidateShowstopperSurfaces();
      if (removedAnyOcc) this._occlusionDirty = true;
      if (removedAnyLight) {
        this._depthDirty = true;
        if (canvas.masks?.depth) canvas.masks.depth.renderDirty = true;
        this._depthElevSyncNeeded = true;
      }
    }

    const reqRev = this.tileEditsRev;
    const gen = this._mountGen;
    const isViewedLayer = Boolean(level?.isView);
    const visVp = this.getViewportWorldRect(0.0);
    const isOnVisScreen = (t) => {
      const ax0 = t.anchorX !== undefined ? t.anchorX : 0.5;
      const ay0 = t.anchorY !== undefined ? t.anchorY : 0.5;
      const pivX = t.anchorX === undefined ? (t.x + t.w * 0.5) : t.x;
      const pivY = t.anchorY === undefined ? (t.y + t.h * 0.5) : t.y;
      const halfDiag = Math.hypot(t.w || 0, t.h || 0) * Math.max(ax0, 1 - ax0, ay0, 1 - ay0);
      return pivX + halfDiag >= visVp.x0 && pivX - halfDiag <= visVp.x1 && pivY + halfDiag >= visVp.y0 && pivY - halfDiag <= visVp.y1;
    };
    for (const fullId of needed) {
      if (this.activeVirtualTiles.has(fullId) || this.virtualTilePending.has(fullId) || this._pendingVirtualTileKeys.has(fullId)) continue;
      const tid = Number(fullId.split("::")[1]);
      const tSpec = this.resolveVirtualTile(lid, tid, tiles[tid], level);
      if (!tSpec?.src || tSpec.hidden) continue;

      const inVisRect = isOnVisScreen(tSpec);
      // During active zoom/pan only stream props actually inside the visible screen; offscreen padding fills once idle
      if (isMoving && !inVisRect) continue;
      const onVis = isViewedLayer && inVisRect;
      const syncTex = this.texMgr.getSync(tSpec.src);
      if (syncTex) {
        this._pendingVirtualTileKeys.add(fullId);
        const qItem = { fullId, lid, tid, layer, tSpec, defaultElev, reqRev, gen, tex: syncTex };
        if (onVis) this.pendingVirtualTileMounts.unshift(qItem);
        else this.pendingVirtualTileMounts.push(qItem);
        this._tilesDirty = true;
        changed = true;
        continue;
      }

      this.virtualTilePending.add(fullId);
      this.texMgr.load(tSpec.src, { mipmap: true, priority: onVis ? 0 : 1 }).then(tex => {
        if (this._mountGen === gen && this.levelLayers.get(lid) === layer && this.tileEditsRev === reqRev) {
          this.virtualTilePending.delete(fullId);
        }
        if (!this.active || this._mountGen !== gen || this.levelLayers.get(lid) !== layer) return;
        if (this.activeVirtualTiles.has(fullId) || this._pendingVirtualTileKeys.has(fullId) || this.tileEditsRev !== reqRev) return;
        if (!isTextureUsable(tex)) {
          layer.lastTileKey = "";
          return;
        }
        this._pendingVirtualTileKeys.add(fullId);
        const qItem = { fullId, lid, tid, layer, tSpec, defaultElev, reqRev, gen, tex };
        if (onVis) this.pendingVirtualTileMounts.unshift(qItem);
        else this.pendingVirtualTileMounts.push(qItem);
        this._tilesDirty = true;
      });
      changed = true;
    }

    return changed;
  }

  _mountVirtualTileMesh(item, curVp) {
    if (!item) return null;
    const { fullId, lid, tid, layer, tSpec, defaultElev, reqRev, gen } = item;
    if (!this.active || this._mountGen !== gen || this.levelLayers.get(lid) !== layer) return null;
    if (this.activeVirtualTiles.has(fullId) || this.tileEditsRev !== reqRev) return null;

    const tex = isTextureUsable(item.tex) ? item.tex : this.texMgr.getSync(tSpec.src);
    if (!isTextureUsable(tex)) {
      layer.lastTileKey = "";
      return null;
    }

    const zNow = layer.lastTargetZ;
    const showInteriorNow = this._shouldMountInteriorTiles(layer, curVp?.scale ?? canvas.stage?.scale?.x ?? 1);
    const effZNow = Math.max(zNow, showInteriorNow ? (layer.zOffset + 5) : 0);
    if (tSpec.minZ !== undefined && effZNow < tSpec.minZ) return null;
    if (tSpec.maxZ !== undefined && zNow > tSpec.maxZ) return null;

    const { simGrid, simSectorPx } = layer;
    const ax0 = tSpec.anchorX !== undefined ? tSpec.anchorX : 0.5;
    const ay0 = tSpec.anchorY !== undefined ? tSpec.anchorY : 0.5;
    const pivX = tSpec.anchorX === undefined ? (tSpec.x + tSpec.w * 0.5) : tSpec.x;
    const pivY = tSpec.anchorY === undefined ? (tSpec.y + tSpec.h * 0.5) : tSpec.y;
    const halfDiag = Math.hypot(tSpec.w || 0, tSpec.h || 0) * Math.max(ax0, 1 - ax0, ay0, 1 - ay0);
    const curSx0 = Math.max(0, Math.floor(curVp.x0 / simSectorPx));
    const curSy0 = Math.max(0, Math.floor(curVp.y0 / simSectorPx));
    const curSx1 = Math.min(simGrid - 1, Math.floor(curVp.x1 / simSectorPx));
    const curSy1 = Math.min(simGrid - 1, Math.floor(curVp.y1 / simSectorPx));
    const secX0 = curSx0 * simSectorPx;
    const secY0 = curSy0 * simSectorPx;
    const secX1 = (curSx1 + 1) * simSectorPx;
    const secY1 = (curSy1 + 1) * simSectorPx;
    if (pivX + halfDiag < secX0 || pivX - halfDiag > secX1 || pivY + halfDiag < secY0 || pivY - halfDiag > secY1) {
      layer.lastTileKey = "";
      return null;
    }

    const PrimaryCanvasGroup = foundry.canvas.groups.PrimaryCanvasGroup;
    const m = this.acquireMesh();
    m.name = `Tile.BoundlessVirtual.${fullId}`;
    const ax = tSpec.anchorX ?? 0.5;
    const ay = tSpec.anchorY ?? 0.5;
    m.anchor.set(ax, ay);
    m.texture = tex;
    m.position.set(tSpec.x + (tSpec.anchorX === undefined ? tSpec.w * 0.5 : 0), tSpec.y + (tSpec.anchorY === undefined ? tSpec.h * 0.5 : 0));
    const sx = Number.isFinite(tSpec.scaleX) ? tSpec.scaleX : 1;
    const sy = Number.isFinite(tSpec.scaleY) ? tSpec.scaleY : 1;
    const fit = ["fill", "cover", "contain", "width", "height"].includes(tSpec.fit) ? tSpec.fit : "fill";
    if (typeof m.resize === "function" && tex.width > 0 && tex.height > 0) {
      m.resize(Math.max(0, tSpec.w || 0), Math.max(0, tSpec.h || 0), { fit, scaleX: sx, scaleY: sy });
    } else {
      m.width = tSpec.w;
      m.height = tSpec.h;
      if (sx < 0) m.scale.x = -Math.abs(m.scale.x);
      if (sy < 0) m.scale.y = -Math.abs(m.scale.y);
    }
    m.angle = tSpec.rot || 0;
    m.elevation = Number.isFinite(tSpec.elevation) ? tSpec.elevation : defaultElev;
    m.sortLayer = resolveSortLayer(tSpec.sortLayer, PrimaryCanvasGroup.SORT_LAYERS.TILES);
    m.sort = tSpec.sort ?? 50;

    const defaultOcc = layer.isUpper
      ? (CONST.OCCLUSION_MODES.FADE | CONST.OCCLUSION_MODES.RADIAL | CONST.OCCLUSION_MODES.SURFACE)
      : CONST.OCCLUSION_MODES.NONE;
    m.occlusionMode = resolveOcclusionMode(tSpec.occlusionMode, defaultOcc);
    m.unoccludedAlpha = tSpec.alpha ?? 1.0;
    m.occludedAlpha = tSpec.occludedAlpha ?? (layer.isUpper ? 0.08 : 0.2);
    m.hoverFade = tSpec.hoverFade ?? (m.occlusionMode !== CONST.OCCLUSION_MODES.NONE && m.occlusionMode !== CONST.OCCLUSION_MODES.SURFACE);
    m.restrictsLight = Boolean(tSpec.restrictsLight);
    m.restrictsWeather = Boolean(tSpec.restrictsWeather);
    m.textureAlphaThreshold = tSpec.alphaThreshold ?? 0.75;
    if (tSpec.tint !== undefined && tSpec.tint !== null) {
      m.tint = typeof tSpec.tint === "string" ? foundry.utils.Color.from(tSpec.tint).valueOf() : tSpec.tint;
    }
    // Hide raw mesh if TilesLayer editor currently renders the native editable Tile for this exact level & slot
    const edTile = this.layerEditors?.tileActive ? this.layerEditors.tilesByKey.get(`t:${tid}`) : null;
    if (edTile && edTile.levelId === lid) {
      m.visible = false;
    }

    canvas.primary.addChild(m);
    m.updateCanvasTransform?.();
    // Decorative props with no occlusion/hoverFade/light restrictions render identically via fast PIXI "batch" shader
    // (halving draw calls & shader switches alongside burn-living-map shadows) and avoid per-frame quadtree rebuilds!
    if (m.occlusionMode === CONST.OCCLUSION_MODES.NONE && !m.hoverFade && !m.restrictsLight && !m.restrictsWeather) {
      m.pluginName = "batch";
      m.updateCanvasTransform = NOOP_TRANSFORM;
    }
    this._syncShowstopperMeshDof(m);
    this.activeVirtualTiles.set(fullId, { levelId: lid, mesh: m, src: tSpec.src, tSpec });
    return m;
  }

  onLightingRefresh(effects) {
    if (!this.active) return;
    this._capFilterResolution(effects?.coloration?.filter, 1.0);
    this._capFilterResolution(effects?.illumination?.filter, 1.0);
    const darkness = canvas.environment?.darknessLevel ?? 0;
    const rangedChanged = this.lightBatch.syncDarknessLevel(darkness);
    this.lightBatch.attachTo(effects);
    this._optimizeEffectsLayers(effects);
    this.tokenStreamer.onVisibilityChanged();
    if (rangedChanged) {
      queueMicrotask(() => {
        if (this.active) this.updateSimAndLightBubbles(false);
      });
    }
    if (this.visibleLevelLayers.length) {
      this.audioStreamer.update(
        this.visibleLevelLayers,
        this.getViewportWorldRect(0.28),
        (lid, sk, idx, raw, lvl) => this.resolveVirtualSound(lid, sk, idx, raw, lvl)
      );
    }
    this._depthDirty = true;
    if (canvas.masks?.depth) canvas.masks.depth.renderDirty = true;
  }

  // Multi-Level Physics Sim-Bubble & Dynamic Lights: strictly driven by tokens (on their own level!), active visionSources, and open doors
  updateSimAndLightBubbles(force = false) {
    if (!this.active || !this.visibleLevelLayers.length || !canvas?.ready || this._updatingBubbles) return;
    this._updatingBubbles = true;
    try {
      const EdgeCls = foundry.canvas.geometry.edges.Edge;
      const LightCls = CONFIG.Canvas.lightSourceClass;
      const pxPerFt = canvas.dimensions.size / canvas.dimensions.distance;
      const darkness = canvas.environment?.darknessLevel ?? 0;

      // 1. Collect Dynamic PointLightSources FIRST so we guarantee their full light radius has wall edges in `level.edges`.
      //    Outdoor lights (`!meta.isIndoor`) ALWAYS stay eligible at all zoom levels so controlled/viewed tokens with sightRange=0
      //    never lose vision on zoom-out! When macro bakedRoofMask is active (roofs unloaded from CanvasDepthMask), only suppress
      //    indoor lights that are NOT directly inside an active visionSource's LOS polygon so they don't bleed through baked roofs.
      const neededDynLights = new Set();
      const suppressUnseenIndoorForMacroRoof = Boolean(this.lightBatch.useBakedRoofMask);
      const suppressIndoorDyn = Boolean(this.lightBatch.hideIndoorLights);

      const isMetaEligibleDyn = (meta, visionSource = null) => {
        if (!meta) return false;
        if (suppressIndoorDyn && meta.isIndoor) return false;
        if (suppressUnseenIndoorForMacroRoof && meta.isIndoor) {
          const canSeeIndoor = Boolean(visionSource?.los?.contains?.(meta.lx, meta.ly));
          if (!canSeeIndoor) return false;
        }
        if (darkness < (meta.darkMin ?? 0) || darkness > (meta.darkMax ?? 1)) return false;
        return true;
      };

      // 1a. Open-door lights (always included, never starved by vision light cap)
      for (const door of this.openDoors.values()) {
        const layer = this.levelLayers.get(door.levelId);
        if (!layer?.spec?.sectors) continue;
        const { simGrid, simSectorPx, spec } = layer;
        const sx0 = Math.max(0, Math.floor((door.x - LIGHT_PAD_WORLD_PX) / simSectorPx));
        const sy0 = Math.max(0, Math.floor((door.y - LIGHT_PAD_WORLD_PX) / simSectorPx));
        const sx1 = Math.min(simGrid - 1, Math.floor((door.x + LIGHT_PAD_WORLD_PX) / simSectorPx));
        const sy1 = Math.min(simGrid - 1, Math.floor((door.y + LIGHT_PAD_WORLD_PX) / simSectorPx));
        for (let sy = sy0; sy <= sy1; sy++) {
          for (let sx = sx0; sx <= sx1; sx++) {
            const sk = `${sx}_${sy}`;
            const sec = spec.sectors[sk];
            if (!sec?.l?.length) continue;
            for (let li = 0; li < sec.l.length; li++) {
              const lid = `${door.levelId}::${sk}_${li}`;
              const meta = this.lightBatch.lightMetaById.get(lid);
              if (isMetaEligibleDyn(meta) && Math.hypot(meta.lx - door.x, meta.ly - door.y) <= meta.dimPx + 150) {
                neededDynLights.add(lid);
              }
            }
          }
        }
      }

      // 1b. Nearest lights to active visionSources (skip when box-selecting a crowd > 6 visionSources)
      const MAX_VISION_DYN_LIGHTS = 24;
      if (canvas.effects?.visionSources?.size && canvas.effects.visionSources.size <= 6) {
        const visionCandidates = new Map(); // lid -> minDistSq
        for (const vs of canvas.effects.visionSources) {
          if (!vs?.active) continue;
          const vsLevelId = vs.data?.level || canvas.level?.id;
          const layer = this.levelLayers.get(vsLevelId);
          if (!layer?.spec?.sectors) continue;
          const { simGrid, simSectorPx, spec } = layer;
          const vRad = Math.min(MAX_LOS_RADIUS_PX, Math.max(vs.radius || 0, 60 * pxPerFt));
          const sx0 = Math.max(0, Math.floor((vs.x - vRad - LIGHT_PAD_WORLD_PX) / simSectorPx));
          const sy0 = Math.max(0, Math.floor((vs.y - vRad - LIGHT_PAD_WORLD_PX) / simSectorPx));
          const sx1 = Math.min(simGrid - 1, Math.floor((vs.x + vRad + LIGHT_PAD_WORLD_PX) / simSectorPx));
          const sy1 = Math.min(simGrid - 1, Math.floor((vs.y + vRad + LIGHT_PAD_WORLD_PX) / simSectorPx));
          for (let sy = sy0; sy <= sy1; sy++) {
            for (let sx = sx0; sx <= sx1; sx++) {
              const sk = `${sx}_${sy}`;
              const sec = spec.sectors[sk];
              if (!sec?.l?.length) continue;
              for (let li = 0; li < sec.l.length; li++) {
                const lid = `${vsLevelId}::${sk}_${li}`;
                if (neededDynLights.has(lid)) continue;
                const meta = this.lightBatch.lightMetaById.get(lid);
                if (!isMetaEligibleDyn(meta, vs)) continue;
                const dx = meta.lx - vs.x;
                const dy = meta.ly - vs.y;
                const maxD = vRad + meta.dimPx;
                const distSq = dx * dx + dy * dy;
                if (distSq <= maxD * maxD) {
                  const prev = visionCandidates.get(lid);
                  if (prev === undefined || distSq < prev) visionCandidates.set(lid, distSq);
                }
              }
            }
          }
        }
        if (visionCandidates.size > 0) {
          const sorted = Array.from(visionCandidates.entries()).sort((a, b) => a[1] - b[1]);
          const take = Math.min(MAX_VISION_DYN_LIGHTS, sorted.length);
          for (let i = 0; i < take; i++) neededDynLights.add(sorted[i][0]);
        }
      }

      // 2. Physics Wall Edges per Level (`level.edges`): around active tokens (controlled, player-owned,
      //    light-emitting, active visionSources), open doors, and every active dynamic PointLightSource
      const neededSim = new Map(); // "${levelId}::${sx}_${sy}" -> { layer, sk }
      const addSimBubble = (levelId, wx, wy, radiusPx = 0) => {
        const layer = this.levelLayers.get(levelId);
        if (!layer?.spec?.sectors) return;
        const { simGrid, simSectorPx, spec } = layer;
        const effRad = Math.max(simSectorPx, radiusPx || 0);
        const sx0 = Math.max(0, Math.floor((wx - effRad) / simSectorPx));
        const sy0 = Math.max(0, Math.floor((wy - effRad) / simSectorPx));
        const sx1 = Math.min(simGrid - 1, Math.floor((wx + effRad) / simSectorPx));
        const sy1 = Math.min(simGrid - 1, Math.floor((wy + effRad) / simSectorPx));
        for (let y = sy0; y <= sy1; y++) {
          for (let x = sx0; x <= sx1; x++) {
            const sk = `${x}_${y}`;
            if (spec.sectors[sk]) {
              neededSim.set(`${levelId}::${sk}`, { layer, sk });
            }
          }
        }
      };

      const controlledCount = canvas.tokens?.controlled?.length || 0;
      const isBulkSelection = controlledCount > 8;
      let bulkControlledAdded = 0;

      for (const tok of canvas.tokens.placeables) {
        if (!tok || tok.destroyed || tok.isPreview || !tok.center) continue;
        const doc = tok.document;
        const lightRadPx = Math.max(doc?.light?.dim || 0, doc?.light?.bright || 0) * pxPerFt;
        const isCoreActor = Boolean(doc?.hasPlayerOwner)
          || Boolean(tok.vision?.active)
          || lightRadPx > 0;
        let isActiveActor = isCoreActor;
        if (!isActiveActor && tok.controlled) {
          if (!isBulkSelection || bulkControlledAdded < 8) {
            isActiveActor = true;
            bulkControlledAdded++;
          }
        }
        if (!isActiveActor) continue;
        const visRadPx = tok.vision?.active ? Math.min(MAX_LOS_RADIUS_PX, tok.vision.radius || 0) : 0;
        addSimBubble(doc?.level || canvas.level?.id, tok.center.x, tok.center.y, Math.max(lightRadPx, visRadPx));
      }

      if (canvas.effects?.visionSources?.size) {
        for (const vs of canvas.effects.visionSources) {
          if (!vs?.active) continue;
          const vRad = Math.min(MAX_LOS_RADIUS_PX, vs.radius || 0);
          addSimBubble(vs.data?.level || canvas.level?.id, vs.x, vs.y, vRad);
        }
      }

      for (const door of this.openDoors.values()) {
        addSimBubble(door.levelId, door.x, door.y, LIGHT_PAD_WORLD_PX);
      }

      // Guarantee every active dynamic PointLightSource has all wall sectors within its full radius
      for (const lid of neededDynLights) {
        const meta = this.lightBatch.lightMetaById.get(lid);
        if (meta && meta.walls !== false) {
          addSimBubble(meta.levelId, meta.lx, meta.ly, meta.dimPx + 100);
        }
      }

      const simKey = Array.from(neededSim.keys()).sort().join("|");
      let edgesChanged = false;

      if (force || simKey !== this.lastSimKey) {
        this.lastSimKey = simKey;

        for (const [fullKey, data] of this.simSectors) {
          if (!neededSim.has(fullKey)) {
            for (const eid of data.edgeIds) data.level.edges.delete(eid);
            this.simSectors.delete(fullKey);
            edgesChanged = true;
          }
        }

        for (const [fullKey, { layer, sk }] of neededSim) {
          if (this.simSectors.has(fullKey)) continue;
          const sec = layer.spec.sectors[sk];
          if (!sec) continue;
          const level = layer.level;
          const lid = level.id;
          const edgeIds = [];

          if (sec.w) {
            for (let wi = 0; wi < sec.w.length; wi++) {
              const seg = this.resolveVirtualWall(lid, "w", sk, wi, sec.w[wi]);
              if (!seg) continue;
              const dKey = seg.door ? `${lid}::${sk}_w${wi}` : null;
              const isOpen = dKey ? (this.getCurrentDoorState(dKey, seg.ds) === 1) : false;
              const eid = `mw_${lid}_${sk}_${wi}`;
              if (!isOpen) {
                const [x1, y1, x2, y2] = seg.c;
                const threshold = buildEdgeThresholdPx(seg.threshold, pxPerFt);
                const edge = new EdgeCls({ x: x1, y: y1 }, { x: x2, y: y2 }, {
                  id: eid, type: "wall",
                  move: seg.move, sight: seg.sight, light: seg.light, darkness: seg.darkness ?? seg.light, sound: seg.sound, direction: seg.dir || 0,
                  ...(threshold ? { threshold } : {})
                });
                level.edges.set(eid, edge);
              }
              edgeIds.push(eid);
            }
          }

          if (sec.d) {
            for (let di = 0; di < sec.d.length; di++) {
              const seg = this.resolveVirtualWall(lid, "d", sk, di, sec.d[di]);
              if (!seg) continue;
              const [x1, y1, x2, y2] = seg.c;
              const dKey = `${lid}::${sk}_${di}`;
              const eid = `md_${dKey}`;
              const isOpen = seg.door ? (this.getCurrentDoorState(dKey, seg.ds) === 1) : false;
              if (!isOpen) {
                const threshold = buildEdgeThresholdPx(seg.threshold, pxPerFt);
                const edge = new EdgeCls({ x: x1, y: y1 }, { x: x2, y: y2 }, {
                  id: eid, type: "wall",
                  move: seg.move, sight: seg.sight, light: seg.light, darkness: seg.darkness ?? seg.light, sound: seg.sound, direction: seg.dir || 0,
                  ...(threshold ? { threshold } : {})
                });
                level.edges.set(eid, edge);
              }
              edgeIds.push(eid);
            }
          }

          this.simSectors.set(fullKey, { level, edgeIds });
          edgesChanged = true;
        }
      }

      const dynKey = Array.from(neededDynLights).sort().join("|");
      let lightsChanged = false;

      if (force || dynKey !== this.lastDynLightKey || edgesChanged) {
        this.lastDynLightKey = dynKey;

        for (const [lid, ls] of this.dynamicLights) {
          if (!neededDynLights.has(lid)) {
            ls.destroy();
            this.dynamicLights.delete(lid);
            this.lightBatch.setLightWeight(lid, 1.0);
            lightsChanged = true;
          }
        }

        for (const lid of neededDynLights) {
          if (this.dynamicLights.has(lid)) {
            if (edgesChanged) {
              const ls = this.dynamicLights.get(lid);
              ls.initialize(ls.data);
            }
            continue;
          }
          const meta = this.lightBatch.lightMetaById.get(lid);
          if (!meta) continue;
          const [lx, ly, dimFt, brightFt, color, alpha, anim] = meta.raw;
          const ls = new LightCls({ sourceId: `MegaLight.${lid}` });
          ls.initialize({
            x: lx, y: ly, level: meta.levelId, elevation: meta.elevation,
            walls: meta.walls !== false, vision: false,
            angle: meta.angle ?? 360,
            rotation: meta.rotation ?? 0,
            dim: (dimFt || 0) * pxPerFt, bright: (brightFt || 0) * pxPerFt,
            color, alpha,
            animation: anim ? { type: anim, speed: 3, intensity: 3 } : {}
          });
          ls.add();
          this.dynamicLights.set(lid, ls);
          this.lightBatch.setLightWeight(lid, 0.0);
          lightsChanged = true;
        }
      }

      this.lightBatch.flushWeights();

      if (edgesChanged || lightsChanged) {
        canvas.perception.update({
          initializeVision: edgesChanged,
          initializeLighting: lightsChanged || edgesChanged,
          initializeSounds: edgesChanged,
          refreshLighting: true,
          refreshVision: true
        });
      } else {
        this.lightBatch.attachTo(canvas.effects);
      }
    } finally {
      this._updatingBubbles = false;
    }
  }

  // ===== Networked & Persisted Door Synchronization =====

  _ensureSocket() {
    if (this._socketRegistered || !game.socket) return;
    this._socketRegistered = true;
    game.socket.on(SOCKET_NAME, (payload) => this._onSocketMessage(payload));
  }

  _resolveDoorByKey(dKey) {
    if (!dKey || !dKey.includes("::")) return null;
    const [levelId, rest] = dKey.split("::");
    const parts = rest.split("_");
    if (parts.length !== 3) return null;
    const sx = Number(parts[0]), sy = Number(parts[1]);
    const isConvertedWall = parts[2].startsWith("w");
    const idx = Number(isConvertedWall ? parts[2].slice(1) : parts[2]);
    const sk = `${sx}_${sy}`;
    const layer = this.levelLayers.get(levelId);
    const sec = layer?.spec?.sectors?.[sk];
    const raw = isConvertedWall ? sec?.w?.[idx] : sec?.d?.[idx];
    if (!raw) return null;
    const seg = this.resolveVirtualWall(levelId, isConvertedWall ? "w" : "d", sk, idx, raw);
    if (!seg || !seg.door) return null;
    const [x1, y1, x2, y2] = seg.c;
    return {
      dKey,
      eid: isConvertedWall ? `mw_${levelId}_${sk}_${idx}` : `md_${dKey}`,
      levelId,
      sx,
      sy,
      ptA: { x: x1, y: y1 },
      ptB: { x: x2, y: y2 },
      move: seg.move ?? 20,
      sight: seg.sight ?? 20,
      light: seg.light ?? 20,
      darkness: seg.darkness ?? seg.light ?? 20,
      sound: seg.sound ?? 20,
      dir: seg.dir || 0,
      doorType: seg.door,
      defaultDs: seg.ds,
      doorSound: seg.doorSound || "",
      threshold: seg.threshold || null
    };
  }

  _normalizeDoorState(val, fallback = 0) {
    if (val === true) return 1;
    if (val === false) return 0;
    const n = Number(val);
    return (n === 0 || n === 1 || n === 2) ? n : fallback;
  }

  getCurrentDoorState(dKey, defaultDs = 0) {
    return this.doorStates.has(dKey) ? this.doorStates.get(dKey) : defaultDs;
  }

  _restoreDoorStates(scene) {
    this.doorStates.clear();
    this.openDoors.clear();
    const savedStates = scene?.flags?.[MODULE_ID]?.doorStates;
    if (!savedStates || typeof savedStates !== "object") return;
    for (const [dKey, rawVal] of Object.entries(savedStates)) {
      if (rawVal === null || rawVal === undefined) continue;
      const info = this._resolveDoorByKey(dKey);
      const ds = this._normalizeDoorState(rawVal, info?.defaultDs ?? 0);
      this.doorStates.set(dKey, ds);
      if (info && ((ds === 1) !== (info.defaultDs === 1))) {
        const dx = (info.ptA.x + info.ptB.x) * 0.5;
        const dy = (info.ptA.y + info.ptB.y) * 0.5;
        this.openDoors.set(dKey, { levelId: info.levelId, x: dx, y: dy, sx: info.sx, sy: info.sy, eid: info.eid });
      }
    }
  }

  _reconcileChunkDoorStates(layer, chunkData) {
    if (!layer || !chunkData?.sectors || !this.doorStates.size) return;
    const lid = layer.level.id;
    const prefix = `${lid}::`;
    for (const [dKey, ds] of this.doorStates) {
      if (!dKey.startsWith(prefix)) continue;
      const info = this._resolveDoorByKey(dKey);
      if (!info) continue;
      const sk = `${info.sx}_${info.sy}`;
      if (!chunkData.sectors[sk]) continue;
      const differsFromBaked = (ds === 1) !== (info.defaultDs === 1);
      if (differsFromBaked) {
        const dx = (info.ptA.x + info.ptB.x) * 0.5;
        const dy = (info.ptA.y + info.ptB.y) * 0.5;
        this.openDoors.set(dKey, { levelId: info.levelId, x: dx, y: dy, sx: info.sx, sy: info.sy, eid: info.eid });
      } else {
        this.openDoors.delete(dKey);
      }
    }
  }

  _applyDoorStateLocal(info, targetDs, { playSound = true } = {}) {
    const { dKey, eid, levelId, sx, sy, ptA, ptB, defaultDs } = info;
    const ds = this._normalizeDoorState(targetDs, defaultDs);
    const curDs = this.getCurrentDoorState(dKey, defaultDs);
    if (curDs === ds) return false;

    const EdgeCls = foundry.canvas.geometry.edges.Edge;
    const layer = this.levelLayers.get(levelId);
    const level = layer?.level || canvas.level;
    const dx = (ptA.x + ptB.x) * 0.5, dy = (ptA.y + ptB.y) * 0.5;

    this.doorStates.set(dKey, ds);
    const isOpen = ds === 1;
    const wasOpen = curDs === 1;
    const differsFromBaked = isOpen !== (defaultDs === 1);

    if (isOpen) {
      level?.edges?.delete(eid);
    } else if (this.simSectors.has(`${levelId}::${sx}_${sy}`)) {
      const pxPerFt = (canvas.dimensions?.size || 100) / Math.max(0.001, Number(canvas.dimensions?.distance) || 5);
      const threshold = buildEdgeThresholdPx(info.threshold, pxPerFt);
      level?.edges?.set(eid, new EdgeCls(ptA, ptB, {
        id: eid, type: "wall",
        move: info.move ?? 20,
        sight: info.sight ?? 20,
        light: info.light ?? 20,
        darkness: info.darkness ?? info.light ?? 20,
        sound: info.sound ?? 20,
        direction: info.dir || 0,
        ...(threshold ? { threshold } : {})
      }));
    }

    if (differsFromBaked) {
      this.openDoors.set(dKey, { levelId, x: dx, y: dy, sx, sy, eid });
    } else {
      this.openDoors.delete(dKey);
    }

    // Drive native Wall._onUpdate (DoorControl icon, DoorMesh animation, native door sound)
    this.wallEditor.applyDoorStateToMounted(dKey, ds, { playSound });

    if (isOpen !== wasOpen) {
      this.updateSimAndLightBubbles(false);
      for (const [, ls] of this.dynamicLights) {
        if (ls.data?.level !== levelId) continue;
        const r = (ls.radius || ls.data?.dim || 600) + 150;
        if (Math.hypot(ls.x - dx, ls.y - dy) <= r) ls.initialize(ls.data);
      }
      canvas.perception.update({
        initializeVision: true,
        initializeLighting: true,
        initializeSounds: true,
        refreshLighting: true,
        refreshVision: true
      });
    }
    return true;
  }

  async _onSocketMessage(payload) {
    if (!payload || !this.active || payload.sceneId !== canvas.scene?.id) return;
    if (payload.senderId === game.user?.id) return;

    if (this.fogManager.handleSocketMessage(payload)) return;

    const info = this._resolveDoorByKey(payload.dKey);
    if (!info) {
      if (payload.type === "doorState" && payload.dKey) {
        if (!game.users?.get?.(payload.senderId)?.isGM) return;
        const targetDs = payload.ds !== undefined
          ? this._normalizeDoorState(payload.ds, 0)
          : (payload.isOpen ? 1 : 0);
        this.doorStates.set(payload.dKey, targetDs);
      }
      return;
    }

    const targetDs = payload.ds !== undefined
      ? this._normalizeDoorState(payload.ds, info.defaultDs)
      : (payload.isOpen ? 1 : 0);

    if (payload.type === "doorState") {
      if (!game.users?.get?.(payload.senderId)?.isGM) return;
      this._applyDoorStateLocal(info, targetDs, { playSound: payload.playSound !== false });
    } else if (payload.type === "doorRequest") {
      // Only the single active GM persists player door requests and broadcasts authoritative state
      if (game.users.activeGM?.id !== game.user?.id) return;
      const curDs = this.getCurrentDoorState(info.dKey, info.defaultDs);
      if (info.doorType === 2 || curDs === 2 || targetDs === 2) return;
      this._applyDoorStateLocal(info, targetDs, { playSound: true });
      game.socket?.emit(SOCKET_NAME, {
        type: "doorState",
        sceneId: canvas.scene.id,
        dKey: info.dKey,
        ds: targetDs,
        playSound: true,
        senderId: game.user.id
      });
      await canvas.scene.update({ [`flags.${MODULE_ID}.doorStates.${info.dKey}`]: targetDs });
    }
  }

  requestDoorState(dKey, targetDs, { playSound = true } = {}) {
    const info = this._resolveDoorByKey(dKey);
    if (!info) return;
    const ds = this._normalizeDoorState(targetDs, info.defaultDs);
    const curDs = this.getCurrentDoorState(dKey, info.defaultDs);

    if (!game.user.isGM) {
      if (info.doorType === 2 || curDs === 2 || ds === 2) return;
      if (!game.users?.activeGM) return;
    }

    this._applyDoorStateLocal(info, ds, { playSound });

    if (game.user.isGM) {
      game.socket?.emit(SOCKET_NAME, {
        type: "doorState",
        sceneId: canvas.scene?.id,
        dKey,
        ds,
        playSound,
        senderId: game.user.id
      });
      canvas.scene?.update({ [`flags.${MODULE_ID}.doorStates.${dKey}`]: ds }).catch(err => {
        console.warn(`${MODULE_ID} | Failed to persist door state:`, err);
      });
    } else {
      game.socket?.emit(SOCKET_NAME, {
        type: "doorRequest",
        sceneId: canvas.scene?.id,
        dKey,
        ds,
        senderId: game.user.id
      });
    }
  }

  _loadWallEdits(scene) {
    this.wallEdits.clear();
    const raw = scene?.flags?.[MODULE_ID]?.wallEdits;
    if (raw && typeof raw === "object") {
      for (const [lid, mapObj] of Object.entries(raw)) {
        if (!mapObj || typeof mapObj !== "object") continue;
        const levelMap = new Map();
        for (const [wKey, val] of Object.entries(mapObj)) {
          if (val === null) {
            levelMap.set(wKey, null);
          } else if (val && typeof val === "object" && Array.isArray(val.c)) {
            levelMap.set(wKey, val);
          }
        }
        if (levelMap.size) this.wallEdits.set(lid, levelMap);
      }
    }
    this.wallEditsRev++;
  }

  resolveVirtualWall(levelId, kind, sk, idx, raw) {
    const wKey = `${sk}:${kind}:${idx}`;
    const levelMap = this.wallEdits.get(levelId);
    if (levelMap && levelMap.has(wKey)) {
      const ov = levelMap.get(wKey);
      if (ov === null) return null; // Deleted by GM
      return {
        kind,
        levelId,
        sk,
        idx,
        wKey,
        c: ov.c,
        move: ov.move ?? 20,
        sight: ov.sight ?? 20,
        light: ov.light ?? 20,
        sound: ov.sound ?? 20,
        dir: ov.dir || 0,
        door: ov.door || 0,
        ds: ov.ds || 0,
        doorSound: ov.doorSound || "",
        threshold: ov.threshold || null,
        animation: (ov.animation?.type && ov.animation?.texture) ? ov.animation : null
      };
    }
    if (kind === "d") {
      const [x1, y1, x2, y2, doorType, defaultDs, extra] = raw;
      return {
        kind: "d",
        levelId,
        sk,
        idx,
        wKey,
        c: [x1, y1, x2, y2],
        move: extra?.move ?? 20,
        sight: extra?.sight ?? 20,
        light: extra?.light ?? 20,
        sound: extra?.sound ?? 20,
        dir: extra?.dir || 0,
        door: doorType || 1,
        ds: defaultDs || 0,
        doorSound: extra?.doorSound || "",
        threshold: extra?.threshold || null,
        animation: (extra?.animation?.type && extra?.animation?.texture) ? extra.animation : null
      };
    }
    const [x1, y1, x2, y2, move, sight, light, sound, dir, extra] = raw;
    return {
      kind: "w",
      levelId,
      sk,
      idx,
      wKey,
      c: [x1, y1, x2, y2],
      move: move ?? 20,
      sight: sight ?? 20,
      light: light ?? 20,
      sound: sound ?? 20,
      dir: dir || 0,
      door: 0,
      ds: 0,
      doorSound: "",
      threshold: extra?.threshold || null,
      animation: null
    };
  }

  setVirtualWallEditLocal(levelId, wKey, value) {
    let levelMap = this.wallEdits.get(levelId);
    if (!levelMap) {
      levelMap = new Map();
      this.wallEdits.set(levelId, levelMap);
    }
    levelMap.set(wKey, value);
    this.wallEditsRev++;
  }

  applyVirtualWallChangesLocal() {
    for (const [, data] of this.simSectors) {
      if (data.level?.edges) {
        for (const eid of data.edgeIds) data.level.edges.delete(eid);
      }
    }
    this.simSectors.clear();
    this.lastSimKey = "";

    // Revalidate tracked doors in openDoors after wall/door edits (removals, wall conversions, coordinate moves)
    for (const dKey of Array.from(this.openDoors.keys())) {
      const info = this._resolveDoorByKey(dKey);
      if (!info) {
        this.openDoors.delete(dKey);
        continue;
      }
      const curDs = this.getCurrentDoorState(dKey, info.defaultDs);
      if ((curDs === 1) !== (info.defaultDs === 1)) {
        const dx = (info.ptA.x + info.ptB.x) * 0.5;
        const dy = (info.ptA.y + info.ptB.y) * 0.5;
        this.openDoors.set(dKey, { levelId: info.levelId, x: dx, y: dy, sx: info.sx, sy: info.sy, eid: info.eid });
      } else {
        this.openDoors.delete(dKey);
      }
    }

    this.updateSimAndLightBubbles(true);
    this.wallEditor.syncViewport(true);
    this.scheduleLightBatchRebuild();
  }

  _loadGenericEdits(scene, flagName, targetMap) {
    targetMap.clear();
    const raw = scene?.flags?.[MODULE_ID]?.[flagName];
    if (raw && typeof raw === "object") {
      for (const [lid, mapObj] of Object.entries(raw)) {
        if (!mapObj || typeof mapObj !== "object") continue;
        const levelMap = new Map();
        for (const [k, val] of Object.entries(mapObj)) {
          if (val === null) levelMap.set(k, null);
          else if (val && typeof val === "object") levelMap.set(k, val);
        }
        if (levelMap.size) targetMap.set(lid, levelMap);
      }
    }
  }

  _loadLightEdits(scene) {
    this._loadGenericEdits(scene, "lightEdits", this.lightEdits);
    this.lightEditsRev++;
  }

  _loadSoundEdits(scene) {
    this._loadGenericEdits(scene, "soundEdits", this.soundEdits);
    this.soundEditsRev++;
  }

  _loadTileEdits(scene) {
    this._loadGenericEdits(scene, "tileEdits", this.tileEdits);
    this.tileEditsRev++;
  }

  resolveVirtualLight(levelId, sk, idx, raw, level = null) {
    const lKey = `${sk}:l:${idx}`;
    const defaultElev = getLevelBaseElevation(level) + 6;
    const levelMap = this.lightEdits.get(levelId);
    if (levelMap && levelMap.has(lKey)) {
      const ov = levelMap.get(lKey);
      if (ov === null) return null;
      return {
        levelId, sk, idx, lKey,
        x: ov.x, y: ov.y,
        dim: ov.dim ?? 0, bright: ov.bright ?? 0,
        color: ov.color ?? null, alpha: ov.alpha ?? 0.5,
        anim: ov.anim || "",
        elevation: Number.isFinite(ov.elevation) ? ov.elevation : defaultElev,
        hidden: Boolean(ov.hidden),
        walls: ov.walls !== false,
        angle: ov.angle ?? 360,
        rotation: ov.rotation ?? 0,
        darkMin: ov.darkMin ?? 0,
        darkMax: ov.darkMax ?? 1
      };
    }
    const [x, y, dim, bright, color, alpha, anim, customElev, extra] = raw;
    const ex = extra && typeof extra === "object" ? extra : null;
    return {
      levelId, sk, idx, lKey,
      x, y, dim: dim || 0, bright: bright || 0,
      color: color ?? null, alpha: alpha ?? 0.5, anim: anim || "",
      elevation: Number.isFinite(customElev) ? customElev : defaultElev,
      hidden: Boolean(ex?.hidden),
      walls: ex?.walls !== false,
      angle: ex?.angle ?? 360,
      rotation: ex?.rotation ?? 0,
      darkMin: ex?.darkMin ?? 0,
      darkMax: ex?.darkMax ?? 1
    };
  }

  setVirtualLightEditLocal(levelId, lKey, value) {
    let m = this.lightEdits.get(levelId);
    if (!m) { m = new Map(); this.lightEdits.set(levelId, m); }
    m.set(lKey, value);
    this.lightEditsRev++;
  }

  applyVirtualLightChangesLocal() {
    for (const [, ls] of this.dynamicLights) ls.destroy();
    this.dynamicLights.clear();
    this.lastDynLightKey = "";
    // scheduleLightBatchRebuild runs updateSimAndLightBubbles(true) strictly AFTER rebuilding lightMetaById
    this.scheduleLightBatchRebuild();
    this.layerEditors.syncLighting(true);
  }

  resolveVirtualSound(levelId, sk, idx, raw, level = null) {
    const sKey = `${sk}:s:${idx}`;
    const defaultElev = getLevelBaseElevation(level) + 5;
    const levelMap = this.soundEdits.get(levelId);
    if (levelMap && levelMap.has(sKey)) {
      const ov = levelMap.get(sKey);
      if (ov === null) return null;
      return {
        levelId, sk, idx, sKey,
        x: ov.x, y: ov.y, radius: ov.radius ?? 20, path: ov.path || "",
        volume: ov.volume ?? 0.6, walls: ov.walls !== false, easing: ov.easing !== false,
        darkMin: ov.darkMin ?? 0, darkMax: ov.darkMax ?? 1,
        elevation: Number.isFinite(ov.elevation) ? ov.elevation : defaultElev,
        hidden: Boolean(ov.hidden)
      };
    }
    const [x, y, radius, path, volume, walls, easing, darkMin, darkMax, customElev, extra] = raw;
    const ex = extra && typeof extra === "object" ? extra : null;
    return {
      levelId, sk, idx, sKey,
      x, y, radius: radius || 20, path: path || "",
      volume: volume ?? 0.6, walls: walls !== false, easing: easing !== false,
      darkMin: darkMin ?? 0, darkMax: darkMax ?? 1,
      elevation: Number.isFinite(customElev) ? customElev : defaultElev,
      hidden: Boolean(ex?.hidden)
    };
  }

  setVirtualSoundEditLocal(levelId, sKey, value) {
    let m = this.soundEdits.get(levelId);
    if (!m) { m = new Map(); this.soundEdits.set(levelId, m); }
    m.set(sKey, value);
    this.soundEditsRev++;
  }

  applyVirtualSoundChangesLocal() {
    this.audioStreamer.lastKey = "";
    this.audioStreamer.update(
      this.visibleLevelLayers,
      this.getViewportWorldRect(0.28),
      (lid, sk, idx, raw, lvl) => this.resolveVirtualSound(lid, sk, idx, raw, lvl)
    );
    this.layerEditors.syncSounds(true);
  }

  resolveVirtualTile(levelId, tid, raw, level = null) {
    const tKey = `t:${tid}`;
    const defaultElev = getLevelBaseElevation(level);
    const levelMap = this.tileEdits.get(levelId);
    if (levelMap && levelMap.has(tKey)) {
      const ov = levelMap.get(tKey);
      if (ov === null) return null;
      // Preserve non-editable Boundless tile metadata from raw spec (without re-injecting raw.anchorX/anchorY)
      const preserved = {};
      if (raw && typeof raw === "object") {
        for (const k of ["minZ", "maxZ", "sortLayer", "hoverFade", "surfaceMode", "walkable"]) {
          if (raw[k] !== undefined) preserved[k] = raw[k];
        }
      }
      return { levelId, tid, tKey, ...preserved, ...ov, elevation: Number.isFinite(ov.elevation) ? ov.elevation : defaultElev };
    }
    if (!raw) return null;
    return { levelId, tid, tKey, ...raw, elevation: Number.isFinite(raw.elevation) ? raw.elevation : defaultElev };
  }

  setVirtualTileEditLocal(levelId, tKey, value) {
    let m = this.tileEdits.get(levelId);
    if (!m) { m = new Map(); this.tileEdits.set(levelId, m); }
    m.set(tKey, value);
    this.tileEditsRev++;
  }

  setVirtualTilesVisible(visible) {
    const v = Boolean(visible);
    for (const vt of this.activeVirtualTiles.values()) {
      if (vt?.mesh && !vt.mesh.destroyed) vt.mesh.visible = v;
    }
  }

  applyVirtualTileChangesLocal() {
    for (const [, vt] of this.activeVirtualTiles) {
      if (vt.mesh) this.retireMesh(vt.mesh);
    }
    this.activeVirtualTiles.clear();
    this.virtualTilePending.clear();
    this.pendingVirtualTileMounts = [];
    this._pendingVirtualTileKeys.clear();
    for (const layer of this.visibleLevelLayers) layer.lastTileKey = "";
    this.updatePyramid();
    this.layerEditors.syncTiles(true);
    this._occlusionDirty = true;
    this._depthDirty = true;
    if (canvas.masks?.depth) canvas.masks.depth.renderDirty = true;
    this._depthElevSyncNeeded = true;
  }

  scheduleLightBatchRebuild() {
    if (this._lightRebuildScheduled) return;
    this._lightRebuildScheduled = true;
    queueMicrotask(() => {
      this._lightRebuildScheduled = false;
      if (!this.active || !this.visibleLevelLayers.length || !canvas?.ready) return;
      const pxPerFt = canvas.dimensions.size / canvas.dimensions.distance;
      this.lightBatch.build(
        this.visibleLevelLayers,
        pxPerFt,
        (lid, kind, sk, idx, raw) => this.resolveVirtualWall(lid, kind, sk, idx, raw),
        (lid, sk, idx, raw, lvl) => this.resolveVirtualLight(lid, sk, idx, raw, lvl),
        this._getLightBatchBuildOpts()
      );
      // Re-queue GPU light baking for all resident chunks on chunked worlds so edits never wipe chunk lights
      this.chunkStreamer.requeueAllLoadedChunks();
      this._syncIndoorLightVisibility();
      this.lightBatch.syncDarknessLevel(canvas.environment?.darknessLevel ?? 0);
      this.updateSimAndLightBubbles(true);
      this.lightBatch.attachTo(canvas.effects);
      this.lightBatch.updateViewport(this.getViewportWorldRect(0.28));
      this._depthElevSyncNeeded = true;
      this._optimizeEffectsLayers(canvas.effects);
    });
  }

  onSceneUpdate(scene, changes) {
    if (scene?.id !== canvas.scene?.id) return;

    const flagChanges = changes?.flags?.[MODULE_ID];
    const flagDeleted = Boolean(changes?.flags && (`-=${MODULE_ID}` in changes.flags));

    // Handle enabling/disabling or manifest changes even when controller is currently inactive
    if (flagDeleted || (flagChanges && ("enabled" in flagChanges || "manifestUrl" in flagChanges || "-=manifestUrl" in flagChanges || "levelId" in flagChanges || "-=levelId" in flagChanges))) {
      this.mount(scene);
      return;
    }

    if (!this.active) return;

    // React to native Foundry v14 Scene fog mode (DISABLED / INDIVIDUAL / SHARED) & tokenVision changes
    if (changes?.fog || "tokenVision" in (changes || {})) {
      this.fogManager.mount(scene);
      this.tokenStreamer.onVisibilityChanged();
    }

    if (!flagChanges || typeof flagChanges !== "object") return;

    if ("wallEdits" in flagChanges || "-=wallEdits" in flagChanges) {
      this._loadWallEdits(scene);
      this.applyVirtualWallChangesLocal();
    }

    if ("lightEdits" in flagChanges || "-=lightEdits" in flagChanges) {
      this._loadLightEdits(scene);
      this.applyVirtualLightChangesLocal();
    }

    if ("soundEdits" in flagChanges || "-=soundEdits" in flagChanges) {
      this._loadSoundEdits(scene);
      this.applyVirtualSoundChangesLocal();
    }

    if ("tileEdits" in flagChanges || "-=tileEdits" in flagChanges) {
      this._loadTileEdits(scene);
      this.applyVirtualTileChangesLocal();
    }

    if ("-=doorStates" in flagChanges || flagChanges.doorStates === null) {
      const prevKeys = Array.from(this.doorStates.keys());
      // Keep this.doorStates intact while reverting so _applyDoorStateLocal sees curDs !== defaultDs
      for (const dKey of prevKeys) {
        const info = this._resolveDoorByKey(dKey);
        if (info) this._applyDoorStateLocal(info, info.defaultDs, { playSound: false });
      }
      this.doorStates.clear();
      this.openDoors.clear();
      this._restoreDoorStates(scene);
    } else if (flagChanges.doorStates && typeof flagChanges.doorStates === "object") {
      for (const [rawKey, rawVal] of Object.entries(flagChanges.doorStates)) {
        if (rawKey.startsWith("-=") || rawVal === null) {
          const dKey = rawKey.startsWith("-=") ? rawKey.slice(2) : rawKey;
          const info = this._resolveDoorByKey(dKey);
          if (info) {
            this._applyDoorStateLocal(info, info.defaultDs, { playSound: false });
          }
          this.doorStates.delete(dKey);
          this.openDoors.delete(dKey);
        } else {
          const info = this._resolveDoorByKey(rawKey);
          if (info) {
            this._applyDoorStateLocal(info, rawVal, { playSound: false });
          } else {
            this.doorStates.set(rawKey, this._normalizeDoorState(rawVal, 0));
          }
        }
      }
    }

    if ("pois" in flagChanges || "-=pois" in flagChanges || "showPois" in flagChanges) {
      if (flagChanges.showPois !== false && !this.poiManager.container) {
        this.poiManager.mount(scene, this.manifest);
      } else {
        this.poiManager.rebuild(scene, this.manifest);
      }
    }

    if ("showCharacterPins" in flagChanges) {
      if (flagChanges.showCharacterPins !== false && !this.charPins.container) {
        this.charPins.mount(scene);
      } else {
        this.charPins.rebuild(scene);
      }
    }

    if ("chunkedFog" in flagChanges) {
      this.fogManager.mount(scene);
    } else {
      if ("sharedFog" in flagChanges || "-=sharedFog" in flagChanges) {
        this.fogManager.onSceneFogFlagsChanged(scene, flagChanges.sharedFog ?? null);
      }
      if (flagChanges.fogResetAt && typeof flagChanges.fogResetAt === "object") {
        this.fogManager.onSceneFogResetChanged(scene, flagChanges.fogResetAt);
      }
      if (flagChanges.fogBrush && typeof flagChanges.fogBrush === "object") {
        this.fogManager.onSceneFogBrushChanged(scene, flagChanges.fogBrush);
      }
    }

    if ("virtualizeTokens" in flagChanges) {
      this.tokenStreamer.mount(scene);
      this.tokenStreamer.scheduleSync(this.getViewportWorldRect(0.28), true);
    }
  }

  // ===== Public Level, POI & Virtual Tile API =====

  getEffectivePOIs(scene = canvas.scene) {
    if (!scene) return [];
    const resolved = this.poiManager.resolvePois(scene, scene.id === canvas.scene?.id ? this.manifest : null);
    return foundry.utils.deepClone(resolved || []);
  }

  _sanitizePoisForSave(pois) {
    return (pois || []).map(p => {
      const clean = { ...p };
      delete clean._isSecondaryProvince;
      delete clean._virtualSub;
      return clean;
    });
  }

  async addPOI(poiSpec, scene = canvas.scene) {
    if (!scene) return null;
    const existing = this._sanitizePoisForSave(this.getEffectivePOIs(scene));
    const kind = poiSpec.kind === "detail" ? "detail" : (poiSpec.kind === "minor" ? "minor" : "major");
    const entry = {
      id: poiSpec.id || foundry.utils.randomID(),
      name: poiSpec.name || game.i18n.localize("BOUNDLESS.Config.PoiDefaultName"),
      subtitle: poiSpec.subtitle || "",
      x: Math.round(poiSpec.x ?? (scene.width || 100000) * 0.5),
      y: Math.round(poiSpec.y ?? (scene.height || 100000) * 0.5),
      levelId: poiSpec.levelId || null,
      targetScale: Number(poiSpec.targetScale ?? poiSpec.scale) || (kind === "major" ? 0.085 : (kind === "detail" ? 0.68 : 0.26)),
      color: poiSpec.color || "#f5c96b",
      kind,
      icon: poiSpec.icon || "",
      journalUuid: poiSpec.journalUuid || "",
      hidden: Boolean(poiSpec.hidden)
    };
    existing.push(entry);
    await scene.update({ [`flags.${MODULE_ID}.pois`]: existing });
    return entry;
  }

  async updatePOI(poiId, patch, scene = canvas.scene) {
    if (!scene || !poiId || !patch) return null;
    const existing = this._sanitizePoisForSave(this.getEffectivePOIs(scene));
    const idx = existing.findIndex(p => p.id === poiId);
    if (idx < 0) return null;
    const updated = { ...existing[idx], ...patch, id: poiId };
    delete updated._isSecondaryProvince;
    delete updated._virtualSub;
    if ("x" in patch) updated.x = Math.round(patch.x);
    if ("y" in patch) updated.y = Math.round(patch.y);
    if ("targetScale" in patch) {
      updated.targetScale = Number(patch.targetScale) || 0.45;
      delete updated.scale;
    }
    existing[idx] = updated;
    await scene.update({ [`flags.${MODULE_ID}.pois`]: existing });
    return updated;
  }

  async removePOI(poiId, scene = canvas.scene) {
    if (!scene || !poiId) return false;
    const existing = this._sanitizePoisForSave(this.getEffectivePOIs(scene)).filter(p => p.id !== poiId);
    await scene.update({ [`flags.${MODULE_ID}.pois`]: existing });
    return true;
  }

  async resetPOIs(scene = canvas.scene) {
    if (!scene) return false;
    await scene.update({ [`flags.${MODULE_ID}.-=pois`]: null });
    return true;
  }

  async flyToCharacter(userOrActorId = null, options = {}) {
    if (!this.active || !canvas?.ready) return false;
    return this.charPins.focusCharacter(userOrActorId, options);
  }

  async flyTo(target, options = {}) {
    if (!this.active || !canvas?.ready) return false;
    let poi = target;
    if (typeof target === "string") {
      const needle = target.trim().toLowerCase();
      const all = this.poiManager.resolvePois(canvas.scene, this.manifest);
      poi = all.find(p => p.id === target || p.name?.toLowerCase() === needle)
        || all.find(p => p.name?.toLowerCase().includes(needle));
    }
    if (!poi) return false;
    return this.poiManager.flyTo(poi, options);
  }

  getVisibleLevels() {
    return this.visibleLevelLayers.map(l => ({
      id: l.level.id,
      name: l.level.name,
      isView: l.level.isView,
      isUpper: l.isUpper,
      elevation: { ...l.level.elevation },
      hasPyramid: l.hasPyramid,
      tilesCount: l.spec?.tiles?.length || 0,
      overlaysCount: l.spec?.overlays?.length || 0
    }));
  }

  async configureLevel(levelId, config = {}) {
    const level = canvas.scene?.levels?.get(levelId);
    if (!level) throw new Error(`Level "${levelId}" not found on active scene.`);
    await level.update({ [`flags.${MODULE_ID}`]: config });
    await this.mount(canvas.scene);
  }

  /**
   * Collect and serialize native Foundry TileDocuments, WallDocuments, AmbientLightDocuments (non-negative),
   * and AmbientSoundDocuments belonging to a Level into Boundless spatial sectors.
   */
  collectLevelSpatialData(scene, level, { simGrid = null } = {}) {
    const levelId = level.id;
    const dims = scene.getDimensions?.();
    const worldPx = Math.max(dims?.width || scene.width || 100000, dims?.height || scene.height || 100000);
    const resolvedSimGrid = simGrid || Math.max(4, Math.min(40, Math.ceil(worldPx / 2500)));
    const simSectorPx = Math.ceil(worldPx / resolvedSimGrid);
    const sectors = {};
    const ensureSec = (sx, sy) => {
      const k = `${Math.max(0, Math.min(resolvedSimGrid - 1, sx))}_${Math.max(0, Math.min(resolvedSimGrid - 1, sy))}`;
      return (sectors[k] ??= { w: [], d: [], l: [], t: [], o: [], s: [] });
    };

    const tiles = [];
    const tileIdsToDelete = [];
    for (const t of scene.tiles) {
      if (t.levels?.size && !t.levels.has(levelId)) continue;
      if (!t.texture?.src) continue;
      const tid = tiles.length;
      const occModes = Array.from(t.occlusion?.modes || []);
      const rot = t.rotation || 0;
      const ax = Number.isFinite(t.texture.anchorX) ? t.texture.anchorX : 0.5;
      const ay = Number.isFinite(t.texture.anchorY) ? t.texture.anchorY : 0.5;
      const tileSpec = {
        src: t.texture.src,
        x: t.x, y: t.y, w: t.width, h: t.height,
        anchorX: ax,
        anchorY: ay,
        rot,
        elevation: t.elevation,
        sort: t.sort || 0,
        alpha: t.alpha ?? 1,
        hidden: Boolean(t.hidden),
        tint: t.texture.tint ? foundry.utils.Color.from(t.texture.tint).css : null,
        alphaThreshold: t.texture.alphaThreshold ?? 0.75,
        occlusionMode: occModes.length ? occModes : CONST.OCCLUSION_MODES.NONE,
        occludedAlpha: t.occlusion?.alpha ?? 0.2,
        restrictsLight: Boolean(t.restrictions?.light),
        restrictsWeather: Boolean(t.restrictions?.weather)
      };
      if (Number.isFinite(t.texture.scaleX) && t.texture.scaleX !== 1) tileSpec.scaleX = t.texture.scaleX;
      if (Number.isFinite(t.texture.scaleY) && t.texture.scaleY !== 1) tileSpec.scaleY = t.texture.scaleY;
      if (t.texture.fit && t.texture.fit !== "fill") tileSpec.fit = t.texture.fit;
      tiles.push(tileSpec);
      tileIdsToDelete.push(t.id);

      // Compute rotated AABB around Foundry v14 Tile pivot (t.x, t.y) with anchor (ax, ay)
      const rad = (rot * Math.PI) / 180;
      const cos = Math.cos(rad);
      const sin = Math.sin(rad);
      const dx = (0.5 - ax) * t.width;
      const dy = (0.5 - ay) * t.height;
      const cx = t.x + (cos * dx - sin * dy);
      const cy = t.y + (sin * dx + cos * dy);
      const rx = (t.width * Math.abs(cos) + t.height * Math.abs(sin)) * 0.5;
      const ry = (t.width * Math.abs(sin) + t.height * Math.abs(cos)) * 0.5;
      const minX = cx - rx, maxX = cx + rx, minY = cy - ry, maxY = cy + ry;
      const sx0 = Math.max(0, Math.min(resolvedSimGrid - 1, Math.floor(minX / simSectorPx)));
      const sy0 = Math.max(0, Math.min(resolvedSimGrid - 1, Math.floor(minY / simSectorPx)));
      const sx1 = Math.max(0, Math.min(resolvedSimGrid - 1, Math.floor(maxX / simSectorPx)));
      const sy1 = Math.max(0, Math.min(resolvedSimGrid - 1, Math.floor(maxY / simSectorPx)));
      for (let sy = sy0; sy <= sy1; sy++) {
        for (let sx = sx0; sx <= sx1; sx++) {
          ensureSec(sx, sy).t.push(tid);
        }
      }
    }

    const wallIdsToDelete = [];
    for (const w of scene.walls) {
      if (w.levels?.size && !w.levels.has(levelId)) continue;
      const [x1, y1, x2, y2] = w.c;
      const cx = (x1 + x2) * 0.5, cy = (y1 + y2) * 0.5;
      const sec = ensureSec(Math.floor(cx / simSectorPx), Math.floor(cy / simSectorPx));
      if (w.door) {
        const extra = {};
        if (w.move !== undefined && w.move !== 20) extra.move = w.move;
        if (w.sight !== undefined && w.sight !== 20) extra.sight = w.sight;
        if (w.light !== undefined && w.light !== 20) extra.light = w.light;
        if (w.sound !== undefined && w.sound !== 20) extra.sound = w.sound;
        if (w.dir) extra.dir = w.dir;
        if (w.doorSound) extra.doorSound = w.doorSound;
        if (w.animation?.type && w.animation?.texture) {
          extra.animation = {
            type: w.animation.type,
            texture: w.animation.texture,
            flip: Boolean(w.animation.flip),
            double: Boolean(w.animation.double),
            direction: w.animation.direction ?? 1,
            duration: w.animation.duration ?? 750,
            strength: w.animation.strength ?? 1
          };
        }
        if (w.threshold && (w.threshold.light || w.threshold.sight || w.threshold.sound)) {
          extra.threshold = {
            light: w.threshold.light ?? null,
            sight: w.threshold.sight ?? null,
            sound: w.threshold.sound ?? null,
            attenuation: Boolean(w.threshold.attenuation)
          };
        }
        sec.d.push(Object.keys(extra).length
          ? [x1, y1, x2, y2, w.door, w.ds || 0, extra]
          : [x1, y1, x2, y2, w.door, w.ds || 0]);
      } else {
        const row = [x1, y1, x2, y2, w.move, w.sight, w.light, w.sound, w.dir || 0];
        if (w.threshold && (w.threshold.light || w.threshold.sight || w.threshold.sound)) {
          row.push({
            threshold: {
              light: w.threshold.light ?? null,
              sight: w.threshold.sight ?? null,
              sound: w.threshold.sound ?? null,
              attenuation: Boolean(w.threshold.attenuation)
            }
          });
        }
        sec.w.push(row);
      }
      wallIdsToDelete.push(w.id);
    }

    const lightIdsToDelete = [];
    for (const l of scene.lights) {
      if (l.levels?.size && !l.levels.has(levelId)) continue;
      // Keep negative (darkness) and vision-providing sources as native AmbientLightDocuments
      if (l.config?.negative || l.vision) continue;
      const sec = ensureSec(Math.floor(l.x / simSectorPx), Math.floor(l.y / simSectorPx));
      const colorCss = l.config?.color ? foundry.utils.Color.from(l.config.color).css : null;
      const extra = {};
      if (l.hidden) extra.hidden = true;
      if (l.walls === false) extra.walls = false;
      if ((l.config?.angle ?? 360) < 360) {
        extra.angle = l.config.angle;
        if (l.rotation) extra.rotation = l.rotation;
      }
      if ((l.config?.darkness?.min ?? 0) > 0) extra.darkMin = l.config.darkness.min;
      if ((l.config?.darkness?.max ?? 1) < 1) extra.darkMax = l.config.darkness.max;
      const tuple = [
        l.x, l.y,
        l.config?.dim || 0,
        l.config?.bright || 0,
        colorCss,
        l.config?.alpha ?? 0.5,
        l.config?.animation?.type || "",
        l.elevation
      ];
      if (Object.keys(extra).length) tuple.push(extra);
      sec.l.push(tuple);
      lightIdsToDelete.push(l.id);
    }

    const soundIdsToDelete = [];
    for (const snd of (scene.sounds || [])) {
      if (snd.levels?.size && !snd.levels.has(levelId)) continue;
      if (!snd.path) continue;
      const sec = ensureSec(Math.floor(snd.x / simSectorPx), Math.floor(snd.y / simSectorPx));
      const row = [
        snd.x, snd.y,
        snd.radius || 20,
        snd.path,
        snd.volume ?? 0.6,
        snd.walls !== false,
        snd.easing !== false,
        snd.darkness?.min ?? 0,
        snd.darkness?.max ?? 1,
        snd.elevation
      ];
      if (snd.hidden) row.push({ hidden: true });
      sec.s.push(row);
      soundIdsToDelete.push(snd.id);
    }

    return {
      worldPx,
      simGrid: resolvedSimGrid,
      simSectorPx,
      tiles,
      sectors,
      tileIdsToDelete,
      wallIdsToDelete,
      lightIdsToDelete,
      soundIdsToDelete
    };
  }

  /**
   * Bake an existing Foundry Scene (background pyramid + walls/doors/lights/sounds/tiles) into WebP files
   * + `pyramid_manifest.json` in the world data folder directly from the browser.
   */
  bakeSceneToPyramid(scene = canvas.scene, options = {}) {
    return bakeSceneToBoundless(this, scene, options);
  }

  /**
   * Bake native Foundry TileDocuments, WallDocuments, and AmbientLightDocuments on a Level
   * into an inline Boundless spatial sector manifest on `level.flags["boundless"]`.
   */
  async bakeNativeToLevel(levelId = canvas.level?.id, { removeOriginals = false, simGrid = null, scene = canvas.scene } = {}) {
    const targetScene = scene || canvas.scene;
    const level = targetScene?.levels?.get(levelId);
    if (!targetScene || !level) throw new Error(`Level "${levelId}" not found.`);

    const {
      worldPx, simGrid: resolvedSimGrid, simSectorPx, tiles, sectors,
      tileIdsToDelete, wallIdsToDelete, lightIdsToDelete, soundIdsToDelete
    } = this.collectLevelSpatialData(targetScene, level, { simGrid });

    const inlineManifest = { worldPx, simGrid: resolvedSimGrid, simSectorPx, tiles, sectors };
    const existingCfg = foundry.utils.deepClone(level.flags?.[MODULE_ID] || {});
    await level.update({ [`flags.${MODULE_ID}`]: { ...existingCfg, enabled: true, inlineManifest } });

    // Clear stale index-keyed edits & doorStates for this re-baked level on targetScene
    const prevSceneFlags = targetScene.flags?.[MODULE_ID] || {};
    const stalePatch = {};
    for (const mapKey of ["wallEdits", "lightEdits", "soundEdits", "tileEdits"]) {
      if (prevSceneFlags[mapKey] && typeof prevSceneFlags[mapKey] === "object" && (levelId in prevSceneFlags[mapKey])) {
        stalePatch[`flags.${MODULE_ID}.${mapKey}.-=${levelId}`] = null;
      }
    }
    if (prevSceneFlags.doorStates && typeof prevSceneFlags.doorStates === "object") {
      const prefix = `${levelId}:`;
      for (const dKey of Object.keys(prevSceneFlags.doorStates)) {
        if (dKey.startsWith(prefix)) stalePatch[`flags.${MODULE_ID}.doorStates.-=${dKey}`] = null;
      }
    }
    if (Object.keys(stalePatch).length) {
      await targetScene.update(stalePatch);
    }

    if (removeOriginals) {
      const hasMultipleLevels = (targetScene.levels?.size || 0) > 1;
      const otherLevelIds = hasMultipleLevels
        ? Array.from(targetScene.levels || []).map(l => l.id).filter(lid => lid !== levelId)
        : [];
      const pruneOrDelete = async (docName, rawIds) => {
        const ids = Array.from(new Set(rawIds));
        if (!ids.length) return;
        if (!hasMultipleLevels) {
          await targetScene.deleteEmbeddedDocuments(docName, ids);
          return;
        }
        const collection = targetScene.getEmbeddedCollection?.(docName);
        const toDelete = [];
        const toUpdate = [];
        for (const id of ids) {
          const doc = collection?.get?.(id);
          if (!doc) continue;
          const docLevels = doc.levels ? Array.from(doc.levels) : [];
          if (!docLevels.length) {
            if (otherLevelIds.length === 0) toDelete.push(id);
            else toUpdate.push({ _id: id, levels: otherLevelIds });
            continue;
          }
          const remaining = docLevels.filter(lid => lid !== levelId);
          if (remaining.length === 0) toDelete.push(id);
          else if (remaining.length < docLevels.length) toUpdate.push({ _id: id, levels: remaining });
        }
        if (toUpdate.length) await targetScene.updateEmbeddedDocuments(docName, toUpdate);
        if (toDelete.length) await targetScene.deleteEmbeddedDocuments(docName, toDelete);
      };
      await pruneOrDelete("Tile", tileIdsToDelete);
      await pruneOrDelete("Wall", wallIdsToDelete);
      await pruneOrDelete("AmbientLight", lightIdsToDelete);
      await pruneOrDelete("AmbientSound", soundIdsToDelete);
    }

    if (canvas.scene?.id === targetScene.id) {
      await this.mount(targetScene);
    }
    return {
      levelId,
      tiles: tiles.length,
      walls: wallIdsToDelete.length,
      lights: lightIdsToDelete.length,
      sounds: soundIdsToDelete.length
    };
  }

  _isPointInsideVirtualTile(px, py, tSpec, pad = 0) {
    const w = tSpec?.w || 0;
    const h = tSpec?.h || 0;
    if (w <= 0 || h <= 0) return false;
    // Anchor pivot matches syncVirtualTiles(): if anchorX is omitted, x/y is top-left and pivot is (x + w/2, y + h/2)
    const ax = tSpec.anchorX !== undefined ? tSpec.anchorX : 0.5;
    const ay = tSpec.anchorY !== undefined ? tSpec.anchorY : 0.5;
    const pivX = tSpec.anchorX === undefined ? (tSpec.x + w * 0.5) : tSpec.x;
    const pivY = tSpec.anchorY === undefined ? (tSpec.y + h * 0.5) : tSpec.y;
    const dx = px - pivX;
    const dy = py - pivY;
    const rot = tSpec.rot || 0;
    let lx = dx;
    let ly = dy;
    if (rot) {
      const rad = (-rot * Math.PI) / 180;
      const c = Math.cos(rad);
      const s = Math.sin(rad);
      lx = dx * c - dy * s;
      ly = dx * s + dy * c;
    }
    const minLx = -ax * w - pad;
    const maxLx = (1 - ax) * w + pad;
    const minLy = -ay * h - pad;
    const maxLy = (1 - ay) * h + pad;
    return lx >= minLx && lx <= maxLx && ly >= minLy && ly <= maxLy;
  }

  /**
   * Check whether a world point at elevation `tokElev` sits beneath a baked pyramid roof
   * (or unloaded virtual tile with `minZ > lastTargetZ`) when no native roofMesh is currently covering it.
   */
  isPointUnderBakedRoof(lid, tx, ty, tokElev = 0) {
    const layer = this.levelLayers.get(lid);
    if (!layer?.spec) return false;
    const { simGrid, simSectorPx, spec, level } = layer;
    const topElev = getLevelRoofElevation(level);
    const sx = Math.max(0, Math.min(simGrid - 1, Math.floor(tx / simSectorPx)));
    const sy = Math.max(0, Math.min(simGrid - 1, Math.floor(ty / simSectorPx)));

    // 1. Check baked building roofs across 3x3 neighbor sectors (buildings like taverns can straddle sector borders)
    if (tokElev < topElev && spec.overlays && spec.sectors) {
      const viewedBottom = getLevelBottomElevation(canvas.level);
      const hideRoofsForUpperView = !level.isView && viewedBottom >= topElev;
      if (!hideRoofsForUpperView) {
        for (let dy = -1; dy <= 1; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            const oList = spec.sectors[`${sx + dx}_${sy + dy}`]?.o;
            if (!oList?.length) continue;
            for (const oid of oList) {
              const ovSpec = spec.overlays[oid];
              if (!isPointUnderRoofSpec(tx, ty, ovSpec)) continue;
              const mountedRoof = this.activeOverlays.get(`${lid}::${oid}`)?.roofMesh;
              if (!mountedRoof || !mountedRoof.visible || mountedRoof.unoccludedAlpha < 0.9) {
                return true;
              }
            }
          }
        }
      }
    }

    // 2. Check zoomed-out virtual tiles with minZ > current targetZ that sit above this point (including sectorless inline lists & dragged tileEdits)
    if (spec.tiles?.length) {
      const candidateTids = new Set();
      if (spec.sectors) {
        for (let dy = -1; dy <= 1; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            const tList = spec.sectors[`${sx + dx}_${sy + dy}`]?.t;
            if (tList?.length) for (const tid of tList) candidateTids.add(tid);
          }
        }
        const lvlEdits = this.tileEdits.get(lid);
        if (lvlEdits?.size) {
          for (const [tKey, ov] of lvlEdits) {
            if (!ov || !tKey.startsWith("t:")) continue;
            const tid = Number(tKey.slice(2));
            if (Number.isInteger(tid) && spec.tiles[tid]) candidateTids.add(tid);
          }
        }
      } else {
        for (let tid = 0; tid < spec.tiles.length; tid++) candidateTids.add(tid);
      }
      for (const tid of candidateTids) {
        const tSpec = this.resolveVirtualTile(lid, tid, spec.tiles[tid], level);
        if (!tSpec || tSpec.hidden || (tSpec.alpha ?? 1) < 0.35 || (tSpec.elevation ?? 0) <= tokElev) continue;
        if (tSpec.minZ !== undefined && layer.lastTargetZ < tSpec.minZ) {
          if (this._isPointInsideVirtualTile(tx, ty, tSpec, 0)) {
            return true;
          }
        }
      }
    }

    return false;
  }

  /**
   * Resolve the highest solid Boundless surface (building roof overlay or virtual tile)
   * supporting a token at `(x, y)` with elevation `elev`. Used by Showstopper's
   * elevation/perspective/falling system so tokens standing on Boundless roofs or
   * virtual platforms rest solidly instead of hovering or falling to `0 ft`.
   */
  getSupportingSurfaceAt(x, y, elev = 0, levelId = null, rCore = 20) {
    if (!this.active || !Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(elev)) return null;
    const lid = levelId || canvas?.level?.id || null;
    const layers = lid && this.levelLayers.has(lid)
      ? [this.levelLayers.get(lid)]
      : Array.from(this.levelLayers.values());
    if (!layers.length) return null;

    let best = null;
    let bestElev = -Infinity;
    const radius = Math.max(4, Number(rCore) || 20);

    for (const layer of layers) {
      if (!layer?.spec) continue;
      const curLid = layer.level?.id;
      const { simGrid, simSectorPx, spec, level } = layer;
      const topElev = getLevelRoofElevation(level);
      const sx = Math.max(0, Math.min(simGrid - 1, Math.floor(x / simSectorPx)));
      const sy = Math.max(0, Math.min(simGrid - 1, Math.floor(y / simSectorPx)));

      // 1) Baked building roofs (`spec.overlays` -> `roofMesh` at `topElev`)
      if (topElev <= elev + 0.05 && topElev > bestElev + 0.001 && spec.overlays && spec.sectors) {
        let hitRoofId = null;
        for (let dy = -1; dy <= 1 && !hitRoofId; dy++) {
          for (let dx = -1; dx <= 1 && !hitRoofId; dx++) {
            const oList = spec.sectors[`${sx + dx}_${sy + dy}`]?.o;
            if (!oList?.length) continue;
            for (const oid of oList) {
              const ovSpec = spec.overlays[oid];
              if (!ovSpec?.roof || ovSpec.walls?.includes("anchor_")) continue;
              const halfMax = Math.max(ovSpec.w || 0, ovSpec.h || 0) * 0.72 + radius;
              if (Math.abs(x - ovSpec.cx) > halfMax || Math.abs(y - ovSpec.cy) > halfMax) continue;

              const fullId = `${curLid}::${oid}`;
              const mountedRoof = this.activeOverlays.get(fullId)?.roofMesh;
              if (mountedRoof && !mountedRoof.destroyed && mountedRoof.visible !== false) {
                let hitWeight = 0;
                for (let k = 0; k < SUPPORT_SOLE_KERNEL.length; k++) {
                  const [kx, ky, w] = SUPPORT_SOLE_KERNEL[k];
                  if (meshContainsPointPixelSafe(mountedRoof, x + kx * radius, y + ky * radius, 0.25)) {
                    hitWeight += w;
                    if (hitWeight >= 5) break;
                  }
                }
                if (hitWeight >= 5) {
                  hitRoofId = fullId;
                  break;
                }
              } else if (isPointUnderRoofSpec(x, y, ovSpec)) {
                hitRoofId = fullId;
                break;
              }
            }
          }
        }
        if (hitRoofId) {
          bestElev = topElev;
          best = {
            elevation: topElev,
            level: level || null,
            sourceType: "tile",
            sourceId: hitRoofId,
            isLargePlatform: true
          };
        }
      }

      // 2) Virtual tiles (`spec.tiles` indexed per sector `sectors[sk].t`, sectorless lists, and dragged `tileEdits`)
      if (spec.tiles?.length) {
        const candidateTids = new Set();
        if (spec.sectors) {
          for (let dy = -1; dy <= 1; dy++) {
            for (let dx = -1; dx <= 1; dx++) {
              const tList = spec.sectors[`${sx + dx}_${sy + dy}`]?.t;
              if (tList?.length) for (const tid of tList) candidateTids.add(tid);
            }
          }
          const lvlEdits = this.tileEdits.get(curLid);
          if (lvlEdits?.size) {
            for (const [tKey, ov] of lvlEdits) {
              if (!ov || !tKey.startsWith("t:")) continue;
              const tid = Number(tKey.slice(2));
              if (Number.isInteger(tid) && spec.tiles[tid]) candidateTids.add(tid);
            }
          }
        } else {
          for (let tid = 0; tid < spec.tiles.length; tid++) candidateTids.add(tid);
        }
        for (const tid of candidateTids) {
          const tSpec = this.resolveVirtualTile(curLid, tid, spec.tiles[tid], level);
          if (!tSpec || tSpec.hidden) continue;
          if (tSpec.surfaceMode === "ignore" || tSpec.walkable === false) continue;
          const alpha = Number(tSpec.alpha ?? 1);
          if (tSpec.surfaceMode !== "solid" && alpha < 0.35) continue;

          const tElev = Number.isFinite(Number(tSpec.elevation)) ? Number(tSpec.elevation) : getLevelBaseElevation(level);
          if (tElev > elev + 0.05 || tElev <= bestElev + 0.001) continue;

          if (!this._isPointInsideVirtualTile(x, y, tSpec, radius)) continue;

          const fullId = `${curLid}::${tid}`;
          const mountedMesh = this.activeVirtualTiles.get(fullId)?.mesh;
          let supported = false;
          if (mountedMesh && !mountedMesh.destroyed && mountedMesh.visible !== false) {
            const alphaThr = tSpec.surfaceMode === "solid" ? 0.05 : Math.min(0.85, 0.25 / Math.max(0.35, alpha));
            let hitWeight = 0;
            for (let k = 0; k < SUPPORT_SOLE_KERNEL.length; k++) {
              const [kx, ky, w] = SUPPORT_SOLE_KERNEL[k];
              if (meshContainsPointPixelSafe(mountedMesh, x + kx * radius, y + ky * radius, alphaThr)) {
                hitWeight += w;
                if (hitWeight >= 5) break;
              }
            }
            supported = hitWeight >= 5;
          } else {
            supported = this._isPointInsideVirtualTile(x, y, tSpec, 0);
          }

          if (supported) {
            bestElev = tElev;
            best = {
              elevation: tElev,
              level: level || null,
              sourceType: "tile",
              sourceId: fullId,
              isLargePlatform: true
            };
          }
        }
      }
    }

    return best;
  }

  syncRoofTokenOcclusion() {
    if (!this.active || !canvas?.tokens?.placeables) return;

    const nextHidden = new Set();
    for (const tok of canvas.tokens.placeables) {
      if (!tok || tok.destroyed || tok.isPreview || tok.controlled) continue;
      const doc = tok.document;
      const lid = doc?.level || canvas.level?.id;
      const rawElev = Number(doc?.elevation ?? 0);
      const visElev = Number.isFinite(Number(tok._ssJumpState?.elevation))
        ? Number(tok._ssJumpState.elevation)
        : (Number.isFinite(Number(tok._ssVisualElevation)) ? Number(tok._ssVisualElevation) : rawElev);
      const tokElev = Math.max(rawElev, visElev);
      if (this.isPointUnderBakedRoof(lid, tok.center.x, tok.center.y, tokElev)) {
        nextHidden.add(tok);
        if (tok.renderable) tok.renderable = false;
        if (tok.mesh && !tok.mesh.destroyed && tok.mesh.renderable) tok.mesh.renderable = false;
        if (tok._ssJumpShadow && !tok._ssJumpShadow.destroyed && tok._ssJumpShadow.renderable) {
          tok._ssJumpShadow.renderable = false;
        }
      }
    }

    // Restore tokens that are no longer hidden by baked roofs
    let restoredAny = false;
    for (const tok of this._roofHiddenTokens) {
      if (nextHidden.has(tok)) continue;
      if (tok && !tok.destroyed) {
        tok.renderable = true;
        if (tok.mesh && !tok.mesh.destroyed) tok.mesh.renderable = true;
        if (tok._ssJumpShadow && !tok._ssJumpShadow.destroyed) tok._ssJumpShadow.renderable = true;
        restoredAny = true;
      }
    }
    this._roofHiddenTokens = nextHidden;
    this.tokenStreamer.onVisibilityChanged();
    if (restoredAny && this.tokenStreamer.enabled) {
      this.tokenStreamer.scheduleSync(null, false);
    }
  }

  needsOcclusionRefreshNear(doc) {
    if (!this.active || !doc) return false;
    if (this.visibleLevelLayers.length > 1) return true;
    if (!this.activeOverlays.size && !this.activeVirtualTiles.size) return false;
    const tx = (doc.x ?? 0) + ((doc.width ?? 1) * (canvas.dimensions?.size || 100) * 0.5);
    const ty = (doc.y ?? 0) + ((doc.height ?? 1) * (canvas.dimensions?.size || 100) * 0.5);
    for (const ov of this.activeOverlays.values()) {
      if (!ov.roofMesh?.visible) continue;
      const rx = Math.max(ov.roofMesh.width || 0, ov.roofMesh.height || 0) * 0.65 + 250;
      if (Math.abs(tx - ov.roofMesh.x) <= rx && Math.abs(ty - ov.roofMesh.y) <= rx) return true;
    }
    for (const vt of this.activeVirtualTiles.values()) {
      const m = vt.mesh;
      if (!m?.visible || !m.occlusionMode) continue;
      const rx = Math.max(m.width || 0, m.height || 0) * 0.65 + 250;
      if (Math.abs(tx - m.x) <= rx && Math.abs(ty - m.y) <= rx) return true;
    }
    return false;
  }

  onChunkLoaded(layer, chunkKey, chunkData) {
    if (!this.active || !layer) return;
    // Queue non-blocking time-sliced GPU light baking for this chunk (<= 6ms/frame)
    this.lightBatch.queueChunkBake(layer, chunkKey, chunkData);

    // Reconcile persisted door states that belong to sectors in this newly loaded chunk
    this._reconcileChunkDoorStates(layer, chunkData);

    // Bake pixel-accurate roof mask for chunked worlds (repeat=true only when chunk spans full superGrid region)
    if (chunkData?.overlays && !layer.spec?.roofMaskUrl) {
      const isSuperGrid = Boolean(layer.spec?.superGrid);
      const regionPx = layer.spec?.superGrid?.regionPx || 100000;
      const b = chunkData.bounds || { x: 0, y: 0, w: regionPx, h: regionPx };
      const isFullSuperGridProvince = isSuperGrid && (b.w === regionPx && b.h === regionPx);
      if (isFullSuperGridProvince) {
        if (!this.lightBatch.bakedRoofMask && !this._roofMaskBaking) {
          const ovList = Array.isArray(chunkData.overlays) ? chunkData.overlays : Object.values(chunkData.overlays);
          this._bakeRoofMaskFromList(ovList, {
            originX: b.x || 0,
            originY: b.y || 0,
            regionW: b.w || regionPx,
            regionH: b.h || regionPx,
            repeat: true
          });
        }
      } else {
        const allOvs = Object.values(layer.spec.overlays || {});
        let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
        for (const ov of allOvs) {
          if (!ov?.roof || ov.walls?.includes("anchor_")) continue;
          const r = Math.hypot(ov.w || 0, ov.h || 0) * 0.5;
          if (ov.cx - r < minX) minX = ov.cx - r;
          if (ov.cy - r < minY) minY = ov.cy - r;
          if (ov.cx + r > maxX) maxX = ov.cx + r;
          if (ov.cy + r > maxY) maxY = ov.cy + r;
        }
        if (minX < maxX && minY < maxY) {
          this._bakeRoofMaskFromList(allOvs, {
            originX: minX,
            originY: minY,
            regionW: maxX - minX,
            regionH: maxY - minY,
            repeat: false
          });
        }
      }
    }

    // Invalidate spatial caches so roofs, walls, doors, audio, editors, and sim-bubbles pick up newly loaded sectors immediately
    layer.lastOverlayKey = "";
    layer.lastTileKey = "";
    this.lastSimKey = null;
    this.lastDynLightKey = null;
    this.audioStreamer.lastKey = "";
    this._roofTokenOccDirty = true;
    this.updatePyramid();
    this.updateSimAndLightBubbles(true);
    this.wallEditor.syncViewport(true);
    this.layerEditors.syncViewport(true);
  }

  onChunkUnloaded(layer, chunkKey, { deferRefresh = false } = {}) {
    if (!layer) return;
    this.lightBatch.detachChunk(layer.level.id, chunkKey);
    // Drop openDoors entries whose sectors were unloaded with this chunk
    const lid = layer.level.id;
    const sectors = layer.spec?.sectors;
    for (const [dKey, door] of this.openDoors) {
      if (door.levelId === lid && !sectors?.[`${door.sx}_${door.sy}`]) {
        this.openDoors.delete(dKey);
      }
    }
    layer.lastOverlayKey = "";
    layer.lastTileKey = "";
    this.lastSimKey = null;
    this.lastDynLightKey = null;
    this.audioStreamer.lastKey = "";
    this._roofTokenOccDirty = true;
    if (this.active) {
      this.updateSimAndLightBubbles(true);
      this.wallEditor.syncViewport(true);
      this.layerEditors.syncViewport(true);
      if (!deferRefresh && !this._inUpdatePyramid) {
        this.updatePyramid();
      }
    }
  }

  updateAll(force = false) {
    this.updatePyramid();
    if (force) {
      this.updateSimAndLightBubbles(true);
    }
  }

  /**
   * Create (or activate) a 6000x6000 cells (600,000 x 600,000 px) continental stress-test Scene:
   * 36 provinces, 160,668 walls, 12,888 doors, 22,860 shadowed GPU lights, 8,244 interactive buildings.
   * Usage in F12 console: `await Boundless.createStressTest6000({ tokens: 600 })`
   */
  async createStressTest6000({ name = "Континент 6000×6000 (Стресс-тест)", tokens = 600, activate = true, recreate = false } = {}) {
    if (!game?.user?.isGM) {
      ui.notifications?.warn("Только мастер может создать сцену стресс-теста.");
      return null;
    }
    const manifestUrl = `modules/${MODULE_ID}/assets/pyramid_6000/pyramid_manifest_6000.json`;
    let scene = game.scenes.find(s => s.flags?.[MODULE_ID]?.manifestUrl === manifestUrl);
    if (scene && recreate) {
      await scene.delete();
      scene = null;
    }
    if (!scene) {
      scene = await Scene.create({
        name,
        width: 600000,
        height: 600000,
        padding: 0,
        backgroundColor: "#0c1118",
        grid: {
          type: CONST.GRID_TYPES.SQUARE,
          size: 100,
          distance: 5,
          units: "ft",
          alpha: 0.15
        },
        tokenVision: true,
        fog: { mode: CONST.FOG_EXPLORATION_MODES?.SHARED ?? 2 },
        environment: { globalLight: { enabled: true } },
        initial: { x: 300000, y: 300000, scale: 0.002 },
        flags: {
          [MODULE_ID]: {
            enabled: true,
            manifestUrl,
            showPois: true,
            chunkedFog: true,
            virtualizeTokens: true
          }
        }
      });
    }

    if (tokens > 0 && scene && scene.tokens.size === 0) {
      await this.tokenStreamer.spawnNativePopulation(tokens, { scene });
    }

    if (activate && scene) {
      await scene.view();
    }
    return scene;
  }

  spawnNativePopulation(count = 600, options = {}) {
    return this.tokenStreamer.spawnNativePopulation(count, options);
  }

  restoreLegacyVirtualTokens(scene = canvas?.scene) {
    return this.tokenStreamer.restoreLegacyVirtualTokens(scene);
  }

  /**
   * Migrate any legacy `sh-megamap` scene flags, level flags, user fog flags, and localStorage entries
   * into `boundless` (rewriting `modules/sh-megamap/` asset paths recursively) and remount active scene.
   */
  async migrateLegacyScenes() {
    const LEGACY_ID = "sh-megamap";
    const rewritePaths = (val) => {
      if (typeof val === "string") {
        return val.includes(`modules/${LEGACY_ID}/`)
          ? val.replaceAll(`modules/${LEGACY_ID}/`, `modules/${MODULE_ID}/`)
          : val;
      }
      if (Array.isArray(val)) return val.map(rewritePaths);
      if (val && typeof val === "object") {
        const out = {};
        for (const [k, v] of Object.entries(val)) out[k] = rewritePaths(v);
        return out;
      }
      return val;
    };

    // 1. Migrate client-side localStorage (camera positions & individual fog)
    try {
      const toMove = [];
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (k && k.startsWith(`${LEGACY_ID}.`)) toMove.push(k);
      }
      for (const oldKey of toMove) {
        const newKey = `${MODULE_ID}.${oldKey.slice(LEGACY_ID.length + 1)}`;
        if (localStorage.getItem(newKey) === null) {
          localStorage.setItem(newKey, localStorage.getItem(oldKey));
        }
        localStorage.removeItem(oldKey);
      }
    } catch {}

    // 2. Migrate current user's personal fog flags
    try {
      const uLegacy = game.user?.flags?.[LEGACY_ID];
      if (uLegacy) {
        const merged = foundry.utils.mergeObject(
          rewritePaths(foundry.utils.deepClone(uLegacy)),
          foundry.utils.deepClone(game.user.flags?.[MODULE_ID] || {}),
          { inplace: false }
        );
        await game.user.update({
          [`flags.${MODULE_ID}`]: merged,
          [`flags.-=${LEGACY_ID}`]: null
        });
      }
    } catch {}

    if (!game.user?.isActiveGM) return { scenes: 0, levels: 0 };

    let migratedScenes = 0;
    let migratedLevels = 0;
    let activeSceneTouched = false;

    for (const scene of game.scenes || []) {
      const legacyScene = scene.flags?.[LEGACY_ID];
      const curScene = scene.flags?.[MODULE_ID];
      const curHasOldPath = curScene && JSON.stringify(curScene).includes(`modules/${LEGACY_ID}/`);

      if (legacyScene || curHasOldPath) {
        const base = legacyScene ? rewritePaths(foundry.utils.deepClone(legacyScene)) : {};
        const cur = curScene ? rewritePaths(foundry.utils.deepClone(curScene)) : {};
        const merged = foundry.utils.mergeObject(base, cur, { inplace: false });
        const upd = { [`flags.${MODULE_ID}`]: merged };
        if (legacyScene) upd[`flags.-=${LEGACY_ID}`] = null;
        await scene.update(upd);
        migratedScenes++;
        if (canvas?.scene?.id === scene.id) activeSceneTouched = true;
      }

      // Migrate every Level on the scene (`level.flags["sh-megamap"]` or stale paths inside `inlineManifest`)
      for (const level of scene.levels || []) {
        const legacyLvl = level.flags?.[LEGACY_ID];
        const curLvl = level.flags?.[MODULE_ID];
        const lvlHasOldPath = curLvl && JSON.stringify(curLvl).includes(`modules/${LEGACY_ID}/`);
        if (!legacyLvl && !lvlHasOldPath) continue;

        const base = legacyLvl ? rewritePaths(foundry.utils.deepClone(legacyLvl)) : {};
        const cur = curLvl ? rewritePaths(foundry.utils.deepClone(curLvl)) : {};
        const merged = foundry.utils.mergeObject(base, cur, { inplace: false });
        const upd = { [`flags.${MODULE_ID}`]: merged };
        if (legacyLvl) upd[`flags.-=${LEGACY_ID}`] = null;
        await level.update(upd);
        migratedLevels++;
        if (canvas?.scene?.id === scene.id) activeSceneTouched = true;
      }
    }

    if (activeSceneTouched && canvas?.ready && canvas.scene) {
      await this.mount(canvas.scene);
    }

    if (migratedScenes > 0 || migratedLevels > 0) {
      console.log(`${MODULE_ID} | Migrated legacy sh-megamap data: ${migratedScenes} scene(s), ${migratedLevels} level(s).`);
    }
    return { scenes: migratedScenes, levels: migratedLevels };
  }

  unmount() {
    if (this.active) this._saveCameraNow();
    this.active = false;
    this._mounting = false;
    this._mountGen++;
    this._prewarmGen++;
    this.manifest = null;
    if (this._camSaveTimer !== null) {
      clearTimeout(this._camSaveTimer);
      this._camSaveTimer = null;
    }
    if (this._beforeUnloadFn) {
      window.removeEventListener("beforeunload", this._beforeUnloadFn);
      this._beforeUnloadFn = null;
    }
    this._restoringCamera = false;
    this._zoomSyncQueued = false;
    this.isCameraFlying = false;
    this._lastPanMs = 0;
    this._pruneNeeded = false;
    this._lastOccRefreshMs = 0;
    this._showstopperDirty = false;
    this._lastShowstopperMs = 0;
    this._vtIdleCleanupNeeded = false;

    this.poiManager.unmount();
    this.charPins.unmount();
    this.fogManager.unmount();
    // Unmount in reverse patch order so scene.updateEmbeddedDocuments / deleteEmbeddedDocuments restore cleanly
    this.layerEditors.unmount();
    this.wallEditor.unmount();
    this.tokenStreamer.unmount();
    this.chunkStreamer.unmount();
    this.audioStreamer.unmount();
    this.wallEdits.clear();
    this.lightEdits.clear();
    this.soundEdits.clear();
    this.tileEdits.clear();
    this._lightRebuildScheduled = false;

    if (this.tickerFn && canvas?.app?.ticker) {
      canvas.app.ticker.remove(this.tickerFn);
    }
    this.tickerFn = null;

    for (const [filter, origDesc] of this._patchedFilters) {
      if (origDesc) {
        Object.defineProperty(filter, "resolution", origDesc);
      } else {
        delete filter.resolution;
      }
    }
    this._patchedFilters.clear();

    if (this._origSmaaEnabled !== null) {
      const smaa = canvas.stage?.filters?.find(f => f?.constructor?.name === "SMAAFilter");
      if (smaa) smaa.enabled = this._origSmaaEnabled;
      this._origSmaaEnabled = null;
    }

    if (this._origIfVoidEnabled !== null) {
      const ifVoid = canvas.interface?.filters?.find(f => f?.constructor?.name === "VoidFilter");
      if (ifVoid) ifVoid.enabled = this._origIfVoidEnabled;
      this._origIfVoidEnabled = null;
    }

    if (canvas?.effects?.darkness) canvas.effects.darkness.visible = true;
    if (canvas?.effects?.background?.lighting) canvas.effects.background.lighting.visible = true;
    if (canvas?.effects?.coloration) canvas.effects.coloration.visible = true;

    if (this._origDepthAutoRender !== null) {
      if (canvas?.masks?.depth) {
        canvas.masks.depth.autoRender = this._origDepthAutoRender;
        canvas.masks.depth.renderDirty = true;
      }
      this._origDepthAutoRender = null;
    }

    if (this._origTextureGcMode !== null) {
      if (canvas?.app?.renderer?.textureGC) {
        canvas.app.renderer.textureGC.mode = this._origTextureGcMode;
      }
      this._origTextureGcMode = null;
    }

    for (const [, bgMesh] of this._hiddenNativeLevelBg) {
      if (bgMesh && !bgMesh.destroyed) bgMesh.visible = true;
    }
    this._hiddenNativeLevelBg.clear();

    this.pendingTileMounts = [];
    this.pendingOverlayMounts = [];
    this._pendingOverlayKeys.clear();
    this.pendingVirtualTileMounts = [];
    this._pendingVirtualTileKeys.clear();
    this._roofTokenOccDirty = false;
    this._waitingForRoofsBeforeIndoor = false;
    this._roofMaskBaking = false;
    this._roofMaskGen++;
    this._depthDirty = false;
    this._depthDeferred = false;
    this._depthElevSyncNeeded = false;

    for (const [, data] of this.simSectors) {
      if (data.level?.edges) {
        for (const eid of data.edgeIds) data.level.edges.delete(eid);
      }
    }
    this.simSectors.clear();
    this.doorStates.clear();
    this.openDoors.clear();

    for (const [, ls] of this.dynamicLights) ls.destroy();
    this.dynamicLights.clear();
    this.lightBatch.destroy();
    this.lightBatch.disposeBakedRoofMask();
    this.lightBatch.hideIndoorLights = false;
    this._updatingBubbles = false;

    const destroyMeshSafe = (m) => {
      if (!m) return;
      m.debounceSetOcclusion?.cancel?.();
      try { m._ssDofBlurFilter?.destroy?.(); } catch {}
      m._ssDofBlurFilter = null;
      m.parent?.removeChild(m);
      if (!m.destroyed) m.destroy();
    };

    for (const [, e] of this.tilesByKey) {
      destroyMeshSafe(e.mesh);
    }
    this.tilesByKey.clear();

    for (const tok of this._roofHiddenTokens) {
      if (tok && !tok.destroyed) {
        tok.renderable = true;
        if (tok.mesh && !tok.mesh.destroyed) tok.mesh.renderable = true;
        if (tok._ssJumpShadow && !tok._ssJumpShadow.destroyed) tok._ssJumpShadow.renderable = true;
      }
    }
    this._roofHiddenTokens.clear();
    this._lastRoofOccSig = "";
    this._revealTileKeys.clear();

    for (const [, ov] of this.activeOverlays) {
      destroyMeshSafe(ov.wallsMesh);
      destroyMeshSafe(ov.roofMesh);
    }
    this.activeOverlays.clear();
    this.overlayPending.clear();

    for (const [, vt] of this.activeVirtualTiles) {
      destroyMeshSafe(vt.mesh);
    }
    this.activeVirtualTiles.clear();
    this.virtualTilePending.clear();

    for (const m of this.meshPool) destroyMeshSafe(m);
    this.meshPool = [];

    this.levelLayers.clear();
    this.visibleLevelLayers = [];
    this.texMgr.clear(true);
    this.lastSimKey = "";
    this.lastDynLightKey = "";
    this.lastTargetZ = -1;
    this._tilesDirty = false;
    this._lastOverlayAlpha = -1;
    this._occlusionDirty = false;
  }
}

const controller = new MegaWorld1000();
registerConfigUI(controller);
registerPoiControls(controller);
registerFogControls(controller);
registerWallEditorControls(controller);
registerLayerEditorControls(controller);

Hooks.once("init", () => {
  installLazyTokenLayerPatch();
  installHoverFadeHitTestPatch();
  installCharacterSwitchPatch(controller);
});

Hooks.once("ready", async () => {
  const mod = game.modules?.get?.(MODULE_ID);
  if (mod) mod.api = controller;
  controller._ensureSocket();
  await controller.migrateLegacyScenes();
});

Hooks.on("canvasReady", (c) => {
  controller.mount(c.scene);
});

Hooks.on("updateScene", (scene, changes) => {
  controller.onSceneUpdate(scene, changes);
});

Hooks.on("updateLevel", (level, changes) => {
  const parentScene = level?.parent;
  if (!parentScene || parentScene.id !== canvas.scene?.id) return;
  const flagChanges = changes?.flags?.[MODULE_ID];
  const flagDeleted = Boolean(changes?.flags && (`-=${MODULE_ID}` in changes.flags));
  if (flagChanges || flagDeleted) {
    controller.mount(parentScene);
  }
});

Hooks.on("canvasPan", () => {
  if (!controller.active || controller._restoringCamera || controller._mounting) return;
  controller._lastPanMs = performance.now();
  controller.scheduleCameraSave();
  controller.updatePyramid();
});

let _controlTokenQueued = false;
Hooks.on("controlToken", () => {
  if (!controller.active) return;
  if (_controlTokenQueued) return;
  _controlTokenQueued = true;
  queueMicrotask(() => {
    _controlTokenQueued = false;
    if (!controller.active) return;
    controller.updateSimAndLightBubbles(false);
    controller.tokenStreamer.onVisibilityChanged();
    controller._roofTokenOccDirty = true;
  });
});

Hooks.on("lightingRefresh", (effects) => {
  if (!controller.active) return;
  controller.onLightingRefresh(effects);
  controller.tokenStreamer.onVisibilityChanged();
});

let _sightRefreshQueued = false;
Hooks.on("sightRefresh", () => {
  if (!controller.active) return;
  if (_sightRefreshQueued) return;
  _sightRefreshQueued = true;
  queueMicrotask(() => {
    _sightRefreshQueued = false;
    if (!controller.active) return;
    controller.fogManager.revealFromActiveVision();
    controller.wallEditor.refreshDoorVisibility();
    controller.updateSimAndLightBubbles(false);
    controller.tokenStreamer.onVisibilityChanged();
  });
});

Hooks.on("updateToken", (doc, changes) => {
  if (!controller.active || doc?.parent?.id !== canvas.scene?.id) return;
  controller.tokenStreamer.onTokenUpdated(doc, changes);
  controller.charPins.onTokenUpdated(doc, changes);
  const posChanged = "x" in changes || "y" in changes || "level" in changes;
  const elevChanged = "elevation" in changes;
  const lightChanged = "light" in changes;
  if (posChanged || elevChanged || lightChanged) {
    if ((posChanged || elevChanged) && controller._hasMultiElevationDepth()) controller._depthDirty = true;
    if (posChanged || lightChanged) controller.updateSimAndLightBubbles(false);
    if (posChanged || elevChanged) controller._roofTokenOccDirty = true;
    if (posChanged && controller.needsOcclusionRefreshNear(doc)) {
      canvas.perception.update({ refreshOcclusion: true, refreshOcclusionStates: true, refreshOcclusionMask: true });
    }
  }
});

Hooks.on("drawToken", (tok) => {
  if (!controller.active || tok?.document?.parent?.id !== canvas.scene?.id) return;
  controller.tokenStreamer.onTokenDrawn(tok);
});

Hooks.on("refreshToken", (tok, flags) => {
  if (!controller.active || tok?.document?.parent?.id !== canvas.scene?.id) return;
  if (flags?.refreshPosition || flags?.refreshElevation) {
    controller._roofTokenOccDirty = true;
  }
});

Hooks.on("createToken", (doc) => {
  if (!controller.active || doc?.parent?.id !== canvas.scene?.id) return;
  controller.tokenStreamer.onTokenCreated(doc);
  controller.charPins.onTokenCreatedOrDeleted();
  controller._depthDirty = true;
  controller._syncInterfaceVoidFilter();
  controller.updateSimAndLightBubbles(false);
  controller.syncRoofTokenOcclusion();
});

Hooks.on("deleteToken", (doc) => {
  if (!controller.active || doc?.parent?.id !== canvas.scene?.id) return;
  controller.tokenStreamer.onTokenDeleted(doc);
  controller.charPins.onTokenCreatedOrDeleted();
  controller._depthDirty = true;
  controller._syncInterfaceVoidFilter();
  controller.updateSimAndLightBubbles(false);
});

Hooks.on("updateUser", (_user, changes) => {
  if (!controller.active) return;
  if ("character" in changes || "color" in changes) {
    controller.charPins.onUserOrActorUpdated();
  }
});

Hooks.on("updateActor", (_actor, changes) => {
  if (!controller.active) return;
  if ("img" in changes || "name" in changes || "ownership" in changes) {
    controller.charPins.onUserOrActorUpdated();
  }
});

Hooks.on("collapseSidebar", () => {
  if (!controller.active) return;
  controller.charPins._lastSidebarCheckMs = 0;
  setTimeout(() => {
    if (controller.active) controller.charPins.updateViewport();
  }, 120);
});

window.addEventListener("resize", () => {
  if (!controller.active) return;
  controller.poiManager._layoutDirty = true;
  controller.poiManager.updateViewport();
  controller.charPins._lastSidebarCheckMs = 0;
  controller.charPins.updateViewport();
});

// React seamlessly to native TileDocuments added/edited/removed on any level (floors blocking lower-level lights, roofs, etc.)
for (const hookName of ["createTile", "updateTile", "deleteTile"]) {
  Hooks.on(hookName, (doc) => {
    if (!controller.active || doc?.parent?.id !== canvas.scene?.id) return;
    controller._depthDirty = true;
    controller._depthElevSyncNeeded = true;
    controller._occlusionDirty = true;
  });
}

// React to native WallDocuments added/edited/removed on any level so GPU light shadows stay in sync
for (const hookName of ["createWall", "updateWall", "deleteWall"]) {
  Hooks.on(hookName, (doc) => {
    if (!controller.active || !controller.visibleLevelLayers.length || doc?.parent?.id !== canvas.scene?.id) return;
    controller.scheduleLightBatchRebuild();
  });
}

// React to ALT highlight & v14 Region/Surface changes so CanvasDepthMask and z=5 interior reveal sync immediately
Hooks.on("highlightObjects", () => {
  if (!controller.active) return;
  controller._depthDirty = true;
});

for (const hookName of ["createRegion", "updateRegion", "deleteRegion", "createRegionBehavior", "updateRegionBehavior", "deleteRegionBehavior"]) {
  Hooks.on(hookName, (doc) => {
    if (!controller.active) return;
    const sc = doc?.parent?.documentName === "Scene" ? doc.parent : doc?.parent?.parent;
    if (sc && sc.id !== canvas.scene?.id) return;
    controller._depthDirty = true;
    controller._occlusionDirty = true;
  });
}

Hooks.on("initializeEdges", (scene) => {
  if (!controller.active || (scene && scene.id !== canvas.scene?.id)) return;
  controller.simSectors.clear();
  controller.lastSimKey = "";
  controller.updateSimAndLightBubbles(true);
});

Hooks.on("canvasTearDown", () => {
  controller.unmount();
});

globalThis.Boundless = controller;
export { controller as Boundless };
