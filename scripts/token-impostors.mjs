const MODULE_ID = "boundless";
const CELL_PX = 64;
const PAD_PX = 4;
const CONTENT_PX = CELL_PX - PAD_PX * 2; // 56x56 art inside 64x64 cell -> 4px guard band against mip bleed
const INITIAL_ATLAS_PX = 1024;           // 16x16 = 256 unique portraits (~5.3 MB VRAM)
const MAX_ATLAS_PX = 2048;               // 32x32 = 1024 unique portraits (~21.3 MB VRAM)
const MAX_CONCURRENT_DECODES = 4;
const PARTY_MIN_SCREEN_RADIUS = 11.0;    // Readable ~22px medallion on orbital view for PCs only

const IMPOSTOR_VERT = `
precision highp float;

attribute vec2 aCenter;
attribute vec2 aCorner;
attribute vec4 aSizeInfo;  // x: halfSizeWorld, y: minScreenPx (0 for NPCs), z: rotationRad, w: elevation
attribute vec4 aAtlasRect; // x: u0, y: v0, z: uSpan, w: hasSlot (0/1)
attribute vec3 aRingColor;
attribute vec3 aAvgColor;
attribute vec4 aState;     // x: alpha (<=0 culled), y: needsVisionMask, z: isParty, w: ringEnabled

uniform mat3 translationMatrix;
uniform mat3 projectionMatrix;
uniform vec2 uScreenDimensions;
uniform float uStageScale;

varying vec2 vLocal;
varying vec2 vSamplerUvs;
varying vec2 vWorldPos;
varying vec4 vAtlasRect;
varying vec3 vRingColor;
varying vec3 vAvgColor;
varying float vAlpha;
varying float vScreenRadius;
varying float vRot;
varying float vElevation;
varying float vNeedsVision;
varying float vIsParty;
varying float vRingEnabled;

void main() {
  float scale = max(uStageScale, 0.0005);
  float baseAlpha = aState.x;
  float isParty = aState.z;

  // Regular NPCs stay strictly world-space and fade gently away on deep orbit (< 2.5px) instead of forming radar clutter.
  // Party PCs remain readable as subtle medallions on orbital zoom and smoothly shrink to 1:1 token size by scale 0.125.
  float npcOrbitFade = mix(smoothstep(0.024, 0.052, scale), 1.0, isParty);
  float finalAlpha = baseAlpha * npcOrbitFade;

  if (finalAlpha <= 0.002 || aSizeInfo.x <= 0.0) {
    vAlpha = 0.0;
    vLocal = vec2(2.0);
    vSamplerUvs = vec2(0.0);
    vWorldPos = vec2(0.0);
    vAtlasRect = vec4(0.0);
    vRingColor = vec3(0.0);
    vAvgColor = vec3(0.0);
    vScreenRadius = 0.0;
    vRot = 0.0;
    vElevation = 0.0;
    vNeedsVision = 0.0;
    vIsParty = 0.0;
    vRingEnabled = 0.0;
    gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
    return;
  }

  float medalBlend = isParty * (1.0 - smoothstep(0.075, 0.125, scale));
  float minWorldHalf = (aSizeInfo.y * medalBlend) / scale;
  float effHalf = max(aSizeInfo.x, minWorldHalf);
  float quadHalf = effHalf * 1.12;

  vec2 worldPos = aCenter + aCorner * quadHalf;
  vec3 tPos = translationMatrix * vec3(worldPos, 1.0);

  vLocal = aCorner * 1.12;
  vSamplerUvs = tPos.xy / max(uScreenDimensions, vec2(1.0));
  vWorldPos = worldPos;
  vAtlasRect = aAtlasRect;
  vRingColor = aRingColor;
  vAvgColor = aAvgColor;
  vAlpha = finalAlpha;
  vScreenRadius = effHalf * scale;
  vRot = aSizeInfo.z;
  vElevation = aSizeInfo.w;
  vNeedsVision = aState.y;
  vIsParty = isParty;
  vRingEnabled = aState.w;

  gl_Position = vec4((projectionMatrix * tPos).xy, 0.0, 1.0);
}
`;

