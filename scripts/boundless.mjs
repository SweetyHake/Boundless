import { PoiManager } from "./poi.mjs";
import { ChunkedFogManager, registerFogControls } from "./chunked-fog.mjs";
import { MacroAtmosphereLayer } from "./macro-atmosphere.mjs";
import { MegaAudioStreamer } from "./audio-streamer.mjs";
import { VirtualWallEditor, registerWallEditorControls } from "./wall-editor.mjs";
import { VirtualLayerEditors, registerLayerEditorControls } from "./layer-editors.mjs";
import { TokenStreamer, installLazyTokenLayerPatch } from "./token-streamer.mjs";
import { ChunkStreamer } from "./chunk-streamer.mjs";
import { TileWorkerPool, isWorkerDecodableUrl } from "./tile-worker-pool.mjs";
import { registerConfigUI } from "./config-ui.mjs";

const MODULE_ID = "boundless";
const SOCKET_NAME = `module.${MODULE_ID}`;
const MAX_LOS_RADIUS_PX = 4500; // 45 cells (225 ft) horizon prevents 100kpx full-world raycasts
const MAX_VRAM_TEXTURES = 96;   // ~240 MB VRAM budget for mipmapped 1024x1024 WebP cache
const CROSSFADE_MS = 160;       // Smooth invisible LOD blend duration
const LIGHT_PAD_WORLD_PX = 900; // > max 40ft (800px) light radius so lights never pop on viewport edge
const FOUNDRY_DEFAULT_ATTENUATION = 0.277992; // Exact Foundry v14 computedAttenuation for data.attenuation = 0.5
const WORLD_MIN_SCALE = 0.008;        // Seamless full-world zoom-out
const CAMERA_STORAGE_PREFIX = "boundless.camera";
const CAMERA_SAVE_DEBOUNCE_MS = 250;