const IMPOSTOR_FRAG = `
precision highp float;

uniform sampler2D uAtlas;
uniform sampler2D uVisionTex;
uniform bool uUseVisionMask;
uniform sampler2D uBakedRoofMask;
uniform bool uUseBakedRoofMask;
uniform vec2 uBakedRoofOrigin;
uniform vec2 uBakedRoofRegion;
uniform bool uBakedRoofRepeat;
uniform float uRoofElev;

varying vec2 vLocal;
varying vec2 vSamplerUvs;
varying vec2 vWorldPos;
varying vec4 vAtlasRect;
varying vec3 vRingColor;
varying vec3 vAvgColor;
varying float vAlpha;
varying float vScreenRadius;
varying float vRot;
varying float vElevation;
varying float vNeedsVision;
varying float vIsParty;
varying float vRingEnabled;

void main() {
  if (vAlpha <= 0.002) discard;

  // 1. GPU Vision Mask safety net: never leak non-owned enemies inside explored-only FoW
  if (uUseVisionMask && vNeedsVision > 0.5) {
    float vis = texture2D(uVisionTex, vSamplerUvs).r;
    if (vis < 0.05) discard;
  }

  // 2. Pixel-accurate baked roof mask when native roof meshes are unloaded on macro zoom
  if (uUseBakedRoofMask && vElevation < uRoofElev) {
    vec2 rawRoofUv = (vWorldPos - uBakedRoofOrigin) / max(uBakedRoofRegion, vec2(1.0));
    bool inRoofBounds = uBakedRoofRepeat || (rawRoofUv.x >= 0.0 && rawRoofUv.x <= 1.0 && rawRoofUv.y >= 0.0 && rawRoofUv.y <= 1.0);
    if (inRoofBounds) {
      vec2 roofUv = uBakedRoofRepeat ? fract(rawRoofUv) : rawRoofUv;
      float roofAlpha = texture2D(uBakedRoofMask, roofUv).a;
      if (roofAlpha > 0.72) discard;
    }
  }

  float r = length(vLocal);
  float aa = clamp(1.35 / max(vScreenRadius, 1.0), 0.015, 0.25);

  // Subtle grounded drop shadow slightly offset downwards
  float shadowDist = length(vLocal - vec2(0.0, 0.08));
  float shadowAlpha = (1.0 - smoothstep(0.84, 1.10, shadowDist)) * 0.36;

  float hasSlot = vAtlasRect.w;
  float portraitMix = smoothstep(2.8, 7.2, vScreenRadius) * hasSlot;

  // Sample rotated atlas slot (strictly clamped inside the 56x56 inner content rect)
  vec4 texSample = vec4(0.0);
  if (portraitMix > 0.001) {
    float c = cos(-vRot);
    float s = sin(-vRot);
    vec2 rotLocal = vec2(vLocal.x * c - vLocal.y * s, vLocal.x * s + vLocal.y * c);
    vec2 localUv = rotLocal * 0.5 + 0.5;
    if (localUv.x >= 0.0 && localUv.x <= 1.0 && localUv.y >= 0.0 && localUv.y <= 1.0) {
      vec2 clamped = clamp(localUv, vec2(0.01), vec2(0.99));
      vec2 atlasUv = vAtlasRect.xy + clamped * vAtlasRect.z;
      texSample = texture2D(uAtlas, atlasUv);
    }
  }

  // Free-form transparent token art (no dynamic ring and not an orbital party medallion)
  if (vRingEnabled < 0.5 && vIsParty < 0.5 && portraitMix > 0.45) {
    // texSample is premultiplied; blend cleanly over soft ground shadow
    vec3 shadowRgb = vec3(0.02, 0.02, 0.03) * shadowAlpha;
    vec3 rgb = texSample.rgb + shadowRgb * (1.0 - texSample.a);
    float outA = texSample.a + shadowAlpha * (1.0 - texSample.a);
    if (outA <= 0.005) discard;
    gl_FragColor = vec4(rgb, outA) * vAlpha;
    return;
  }

  // Circular token / Dynamic Ring / orbital medallion / instant placeholder while atlas slot loads
  float discMask = 1.0 - smoothstep(0.98 - aa, 0.98 + aa, r);
  float rimWidth = clamp(1.35 / max(vScreenRadius, 1.0), 0.065, 0.22);
  float innerRadius = 0.98 - rimWidth;
  float innerMask = 1.0 - smoothstep(innerRadius - aa, innerRadius + aa, r);

  // Soft interior fill: portrait smoothly morphing from avg color as token grows past 3..7px
  vec3 fillRgb = mix(vAvgColor, vRingColor * 0.62, 0.18);
  if (portraitMix > 0.001) {
    vec3 straightTex = texSample.a > 0.01 ? (texSample.rgb / texSample.a) : fillRgb;
    vec3 overFill = mix(fillRgb, straightTex, texSample.a);
    fillRgb = mix(fillRgb, overFill, portraitMix);
  }

  // Subtle rim bevel highlight
  float bevel = 0.88 + 0.18 * clamp(-vLocal.y * 0.5 + 0.5, 0.0, 1.0);
  vec3 rimRgb = vRingColor * bevel;
  vec3 bodyRgb = mix(rimRgb, fillRgb, innerMask);

  // Composite disc over grounded shadow (premultiplied output)
  vec3 outRgb = bodyRgb * discMask + vec3(0.02, 0.02, 0.03) * shadowAlpha * (1.0 - discMask);
  float outA = discMask + shadowAlpha * (1.0 - discMask);
  if (outA <= 0.005) discard;

  gl_FragColor = vec4(outRgb, outA) * vAlpha;
}
`;

function getDispositionRingColor(doc, isParty) {
  if (isParty) return [0.96, 0.79, 0.39]; // Warm gold for PCs
  const ringCol = doc._source?.ring?.enabled ? doc._source?.ring?.colors?.ring : null;
  if (ringCol) {
    try {
      const c = foundry.utils.Color.from(ringCol);
      if (c?.rgb) return [c.rgb[0], c.rgb[1], c.rgb[2]];
    } catch {}
  }
  const disp = doc._source?.disposition ?? doc.disposition ?? 0;
  if (disp === 1) return [0.40, 0.85, 0.54];   // Friendly
  if (disp === -1) return [0.88, 0.35, 0.32];  // Hostile
  if (disp === -2) return [0.62, 0.44, 0.91];  // Secret
  return [0.88, 0.76, 0.36];                   // Neutral
}

function getSafeTokenArtSrc(doc) {
  const srcRing = doc._source?.ring;
  if (srcRing?.enabled) {
    const subj = srcRing.subject?.texture || doc.ring?.subject?.texture;
    if (subj) return subj;
  }
  return doc._source?.texture?.src || doc.texture?.src || doc.baseActor?.img || "";
}

function isPartyTokenDoc(doc) {
  if (!doc) return false;
  const base = doc.baseActor;
  if (base?.hasPlayerOwner || base?.type === "character") return true;
  if (doc._source?.actorLink && base?.isOwner) return true;
  return false;
}

function isOwnedByCurrentUserSafe(doc) {
  const base = doc?.baseActor;
  if (!base) return false;
  if (base.isOwner) return true;
  if (typeof base.testUserPermission === "function" && game.user) {
    try { return base.testUserPermission(game.user, "OWNER"); } catch {}
  }
  return false;
}

/**
 * Single-draw-call Dynamic Texture Atlas Token Impostor Layer mounted inside `canvas.primary`.
 * - Eliminates token pop-in from empty air when descending from orbital/sky zoom.
 * - Zero `doc.actor` touches (preserves Foundry v14 lazy `ActorDelta`).
 * - Strict Foundry v14 visibility enforcement (CPU `testVisibility` + GPU `uVisionTex` + baked roof mask).
 */
export class TokenImpostorLayer {
  constructor(controller, streamer) {
    this.controller = controller;
    this.streamer = streamer;

    this.mounted = false;
    this.sceneId = null;

    // Dynamic texture atlas (Canvas2D -> PIXI.Texture, starts 1024x1024, auto-grows to 2048x2048)
    this.atlasSize = INITIAL_ATLAS_PX;
    this.atlasCanvas = null;
    this.atlasCtx = null;
    this.atlasTexture = null;
    this.atlasDirty = false;
    this.slotsBySrc = new Map(); // src -> { col, row, u0, v0, uSpan, avgRgb, ready, failed }
    this.nextSlotIdx = 0;
    this._decodeQueue = [];
    this._decodeQueuedSet = new Set();
    this._activeDecodes = 0;
    this._gen = 0;

    // Packed GPU geometry (4 verts + 6 indices per tracked token)
    this.mesh = null;
    this.shader = null;
    this.geometry = null;
    this.capacity = 0;
    this.count = 0;
    this.docIndexById = new Map(); // docId -> slotIndex [0..count-1]
    this.docIds = [];              // slotIndex -> docId
    this.docSrcById = new Map();   // docId -> art src
    this.docsBySrc = new Map();    // src -> Set<docId>

    // Backing typed arrays & PIXI buffers
    this.centerArr = null;
    this.cornerArr = null;
    this.sizeInfoArr = null;
    this.atlasRectArr = null;
    this.ringColorArr = null;
    this.avgColorArr = null;
    this.stateArr = null;
    this.indexArr = null;

    this.centerBuf = null;
    this.sizeInfoBuf = null;
    this.atlasRectBuf = null;
    this.ringColorBuf = null;
    this.avgColorBuf = null;
    this.stateBuf = null;

    this._bufDirty = {
      center: false,
      sizeInfo: false,
      atlasRect: false,
      ringColor: false,
      avgColor: false,
      state: false
    };

    // Per-token fade overrides (docId -> impostorAlphaMultiplier in [0..1]) driven by TokenStreamer crossfades
    this.fadeOverrides = new Map();
    this._visibilityDirty = true;
    this._lastVisSyncMs = 0;
  }

  mount(scene) {
    this.unmount();
    if (!scene || !canvas?.primary || typeof PIXI === "undefined") return;
    this.mounted = true;
    this.sceneId = scene.id;
    this._gen++;

    this._initAtlas();
    this._initShader();
    this.rebuildFromScene(scene);
  }

  unmount() {
    this.mounted = false;
    this.sceneId = null;
    this._gen++;

    this._decodeQueue = [];
    this._decodeQueuedSet.clear();
    this._activeDecodes = 0;
    this.fadeOverrides.clear();

    if (this.mesh) {
      this.mesh.parent?.removeChild(this.mesh);
      try { this.mesh.destroy({ children: false }); } catch {}
      this.mesh = null;
    }
    if (this.geometry) {
      try { this.geometry.destroy(); } catch {}
      this.geometry = null;
    }
    this.shader = null;

    if (this.atlasTexture) {
      try { this.atlasTexture.destroy(true); } catch {}
      this.atlasTexture = null;
    }
    this.atlasCanvas = null;
    this.atlasCtx = null;
    this.atlasDirty = false;
    this.atlasSize = INITIAL_ATLAS_PX;
    this.slotsBySrc.clear();
    this.nextSlotIdx = 0;

    this.capacity = 0;
    this.count = 0;
    this.docIndexById.clear();
    this.docIds = [];
    this.docSrcById.clear();
    this.docsBySrc.clear();
    this.centerArr = null;
    this.cornerArr = null;
    this.sizeInfoArr = null;
    this.atlasRectArr = null;
    this.ringColorArr = null;
    this.avgColorArr = null;
    this.stateArr = null;
    this.indexArr = null;
    this.centerBuf = null;
    this.sizeInfoBuf = null;
    this.atlasRectBuf = null;
    this.ringColorBuf = null;
    this.avgColorBuf = null;
    this.stateBuf = null;
    this._visibilityDirty = true;
  }

  _initAtlas() {
    this.atlasSize = INITIAL_ATLAS_PX;
    if (typeof document !== "undefined" && typeof document.createElement === "function") {
      const c = document.createElement("canvas");
      c.width = this.atlasSize;
      c.height = this.atlasSize;
      this.atlasCanvas = c;
      this.atlasCtx = c.getContext("2d", { willReadFrequently: true });
      this.atlasCtx?.clearRect(0, 0, this.atlasSize, this.atlasSize);
      const base = PIXI.BaseTexture.from(c, {
        scaleMode: PIXI.SCALE_MODES.LINEAR,
        mipmap: PIXI.MIPMAP_MODES.ON,
        wrapMode: PIXI.WRAP_MODES.CLAMP,
        alphaMode: PIXI.ALPHA_MODES.PMA,
        resolution: 1
      });
      this.atlasTexture = new PIXI.Texture(base);
    } else {
      this.atlasTexture = PIXI.Texture.WHITE;
    }
  }

  _growAtlasToMax() {
    if (this.atlasSize >= MAX_ATLAS_PX || !this.atlasCanvas || !this.atlasCtx) return false;
    const oldSize = this.atlasSize;
    const oldCanvas = this.atlasCanvas;
    this.atlasSize = MAX_ATLAS_PX;

    const nextCanvas = document.createElement("canvas");
    nextCanvas.width = this.atlasSize;
    nextCanvas.height = this.atlasSize;
    const nextCtx = nextCanvas.getContext("2d", { willReadFrequently: true });
    nextCtx.clearRect(0, 0, this.atlasSize, this.atlasSize);
    nextCtx.drawImage(oldCanvas, 0, 0);

    this.atlasCanvas = nextCanvas;
    this.atlasCtx = nextCtx;

    const oldTex = this.atlasTexture;
    const base = PIXI.BaseTexture.from(nextCanvas, {
      scaleMode: PIXI.SCALE_MODES.LINEAR,
      mipmap: PIXI.MIPMAP_MODES.ON,
      wrapMode: PIXI.WRAP_MODES.CLAMP,
      alphaMode: PIXI.ALPHA_MODES.PMA,
      resolution: 1
    });
    this.atlasTexture = new PIXI.Texture(base);
    if (this.shader?.uniforms) this.shader.uniforms.uAtlas = this.atlasTexture;
    try { oldTex?.destroy?.(true); } catch {}

    // Recompute UVs for existing slots since atlas doubled in width & height
    const inv = 1 / this.atlasSize;
    const uSpan = CONTENT_PX * inv;
    for (const [src, slot] of this.slotsBySrc) {
      slot.u0 = (slot.col * CELL_PX + PAD_PX) * inv;
      slot.v0 = (slot.row * CELL_PX + PAD_PX) * inv;
      slot.uSpan = uSpan;
      if (slot.ready) this._applySlotToDocs(src, slot);
    }
    this.atlasDirty = true;
    return true;
  }