function smoothstep(edge0, edge1, x) {
  const t = Math.max(0, Math.min(1, (x - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
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
  if (uUseDepthTexture) {
    vec4 depthColor = texture2D(uDepthTexture, vSamplerUvs);
    depthMask = step(depthColor.g - (0.5 / 255.0), vDepthElev)
              * step(vDepthElev, (254.5 / 255.0) - depthColor.r);
    if (depthMask <= 0.001) discard;
  }
  if (uUseBakedRoofMask && vDimPx < 5000.0) {
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

  vec3 finalCol = switchColor(brightCol, dimCol, dist, vRatio, uAttenuation);
  float edgeFade = smoothstep(1.0, 1.0 - uAttenuation, dist) * depthMask;
  vec3 outCol = mix(bg, finalCol, edgeFade);

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

const vec3 BT709 = vec3(0.2126, 0.7152, 0.0722);
float perceivedBrightness(vec3 c) { return sqrt(dot(BT709, c * c)); }

void main() {
  if (vColorAlpha <= 0.001 || dot(vColor, vColor) <= 0.0001) discard;
  float dist = length(vOffset);
  if (dist >= 1.0) discard;

  float depthMask = 1.0;
  if (uUseDepthTexture) {
    vec4 depthColor = texture2D(uDepthTexture, vSamplerUvs);
    depthMask = step(depthColor.g - (0.5 / 255.0), vDepthElev)
              * step(vDepthElev, (254.5 / 255.0) - depthColor.r);
    if (depthMask <= 0.001) discard;
  }
  if (uUseBakedRoofMask && vDimPx < 5000.0) {
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

  float edgeFade = smoothstep(1.0, 1.0 - uAttenuation, dist) * depthMask;
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
      const lx = m[0], ly = m[1], rad = m[2];
      const colorHex = m[3] || "#ffaa44";
      const alpha = m[4] ?? 0.45;
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
        params.push(rad, 0.35, alpha, -1.0);
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

  _collectNativeWallEdges(levelId, EdgeCls) {
    const nativeEdges = [];
    if (canvas.scene?.walls) {
      for (const w of canvas.scene.walls) {
        if (w.light === 0) continue;
        if (w.door && w.ds === 1) continue;
        if (w.levels?.size && !w.levels.has(levelId)) continue;
        const [x1, y1, x2, y2] = w.c;
        nativeEdges.push(new EdgeCls({ x: x1, y: y1 }, { x: x2, y: y2 }, {
          id: `nw_${levelId}_${w.id}`, type: "wall",
          move: w.move, sight: w.sight, light: w.light, sound: w.sound, direction: w.dir || 0
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
      const defaultLightElev = (level.elevation?.base ?? level.elevation?.bottom ?? 0) + 6;
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
              arr.push(new EdgeCls({ x: w[0], y: w[1] }, { x: w[2], y: w[3] }, {
                id: `sgw_${levelId}_${bsk}_${wi}`, type: "wall",
                move: w[4], sight: w[5], light: w[6], sound: w[7], direction: w[8] || 0
              }));
            }
          }
          if (bsec.d) {
            for (let di = 0; di < bsec.d.length; di++) {
              const d = bsec.d[di];
              if (d[5] === 1) continue;
              arr.push(new EdgeCls({ x: d[0], y: d[1] }, { x: d[2], y: d[3] }, {
                id: `sgd_${levelId}_${bsk}_${di}`, type: "wall",
                move: 20, sight: 20, light: 20, sound: 20, direction: 0
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
        const topElev = level.elevation?.top ?? 20;
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
            const lx = raw[0], ly = raw[1];
            const dimFt = raw[2], brightFt = raw[3];
            const colorHex = raw[4], alpha = raw[5] ?? 0.5, anim = raw[6] || "";
            const elevation = Number.isFinite(raw[7]) ? raw[7] : defaultLightElev;
            const dimPx = Math.max(dimFt || 0, brightFt || 0) * pxPerFt;
            if (dimPx <= 0) continue;
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
            for (const e of localEdges) {
              if (Math.max(e.a.x, e.b.x) >= lx - dimPx && Math.min(e.a.x, e.b.x) <= lx + dimPx &&
                  Math.max(e.a.y, e.b.y) >= ly - dimPx && Math.min(e.a.y, e.b.y) <= ly + dimPx) {
                hasNearbyWall = true;
                break;
              }
            }

            let offsets = null;
            if (hasNearbyWall) {
              const poly = new CSP();
              poly.initialize({ x: lx, y: ly }, {
                type: "light",
                level: fakeBaseLevel,
                edgeTypes: { wall: true },
                radius: dimPx,
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
            if (elevation < topElev && baseSpec.overlays?.length) {
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
              dimPx, ratio, r, g, b, phase, offsets, isIndoor
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
                this.lightMetaById.set(lightId, {
                  id: lightId, levelId, elevation: bl.elevation, sk, lx, ly, dimPx: bl.dimPx, vStart, vCount,
                  weight: 1.0, baseWeight: suppressed ? 0.0 : 1.0, isIndoor: bl.isIndoor,
                  walls: true, angle: 360, rotation: 0, darkMin: 0, darkMax: 1,
                  raw: [lx, ly, bl.dimFt, bl.brightFt, bl.colorHex, bl.alpha, bl.anim, bl.elevation]
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
            arr.push(new EdgeCls({ x: x1, y: y1 }, { x: x2, y: y2 }, {
              id: `bw_${levelId}_${sk}_${wi}`, type: "wall",
              move: seg.move, sight: seg.sight, light: seg.light, sound: seg.sound, direction: seg.dir || 0
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
            arr.push(new EdgeCls({ x: x1, y: y1 }, { x: x2, y: y2 }, {
              id: `bd_${levelId}_${sk}_${di}`, type: "wall",
              move: seg.move, sight: seg.sight, light: seg.light, sound: seg.sound, direction: seg.dir || 0
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
          const topElev = level.elevation?.top ?? 20;
          let isIndoor = false;
          if (elevation < topElev && spec.overlays?.length) {
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
    // Ensure Foundry's depth mask elevation table is up to date before mapping
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
    const overlays = chunkData.overlays || layer.spec?.overlays || {};
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
          arr.push(new EdgeCls({ x: x1, y: y1 }, { x: x2, y: y2 }, {
            id: `cw_${levelId}_${sk}_${wi}`, type: "wall",
            move: seg.move, sight: seg.sight, light: seg.light, sound: seg.sound, direction: seg.dir || 0
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
          arr.push(new EdgeCls({ x: x1, y: y1 }, { x: x2, y: y2 }, {
            id: `cd_${levelId}_${sk}_${di}`, type: "wall",
            move: seg.move, sight: seg.sight, light: seg.light, sound: seg.sound, direction: seg.dir || 0
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
    const sched = typeof requestAnimationFrame === "function"
      ? requestAnimationFrame
      : (fn) => setTimeout(fn, 0);
    this._chunkBakeRaf = sched(() => {
      this._chunkBakeRaf = null;
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

      const defaultLightElev = (job.level.elevation?.base ?? job.level.elevation?.bottom ?? 0) + 6;
      const topElev = job.level.elevation?.top ?? 20;

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
    if (depthMask) {
      depthMask._elevationDirty = true;
      depthMask._update?.();
      for (const meta of job.metas) {
        const mapped = depthMask.mapElevation(meta.elevation);
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
    this.totalLights += job.metas.length;
    this.activeLightsCount += batch.activeCount;
    this.totalVertices += job.vertCursor;

    const effects = this._effects || canvas?.effects;
    if (effects) this._attachSingleBatch(batch, effects);
    if (this._lastVp) {
      const vp = this._lastVp;
      const showDetail = !this.macroBatch || vp.scale >= 0.035;
      this._cullBatch(batch, vp.x0 - LIGHT_PAD_WORLD_PX, vp.y0 - LIGHT_PAD_WORLD_PX, vp.x1 + LIGHT_PAD_WORLD_PX, vp.y1 + LIGHT_PAD_WORLD_PX, showDetail);
      this._updateMacroCrossfade(vp.scale);
    }
    this._onBatchChanged?.();
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
    const showMacro = scale < 0.07;
    if (!showMacro) {
      mb.illumMesh.visible = false;
      mb.colorMesh.visible = false;
      return;
    }
    // Smoothly fade macro orbital glow out across [0.035..0.068] when detailed chunks are mounted
    // so macroBatch and chunkBatches never double-brighten via SCREEN blending.
    const targetAlpha = this.chunkBatches.size > 0
      ? (1.0 - smoothstep(0.035, 0.068, scale))
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
      const showDetail = !this.macroBatch || vp.scale >= 0.035;
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
    const isDynamic = Boolean(illum?.hasDynamicDarknessLevel && illum?.renderTexture);
    u.uHasDarknessTexture = isDynamic;
    if (isDynamic) u.uDarknessLevelTexture = illum.renderTexture;

    const depthTex = canvas.masks?.depth?.renderTexture;
    u.uUseDepthTexture = Boolean(this.useDepthTexture && depthTex);
    if (u.uUseDepthTexture) u.uDepthTexture = depthTex;

    const hasRoofMask = Boolean(this.useBakedRoofMask && this.bakedRoofMask && !this.bakedRoofMask.destroyed);
    u.uUseBakedRoofMask = hasRoofMask;
    if (hasRoofMask) {
      u.uBakedRoofMask = this.bakedRoofMask;
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
    u.uHasPrimaryTexture = Boolean(primTex);
    u.uPrimaryTexture = primTex || PIXI.Texture.WHITE;

    const depthTex = canvas.masks?.depth?.renderTexture;
    u.uUseDepthTexture = Boolean(this.useDepthTexture && depthTex);
    if (u.uUseDepthTexture) u.uDepthTexture = depthTex;

    const hasRoofMask = Boolean(this.useBakedRoofMask && this.bakedRoofMask && !this.bakedRoofMask.destroyed);
    u.uUseBakedRoofMask = hasRoofMask;
    if (hasRoofMask) {
      u.uBakedRoofMask = this.bakedRoofMask;
      u.uBakedRoofRepeat = this.bakedRoofRepeat;
    }

    u.uMacroLift = smoothstep(0.14, 0.025, scale);
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
    this.useBakedRoofMask = Boolean(enabled && this.bakedRoofMask && !this.bakedRoofMask.destroyed);
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
    if (this.weightsDirty && this.weightBuffer) {
      this.weightBuffer.update();
      this.weightsDirty = false;
      const hasVisible = this.visibleIndexCount > 0 && this.activeLightsCount > 0;
      if (this.illumMesh) this.illumMesh.visible = hasVisible;
      if (this.colorMesh) this.colorMesh.visible = hasVisible;
    }
    const showDetail = !this.macroBatch || !this._lastVp || this._lastVp.scale >= 0.035;
    for (const batch of this.chunkBatches.values()) {
      if (!batch.weightsDirty || !batch.weightBuffer) continue;
      batch.weightBuffer.update();
      batch.weightsDirty = false;
      const hasVisible = showDetail && batch.visibleIndexCount > 0 && batch.activeCount > 0;
      batch.illumMesh.visible = hasVisible;
      batch.colorMesh.visible = hasVisible;
    }
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
    if (this._chunkBakeRaf !== null && typeof cancelAnimationFrame === "function") {
      try { cancelAnimationFrame(this._chunkBakeRaf); } catch {}
    }
    this._chunkBakeRaf = null;
    this._effects = null;
    this._lastVp = null;
    this._depthElevCheckMap.clear();
    this._hasDarknessRangedLights = false;
    this._isSuppressedFn = null;
    this._hasLevelEditsFn = null;
    this._onBatchChanged = null;

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

class LRUTextureManager {
  promises = new Map();     // src -> Promise<PIXI.Texture>
  lru = new Map();          // src -> PIXI.Texture (insertion order = LRU -> MRU)
  pinned = new Set();       // Static icons + z0..z2 low-level pyramid stay resident
  workerOwned = new Map();  // src -> { tex: PIXI.Texture, bitmap: ImageBitmap }
  workerPool = new TileWorkerPool();

  pin(src) {
    if (src) this.pinned.add(src);
  }

  getSync(src) {
    const tex = this.lru.get(src);
    if (tex) {
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

  _loadFallback(src, mipmap) {
    this.workerPool.stats.fallbackDecoded++;
    return foundry.canvas.loadTexture(src).then(tex => {
      if (tex?.baseTexture) {
        this._configureBaseTexture(tex, mipmap);
        this.lru.delete(src);
        this.lru.set(src, tex);
      }
      return tex;
    }).catch(() => null);
  }

  load(src, { mipmap = true, isPinned = false, priority = 1 } = {}) {
    if (!src) return Promise.resolve(null);
    if (isPinned) this.pinned.add(src);
    const existing = this.getSync(src);
    if (existing) return Promise.resolve(existing);
    if (this.promises.has(src)) {
      this.workerPool.boost(src, priority);
      return this.promises.get(src);
    }

    const useWorker = isWorkerDecodableUrl(src) && this.workerPool.isSupported();
    let p;
    if (useWorker) {
      p = this.workerPool.decode(src, { priority }).then(bitmap => {
        if (!bitmap) return null;
        try {
          const base = new PIXI.BaseTexture(bitmap, {
            mipmap: mipmap ? PIXI.MIPMAP_MODES.ON : PIXI.MIPMAP_MODES.OFF,
            scaleMode: PIXI.SCALE_MODES.LINEAR,
            wrapMode: PIXI.WRAP_MODES.CLAMP,
            alphaMode: PIXI.ALPHA_MODES.PMA,
            resolution: 1
          });
          const tex = new PIXI.Texture(base);
          this.workerOwned.set(src, { tex, bitmap });
          this.lru.delete(src);
          this.lru.set(src, tex);
          return tex;
        } catch (err) {
          try { bitmap.close(); } catch {}
          return this._loadFallback(src, mipmap);
        }
      }).catch(err => {
        if (err?.aborted) return null;
        return this._loadFallback(src, mipmap);
      }).finally(() => {
        this.promises.delete(src);
      });
    } else {
      p = this._loadFallback(src, mipmap).finally(() => {
        this.promises.delete(src);
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
    return this.workerPool.cancelAtOrBelowPriority(2);
  }

  _disposeEntry(src) {
    this.lru.delete(src);
    const owned = this.workerOwned.get(src);
    if (owned) {
      this.workerOwned.delete(src);
      try { owned.tex?.destroy?.(true); } catch {}
      try { owned.bitmap?.close?.(); } catch {}
    } else {
      PIXI.Assets.unload(src).catch(() => {});
    }
  }

  prune(inUseSet) {
    if (this.lru.size <= MAX_VRAM_TEXTURES) return;
    for (const [src] of this.lru) {
      if (this.lru.size <= MAX_VRAM_TEXTURES) break;
      if (this.pinned.has(src) || inUseSet.has(src)) continue;
      this._disposeEntry(src);
    }
  }

  clear() {
    this.workerPool.cancelAll();
    for (const [src] of Array.from(this.lru.entries())) {
      if (!this.pinned.has(src)) this._disposeEntry(src);
    }
    this.promises.clear();
  }

  getStats() {
    return {
      lruSize: this.lru.size,
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
  _hiddenNativeLevelBg = new Map(); // levelId -> PrimarySpriteMesh

  // Subsystems: POI fast-travel pins, high-res chunked Fog of War, spatial ambient audio, door socket sync
  poiManager = new PoiManager(this);
  fogManager = new ChunkedFogManager();
  atmosphere = new MacroAtmosphereLayer();
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
  _prewarmGen = 0;

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
    const [sw = 1600, sh = 1000] = canvas.screenDimensions || [];
    const safeScale = Math.max(0.01, targetScale || 0.45);
    const halfW = (sw / safeScale) * 0.55;
    const halfH = (sh / safeScale) * 0.55;

    const urls = [];
    const queued = new Set();
    const maxBudget = 12;

    for (const layer of this.visibleLevelLayers) {
      if (!layer.hasPyramid || urls.length >= maxBudget) continue;
      const { bounds } = layer;
      const destZ = Math.max(1, this._computeTargetZ(layer, safeScale));
      // Warm intermediate levels first (closest in time during descent), then destination level
      const levelsToWarm = [];
      if (destZ - 2 >= 1) levelsToWarm.push(destZ - 2);
      if (destZ - 1 >= 1) levelsToWarm.push(destZ - 1);
      levelsToWarm.push(destZ);

      for (const z of levelsToWarm) {
        if (urls.length >= maxBudget) break;
        const nTiles = this._getPyramidGridSize(layer, z);
        const tileWorldSize = bounds.w / nTiles;
        const padFactor = z === destZ ? 0.9 : 0.4;
        const bx0 = Math.max(bounds.x, worldX - halfW * padFactor);
        const by0 = Math.max(bounds.y, worldY - halfH * padFactor);
        const bx1 = Math.min(bounds.x + bounds.w, worldX + halfW * padFactor);
        const by1 = Math.min(bounds.y + bounds.h, worldY + halfH * padFactor);
        if (bx0 >= bx1 || by0 >= by1) continue;

        const tx0 = Math.max(0, Math.floor((bx0 - bounds.x) / tileWorldSize));
        const ty0 = Math.max(0, Math.floor((by0 - bounds.y) / tileWorldSize));
        const tx1 = Math.min(nTiles - 1, Math.floor((bx1 - bounds.x) / tileWorldSize));
        const ty1 = Math.min(nTiles - 1, Math.floor((by1 - bounds.y) / tileWorldSize));

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

  _getPyramidGridSize(layer, z) {
    const sg = layer.superGrid;
    if (sg) {
      const macroMaxZ = sg.macroMaxZ ?? 2;
      if (z <= macroMaxZ) return 1 << z;
      return (sg.cols || 6) * (1 << (z - (macroMaxZ + 1)));
    }
    return 1 << z;
  }

  _computeTargetZ(layer, scale) {
    const { worldPx, tilePx, maxZoomZ, superGrid } = layer;
    if (superGrid) {
      const macroMaxZ = superGrid.macroMaxZ ?? 2;
      const regionPx = superGrid.regionPx || 100000;
      const localRatio = (regionPx * scale) / tilePx;
      if (localRatio >= 0.92) {
        const localZ = Math.max(0, Math.ceil(Math.log2(Math.max(1, localRatio))));
        return Math.min(maxZoomZ, (macroMaxZ + 1) + localZ);
      }
      const macroExact = Math.log2(Math.max(0.5, (worldPx * scale) / tilePx));
      return Math.max(0, Math.min(macroMaxZ, Math.ceil(macroExact)));
    }
    const exactZ = Math.log2((worldPx * scale) / tilePx);
    return Math.max(0, Math.min(maxZoomZ, Math.ceil(exactZ)));
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
              sec.w.push([w[0] + offX, w[1] + offY, w[2] + offX, w[3] + offY, w[4], w[5], w[6], w[7], w[8]]);
            }
            totalWalls += sec.w.length;
          }
          if (bsec.d?.length) {
            for (let i = 0; i < bsec.d.length; i++) {
              const d = bsec.d[i];
              sec.d.push([d[0] + offX, d[1] + offY, d[2] + offX, d[3] + offY, d[4], d[5]]);
            }
            totalDoors += sec.d.length;
          }
          if (bsec.l?.length) {
            for (let i = 0; i < bsec.l.length; i++) {
              const l = bsec.l[i];
              sec.l.push([l[0] + offX, l[1] + offY, l[2], l[3], l[4], l[5], l[6], l[7]]);
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
    if (this.manifestCache.has(url)) return this.manifestCache.get(url);
    let data = await fetch(`${url}?v=${Date.now()}`).then(r => r.json());
    // Chunked world manifests (`boundless-chunked-v1`) stream sectors/overlays lazily per-chunk; never expand all 36 provinces into RAM upfront!
    if (data?.chunks?.baseUrl) {
      if (Array.isArray(data.superGrid?.tints) && !data.superGrid.parsedTints) {
        data.superGrid.parsedTints = data.superGrid.tints.map(row =>
          row.map(hex => (typeof hex === "number" ? hex : parseInt(String(hex).replace("#", ""), 16) || 0xffffff))
        );
      }
      if (!data.sectors) data.sectors = {};
      if (!data.overlays) data.overlays = {};
    } else if (data?.superGrid?.baseManifestUrl) {
      data = await this._expandSuperGridManifest(data);
    }
    this.manifestCache.set(url, data);
    return data;
  }

  _normalizeLevelSpec(rawSpec, level, levelCfg = {}) {
    if (!rawSpec) return null;
    const worldPx = rawSpec.worldPx || Math.max(canvas.dimensions?.width || 100000, canvas.dimensions?.height || 100000);
    const tilePx = rawSpec.tilePx || 1024;
    const simGrid = rawSpec.simGrid || 40;
    const simSectorPx = rawSpec.simSectorPx || Math.ceil(worldPx / simGrid);
    const superGrid = rawSpec.superGrid || null;
    const zOffset = superGrid ? ((superGrid.macroMaxZ ?? 2) + 1) : 0;
    const pyramidBaseUrl = levelCfg.pyramidBaseUrl !== undefined
      ? levelCfg.pyramidBaseUrl
      : (rawSpec.pyramidBaseUrl !== undefined
          ? rawSpec.pyramidBaseUrl
          : (rawSpec.blockFlags || rawSpec.maxZoomZ !== undefined ? `modules/${MODULE_ID}/assets/pyramid` : null));

    const hasPyramid = Boolean(pyramidBaseUrl);
    const maxZoomZ = rawSpec.maxZoomZ ?? (hasPyramid ? (7 + zOffset) : 0);
    const bounds = levelCfg.bounds || rawSpec.bounds || { x: 0, y: 0, w: worldPx, h: worldPx };

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
      isUpper: !level.isView && ((level.elevation?.bottom ?? 0) > (canvas.level?.elevation?.bottom ?? 0)),
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
    this.manifest = sceneManifest;

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

    layers.sort((a, b) => (a.level.elevation?.bottom ?? 0) - (b.level.elevation?.bottom ?? 0));
    return layers;
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
    const baseElev = canvas.level?.elevation?.bottom ?? 0;

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
      }
    };
  }

  async mount(scene) {
    this.unmount();
    const cfg = scene?.flags?.[MODULE_ID];
    const anyLevelFlag = scene?.levels?.some?.(l => l.flags?.[MODULE_ID]?.enabled);
    if (!cfg?.enabled && !anyLevelFlag) return;

    installLosHorizonPatch();
    installBulkSelectionPatch();
    installLazyTokenLayerPatch();
    this._ensureSocket();
    this.active = true;
    const mountedLevelId = canvas.level?.id;

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

    // Soft lighting/coloration glow does not need 2x HiDPI FBO fill-rate (4x fewer shaded pixels at 144Hz)
    this._capFilterResolution(canvas.effects?.coloration?.filter, 1.0);
    this._capFilterResolution(canvas.effects?.illumination?.filter, 1.0);

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
    }

    const layers = await this._resolveVisibleLevelLayers(scene, cfg || {});
    if (!this.active || canvas.scene?.id !== scene.id || canvas.level?.id !== mountedLevelId) return;

    this.visibleLevelLayers = layers;
    this.levelLayers.clear();
    for (const l of layers) this.levelLayers.set(l.level.id, l);

    // If the currently viewed level (and its visible sub-levels) have NO Boundless layers, leave Foundry 100% native!
    if (layers.length === 0) {
      console.log(`${MODULE_ID} | Active level "${canvas.level?.name}" has no Boundless layers; running native Foundry rendering.`);
      return;
    }

    // Load virtual wall/light/sound/tile edits before building GPU light batch
    this._loadWallEdits(scene);
    this._loadLightEdits(scene);
    this._loadSoundEdits(scene);
    this._loadTileEdits(scene);

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
        preloadTasks.push(this.texMgr.load(`${layer.pyramidBaseUrl}/0/0_0.webp`, { mipmap: true, isPinned: true }));
      }
    }
    await Promise.all(preloadTasks);
    if (!this.active || canvas.scene?.id !== scene.id || canvas.level?.id !== mountedLevelId) return;

    // Warm z=1 tiles silently in background for every visible pyramid layer
    for (const layer of layers) {
      if (!layer.hasPyramid || layer.maxZoomZ < 1) continue;
      for (let y = 0; y < 2; y++) for (let x = 0; x < 2; x++) {
        this.texMgr.load(`${layer.pyramidBaseUrl}/1/${x}_${y}.webp`, { mipmap: true, isPinned: true });
      }
    }

    // Mount permanent z=0 base layer for every visible pyramid level
    for (const layer of layers) {
      if (layer.hasPyramid) {
        this.ensureTile(layer, {
          key: `${layer.level.id}::0_0_0`,
          levelId: layer.level.id,
          z: 0, x: 0, y: 0,
          src: `${layer.pyramidBaseUrl}/0/0_0.webp`
        }, true);
      }
    }

    // Ticker drives buttery-smooth 160ms alpha crossfades & lazy depth updates
    this.tickerFn = () => this.stepCrossfades(canvas.app.ticker.deltaMS || 16.6);
    canvas.app.ticker.add(this.tickerFn);

    // Restore persisted door states from scene flags before mounting bubbles & door icons
    this._restoreDoorStates(scene);

    // Mount POI fast-travel pins, high-res chunked Fog of War, macro atmosphere, native wall/door/layer editors, token virtualization streamer, and spatial ambient audio
    this.poiManager.mount(scene, this.manifest);
    this.fogManager.mount(scene);
    this.atmosphere.mount(scene);
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
      m.visible = true;
      m.angle = 0;
      m.tint = 0xffffff;
      m.textureAlphaThreshold = 0.75;
      m._occludedBySameElevationSurfaces = true;
      return m;
    }
    const PrimarySpriteMesh = foundry.canvas.primary.PrimarySpriteMesh;
    const m = new PrimarySpriteMesh({ texture: PIXI.Texture.WHITE });
    m.anchor.set(0, 0);
    m.eventMode = "none";
    m.textureAlphaThreshold = 0.75;
    return m;
  }

  retireMesh(m) {
    if (!m) return;
    m.parent?.removeChild(m);
    if (this.meshPool.length < 360) {
      this.meshPool.push(m);
    } else {
      m.destroy();
    }
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
    if (!this.active || !this.visibleLevelLayers.length || !canvas?.ready) return;
    const vp = this.getViewportWorldRect(0.28);

    // Update GPU light frustum culling, spatial chunk streaming, POI pin scale, macro atmosphere, chunked fog culling, spatial audio, and native streamed walls/doors
    this.chunkStreamer.update(vp);
    this.lightBatch.updateViewport(vp);
    this._optimizeEffectsLayers(canvas.effects);
    this.poiManager.updateScale(vp.scale);
    this.atmosphere.updateScale(vp.scale);
    this.fogManager.updateViewportCulling(vp);
    if (!this.isCameraFlying) {
      this.audioStreamer.update(
        this.visibleLevelLayers,
        vp,
        (lid, sk, idx, raw, lvl) => this.resolveVirtualSound(lid, sk, idx, raw, lvl)
      );
      this.wallEditor.syncViewport(false, vp);
      this.layerEditors.syncViewport(false, vp);
      this.tokenStreamer.scheduleSync(vp);
    }
    this._depthDirty = true;

    let anyTilesOrOverlaysChanged = false;
    let maxTargetZ = 0;

    for (const layer of this.visibleLevelLayers) {
      const { bounds } = layer;
      const targetZ = this._computeTargetZ(layer, vp.scale);
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
          const nTiles = this._getPyramidGridSize(layer, targetZ);
          const tileWorldSize = bounds.w / nTiles;
          tx0 = Math.max(0, Math.floor((bx0 - bounds.x) / tileWorldSize));
          ty0 = Math.max(0, Math.floor((by0 - bounds.y) / tileWorldSize));
          tx1 = Math.min(nTiles - 1, Math.floor((bx1 - bounds.x) / tileWorldSize));
          ty1 = Math.min(nTiles - 1, Math.floor((by1 - bounds.y) / tileWorldSize));
        }

        const pyrKey = `${overlapsBounds ? 1 : 0}_${targetZ}_${tx0}_${ty0}_${tx1}_${ty1}`;
        if (pyrKey !== layer.lastPyramidKey) {
          layer.lastPyramidKey = pyrKey;
          anyTilesOrOverlaysChanged = true;

          const lid = layer.level.id;
          const baseKey = `${lid}::0_0_0`;
          const desiredMap = new Map();
          if (overlapsBounds) {
            desiredMap.set(baseKey, { levelId: lid, z: 0, x: 0, y: 0, key: baseKey, src: `${layer.pyramidBaseUrl}/0/0_0.webp` });
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

          const revealTargetZ = layer.zOffset + 5;
          const revealTileZ = layer.zOffset + 6;
          for (const [k, entry] of this.tilesByKey) {
            if (entry.levelId !== lid) continue;
            const keepReveal = Boolean(entry.isReveal && targetZ === revealTargetZ && entry.z === revealTileZ);
            entry.desired = desiredMap.has(k) || keepReveal;
            if (entry.desired) {
              entry.fadingOut = false;
              desiredSrcs.add(entry.src);
            } else {
              entry.isReveal = false;
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
    this._syncIndoorLightVisibility();
    if (anyTilesOrOverlaysChanged) {
      this._roofTokenOccDirty = true;
    }

    if (anyTilesOrOverlaysChanged) {
      const inUse = new Set();
      for (const [, entry] of this.tilesByKey) inUse.add(entry.src);
      for (const [, ov] of this.activeOverlays) {
        if (ov.srcWalls) inUse.add(ov.srcWalls);
        if (ov.srcRoof) inUse.add(ov.srcRoof);
      }
      for (const [, vt] of this.activeVirtualTiles) {
        if (vt.src) inUse.add(vt.src);
      }
      this.texMgr.prune(inUse);
    }
  }

  ensureTile(layer, spec, instant = false) {
    const { bounds } = layer;
    const sizePx = bounds.w / this._getPyramidGridSize(layer, spec.z);
    const x0 = bounds.x + spec.x * sizePx;
    const y0 = bounds.y + spec.y * sizePx;

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

    const isPinned = spec.z <= 2;
    this.texMgr.load(spec.src, { mipmap: true, isPinned, priority: isPinned ? 0 : 1 }).then(tex => {
      if (!this.active || !tex || !this.tilesByKey.has(spec.key)) return;
      const e = this.tilesByKey.get(spec.key);
      if (!e || e.fadingOut || (!e.desired && e.z > 0)) return;
      if (instant || e.z <= 2) {
        this._mountTileMesh(e, tex, instant);
      } else {
        this.pendingTileMounts.push({ key: spec.key, tex, instant });
        this._tilesDirty = true;
      }
    });
  }

  _mountTileMesh(e, tex, instant) {
    if (!e || e.ready || e.fadingOut || (!e.desired && e.z > 0)) return;
    const PrimaryCanvasGroup = foundry.canvas.groups.PrimaryCanvasGroup;
    const layer = e.layer;
    const levelElev = layer.level.elevation?.bottom ?? 0;

    const m = this.acquireMesh();
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
    m.restrictsLight = true;
    m.restrictsWeather = true;

    let hasFinerAbove = false;
    for (const [, other] of this.tilesByKey) {
      if (other.levelId === e.levelId && other.ready && other.z > e.z && other.alpha > 0.25 &&
          this.rectsOverlap(e.x0, e.y0, e.sizePx, other.x0, other.y0, other.sizePx)) {
        hasFinerAbove = true;
        break;
      }
    }
    e.alpha = (instant || hasFinerAbove || !this.hasReadyAncestorCovering(e)) ? 1.0 : 0.0;
    m.unoccludedAlpha = e.alpha;
    e.mesh = m;
    e.ready = true;
    canvas.primary.addChild(m);
    m.updateCanvasTransform?.();
    canvas.primary.sortDirty = true;
    this._tilesDirty = true;
    this._depthDirty = true;
    if (canvas.masks?.depth) canvas.masks.depth._elevationDirty = true;
  }

  rectsOverlap(ax, ay, asz, bx, by, bsz) {
    return !(ax + asz <= bx + 1 || ax + 1 >= bx + bsz || ay + asz <= by + 1 || ay + 1 >= by + bsz);
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

  isTileFullyReplacedByDesired(e) {
    const s = e.sizePx;
    const pts = [
      [e.x0 + s * 0.25, e.y0 + s * 0.25],
      [e.x0 + s * 0.75, e.y0 + s * 0.25],
      [e.x0 + s * 0.25, e.y0 + s * 0.75],
      [e.x0 + s * 0.75, e.y0 + s * 0.75],
    ];
    for (const [px, py] of pts) {
      let covered = false;
      for (const [, other] of this.tilesByKey) {
        if (other.levelId === e.levelId && other.desired && other.ready && other.z > 0 && other.alpha >= 0.98 &&
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
        if (s.elevation <= rm.elevation && s.region?.bounds?.intersects(rm.canvasBounds)) return true;
      }
    }
    return false;
  }

  _ensureOverlayWallsMesh(fullId, layer, ovSpec) {
    const existing = this.activeOverlays.get(fullId);
    if (!existing || existing.wallsMesh || !existing.srcWalls || this.overlayPending.has(`${fullId}:w`)) return;
    const PrimaryCanvasGroup = foundry.canvas.groups.PrimaryCanvasGroup;
    const topElev = layer.level.elevation?.top ?? 20;
    this.overlayPending.add(`${fullId}:w`);
    this.texMgr.load(existing.srcWalls, { mipmap: true }).then((tWalls) => {
      this.overlayPending.delete(`${fullId}:w`);
      const cur = this.activeOverlays.get(fullId);
      if (!this.active || !cur || cur.wallsMesh || !tWalls) return;
      const wallsMesh = this.acquireMesh();
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
      cur.wallsMesh = wallsMesh;
      canvas.primary.sortDirty = true;
      this._tilesDirty = true;
    });
  }

  stepCrossfades(dtMs) {
    if (!this.active || !canvas?.ready) return;

    this.atmosphere.tick(dtMs);

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
        if (layer && localZ === 5) {
          if (revealed) {
            if (ov.wallsMesh) {
              if (!ov.wallsMesh.visible) ov.wallsMesh.visible = true;
              if (ov.wallsMesh.unoccludedAlpha !== 1.0) ov.wallsMesh.unoccludedAlpha = 1.0;
            } else if (ov.ovSpec && ov.srcWalls) {
              this._ensureOverlayWallsMesh(k, layer, ov.ovSpec);
            }
            const revealZ = layer.zOffset + 6;
            if (layer.hasPyramid && layer.maxZoomZ >= revealZ && ov.ovSpec) {
              const { bounds } = layer;
              const nTiles = this._getPyramidGridSize(layer, revealZ);
              const tileWorldSize = bounds.w / nTiles;
              const halfW = (ov.ovSpec.w || 0) * 0.55;
              const halfH = (ov.ovSpec.h || 0) * 0.55;
              const tx0 = Math.max(0, Math.floor((ov.ovSpec.cx - halfW - bounds.x) / tileWorldSize));
              const ty0 = Math.max(0, Math.floor((ov.ovSpec.cy - halfH - bounds.y) / tileWorldSize));
              const tx1 = Math.min(nTiles - 1, Math.floor((ov.ovSpec.cx + halfW - bounds.x) / tileWorldSize));
              const ty1 = Math.min(nTiles - 1, Math.floor((ov.ovSpec.cy + halfH - bounds.y) / tileWorldSize));
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
      }
    } else if (this._lastRoofOccSig) {
      this._lastRoofOccSig = "";
      this._depthDirty = true;
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
          this.ensureTile(layer, spec, true);
          const created = this.tilesByKey.get(key);
          if (created) created.isReveal = true;
        }
      }
    }

    // Frame-budgeted overlay mounting FIRST so newly mounted roofs sync into depthMask in the exact same frame
    if (this.pendingOverlayMounts.length > 0) {
      const maxOvMounts = this.isCameraFlying ? 24 : 48;
      let mountedOv = 0;
      const curVp = this.getViewportWorldRect(0.35);
      while (this.pendingOverlayMounts.length > 0 && mountedOv < maxOvMounts) {
        const item = this.pendingOverlayMounts.shift();
        if (this._mountOverlayMeshes(item, curVp)) mountedOv++;
      }
      if (mountedOv > 0) {
        canvas.primary.sortDirty = true;
        this._tilesDirty = true;
        this._occlusionDirty = true;
        this._depthDirty = true;
        this._depthElevSyncNeeded = true;
        this._roofTokenOccDirty = true;
      }
    }

    if (this._depthElevSyncNeeded) {
      this._depthElevSyncNeeded = false;
      this.lightBatch.syncDepthElevations(this._hasMultiElevationDepth());
      if (canvas.masks?.depth) canvas.masks.depth._elevationDirty = true;
      this._depthDirty = true;
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
      this._occlusionDirty = false;
      canvas.perception.update({ refreshOcclusion: true, refreshOcclusionStates: true, refreshOcclusionMask: true });
    }

    if (this._waitingForRoofsBeforeIndoor) {
      this._syncIndoorLightVisibility();
    }

    if (this._roofTokenOccDirty) {
      this._roofTokenOccDirty = false;
      this.syncRoofTokenOcclusion();
    }

    // Frame-budgeted tile mounting (max 1-2 uploads/frame during flight, 4 when idle)
    if (this.pendingTileMounts.length > 0) {
      const maxMounts = this.isCameraFlying ? 2 : 4;
      let mounted = 0;
      while (this.pendingTileMounts.length > 0 && mounted < maxMounts) {
        const item = this.pendingTileMounts.shift();
        const e = this.tilesByKey.get(item.key);
        if (e && !e.ready && !e.fadingOut && (e.desired || e.z === 0)) {
          this._mountTileMesh(e, item.tex, item.instant);
          mounted++;
        }
      }
      if (this.pendingTileMounts.length > 0) this._tilesDirty = true;
    }

    if (!this._tilesDirty) return;

    const step = dtMs / CROSSFADE_MS;
    const vp = this.getViewportWorldRect(0.35);
    const toDelete = [];
    let stillActive = false;

    const levelReadyState = new Map();
    for (const layer of this.visibleLevelLayers) {
      levelReadyState.set(layer.level.id, {
        allReadyOpaque: layer.lastTargetZ > 0,
        hasDesiredNonZero: false,
        finestZ6Alpha: 0.0
      });
    }

    for (const [k, e] of this.tilesByKey) {
      const st = levelReadyState.get(e.levelId);
      if (e.z === 0) continue;

      if (!e.desired) {
        stillActive = true;
        const onScreen = !(e.x0 + e.sizePx < vp.x0 || e.x0 > vp.x1 || e.y0 + e.sizePx < vp.y0 || e.y0 > vp.y1);
        if (!onScreen || !e.ready) {
          toDelete.push(k);
          continue;
        }
        if (e.z < e.layer.lastTargetZ) {
          if (this.isTileFullyReplacedByDesired(e)) {
            toDelete.push(k);
          }
        } else {
          if (this.hasAnyReadyDesiredUnderneath(e)) {
            e.fadingOut = true;
          }
        }
      } else if (st) {
        st.hasDesiredNonZero = true;
        if (!e.ready || e.alpha < 0.99) {
          st.allReadyOpaque = false;
          stillActive = true;
        }
      }

      if (e.fadingOut) {
        e.alpha = Math.max(0.0, e.alpha - step);
        if (e.mesh) e.mesh.unoccludedAlpha = e.alpha;
        if (e.alpha <= 0.01) toDelete.push(k);
        else stillActive = true;
      } else if (e.desired && e.ready && e.alpha < 1.0) {
        e.alpha = Math.min(1.0, e.alpha + step);
        if (e.mesh) e.mesh.unoccludedAlpha = e.alpha;
        if (e.alpha < 1.0) stillActive = true;
      }

      if (st && e.layer && (e.z - e.layer.zOffset) >= 6 && !e.isReveal && e.ready && e.alpha > st.finestZ6Alpha) {
        st.finestZ6Alpha = e.alpha;
      }
    }

    // Hide z=0 base mesh & native Foundry background mesh while sharper tiles fully cover the viewport
    for (const layer of this.visibleLevelLayers) {
      if (!layer.hasPyramid) continue;
      const lid = layer.level.id;
      const st = levelReadyState.get(lid);
      const z0 = this.tilesByKey.get(`${lid}::0_0_0`);
      const fullyCovered = Boolean(st?.allReadyOpaque && st?.hasDesiredNonZero);
      if (z0?.mesh) {
        const shouldShowBase = !fullyCovered;
        if (z0.mesh.visible !== shouldShowBase) z0.mesh.visible = shouldShowBase;
      }
      this._setNativeLevelBgVisible(layer.level, !fullyCovered);
    }

    for (const [ovKey, ov] of this.activeOverlays) {
      const layer = this.levelLayers.get(ov.levelId);
      const localZ = layer ? (layer.lastTargetZ - layer.zOffset) : -1;
      const isZ6 = localZ >= 6;
      const canReveal = localZ >= 5;
      const revealOnZ5 = Boolean(localZ === 5 && ov.roofMesh && this._isRoofRevealed(ov.roofMesh, occSurfaces));
      const st = levelReadyState.get(ov.levelId);
      const a = isZ6 ? (st ? st.finestZ6Alpha : 1.0) : (revealOnZ5 ? 1.0 : 0.0);
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
          if (!canReveal) ov.roofMesh.occluded = false;
          this._occlusionDirty = true;
        }
        ov.roofMesh.hoverFade = canReveal;
        if (ov.roofMesh.unoccludedAlpha !== 1.0) ov.roofMesh.unoccludedAlpha = 1.0;
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

    // Pick the primary layer carrying baked building roofs (supports monolithic 1000x1000, superGrid, and chunked worlds)
    let targetLayer = null;
    let ovList = null;
    for (const l of layers) {
      const rawOvs = l.spec?._superGridBase?.overlays || l.spec?.overlays;
      if (!rawOvs) continue;
      const list = Array.isArray(rawOvs) ? rawOvs : Object.values(rawOvs);
      if (list.some(o => o?.roof && !o.walls?.includes("anchor_"))) {
        targetLayer = l;
        ovList = list;
        break;
      }
    }
    if (!targetLayer || !ovList?.length) return;

    const isSuperGrid = Boolean(targetLayer.spec?.superGrid);
    const originX = isSuperGrid ? 0 : (targetLayer.bounds?.x || 0);
    const originY = isSuperGrid ? 0 : (targetLayer.bounds?.y || 0);
    const regionW = isSuperGrid ? (targetLayer.spec.superGrid.regionPx || 100000) : (targetLayer.bounds?.w || 100000);
    const regionH = isSuperGrid ? (targetLayer.spec.superGrid.regionPx || 100000) : (targetLayer.bounds?.h || 100000);

    return this._bakeRoofMaskFromList(ovList, {
      originX, originY, regionW, regionH, repeat: isSuperGrid, sceneId, mountedLevelId
    });
  }

  async _bakeRoofMaskFromList(ovList, { originX = 0, originY = 0, regionW = 100000, regionH = 100000, repeat = false, sceneId = canvas.scene?.id, mountedLevelId = canvas.level?.id } = {}) {
    const renderer = canvas?.app?.renderer;
    if (!renderer || !ovList?.length) return;

    const roofUrls = new Set();
    for (const ov of ovList) {
      if (ov?.roof && !ov.walls?.includes("anchor_")) roofUrls.add(ov.roof);
    }
    if (!roofUrls.size) return;

    const gen = ++this._roofMaskGen;
    this._roofMaskBaking = true;
    try {
      // Load & pin the small set of unique roof textures (17 files) so both the mask and localZ>=5 roof meshes are instant
      const urlList = Array.from(roofUrls);
      const loaded = await Promise.all(urlList.map(url => this.texMgr.load(url, { mipmap: true, isPinned: true })));
      if (!this.active || this._roofMaskGen !== gen || canvas.scene?.id !== sceneId || canvas.level?.id !== mountedLevelId) return;

      const texByUrl = new Map();
      for (let i = 0; i < urlList.length; i++) {
        if (loaded[i]) texByUrl.set(urlList[i], loaded[i]);
      }
      if (!texByUrl.size) return;

      const maxTex = renderer.gl?.getParameter?.(renderer.gl.MAX_TEXTURE_SIZE) || 2048;
      const maskSize = maxTex >= 2048 ? 2048 : 1024;
      const rt = PIXI.RenderTexture.create({
        width: maskSize,
        height: maskSize,
        scaleMode: PIXI.SCALE_MODES.LINEAR,
        mipmap: PIXI.MIPMAP_MODES.OFF,
        wrapMode: PIXI.WRAP_MODES.CLAMP
      });

      const container = new PIXI.Container();
      container.scale.set(maskSize / Math.max(1, regionW), maskSize / Math.max(1, regionH));

      for (const ov of ovList) {
        if (!ov?.roof || ov.walls?.includes("anchor_")) continue;
        const tex = texByUrl.get(ov.roof);
        if (!tex) continue;
        const sp = new PIXI.Sprite(tex);
        sp.anchor.set(0.5, 0.5);
        sp.position.set(ov.cx - originX, ov.cy - originY);
        sp.width = ov.w;
        sp.height = ov.h;
        sp.angle = ov.rot || 0;
        container.addChild(sp);
      }

      renderer.render(container, { renderTexture: rt, clear: true });
      container.destroy({ children: true, texture: false, baseTexture: false });

      this.lightBatch.setBakedRoofMask(rt, {
        originX,
        originY,
        regionW,
        regionH,
        repeat
      });
      this._syncIndoorLightVisibility();
    } finally {
      if (this._roofMaskGen === gen) this._roofMaskBaking = false;
    }
  }

  _syncIndoorLightVisibility() {
    if (!this.active || !this.lightBatch) return;
    const viewedBottom = canvas.level?.elevation?.bottom ?? 0;
    let wantMacroRoofMask = false;
    for (const layer of this.visibleLevelLayers) {
      if (!layer.spec?.overlays) continue;
      const topElev = layer.level.elevation?.top ?? 20;
      const hideRoofsForUpperView = !layer.level.isView && viewedBottom >= topElev;
      if (hideRoofsForUpperView) continue;
      const localZ = layer.lastTargetZ - layer.zOffset;
      if (localZ < 5) {
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
    const topElev = level.elevation?.top ?? 20;
    const viewedBottom = canvas.level?.elevation?.bottom ?? 0;
    // If viewing an upper level above this level's top, hide lower-level roofs so upper floor tiles aren't covered
    const hideRoofsForUpperView = !level.isView && viewedBottom >= topElev;
    const localZ = targetZ - layer.zOffset;
    const showWalls = localZ >= 6;
    const canReveal = localZ >= 5;
    // Below localZ 5 roofs never reveal: they are baked in pyramid tiles, indoor lights are GPU-suppressed, and tokens inside are occluded via O(1) sector check
    const shouldMountRoofs = localZ >= 5;

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
    for (const [fullId, ov] of this.activeOverlays) {
      if (ov.levelId !== lid) continue;
      if (!neededOv.has(fullId)) {
        const hadRoof = Boolean(ov.roofMesh);
        if (ov.wallsMesh) this.retireMesh(ov.wallsMesh);
        if (ov.roofMesh) this.retireMesh(ov.roofMesh);
        this.activeOverlays.delete(fullId);
        if (hadRoof) {
          this._depthDirty = true;
          this._depthElevSyncNeeded = true;
        }
        changed = true;
      } else {
        if (ov.roofMesh) {
          if (ov.roofMesh.occlusionMode !== wantOccMode) {
            ov.roofMesh.occlusionMode = wantOccMode;
            if (!canReveal) ov.roofMesh.occluded = false;
            this._occlusionDirty = true;
          }
          ov.roofMesh.hoverFade = canReveal;
        }
        const revealOnZ5 = localZ === 5 && ov.roofMesh && this._isRoofRevealed(ov.roofMesh, occSurfaces);
        if (ov.wallsMesh) ov.wallsMesh.visible = showWalls || revealOnZ5;
      }
    }

    for (const fullId of neededOv) {
      if (this.activeOverlays.has(fullId)) {
        // Lazily load wallsMesh if this overlay was initially mounted at macro zoom with roof only
        const existing = this.activeOverlays.get(fullId);
        if (showWalls && !existing.wallsMesh && existing.srcWalls && existing.ovSpec) {
          this._ensureOverlayWallsMesh(fullId, layer, existing.ovSpec);
        }
        continue;
      }
      if (this.overlayPending.has(fullId)) continue;
      const oid = Number(fullId.split("::")[1]);
      const ovSpec = overlays[oid];
      if (!ovSpec) continue;

      const needWalls = Boolean(showWalls && ovSpec.walls);
      const needRoof = Boolean(!hideRoofsForUpperView && ovSpec.roof);
      const syncWalls = needWalls ? this.texMgr.getSync(ovSpec.walls) : null;
      const syncRoof = needRoof ? this.texMgr.getSync(ovSpec.roof) : null;

      if ((!needWalls || syncWalls) && (!needRoof || syncRoof)) {
        if (syncWalls || syncRoof) {
          this.pendingOverlayMounts.push({ fullId, lid, oid, layer, ovSpec, topElev, tWalls: syncWalls, tRoof: syncRoof });
          changed = true;
        }
        continue;
      }

      this.overlayPending.add(fullId);
      Promise.all([
        needWalls ? this.texMgr.load(ovSpec.walls, { mipmap: true }) : Promise.resolve(null),
        needRoof ? this.texMgr.load(ovSpec.roof, { mipmap: true }) : Promise.resolve(null)
      ]).then(([tWalls, tRoof]) => {
        this.overlayPending.delete(fullId);
        if (!this.active || !this.levelLayers.has(lid) || this.activeOverlays.has(fullId)) return;
        if (!tWalls && !tRoof) return;
        this.pendingOverlayMounts.push({ fullId, lid, oid, layer, ovSpec, topElev, tWalls, tRoof });
      });
      changed = true;
    }

    return changed;
  }

  _mountOverlayMeshes(item, curVp) {
    const { fullId, lid, oid, layer, ovSpec, topElev, tWalls, tRoof } = item;
    if (!this.active || !this.levelLayers.has(lid) || this.activeOverlays.has(fullId)) return false;
    if (ovSpec.cx + ovSpec.w < curVp.x0 || ovSpec.cx - ovSpec.w > curVp.x1 ||
        ovSpec.cy + ovSpec.h < curVp.y0 || ovSpec.cy - ovSpec.h > curVp.y1) return false;

    const PrimaryCanvasGroup = foundry.canvas.groups.PrimaryCanvasGroup;
    const localZNow = layer.lastTargetZ - layer.zOffset;
    if (localZNow < 5) return false;
    const ovTint = ovSpec.tint ?? 0xffffff;
    let wallsMesh = null;
    let roofMesh = null;

    if (tWalls) {
      wallsMesh = this.acquireMesh();
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
    }

    if (tRoof) {
      const canRevealNow = localZNow >= 5;
      roofMesh = this.acquireMesh();
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
      roofMesh._occludedBySameElevationSurfaces = true;
      roofMesh.unoccludedAlpha = 1.0;
      roofMesh.occludedAlpha = 0.05;
      roofMesh.hoverFade = canRevealNow;
      roofMesh.restrictsLight = true;
      roofMesh.restrictsWeather = true;
      roofMesh.textureAlphaThreshold = 0.75;
      canvas.primary.addChild(roofMesh);
      roofMesh.updateCanvasTransform?.();
    }

    this.activeOverlays.set(fullId, { levelId: lid, oid, ovSpec, wallsMesh, roofMesh, srcWalls: ovSpec.walls, srcRoof: ovSpec.roof });
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
    const defaultElev = level.elevation?.bottom ?? 0;

    const sx0 = Math.max(0, Math.floor(vp.x0 / simSectorPx));
    const sy0 = Math.max(0, Math.floor(vp.y0 / simSectorPx));
    const sx1 = Math.min(simGrid - 1, Math.floor(vp.x1 / simSectorPx));
    const sy1 = Math.min(simGrid - 1, Math.floor(vp.y1 / simSectorPx));

    const tileKey = `${targetZ}_${sx0}_${sy0}_${sx1}_${sy1}_r${this.tileEditsRev}`;
    if (tileKey === layer.lastTileKey) return false;
    layer.lastTileKey = tileKey;

    const needed = new Set();
    if (sectors) {
      for (let sy = sy0; sy <= sy1; sy++) {
        for (let sx = sx0; sx <= sx1; sx++) {
          const sec = sectors[`${sx}_${sy}`];
          if (!sec?.t?.length) continue;
          for (const tid of sec.t) {
            const tSpec = this.resolveVirtualTile(lid, tid, tiles[tid], level);
            if (!tSpec) continue;
            if (tSpec.minZ !== undefined && targetZ < tSpec.minZ) continue;
            if (tSpec.maxZ !== undefined && targetZ > tSpec.maxZ) continue;
            needed.add(`${lid}::${tid}`);
          }
        }
      }
    } else {
      // Fallback for small inline tile lists without spatial sector index
      for (let tid = 0; tid < tiles.length; tid++) {
        const t = this.resolveVirtualTile(lid, tid, tiles[tid], level);
        if (!t) continue;
        if (t.minZ !== undefined && targetZ < t.minZ) continue;
        if (t.maxZ !== undefined && targetZ > t.maxZ) continue;
        const x0 = t.x - (t.anchorX ?? 0) * t.w;
        const y0 = t.y - (t.anchorY ?? 0) * t.h;
        if (x0 + t.w >= vp.x0 && x0 <= vp.x1 && y0 + t.h >= vp.y0 && y0 <= vp.y1) {
          needed.add(`${lid}::${tid}`);
        }
      }
    }

    let changed = false;
    for (const [fullId, vt] of this.activeVirtualTiles) {
      if (vt.levelId !== lid) continue;
      if (!needed.has(fullId)) {
        if (vt.mesh) this.retireMesh(vt.mesh);
        this.activeVirtualTiles.delete(fullId);
        changed = true;
      }
    }

    for (const fullId of needed) {
      if (this.activeVirtualTiles.has(fullId) || this.virtualTilePending.has(fullId)) continue;
      const tid = Number(fullId.split("::")[1]);
      const tSpec = this.resolveVirtualTile(lid, tid, tiles[tid], level);
      if (!tSpec?.src) continue;

      this.virtualTilePending.add(fullId);
      this.texMgr.load(tSpec.src, { mipmap: true }).then(tex => {
        this.virtualTilePending.delete(fullId);
        if (!this.active || !tex || !this.levelLayers.has(lid)) return;

        const m = this.acquireMesh();
        const ax = tSpec.anchorX ?? 0.5;
        const ay = tSpec.anchorY ?? 0.5;
        m.anchor.set(ax, ay);
        m.texture = tex;
        m.position.set(tSpec.x + (tSpec.anchorX === undefined ? tSpec.w * 0.5 : 0), tSpec.y + (tSpec.anchorY === undefined ? tSpec.h * 0.5 : 0));
        m.width = tSpec.w;
        m.height = tSpec.h;
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
        // Hide raw mesh if TilesLayer editor currently renders the native editable Tile for this slot
        if (this.layerEditors?.tileActive && this.layerEditors.tilesByKey.has(`t:${tid}`)) {
          m.visible = false;
        }

        canvas.primary.addChild(m);
        m.updateCanvasTransform?.();
        this.activeVirtualTiles.set(fullId, { levelId: lid, mesh: m, src: tSpec.src });
        canvas.primary.sortDirty = true;
        this._occlusionDirty = true;
        this._depthDirty = true;
        if (m.restrictsLight) {
          this._depthElevSyncNeeded = true;
        }
      });
      changed = true;
    }

    return changed;
  }

  onLightingRefresh(effects) {
    if (!this.active) return;
    this._capFilterResolution(effects?.coloration?.filter, 1.0);
    this._capFilterResolution(effects?.illumination?.filter, 1.0);
    const darkness = canvas.environment?.darknessLevel ?? 0;
    const rangedChanged = this.lightBatch.syncDarknessLevel(darkness);
    this.lightBatch.attachTo(effects);
    this._optimizeEffectsLayers(effects);
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

      // 1. Collect Dynamic PointLightSources FIRST so we guarantee their full light radius has wall edges in `level.edges`
      //    When macro bakedRoofMask is active (localZ < 5, roofs unloaded from CanvasDepthMask), keep lights in MegaLightBatch
      //    so native PointLightSources never bleed through baked roofs near tokens.
      const neededDynLights = new Set();
      const suppressAllDynForMacroRoof = Boolean(this.lightBatch.useBakedRoofMask);
      const suppressIndoorDyn = Boolean(this.lightBatch.hideIndoorLights);

      const isMetaEligibleDyn = (meta) => {
        if (!meta) return false;
        if (suppressIndoorDyn && meta.isIndoor) return false;
        if (darkness < (meta.darkMin ?? 0) || darkness > (meta.darkMax ?? 1)) return false;
        return true;
      };

      if (!suppressAllDynForMacroRoof) {
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
                  if (!isMetaEligibleDyn(meta)) continue;
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
              if (isOpen) continue;
              const [x1, y1, x2, y2] = seg.c;
              const eid = `mw_${lid}_${sk}_${wi}`;
              const edge = new EdgeCls({ x: x1, y: y1 }, { x: x2, y: y2 }, {
                id: eid, type: "wall",
                move: seg.move, sight: seg.sight, light: seg.light, sound: seg.sound, direction: seg.dir || 0
              });
              level.edges.set(eid, edge);
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
                const edge = new EdgeCls({ x: x1, y: y1 }, { x: x2, y: y2 }, {
                  id: eid, type: "wall",
                  move: seg.move, sight: seg.sight, light: seg.light, sound: seg.sound, direction: seg.dir || 0
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
      sound: seg.sound ?? 20,
      dir: seg.dir || 0,
      doorType: seg.door,
      defaultDs: seg.ds,
      doorSound: seg.doorSound || ""
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
      const info = this._resolveDoorByKey(dKey);
      if (!info) continue;
      const ds = this._normalizeDoorState(rawVal, info.defaultDs);
      this.doorStates.set(dKey, ds);
      if (ds === 1) {
        const dx = (info.ptA.x + info.ptB.x) * 0.5;
        const dy = (info.ptA.y + info.ptB.y) * 0.5;
        this.openDoors.set(dKey, { levelId: info.levelId, x: dx, y: dy, sx: info.sx, sy: info.sy, eid: info.eid });
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

    if (isOpen) {
      level?.edges?.delete(eid);
      this.openDoors.set(dKey, { levelId, x: dx, y: dy, sx, sy, eid });
    } else {
      if (this.simSectors.has(`${levelId}::${sx}_${sy}`)) {
        level?.edges?.set(eid, new EdgeCls(ptA, ptB, {
          id: eid, type: "wall",
          move: info.move ?? 20,
          sight: info.sight ?? 20,
          light: info.light ?? 20,
          sound: info.sound ?? 20,
          direction: info.dir || 0
        }));
      }
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
    if (!info) return;

    const targetDs = payload.ds !== undefined
      ? this._normalizeDoorState(payload.ds, info.defaultDs)
      : (payload.isOpen ? 1 : 0);

    if (payload.type === "doorState") {
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

    if (!game.user.isGM && (curDs === 2 || ds === 2)) return;

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
        animation: ov.animation?.texture ? ov.animation : null
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
        move: 20,
        sight: 20,
        light: 20,
        sound: 20,
        dir: 0,
        door: doorType || 1,
        ds: defaultDs || 0,
        doorSound: extra?.doorSound || "",
        threshold: extra?.threshold || null,
        animation: extra?.animation?.texture ? extra.animation : null
      };
    }
    const [x1, y1, x2, y2, move, sight, light, sound, dir] = raw;
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
      threshold: null,
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
    const defaultElev = ((level?.elevation?.base ?? level?.elevation?.bottom ?? 0) + 6);
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
    const defaultElev = ((level?.elevation?.base ?? level?.elevation?.bottom ?? 0) + 5);
    const levelMap = this.soundEdits.get(levelId);
    if (levelMap && levelMap.has(sKey)) {
      const ov = levelMap.get(sKey);
      if (ov === null) return null;
      return {
        levelId, sk, idx, sKey,
        x: ov.x, y: ov.y, radius: ov.radius ?? 20, path: ov.path || "",
        volume: ov.volume ?? 0.6, walls: ov.walls !== false, easing: ov.easing !== false,
        darkMin: ov.darkMin ?? 0, darkMax: ov.darkMax ?? 1,
        elevation: Number.isFinite(ov.elevation) ? ov.elevation : defaultElev
      };
    }
    const [x, y, radius, path, volume, walls, easing, darkMin, darkMax, customElev] = raw;
    return {
      levelId, sk, idx, sKey,
      x, y, radius: radius || 20, path: path || "",
      volume: volume ?? 0.6, walls: walls !== false, easing: easing !== false,
      darkMin: darkMin ?? 0, darkMax: darkMax ?? 1,
      elevation: Number.isFinite(customElev) ? customElev : defaultElev
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
    const defaultElev = level?.elevation?.bottom ?? 0;
    const levelMap = this.tileEdits.get(levelId);
    if (levelMap && levelMap.has(tKey)) {
      const ov = levelMap.get(tKey);
      if (ov === null) return null;
      return { levelId, tid, tKey, ...ov, elevation: Number.isFinite(ov.elevation) ? ov.elevation : defaultElev };
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
    for (const layer of this.visibleLevelLayers) layer.lastTileKey = "";
    this.updatePyramid();
    this.layerEditors.syncTiles(true);
    this._occlusionDirty = true;
    this._depthDirty = true;
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
    if (!this.active || scene?.id !== canvas.scene?.id) return;

    // React to native Foundry v14 Scene fog mode (DISABLED / INDIVIDUAL / SHARED) & tokenVision changes
    if (changes?.fog || "tokenVision" in (changes || {})) {
      this.fogManager.mount(scene);
    }

    const flagChanges = changes?.flags?.[MODULE_ID];
    if (!flagChanges) return;

    if (flagChanges.wallEdits && typeof flagChanges.wallEdits === "object") {
      this._loadWallEdits(scene);
      this.applyVirtualWallChangesLocal();
    }

    if (flagChanges.lightEdits && typeof flagChanges.lightEdits === "object") {
      this._loadLightEdits(scene);
      this.applyVirtualLightChangesLocal();
    }

    if (flagChanges.soundEdits && typeof flagChanges.soundEdits === "object") {
      this._loadSoundEdits(scene);
      this.applyVirtualSoundChangesLocal();
    }

    if (flagChanges.tileEdits && typeof flagChanges.tileEdits === "object") {
      this._loadTileEdits(scene);
      this.applyVirtualTileChangesLocal();
    }

    if (flagChanges.doorStates && typeof flagChanges.doorStates === "object") {
      for (const [dKey, rawVal] of Object.entries(flagChanges.doorStates)) {
        const info = this._resolveDoorByKey(dKey);
        if (info) this._applyDoorStateLocal(info, rawVal, { playSound: false });
      }
    }

    if ("pois" in flagChanges || "showPois" in flagChanges) {
      if (flagChanges.showPois !== false && !this.poiManager.container) {
        this.poiManager.mount(scene, this.manifest);
      } else {
        this.poiManager.rebuild(scene, this.manifest);
      }
    }

    if ("chunkedFog" in flagChanges) {
      this.fogManager.mount(scene);
    } else if (flagChanges.sharedFog && typeof flagChanges.sharedFog === "object") {
      this.fogManager.onSceneFogFlagsChanged(scene, flagChanges.sharedFog);
    }

    if ("virtualizeTokens" in flagChanges) {
      this.tokenStreamer.mount(scene);
      this.tokenStreamer.scheduleSync(this.getViewportWorldRect(0.28), true);
    }

    if ("macroAtmosphere" in flagChanges) {
      this.atmosphere.mount(scene);
    }

    if ("enabled" in flagChanges || "manifestUrl" in flagChanges) {
      this.mount(scene);
    }
  }

  // ===== Public Level, POI & Virtual Tile API =====

  async addPOI(poiSpec, scene = canvas.scene) {
    if (!scene) return null;
    const existing = Array.isArray(scene.flags?.[MODULE_ID]?.pois)
      ? foundry.utils.deepClone(scene.flags[MODULE_ID].pois)
      : [];
    const entry = {
      id: poiSpec.id || foundry.utils.randomID(),
      name: poiSpec.name || game.i18n.localize("BOUNDLESS.Config.PoiDefaultName"),
      x: Math.round(poiSpec.x ?? (scene.width || 100000) * 0.5),
      y: Math.round(poiSpec.y ?? (scene.height || 100000) * 0.5),
      levelId: poiSpec.levelId || null,
      targetScale: poiSpec.targetScale || 0.45,
      color: poiSpec.color || "#f5c96b",
      kind: poiSpec.kind || "major",
      hidden: Boolean(poiSpec.hidden)
    };
    existing.push(entry);
    await scene.update({ [`flags.${MODULE_ID}.pois`]: existing });
    return entry;
  }

  async removePOI(poiId, scene = canvas.scene) {
    if (!scene || !poiId) return false;
    const existing = Array.isArray(scene.flags?.[MODULE_ID]?.pois)
      ? scene.flags[MODULE_ID].pois.filter(p => p.id !== poiId)
      : [];
    await scene.update({ [`flags.${MODULE_ID}.pois`]: existing });
    return true;
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
   * Bake native Foundry TileDocuments, WallDocuments, and AmbientLightDocuments on a Level
   * into an inline Boundless spatial sector manifest on `level.flags["boundless"]`.
   */
  async bakeNativeToLevel(levelId = canvas.level?.id, { removeOriginals = false, simGrid = null } = {}) {
    const scene = canvas.scene;
    const level = scene?.levels?.get(levelId);
    if (!scene || !level) throw new Error(`Level "${levelId}" not found.`);

    const worldPx = Math.max(scene.width || 100000, scene.height || 100000);
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
      const tileSpec = {
        src: t.texture.src,
        x: t.x, y: t.y, w: t.width, h: t.height,
        rot: t.rotation || 0,
        elevation: t.elevation,
        sort: t.sort || 0,
        alpha: t.alpha ?? 1,
        tint: t.texture.tint ? foundry.utils.Color.from(t.texture.tint).css : null,
        alphaThreshold: t.texture.alphaThreshold ?? 0.75,
        occlusionMode: occModes.length ? occModes : CONST.OCCLUSION_MODES.NONE,
        occludedAlpha: t.occlusion?.alpha ?? 0.2,
        restrictsLight: Boolean(t.restrictions?.light),
        restrictsWeather: Boolean(t.restrictions?.weather)
      };
      tiles.push(tileSpec);
      tileIdsToDelete.push(t.id);

      const sx0 = Math.floor(t.x / simSectorPx);
      const sy0 = Math.floor(t.y / simSectorPx);
      const sx1 = Math.floor((t.x + t.width) / simSectorPx);
      const sy1 = Math.floor((t.y + t.height) / simSectorPx);
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
        if (w.doorSound) extra.doorSound = w.doorSound;
        if (w.animation?.texture) {
          extra.animation = {
            type: w.animation.type || "swing",
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
        sec.w.push([x1, y1, x2, y2, w.move, w.sight, w.light, w.sound, w.dir || 0]);
      }
      wallIdsToDelete.push(w.id);
    }

    const lightIdsToDelete = [];
    for (const l of scene.lights) {
      if (l.levels?.size && !l.levels.has(levelId)) continue;
      // Keep negative (darkness) sources as native AmbientLightDocuments since MegaLightBatch renders additive light
      if (l.config?.negative) continue;
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
      sec.s.push([
        snd.x, snd.y,
        snd.radius || 20,
        snd.path,
        snd.volume ?? 0.6,
        snd.walls !== false,
        snd.easing !== false,
        snd.darkness?.min ?? 0,
        snd.darkness?.max ?? 1,
        snd.elevation
      ]);
      soundIdsToDelete.push(snd.id);
    }

    const inlineManifest = { worldPx, simGrid: resolvedSimGrid, simSectorPx, tiles, sectors };
    const existingCfg = foundry.utils.deepClone(level.flags?.[MODULE_ID] || {});
    await level.update({ [`flags.${MODULE_ID}`]: { ...existingCfg, enabled: true, inlineManifest } });

    if (removeOriginals) {
      if (tileIdsToDelete.length) await scene.deleteEmbeddedDocuments("Tile", tileIdsToDelete);
      if (wallIdsToDelete.length) await scene.deleteEmbeddedDocuments("Wall", wallIdsToDelete);
      if (lightIdsToDelete.length) await scene.deleteEmbeddedDocuments("AmbientLight", lightIdsToDelete);
      if (soundIdsToDelete.length) await scene.deleteEmbeddedDocuments("AmbientSound", soundIdsToDelete);
    }

    await this.mount(scene);
    return {
      levelId,
      tiles: tiles.length,
      walls: wallIdsToDelete.length,
      lights: lightIdsToDelete.length,
      sounds: soundIdsToDelete.length
    };
  }

  syncRoofTokenOcclusion() {
    if (!this.active || !canvas?.tokens?.placeables) return;

    const nextHidden = new Set();
    for (const tok of canvas.tokens.placeables) {
      if (!tok || tok.destroyed || tok.isPreview || tok.controlled) continue;
      const doc = tok.document;
      const lid = doc?.level || canvas.level?.id;
      const layer = this.levelLayers.get(lid);
      if (!layer?.spec) continue;

      const { simGrid, simSectorPx, spec, level } = layer;
      const topElev = level.elevation?.top ?? 20;
      const tokElev = doc?.elevation ?? 0;
      const tx = tok.center.x, ty = tok.center.y;
      const sx = Math.max(0, Math.min(simGrid - 1, Math.floor(tx / simSectorPx)));
      const sy = Math.max(0, Math.min(simGrid - 1, Math.floor(ty / simSectorPx)));

      let hiddenByBakedRoof = false;

      // 1. Check baked building roofs across 3x3 neighbor sectors (buildings like taverns can straddle sector borders)
      if (tokElev < topElev && spec.overlays && spec.sectors) {
        const viewedBottom = canvas.level?.elevation?.bottom ?? 0;
        const hideRoofsForUpperView = !level.isView && viewedBottom >= topElev;
        if (!hideRoofsForUpperView) {
          for (let dy = -1; dy <= 1 && !hiddenByBakedRoof; dy++) {
            for (let dx = -1; dx <= 1 && !hiddenByBakedRoof; dx++) {
              const oList = spec.sectors[`${sx + dx}_${sy + dy}`]?.o;
              if (!oList?.length) continue;
              for (const oid of oList) {
                const ovSpec = spec.overlays[oid];
                if (!isPointUnderRoofSpec(tx, ty, ovSpec)) continue;
                const mountedRoof = this.activeOverlays.get(`${lid}::${oid}`)?.roofMesh;
                // If native roofMesh at elev=20 is NOT currently covering this building, suppress token so it doesn't poke through the flat pyramid roof
                if (!mountedRoof || !mountedRoof.visible || mountedRoof.unoccludedAlpha < 0.9) {
                  hiddenByBakedRoof = true;
                  break;
                }
              }
            }
          }
        }
      }

      // 2. Check zoomed-out virtual tiles with minZ > current targetZ that sit above this token
      const sec = spec.sectors?.[`${sx}_${sy}`];
      if (!hiddenByBakedRoof && sec?.t?.length && spec.tiles?.length) {
        for (const tid of sec.t) {
          const tSpec = this.resolveVirtualTile(lid, tid, spec.tiles[tid], level);
          if (!tSpec || (tSpec.elevation ?? 0) <= tokElev) continue;
          if (tSpec.minZ !== undefined && layer.lastTargetZ < tSpec.minZ) {
            if (tx >= tSpec.x && tx <= tSpec.x + tSpec.w && ty >= tSpec.y && ty <= tSpec.y + tSpec.h) {
              hiddenByBakedRoof = true;
              break;
            }
          }
        }
      }

      if (hiddenByBakedRoof) {
        nextHidden.add(tok);
        if (tok.renderable) tok.renderable = false;
        if (tok.mesh && !tok.mesh.destroyed && tok.mesh.renderable) tok.mesh.renderable = false;
      }
    }

    // Restore tokens that are no longer hidden by baked roofs
    let restoredAny = false;
    for (const tok of this._roofHiddenTokens) {
      if (nextHidden.has(tok)) continue;
      if (tok && !tok.destroyed) {
        tok.renderable = true;
        if (tok.mesh && !tok.mesh.destroyed) tok.mesh.renderable = true;
        restoredAny = true;
      }
    }
    this._roofHiddenTokens = nextHidden;
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

    // Bake pixel-accurate roof mask for chunked worlds (once with repeat=true for superGrid, or over active chunk overlays)
    if (chunkData?.overlays) {
      const isSuperGrid = Boolean(layer.spec?.superGrid);
      if (isSuperGrid) {
        if (!this.lightBatch.bakedRoofMask && !this._roofMaskBaking) {
          const ovList = Array.isArray(chunkData.overlays) ? chunkData.overlays : Object.values(chunkData.overlays);
          const b = chunkData.bounds || { x: 0, y: 0, w: layer.spec.superGrid.regionPx || 100000, h: layer.spec.superGrid.regionPx || 100000 };
          this._bakeRoofMaskFromList(ovList, {
            originX: b.x || 0,
            originY: b.y || 0,
            regionW: b.w || 100000,
            regionH: b.h || 100000,
            repeat: true
          });
        }
      } else {
        const allOvs = Object.values(layer.spec.overlays || {});
        let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
        for (const ov of allOvs) {
          if (!ov?.roof || ov.walls?.includes("anchor_")) continue;
          const r = Math.max(ov.w || 0, ov.h || 0) * 0.6;
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

    // Invalidate spatial caches so roofs, walls, doors, audio, and sim-bubbles pick up newly loaded sectors immediately
    layer.lastOverlayKey = "";
    layer.lastTileKey = "";
    this.lastSimKey = "";
    this.lastDynLightKey = "";
    this._roofTokenOccDirty = true;
    this.updatePyramid();
    this.updateSimAndLightBubbles(false);
    this.wallEditor.syncViewport(true);
  }

  onChunkUnloaded(layer, chunkKey) {
    if (!layer) return;
    this.lightBatch.detachChunk(layer.level.id, chunkKey);
    layer.lastOverlayKey = "";
    layer.lastTileKey = "";
    this.lastSimKey = "";
    this.lastDynLightKey = "";
    if (this.active) {
      this.updatePyramid();
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
            macroAtmosphere: true,
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

    this.poiManager.unmount();
    this.fogManager.unmount();
    this.atmosphere.unmount();
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

    if (this._origDepthAutoRender !== null && canvas?.masks?.depth) {
      canvas.masks.depth.autoRender = this._origDepthAutoRender;
      canvas.masks.depth.renderDirty = true;
      this._origDepthAutoRender = null;
    }

    for (const [, bgMesh] of this._hiddenNativeLevelBg) {
      if (bgMesh && !bgMesh.destroyed) bgMesh.visible = true;
    }
    this._hiddenNativeLevelBg.clear();

    this.pendingTileMounts = [];
    this.pendingOverlayMounts = [];
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

    for (const [, e] of this.tilesByKey) {
      if (e.mesh) {
        e.mesh.parent?.removeChild(e.mesh);
        e.mesh.destroy();
      }
    }
    this.tilesByKey.clear();

    for (const tok of this._roofHiddenTokens) {
      if (tok && !tok.destroyed) {
        tok.renderable = true;
        if (tok.mesh && !tok.mesh.destroyed) tok.mesh.renderable = true;
      }
    }
    this._roofHiddenTokens.clear();
    this._lastRoofOccSig = "";
    this._revealTileKeys.clear();

    for (const [, ov] of this.activeOverlays) {
      if (ov.wallsMesh) { ov.wallsMesh.parent?.removeChild(ov.wallsMesh); ov.wallsMesh.destroy(); }
      if (ov.roofMesh) { ov.roofMesh.parent?.removeChild(ov.roofMesh); ov.roofMesh.destroy(); }
    }
    this.activeOverlays.clear();
    this.overlayPending.clear();

    for (const [, vt] of this.activeVirtualTiles) {
      if (vt.mesh) { vt.mesh.parent?.removeChild(vt.mesh); vt.mesh.destroy(); }
    }
    this.activeVirtualTiles.clear();
    this.virtualTilePending.clear();

    for (const m of this.meshPool) m.destroy();
    this.meshPool = [];

    this.levelLayers.clear();
    this.visibleLevelLayers = [];
    this.texMgr.clear();
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
registerFogControls(controller);
registerWallEditorControls(controller);
registerLayerEditorControls(controller);

Hooks.once("init", () => {
  installLazyTokenLayerPatch();
});

Hooks.once("ready", async () => {
  controller._ensureSocket();
  await controller.migrateLegacyScenes();
});

Hooks.on("canvasReady", (c) => {
  controller.mount(c.scene);
});

Hooks.on("updateScene", (scene, changes) => {
  controller.onSceneUpdate(scene, changes);
});

Hooks.on("canvasPan", () => {
  if (!controller.active) return;
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
    controller._roofTokenOccDirty = true;
  });
});

Hooks.on("lightingRefresh", (effects) => {
  if (!controller.active) return;
  controller.onLightingRefresh(effects);
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
  });
});

Hooks.on("updateToken", (doc, changes) => {
  if (!controller.active) return;
  controller.tokenStreamer.onTokenUpdated(doc, changes);
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

Hooks.on("createToken", (doc) => {
  if (!controller.active) return;
  controller.tokenStreamer.onTokenCreated(doc);
  controller._depthDirty = true;
  controller._syncInterfaceVoidFilter();
  controller.updateSimAndLightBubbles(false);
  controller.syncRoofTokenOcclusion();
});

Hooks.on("deleteToken", (doc) => {
  if (!controller.active) return;
  controller.tokenStreamer.onTokenDeleted(doc);
  controller._depthDirty = true;
  controller._syncInterfaceVoidFilter();
  controller.updateSimAndLightBubbles(false);
});

// React seamlessly to native TileDocuments added/edited/removed on any level (floors blocking lower-level lights, roofs, etc.)
for (const hookName of ["createTile", "updateTile", "deleteTile"]) {
  Hooks.on(hookName, () => {
    if (!controller.active) return;
    controller._depthDirty = true;
    controller._depthElevSyncNeeded = true;
    controller._occlusionDirty = true;
  });
}

// React to native WallDocuments added/edited/removed on any level so GPU light shadows stay in sync
for (const hookName of ["createWall", "updateWall", "deleteWall"]) {
  Hooks.on(hookName, () => {
    if (!controller.active || !controller.visibleLevelLayers.length) return;
    controller.scheduleLightBatchRebuild();
  });
}

// React to ALT highlight & v14 Region/Surface changes so CanvasDepthMask and z=5 interior reveal sync immediately
Hooks.on("highlightObjects", () => {
  if (!controller.active) return;
  controller._depthDirty = true;
});

for (const hookName of ["createRegion", "updateRegion", "deleteRegion", "createRegionBehavior", "updateRegionBehavior", "deleteRegionBehavior"]) {
  Hooks.on(hookName, () => {
    if (!controller.active) return;
    controller._depthDirty = true;
    controller._occlusionDirty = true;
  });
}

Hooks.on("canvasTearDown", () => {
  controller.unmount();
});

globalThis.Boundless = controller;
export { controller as Boundless };