  _initShader() {
    const screenDims = new Float32Array([
      canvas.screenDimensions?.[0] || 1,
      canvas.screenDimensions?.[1] || 1
    ]);
    this.shader = PIXI.Shader.from(IMPOSTOR_VERT, IMPOSTOR_FRAG, {
      uScreenDimensions: screenDims,
      uStageScale: canvas.stage?.scale?.x || 1,
      uAtlas: this.atlasTexture || PIXI.Texture.WHITE,
      uVisionTex: PIXI.Texture.WHITE,
      uUseVisionMask: false,
      uBakedRoofMask: PIXI.Texture.EMPTY,
      uUseBakedRoofMask: false,
      uBakedRoofOrigin: new Float32Array([0, 0]),
      uBakedRoofRegion: new Float32Array([100000, 100000]),
      uBakedRoofRepeat: false,
      uRoofElev: (canvas.level?.elevation?.top ?? 20)
    });
    this.shader.update = () => this._updateUniforms();
  }

  _updateUniforms() {
    const u = this.shader?.uniforms;
    if (!u || !canvas?.ready) return;
    u.uStageScale = canvas.stage?.scale?.x || 1;
    u.uScreenDimensions[0] = canvas.screenDimensions?.[0] || 1;
    u.uScreenDimensions[1] = canvas.screenDimensions?.[1] || 1;
    u.uAtlas = this.atlasTexture || PIXI.Texture.WHITE;

    const visionTex = canvas.masks?.vision?.renderTexture;
    const useVision = Boolean(canvas.visibility?.tokenVision && !game.user?.isGM && visionTex);
    u.uUseVisionMask = useVision;
    if (useVision) u.uVisionTex = visionTex;

    const lb = this.controller?.lightBatch;
    const hasRoof = Boolean(lb?.useBakedRoofMask && lb.bakedRoofMask && !lb.bakedRoofMask.destroyed);
    u.uUseBakedRoofMask = hasRoof;
    if (hasRoof) {
      u.uBakedRoofMask = lb.bakedRoofMask;
      u.uBakedRoofOrigin[0] = lb.bakedRoofOrigin[0];
      u.uBakedRoofOrigin[1] = lb.bakedRoofOrigin[1];
      u.uBakedRoofRegion[0] = lb.bakedRoofRegion[0];
      u.uBakedRoofRegion[1] = lb.bakedRoofRegion[1];
      u.uBakedRoofRepeat = Boolean(lb.bakedRoofRepeat);
    }
    u.uRoofElev = canvas.level?.elevation?.top ?? 20;
  }

  _ensureCapacity(minCount) {
    if (minCount <= this.capacity && this.geometry && this.mesh) return;
    const nextCap = Math.max(64, 1 << Math.ceil(Math.log2(Math.max(64, minCount + 32))));
    const verts = nextCap * 4;
    const indices = nextCap * 6;

    const nextCenter = new Float32Array(verts * 2);
    const nextCorner = new Float32Array(verts * 2);
    const nextSizeInfo = new Float32Array(verts * 4);
    const nextAtlasRect = new Float32Array(verts * 4);
    const nextRingColor = new Float32Array(verts * 3);
    const nextAvgColor = new Float32Array(verts * 3);
    const nextState = new Float32Array(verts * 4);

    // Pre-fill unit quad corners and triangle indices
    for (let i = 0; i < nextCap; i++) {
      const o = i * 8;
      nextCorner[o] = -1; nextCorner[o + 1] = -1;
      nextCorner[o + 2] = 1; nextCorner[o + 3] = -1;
      nextCorner[o + 4] = 1; nextCorner[o + 5] = 1;
      nextCorner[o + 6] = -1; nextCorner[o + 7] = 1;
    }

    const IdxArr = verts > 65535 ? Uint32Array : Uint16Array;
    const nextIdx = new IdxArr(indices);
    for (let i = 0; i < nextCap; i++) {
      const v0 = i * 4;
      const io = i * 6;
      nextIdx[io] = v0;
      nextIdx[io + 1] = v0 + 1;
      nextIdx[io + 2] = v0 + 2;
      nextIdx[io + 3] = v0;
      nextIdx[io + 4] = v0 + 2;
      nextIdx[io + 5] = v0 + 3;
    }

    if (this.count > 0 && this.centerArr) {
      const copyVerts = this.count * 4;
      nextCenter.set(this.centerArr.subarray(0, copyVerts * 2));
      nextSizeInfo.set(this.sizeInfoArr.subarray(0, copyVerts * 4));
      nextAtlasRect.set(this.atlasRectArr.subarray(0, copyVerts * 4));
      nextRingColor.set(this.ringColorArr.subarray(0, copyVerts * 3));
      nextAvgColor.set(this.avgColorArr.subarray(0, copyVerts * 3));
      nextState.set(this.stateArr.subarray(0, copyVerts * 4));
    }

    this.capacity = nextCap;
    this.centerArr = nextCenter;
    this.cornerArr = nextCorner;
    this.sizeInfoArr = nextSizeInfo;
    this.atlasRectArr = nextAtlasRect;
    this.ringColorArr = nextRingColor;
    this.avgColorArr = nextAvgColor;
    this.stateArr = nextState;
    this.indexArr = nextIdx;

    this.centerBuf = new PIXI.Buffer(nextCenter, false, false);
    this.sizeInfoBuf = new PIXI.Buffer(nextSizeInfo, false, false);
    this.atlasRectBuf = new PIXI.Buffer(nextAtlasRect, false, false);
    this.ringColorBuf = new PIXI.Buffer(nextRingColor, false, false);
    this.avgColorBuf = new PIXI.Buffer(nextAvgColor, false, false);
    this.stateBuf = new PIXI.Buffer(nextState, false, false);

    const oldMesh = this.mesh;
    const oldGeom = this.geometry;

    this.geometry = new PIXI.Geometry()
      .addAttribute("aCenter", this.centerBuf, 2)
      .addAttribute("aCorner", new PIXI.Buffer(nextCorner, true, false), 2)
      .addAttribute("aSizeInfo", this.sizeInfoBuf, 4)
      .addAttribute("aAtlasRect", this.atlasRectBuf, 4)
      .addAttribute("aRingColor", this.ringColorBuf, 3)
      .addAttribute("aAvgColor", this.avgColorBuf, 3)
      .addAttribute("aState", this.stateBuf, 4)
      .addIndex(nextIdx);

    const PrimaryCanvasGroup = foundry.canvas?.groups?.PrimaryCanvasGroup;
    const mesh = new PIXI.Mesh(this.geometry, this.shader);
    mesh.name = "BoundlessTokenImpostors";
    mesh.blendMode = PIXI.BLEND_MODES.NORMAL;
    mesh.eventMode = "none";
    mesh.cullable = false;
    mesh.elevation = canvas.level?.elevation?.bottom ?? 0;
    mesh.sortLayer = PrimaryCanvasGroup?.SORT_LAYERS?.TOKENS ?? 700;
    mesh.sort = -1000;
    mesh.zIndex = -1000;
    mesh.size = this.count * 6;
    mesh.visible = this.count > 0;

    if (oldMesh) {
      oldMesh.parent?.removeChild(oldMesh);
      try { oldMesh.destroy({ children: false }); } catch {}
    }
    if (oldGeom) {
      try { oldGeom.destroy(); } catch {}
    }

    this.mesh = mesh;
    if (canvas?.primary) {
      canvas.primary.addChild(mesh);
      canvas.primary.sortDirty = true;
    }
  }

  _writeQuad2(arr, slotIdx, a, b) {
    const o = slotIdx * 8;
    arr[o] = a; arr[o + 1] = b;
    arr[o + 2] = a; arr[o + 3] = b;
    arr[o + 4] = a; arr[o + 5] = b;
    arr[o + 6] = a; arr[o + 7] = b;
  }

  _writeQuad3(arr, slotIdx, a, b, c) {
    const o = slotIdx * 12;
    arr[o] = a; arr[o + 1] = b; arr[o + 2] = c;
    arr[o + 3] = a; arr[o + 4] = b; arr[o + 5] = c;
    arr[o + 6] = a; arr[o + 7] = b; arr[o + 8] = c;
    arr[o + 9] = a; arr[o + 10] = b; arr[o + 11] = c;
  }

  _writeQuad4(arr, slotIdx, a, b, c, d) {
    const o = slotIdx * 16;
    arr[o] = a; arr[o + 1] = b; arr[o + 2] = c; arr[o + 3] = d;
    arr[o + 4] = a; arr[o + 5] = b; arr[o + 6] = c; arr[o + 7] = d;
    arr[o + 8] = a; arr[o + 9] = b; arr[o + 10] = c; arr[o + 11] = d;
    arr[o + 12] = a; arr[o + 13] = b; arr[o + 14] = c; arr[o + 15] = d;
  }

  _requestAtlasSlot(src) {
    if (!src) return null;
    let slot = this.slotsBySrc.get(src);
    if (slot) return slot;

    const colsPerRow = Math.floor(this.atlasSize / CELL_PX);
    const maxSlots = colsPerRow * colsPerRow;
    if (this.nextSlotIdx >= maxSlots) {
      if (!this._growAtlasToMax()) return null;
    }

    const curCols = Math.floor(this.atlasSize / CELL_PX);
    const idx = this.nextSlotIdx++;
    const col = idx % curCols;
    const row = Math.floor(idx / curCols);
    const inv = 1 / this.atlasSize;

    slot = {
      col,
      row,
      u0: (col * CELL_PX + PAD_PX) * inv,
      v0: (row * CELL_PX + PAD_PX) * inv,
      uSpan: CONTENT_PX * inv,
      avgRgb: null,
      ready: false,
      failed: false
    };
    this.slotsBySrc.set(src, slot);

    if (!this._decodeQueuedSet.has(src)) {
      this._decodeQueuedSet.add(src);
      this._decodeQueue.push(src);
      this._pumpAtlasDecodes();
    }
    return slot;
  }

  _pumpAtlasDecodes() {
    if (!this.mounted || !this.atlasCtx) return;
    while (this._activeDecodes < MAX_CONCURRENT_DECODES && this._decodeQueue.length > 0) {
      const src = this._decodeQueue.shift();
      this._decodeQueuedSet.delete(src);
      const slot = this.slotsBySrc.get(src);
      if (!slot || slot.ready || slot.failed) continue;
      this._activeDecodes++;
      const gen = this._gen;
      this._decodeAndPack(src, slot, gen).finally(() => {
        this._activeDecodes = Math.max(0, this._activeDecodes - 1);
        if (this.mounted && gen === this._gen && this._decodeQueue.length > 0) {
          this._pumpAtlasDecodes();
        }
      });
    }
  }

  async _decodeAndPack(src, slot, gen) {
    if (!this.mounted || gen !== this._gen || !this.atlasCtx) return;
    let drawable = null;
    let shouldClose = false;

    try {
      const lower = String(src).split("?")[0].toLowerCase();
      const isSvg = lower.endsWith(".svg");
      if (!isSvg && typeof fetch === "function" && typeof createImageBitmap === "function") {
        const res = await fetch(src);
        if (res.ok) {
          const blob = await res.blob();
          drawable = await createImageBitmap(blob, {
            resizeWidth: CONTENT_PX,
            resizeHeight: CONTENT_PX,
            resizeQuality: "high"
          });
          shouldClose = true;
        }
      }
      if (!drawable && typeof Image !== "undefined") {
        drawable = await new Promise((resolve, reject) => {
          const img = new Image();
          img.crossOrigin = "anonymous";
          img.onload = () => resolve(img);
          img.onerror = reject;
          img.src = src;
        });
      }
    } catch {
      slot.failed = true;
      return;
    }

    if (!drawable || !this.mounted || gen !== this._gen || !this.atlasCtx) {
      if (shouldClose) try { drawable?.close?.(); } catch {}
      return;
    }

    try {
      const ctx = this.atlasCtx;
      const cellX = slot.col * CELL_PX;
      const cellY = slot.row * CELL_PX;
      const dstX = cellX + PAD_PX;
      const dstY = cellY + PAD_PX;

      ctx.clearRect(cellX, cellY, CELL_PX, CELL_PX);

      // Fit preserving aspect ratio centered in 56x56 content area
      const sw = drawable.width || CONTENT_PX;
      const sh = drawable.height || CONTENT_PX;
      const aspect = sw / Math.max(1, sh);
      let dw = CONTENT_PX;
      let dh = CONTENT_PX;
      if (aspect > 1) dh = CONTENT_PX / aspect;
      else if (aspect < 1) dw = CONTENT_PX * aspect;
      const ox = dstX + (CONTENT_PX - dw) * 0.5;
      const oy = dstY + (CONTENT_PX - dh) * 0.5;

      ctx.drawImage(drawable, ox, oy, dw, dh);

      // Compute average RGB from opaque pixels for seamless orbital morph
      let rSum = 0, gSum = 0, bSum = 0, n = 0;
      try {
        const imgData = ctx.getImageData(dstX, dstY, CONTENT_PX, CONTENT_PX).data;
        for (let py = 4; py < CONTENT_PX - 4; py += 6) {
          for (let px = 4; px < CONTENT_PX - 4; px += 6) {
            const o = (py * CONTENT_PX + px) * 4;
            if (imgData[o + 3] > 40) {
              rSum += imgData[o];
              gSum += imgData[o + 1];
              bSum += imgData[o + 2];
              n++;
            }
          }
        }
      } catch {}

      slot.avgRgb = n > 0
        ? [rSum / (n * 255), gSum / (n * 255), bSum / (n * 255)]
        : [0.65, 0.65, 0.65];
      slot.ready = true;
      this.atlasDirty = true;
      this._applySlotToDocs(src, slot);
    } catch {
      slot.failed = true;
    } finally {
      if (shouldClose) try { drawable.close(); } catch {}
    }
  }

  _applySlotToDocs(src, slot) {
    const ids = this.docsBySrc.get(src);
    if (!ids?.size || !this.atlasRectArr) return;
    for (const docId of ids) {
      const idx = this.docIndexById.get(docId);
      if (idx === undefined) continue;
      this._writeQuad4(this.atlasRectArr, idx, slot.u0, slot.v0, slot.uSpan, 1.0);
      this._bufDirty.atlasRect = true;
      if (slot.avgRgb) {
        this._writeQuad3(this.avgColorArr, idx, slot.avgRgb[0], slot.avgRgb[1], slot.avgRgb[2]);
        this._bufDirty.avgColor = true;
      }
    }
  }

  _registerDocSrc(docId, nextSrc) {
    const prevSrc = this.docSrcById.get(docId);
    if (prevSrc === nextSrc) return;
    if (prevSrc) {
      const oldSet = this.docsBySrc.get(prevSrc);
      if (oldSet) {
        oldSet.delete(docId);
        if (oldSet.size === 0) this.docsBySrc.delete(prevSrc);
      }
    }
    if (nextSrc) {
      this.docSrcById.set(docId, nextSrc);
      let set = this.docsBySrc.get(nextSrc);
      if (!set) {
        set = new Set();
        this.docsBySrc.set(nextSrc, set);
      }
      set.add(docId);
    } else {
      this.docSrcById.delete(docId);
    }
  }

  rebuildFromScene(scene = canvas?.scene) {
    if (!this.mounted || !scene?.tokens) return;
    const iterable = scene.tokens?.values?.() ?? scene.tokens ?? [];
    const list = [];
    for (const doc of iterable) {
      if (doc?.id) list.push(doc);
    }

    this.docIndexById.clear();
    this.docIds = [];
    this.docSrcById.clear();
    this.docsBySrc.clear();
    this.count = 0;

    this._ensureCapacity(list.length);
    for (let i = 0; i < list.length; i++) {
      this._upsertDocInternal(list[i]);
    }
    if (this.mesh) {
      this.mesh.size = this.count * 6;
      this.mesh.visible = this.count > 0;
    }
    this._visibilityDirty = true;
    this.refreshVisibility(true);
    this.flush();
  }

  _upsertDocInternal(doc) {
    if (!doc?.id) return -1;
    let idx = this.docIndexById.get(doc.id);
    if (idx === undefined) {
      this._ensureCapacity(this.count + 1);
      idx = this.count++;
      this.docIndexById.set(doc.id, idx);
      this.docIds[idx] = doc.id;
      if (this.mesh) {
        this.mesh.size = this.count * 6;
        this.mesh.visible = this.count > 0;
      }
    }

    const grid = canvas.grid?.size || 100;
    const x = Number(doc._source?.x ?? doc.x ?? 0);
    const y = Number(doc._source?.y ?? doc.y ?? 0);
    const w = (Number(doc._source?.width ?? doc.width ?? 1) || 1) * grid;
    const h = (Number(doc._source?.height ?? doc.height ?? 1) || 1) * grid;
    const cx = x + w * 0.5;
    const cy = y + h * 0.5;
    const halfSize = Math.min(w, h) * 0.5;
    const elev = Number(doc._source?.elevation ?? doc.elevation ?? 0);
    const lockRot = Boolean(doc._source?.lockRotation ?? doc.lockRotation);
    const rotRad = lockRot ? 0 : ((Number(doc._source?.rotation ?? doc.rotation ?? 0) || 0) * Math.PI / 180);

    const isParty = isPartyTokenDoc(doc);
    const ringEnabled = Boolean(doc._source?.ring?.enabled);
    const ringRgb = getDispositionRingColor(doc, isParty);
    const src = getSafeTokenArtSrc(doc);
    this._registerDocSrc(doc.id, src);

    const slot = src ? this._requestAtlasSlot(src) : null;
    const hasSlot = Boolean(slot?.ready);
    const avgRgb = slot?.avgRgb || [ringRgb[0] * 0.55, ringRgb[1] * 0.55, ringRgb[2] * 0.55];

    this._writeQuad2(this.centerArr, idx, cx, cy);
    this._writeQuad4(this.sizeInfoArr, idx, halfSize, isParty ? PARTY_MIN_SCREEN_RADIUS : 0.0, rotRad, elev);
    this._writeQuad4(this.atlasRectArr, idx, hasSlot ? slot.u0 : 0, hasSlot ? slot.v0 : 0, hasSlot ? slot.uSpan : 0, hasSlot ? 1.0 : 0.0);
    this._writeQuad3(this.ringColorArr, idx, ringRgb[0], ringRgb[1], ringRgb[2]);
    this._writeQuad3(this.avgColorArr, idx, avgRgb[0], avgRgb[1], avgRgb[2]);

    this._bufDirty.center = true;
    this._bufDirty.sizeInfo = true;
    this._bufDirty.atlasRect = true;
    this._bufDirty.ringColor = true;
    this._bufDirty.avgColor = true;
    return idx;
  }

  upsertToken(doc) {
    if (!this.mounted || !doc?.id) return;
    this._upsertDocInternal(doc);
    this._updateSingleTokenState(doc);
  }

  removeToken(docId) {
    if (!this.mounted || !docId) return;
    const idx = this.docIndexById.get(docId);
    if (idx === undefined) return;

    this._registerDocSrc(docId, null);
    this.fadeOverrides.delete(docId);
    this.docIndexById.delete(docId);

    const lastIdx = this.count - 1;
    if (idx !== lastIdx) {
      const movedId = this.docIds[lastIdx];
      this.docIds[idx] = movedId;
      this.docIndexById.set(movedId, idx);

      this.centerArr.copyWithin(idx * 8, lastIdx * 8, lastIdx * 8 + 8);
      this.sizeInfoArr.copyWithin(idx * 16, lastIdx * 16, lastIdx * 16 + 16);
      this.atlasRectArr.copyWithin(idx * 16, lastIdx * 16, lastIdx * 16 + 16);
      this.ringColorArr.copyWithin(idx * 12, lastIdx * 12, lastIdx * 12 + 12);
      this.avgColorArr.copyWithin(idx * 12, lastIdx * 12, lastIdx * 12 + 12);
      this.stateArr.copyWithin(idx * 16, lastIdx * 16, lastIdx * 16 + 16);

      this._bufDirty.center = true;
      this._bufDirty.sizeInfo = true;
      this._bufDirty.atlasRect = true;
      this._bufDirty.ringColor = true;
      this._bufDirty.avgColor = true;
      this._bufDirty.state = true;
    }

    this.docIds.length = lastIdx;
    this.count = lastIdx;
    if (this.mesh) {
      this.mesh.size = this.count * 6;
      this.mesh.visible = this.count > 0;
    }
  }

  setFadeOverride(docId, multiplier) {
    if (!this.mounted || !docId) return;
    if (multiplier === null || multiplier === undefined) {
      this.fadeOverrides.delete(docId);
    } else {
      this.fadeOverrides.set(docId, Math.max(0, Math.min(1, multiplier)));
    }
    const doc = canvas?.scene?.tokens?.get?.(docId);
    if (doc) this._updateSingleTokenState(doc);
  }

  markVisibilityDirty() {
    this._visibilityDirty = true;
  }

  _collectVisionCheckers() {
    const tokenVision = Boolean(canvas.visibility?.tokenVision ?? canvas.scene?.tokenVision);
    const isGM = Boolean(game.user?.isGM);
    const visionBoxes = [];
    let hasActiveVision = false;

    if (tokenVision) {
      for (const vs of canvas.effects?.visionSources || []) {
        if (!vs?.active) continue;
        hasActiveVision = true;
        const r = Math.max(vs.radius || 0, 200);
        visionBoxes.push({ x: vs.x, y: vs.y, r });
      }
      for (const ls of canvas.effects?.lightSources || []) {
        if (!ls?.active || !ls.data?.vision) continue;
        const r = Math.max(ls.radius || 0, 200);
        visionBoxes.push({ x: ls.x, y: ls.y, r });
      }
    }
    return { tokenVision, isGM, hasActiveVision, visionBoxes };
  }

  _computeTokenAlpha(doc, visCtx) {
    if (!doc || !doc.viewed) return { alpha: 0, needsVision: 0, isParty: 0, ringEnabled: 0 };

    const isParty = isPartyTokenDoc(doc) ? 1.0 : 0.0;
    const ringEnabled = doc._source?.ring?.enabled ? 1.0 : 0.0;
    const isHidden = Boolean(doc._source?.hidden ?? doc.hidden);
    if (isHidden && !visCtx.isGM) return { alpha: 0, needsVision: 1, isParty, ringEnabled };

    const owned = isOwnedByCurrentUserSafe(doc);
    const needsVision = (visCtx.tokenVision && !visCtx.isGM && !owned) ? 1.0 : 0.0;

    // If a native Token placeable is currently visible and renderable (and not actively crossfading in), suppress impostor
    const obj = doc._object;
    const hasFadeOverride = this.fadeOverrides.has(doc.id);
    const nativeVisible = Boolean(
      obj && !obj.destroyed && obj.renderable && obj.visible !== false &&
      obj.mesh && !obj.mesh.destroyed && obj.mesh.renderable && obj.mesh.visible !== false
    );
    if (nativeVisible && !hasFadeOverride) {
      return { alpha: 0, needsVision, isParty, ringEnabled };
    }

    const grid = canvas.grid?.size || 100;
    const x = Number(doc._source?.x ?? doc.x ?? 0);
    const y = Number(doc._source?.y ?? doc.y ?? 0);
    const w = (Number(doc._source?.width ?? doc.width ?? 1) || 1) * grid;
    const h = (Number(doc._source?.height ?? doc.height ?? 1) || 1) * grid;
    const cx = x + w * 0.5;
    const cy = y + h * 0.5;
    const elev = Number(doc._source?.elevation ?? doc.elevation ?? 0);

    // Roof check: suppress impostor if sitting under a baked pyramid roof when native roofMesh isn't mounted
    const lid = doc._source?.level || doc.level || canvas.level?.id;
    if (this.controller?.isPointUnderBakedRoof?.(lid, cx, cy, elev)) {
      return { alpha: 0, needsVision, isParty, ringEnabled };
    }

    // Strict Foundry v14 tokenVision CPU gate (prevents any leak into explored-only FoW!)
    if (visCtx.tokenVision) {
      if (!visCtx.isGM && !owned) {
        if (!visCtx.hasActiveVision) return { alpha: 0, needsVision, isParty, ringEnabled };
        if (!this._passesVisionCheck(cx, cy, elev, visCtx.visionBoxes)) {
          return { alpha: 0, needsVision, isParty, ringEnabled };
        }
      } else if (visCtx.isGM && visCtx.hasActiveVision && !obj?.controlled) {
        if (!this._passesVisionCheck(cx, cy, elev, visCtx.visionBoxes)) {
          return { alpha: 0, needsVision, isParty, ringEnabled };
        }
      }
    }

    const rawAlpha = Number.isFinite(doc.alpha)
      ? doc.alpha
      : Math.min(Number(doc._source?.alpha ?? 1), isHidden ? 0.5 : 1.0);
    const overrideMult = hasFadeOverride ? this.fadeOverrides.get(doc.id) : 1.0;
    const alpha = Math.max(0, Math.min(1, rawAlpha * overrideMult));
    return { alpha, needsVision, isParty, ringEnabled };
  }

  _passesVisionCheck(cx, cy, elev, visionBoxes) {
    let inAnyBox = false;
    for (let i = 0; i < visionBoxes.length; i++) {
      const b = visionBoxes[i];
      const dx = cx - b.x;
      const dy = cy - b.y;
      if (dx * dx + dy * dy <= b.r * b.r) {
        inAnyBox = true;
        break;
      }
    }
    if (!inAnyBox) return false;
    const tv = canvas.visibility?.testVisibility;
    if (typeof tv !== "function") return true;
    try {
      return Boolean(tv.call(canvas.visibility, { x: cx, y: cy, elevation: elev }, { tolerance: 0 }));
    } catch {
      return false;
    }
  }

  _updateSingleTokenState(doc, visCtx = null) {
    if (!this.mounted || !doc?.id || !this.stateArr) return;
    const idx = this.docIndexById.get(doc.id);
    if (idx === undefined) return;
    const ctx = visCtx || this._collectVisionCheckers();
    const st = this._computeTokenAlpha(doc, ctx);
    const o = idx * 16;
    if (
      Math.abs(this.stateArr[o] - st.alpha) > 0.001 ||
      this.stateArr[o + 1] !== st.needsVision ||
      this.stateArr[o + 2] !== st.isParty ||
      this.stateArr[o + 3] !== st.ringEnabled
    ) {
      this._writeQuad4(this.stateArr, idx, st.alpha, st.needsVision, st.isParty, st.ringEnabled);
      this._bufDirty.state = true;
    }
  }

  refreshVisibility(force = false) {
    if (!this.mounted || !canvas?.scene?.tokens || this.count === 0) return;
    const now = performance.now();
    if (!force && !this._visibilityDirty && (now - this._lastVisSyncMs) < 120) return;
    this._visibilityDirty = false;
    this._lastVisSyncMs = now;

    const visCtx = this._collectVisionCheckers();
    const tokens = canvas.scene.tokens;
    for (let i = 0; i < this.count; i++) {
      const doc = tokens.get(this.docIds[i]);
      if (doc) this._updateSingleTokenState(doc, visCtx);
    }
  }

  flush() {
    if (!this.mounted) return;
    if (this.atlasDirty && this.atlasTexture?.baseTexture) {
      this.atlasDirty = false;
      this.atlasTexture.baseTexture.update();
    }
    if (this._bufDirty.center && this.centerBuf) { this.centerBuf.update(); this._bufDirty.center = false; }
    if (this._bufDirty.sizeInfo && this.sizeInfoBuf) { this.sizeInfoBuf.update(); this._bufDirty.sizeInfo = false; }
    if (this._bufDirty.atlasRect && this.atlasRectBuf) { this.atlasRectBuf.update(); this._bufDirty.atlasRect = false; }
    if (this._bufDirty.ringColor && this.ringColorBuf) { this.ringColorBuf.update(); this._bufDirty.ringColor = false; }
    if (this._bufDirty.avgColor && this.avgColorBuf) { this.avgColorBuf.update(); this._bufDirty.avgColor = false; }
    if (this._bufDirty.state && this.stateBuf) { this.stateBuf.update(); this._bufDirty.state = false; }
  }

  tick() {
    if (!this.mounted) return;
    if (this._visibilityDirty) this.refreshVisibility(false);
    this.flush();
  }

  getStats() {
    let readySlots = 0;
    for (const s of this.slotsBySrc.values()) if (s.ready) readySlots++;
    return {
      mounted: this.mounted,
      trackedTokens: this.count,
      atlasSize: this.atlasSize,
      atlasSlots: this.slotsBySrc.size,
      atlasReady: readySlots,
      pendingDecodes: this._decodeQueue.length + this._activeDecodes
    };
  }
}
