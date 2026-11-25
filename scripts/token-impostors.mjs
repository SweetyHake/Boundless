import {
  MODULE_ID,
  isTextureUsable,
  getLevelBaseElevation as getFiniteLevelBaseElevation,
  getLevelRoofElevation as getFiniteLevelRoofElevation
} from "./utils.mjs";

const CELL_PX = 128;
const PAD_PX = 4;
const CONTENT_PX = CELL_PX - PAD_PX * 2; // 120x120 crisp art inside 128x128 cell (4px guard band against mip bleed)
const ATLAS_PX = 2048;                   // 16x16 = 256 unique crisp 128x128 token portraits (~16 MB VRAM)
const MAX_CONCURRENT_DECODES = 6;

const IMPOSTOR_VERT = `
precision highp float;

attribute vec2 aCenter;
attribute vec2 aCorner;
attribute vec4 aSizeInfo;  // x: halfWWorld, y: halfHWorld, z: rotationRad, w: elevation
attribute vec4 aAtlasRect; // x: u0, y: v0, z: uSpan, w: hasSlot (0/1)
attribute vec4 aFlipAndPad;// x: signX (+1/-1), y: signY (+1/-1), z: scaleMult, w: unused
attribute vec4 aState;     // x: alpha (<=0 culled), y: needsVisionMask, z: isParty, w: unused

uniform mat3 translationMatrix;
uniform mat3 projectionMatrix;
uniform vec2 uScreenDimensions;
uniform float uStageScale;

varying vec2 vLocal;
varying vec2 vSamplerUvs;
varying vec2 vCenterScreenUv;
varying vec2 vWorldPos;
varying vec4 vAtlasRect;
varying vec2 vFlip;
varying float vAlpha;
varying float vScreenRadius;
varying float vRot;
varying float vElevation;
varying float vNeedsVision;

void main() {
  float scale = max(uStageScale, 0.0005);
  float baseAlpha = aState.x;
  float isParty = aState.z;

  // Gently dissolve sub-2.5px NPCs on extreme continental orbit so distant cities stay clean
  float orbitFade = mix(smoothstep(0.022, 0.048, scale), 1.0, isParty * smoothstep(0.012, 0.030, scale));
  float finalAlpha = baseAlpha * orbitFade;

  if (finalAlpha <= 0.002 || aSizeInfo.x <= 0.0 || aSizeInfo.y <= 0.0) {
    vAlpha = 0.0;
    vLocal = vec2(2.0);
    vSamplerUvs = vec2(0.0);
    vCenterScreenUv = vec2(0.0);
    vWorldPos = vec2(0.0);
    vAtlasRect = vec4(0.0);
    vFlip = vec2(1.0);
    vScreenRadius = 0.0;
    vRot = 0.0;
    vElevation = 0.0;
    vNeedsVision = 0.0;
    gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
    return;
  }

  // Respect token texture scale (e.g. pop-out / oversized Hero in a Box art) and rotate in world space
  float sm = max(aFlipAndPad.z, 0.25);
  vec2 localPt = aCorner * vec2(aSizeInfo.x, aSizeInfo.y) * sm;
  float c = cos(aSizeInfo.z);
  float s = sin(aSizeInfo.z);
  vec2 rotPt = vec2(localPt.x * c - localPt.y * s, localPt.x * s + localPt.y * c);
  vec2 worldPos = aCenter + rotPt;
  vec3 tPos = translationMatrix * vec3(worldPos, 1.0);
  vec3 cPos = translationMatrix * vec3(aCenter, 1.0);
  vec2 safeDims = max(uScreenDimensions, vec2(1.0));

  vLocal = aCorner;
  vSamplerUvs = tPos.xy / safeDims;
  vCenterScreenUv = cPos.xy / safeDims;
  vWorldPos = worldPos;
  vAtlasRect = aAtlasRect;
  vFlip = aFlipAndPad.xy;
  vAlpha = finalAlpha;
  vScreenRadius = max(aSizeInfo.x, aSizeInfo.y) * sm * scale;
  vRot = aSizeInfo.z;
  vElevation = aSizeInfo.w;
  vNeedsVision = aState.y;

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
varying vec2 vCenterScreenUv;
varying vec2 vWorldPos;
varying vec4 vAtlasRect;
varying vec2 vFlip;
varying float vAlpha;
varying float vScreenRadius;
varying float vRot;
varying float vElevation;
varying float vNeedsVision;

void main() {
  if (vAlpha <= 0.002) discard;

  // 1. GPU Vision Mask safety net: never leak non-owned enemies inside explored-only FoW
  if (uUseVisionMask && vNeedsVision > 0.5) {
    float visPix = texture2D(uVisionTex, clamp(vSamplerUvs, vec2(0.0), vec2(1.0))).r;
    float visCenter = texture2D(uVisionTex, clamp(vCenterScreenUv, vec2(0.0), vec2(1.0))).r;
    if (max(visPix, visCenter) < 0.05) discard;
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

  // While atlas slot is decoding (first ~30ms), show only a very subtle grounded shadow silhouette (never bright neon rings)
  if (vAtlasRect.w < 0.5) {
    float r = length(vLocal);
    float shadow = (1.0 - smoothstep(0.35, 0.85, r)) * 0.22 * vAlpha;
    if (shadow <= 0.004) discard;
    gl_FragColor = vec4(vec3(0.05, 0.05, 0.06) * shadow, shadow);
    return;
  }

  vec2 localUv = vLocal * vFlip * 0.5 + 0.5;
  if (localUv.x < 0.0 || localUv.x > 1.0 || localUv.y < 0.0 || localUv.y > 1.0) discard;

  // Sample strictly inside the padded 120x120 art rect in the atlas (texture is premultiplied alpha)
  vec2 clamped = clamp(localUv, vec2(0.004), vec2(0.996));
  vec2 atlasUv = vAtlasRect.xy + clamped * vAtlasRect.z;
  vec4 tex = texture2D(uAtlas, atlasUv);
  if (tex.a <= 0.01) discard;

  gl_FragColor = tex * vAlpha;
}
`;

function parseCssColor(val, fallback) {
  if (!val) return fallback;
  try {
    return foundry.utils.Color.from(val).css || fallback;
  } catch {
    return fallback;
  }
}

function littleEndianToCss(le) {
  if (le === null || le === undefined || !Number.isFinite(le)) return null;
  const r = le & 0xff;
  const g = (le >> 8) & 0xff;
  const b = (le >> 16) & 0xff;
  return `rgb(${r},${g},${b})`;
}

function getFoundryRingAssetInfo(sizeUnits) {
  try {
    const RingCls = globalThis.CONFIG?.Token?.ring?.ringClass;
    if (!RingCls?.getRingDataBySize) return null;
    const data = RingCls.getRingDataBySize(Math.max(1, sizeUnits || 1));
    if (!data?.ringName && !data?.bkgName) return null;
    const ringTex = data.ringName ? globalThis.PIXI?.Assets?.cache?.get?.(data.ringName) : null;
    const bkgTex = data.bkgName ? globalThis.PIXI?.Assets?.cache?.get?.(data.bkgName) : null;
    return {
      ringTex,
      bkgTex,
      subjectScaleAdjustment: Number(data.subjectScaleAdjustment) || 1.5,
      defaultRingCss: littleEndianToCss(data.defaultRingColorLittleEndian),
      defaultBkgCss: littleEndianToCss(data.defaultBackgroundColorLittleEndian)
    };
  } catch {
    return null;
  }
}

function getTokenRenderSpec(doc) {
  const srcObj = doc._source || {};
  const ringEnabled = Boolean(srcObj.ring?.enabled);
  const hasDistinctSubject = Boolean(ringEnabled && (doc.hasDistinctSubjectTexture || srcObj.ring?.subject?.texture));
  const subjectTex = ringEnabled ? (srcObj.ring?.subject?.texture || doc.ring?.subject?.texture || "") : "";
  const baseTex = srcObj.texture?.src || doc.texture?.src || doc.baseActor?.img || "";
  const artSrc = subjectTex || baseTex;

  const wUnits = Number(srcObj.width ?? doc.width ?? 1) || 1;
  const hUnits = Number(srcObj.height ?? doc.height ?? 1) || 1;
  const sizeUnits = Math.min(wUnits, hUnits);
  const ringInfo = ringEnabled ? getFoundryRingAssetInfo(sizeUnits) : null;
  const subjectScaleAdj = ringInfo?.subjectScaleAdjustment || 1.5;

  const sx = Number(srcObj.texture?.scaleX ?? doc.texture?.scaleX ?? 1) || 1;
  const sy = Number(srcObj.texture?.scaleY ?? doc.texture?.scaleY ?? 1) || 1;
  const flipX = sx < 0 ? -1 : 1;
  const flipY = sy < 0 ? -1 : 1;

  // For distinct-subject pop-out tokens (Hero in a Box / D&D 5e), the subject canvas is `subjectScaleAdj * max(1, subScale)`
  // larger than the 1x ring so heads/weapons extend cleanly beyond the ring at exact native Foundry v14 scale!
  const subScale = ringEnabled ? Math.min(2.2, Math.max(0.5, Number(srcObj.ring?.subject?.scale) || 1)) : 1;
  const popoutQuadScale = hasDistinctSubject ? (subjectScaleAdj * Math.max(1.0, subScale)) : 1.0;
  const texScale = ringEnabled
    ? popoutQuadScale
    : Math.min(2.5, Math.max(0.25, Math.max(Math.abs(sx), Math.abs(sy))));

  const ringColor = ringEnabled ? parseCssColor(srcObj.ring?.colors?.ring, ringInfo?.defaultRingCss || "") : "";
  const bgColor = ringEnabled ? parseCssColor(srcObj.ring?.colors?.background, ringInfo?.defaultBkgCss || "") : "";

  const slotKey = ringEnabled
    ? `R${hasDistinctSubject ? "P" : "C"}|${sizeUnits}|${artSrc}|${ringColor}|${bgColor}|${subScale.toFixed(2)}`
    : `T|${artSrc}`;

  return {
    slotKey,
    artSrc,
    ringEnabled,
    hasDistinctSubject,
    sizeUnits,
    subjectScaleAdj,
    popoutQuadScale,
    ringColor,
    bgColor,
    subjectScale: subScale,
    flipX,
    flipY,
    texScale
  };
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

function isTokenInvisibleSafe(doc) {
  if (!doc) return false;
  const invStatus = globalThis.CONFIG?.specialStatusEffects?.INVISIBLE || "invisible";
  const burrowStatus = globalThis.CONFIG?.specialStatusEffects?.BURROW || "burrow";
  if (!doc.isLazyDelta) {
    try {
      if (
        doc.hasStatusEffect?.(invStatus) ||
        doc.hasStatusEffect?.(burrowStatus) ||
        doc.actor?.statuses?.has?.(invStatus) ||
        doc.actor?.statuses?.has?.(burrowStatus)
      ) return true;
    } catch {}
  } else {
    const baseStatuses = doc.baseActor?.statuses;
    if (baseStatuses?.has?.(invStatus) || baseStatuses?.has?.(burrowStatus)) return true;
    const deltaEffects = doc._source?.delta?.effects;
    if (Array.isArray(deltaEffects)) {
      for (let i = 0; i < deltaEffects.length; i++) {
        const ef = deltaEffects[i];
        if (!ef || ef.disabled) continue;
        if (Array.isArray(ef.statuses) && (ef.statuses.includes(invStatus) || ef.statuses.includes(burrowStatus))) {
          return true;
        }
      }
    }
  }
  return false;
}

/**
 * Single-draw-call Dynamic Texture Atlas Token Impostor Layer mounted inside `canvas.primary`.
 * - Renders authentic 128x128 baked token art (including Foundry v14 Dynamic Token Rings) 1:1 with native Tokens.
 * - Zero neon disposition circles, zero `doc.actor` touches (preserves lazy `ActorDelta`).
 * - Strict Foundry v14 visibility enforcement (CPU `testVisibility` + GPU `uVisionTex` + baked roof mask).
 */
export class TokenImpostorLayer {
  constructor(controller, streamer) {
    this.controller = controller;
    this.streamer = streamer;

    this.mounted = false;
    this.sceneId = null;

    // Dynamic 2048x2048 texture atlas (256 slots of 128x128 with 4px padding)
    this.atlasSize = ATLAS_PX;
    this.atlasCanvas = null;
    this.atlasCtx = null;
    this._tmpCanvas = null;
    this._tmpCtx = null;
    this.atlasTexture = null;
    this.atlasDirty = false;
    this.slotsByKey = new Map(); // slotKey -> { col, row, u0, v0, uSpan, spec, ready, failed }
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
    this.activeVisibleCount = 0;
    this.docIndexById = new Map(); // docId -> slotIndex [0..count-1]
    this.docIds = [];              // slotIndex -> docId
    this.docKeyById = new Map();   // docId -> slotKey
    this.docsByKey = new Map();    // slotKey -> Set<docId>

    // Backing typed arrays & PIXI buffers
    this.centerArr = null;
    this.cornerArr = null;
    this.sizeInfoArr = null;
    this.atlasRectArr = null;
    this.flipAndPadArr = null;
    this.stateArr = null;
    this.indexArr = null;

    this.centerBuf = null;
    this.sizeInfoBuf = null;
    this.atlasRectBuf = null;
    this.flipAndPadBuf = null;
    this.stateBuf = null;

    this._bufDirty = {
      center: false,
      sizeInfo: false,
      atlasRect: false,
      flipAndPad: false,
      state: false
    };

    // Per-token fade overrides (docId -> impostorAlphaMultiplier in [0..1]) driven by TokenStreamer crossfades
    this.fadeOverrides = new Map();
    this._visibilityDirty = true;
    this._lastVisSyncMs = 0;
    this._pendingUpserts = new Map();
    this._upsertQueued = false;
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
    this._pendingUpserts.clear();
    this._upsertQueued = false;

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

    if (this.atlasTexture && this.atlasTexture !== PIXI.Texture.WHITE) {
      try { this.atlasTexture.destroy(true); } catch {}
    }
    this.atlasTexture = null;
    this.atlasCanvas = null;
    this.atlasCtx = null;
    this._tmpCanvas = null;
    this._tmpCtx = null;
    this.atlasDirty = false;
    this.slotsByKey.clear();
    this.nextSlotIdx = 0;

    this.capacity = 0;
    this.count = 0;
    this.activeVisibleCount = 0;
    this.docIndexById.clear();
    this.docIds = [];
    this.docKeyById.clear();
    this.docsByKey.clear();
    this.centerArr = null;
    this.cornerArr = null;
    this.sizeInfoArr = null;
    this.atlasRectArr = null;
    this.flipAndPadArr = null;
    this.stateArr = null;
    this.indexArr = null;
    this.centerBuf = null;
    this.sizeInfoBuf = null;
    this.atlasRectBuf = null;
    this.flipAndPadBuf = null;
    this.stateBuf = null;
    this._visibilityDirty = true;
  }

  _initAtlas() {
    this.atlasSize = ATLAS_PX;
    if (typeof document !== "undefined" && typeof document.createElement === "function") {
      const c = document.createElement("canvas");
      c.width = this.atlasSize;
      c.height = this.atlasSize;
      this.atlasCanvas = c;
      this.atlasCtx = c.getContext("2d");
      if (this.atlasCtx) {
        this.atlasCtx.imageSmoothingEnabled = true;
        this.atlasCtx.imageSmoothingQuality = "high";
        this.atlasCtx.clearRect(0, 0, this.atlasSize, this.atlasSize);
      }
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
      uRoofElev: getFiniteLevelRoofElevation(canvas.level)
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
    const useVision = Boolean(
      canvas.visibility?.tokenVision && !game.user?.isGM &&
      visionTex && !visionTex.destroyed && visionTex.baseTexture && !visionTex.baseTexture.destroyed
    );
    u.uUseVisionMask = useVision;
    u.uVisionTex = useVision ? visionTex : PIXI.Texture.WHITE;

    const lb = this.controller?.lightBatch;
    const hasRoof = Boolean(lb?.useBakedRoofMask && isTextureUsable(lb.bakedRoofMask));
    u.uUseBakedRoofMask = hasRoof;
    if (hasRoof) {
      u.uBakedRoofMask = lb.bakedRoofMask;
      u.uBakedRoofOrigin[0] = lb.bakedRoofOrigin[0];
      u.uBakedRoofOrigin[1] = lb.bakedRoofOrigin[1];
      u.uBakedRoofRegion[0] = lb.bakedRoofRegion[0];
      u.uBakedRoofRegion[1] = lb.bakedRoofRegion[1];
      u.uBakedRoofRepeat = Boolean(lb.bakedRoofRepeat);
    } else {
      u.uBakedRoofMask = PIXI.Texture.EMPTY;
    }
    u.uRoofElev = getFiniteLevelRoofElevation(canvas.level);
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
    const nextFlipAndPad = new Float32Array(verts * 4);
    const nextState = new Float32Array(verts * 4);

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
      nextFlipAndPad.set(this.flipAndPadArr.subarray(0, copyVerts * 4));
      nextState.set(this.stateArr.subarray(0, copyVerts * 4));
    }

    this.capacity = nextCap;
    this.centerArr = nextCenter;
    this.cornerArr = nextCorner;
    this.sizeInfoArr = nextSizeInfo;
    this.atlasRectArr = nextAtlasRect;
    this.flipAndPadArr = nextFlipAndPad;
    this.stateArr = nextState;
    this.indexArr = nextIdx;

    this.centerBuf = new PIXI.Buffer(nextCenter, false, false);
    this.sizeInfoBuf = new PIXI.Buffer(nextSizeInfo, false, false);
    this.atlasRectBuf = new PIXI.Buffer(nextAtlasRect, false, false);
    this.flipAndPadBuf = new PIXI.Buffer(nextFlipAndPad, false, false);
    this.stateBuf = new PIXI.Buffer(nextState, false, false);

    const oldMesh = this.mesh;
    const oldGeom = this.geometry;

    this.geometry = new PIXI.Geometry()
      .addAttribute("aCenter", this.centerBuf, 2)
      .addAttribute("aCorner", new PIXI.Buffer(nextCorner, true, false), 2)
      .addAttribute("aSizeInfo", this.sizeInfoBuf, 4)
      .addAttribute("aAtlasRect", this.atlasRectBuf, 4)
      .addAttribute("aFlipAndPad", this.flipAndPadBuf, 4)
      .addAttribute("aState", this.stateBuf, 4)
      .addIndex(nextIdx);

    const PrimaryCanvasGroup = foundry.canvas?.groups?.PrimaryCanvasGroup;
    const mesh = new PIXI.Mesh(this.geometry, this.shader);
    mesh.name = "Level.BoundlessTokenImpostors";
    mesh.blendMode = PIXI.BLEND_MODES.NORMAL;
    mesh.eventMode = "none";
    mesh.cullable = false;
    mesh.elevation = getFiniteLevelBaseElevation(canvas.level);
    mesh.sortLayer = PrimaryCanvasGroup?.SORT_LAYERS?.TOKENS ?? 700;
    mesh.sort = -1000;
    mesh.zIndex = -1000;
    mesh.size = this.count * 6;
    mesh.visible = this.count > 0 && this.activeVisibleCount > 0;

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

  _writeQuad4(arr, slotIdx, a, b, c, d) {
    const o = slotIdx * 16;
    arr[o] = a; arr[o + 1] = b; arr[o + 2] = c; arr[o + 3] = d;
    arr[o + 4] = a; arr[o + 5] = b; arr[o + 6] = c; arr[o + 7] = d;
    arr[o + 8] = a; arr[o + 9] = b; arr[o + 10] = c; arr[o + 11] = d;
    arr[o + 12] = a; arr[o + 13] = b; arr[o + 14] = c; arr[o + 15] = d;
  }

  _requestAtlasSlot(spec) {
    if (!spec?.artSrc) return null;
    let slot = this.slotsByKey.get(spec.slotKey);
    if (slot) return slot;

    const colsPerRow = Math.floor(this.atlasSize / CELL_PX);
    const maxSlots = colsPerRow * colsPerRow;
    let col, row;
    if (this.nextSlotIdx < maxSlots) {
      const idx = this.nextSlotIdx++;
      col = idx % colsPerRow;
      row = Math.floor(idx / colsPerRow);
    } else {
      // Recycle an unused atlas slot (zero refcount in docsByKey)
      let victimKey = null;
      let victimSlot = null;
      for (const [k, s] of this.slotsByKey) {
        if (!this.docsByKey.get(k)?.size) {
          victimKey = k;
          victimSlot = s;
          break;
        }
      }
      if (!victimSlot) return null;
      this.slotsByKey.delete(victimKey);
      this._decodeQueuedSet.delete(victimKey);
      col = victimSlot.col;
      row = victimSlot.row;
    }
    const inv = 1 / this.atlasSize;

    slot = {
      col,
      row,
      u0: (col * CELL_PX + PAD_PX) * inv,
      v0: (row * CELL_PX + PAD_PX) * inv,
      uSpan: CONTENT_PX * inv,
      spec,
      ready: false,
      failed: false
    };
    this.slotsByKey.set(spec.slotKey, slot);

    if (!this._decodeQueuedSet.has(spec.slotKey)) {
      this._decodeQueuedSet.add(spec.slotKey);
      this._decodeQueue.push(spec.slotKey);
      this._pumpAtlasDecodes();
    }
    return slot;
  }

  _pumpAtlasDecodes() {
    if (!this.mounted || !this.atlasCtx) return;
    while (this._activeDecodes < MAX_CONCURRENT_DECODES && this._decodeQueue.length > 0) {
      const slotKey = this._decodeQueue.shift();
      this._decodeQueuedSet.delete(slotKey);
      const slot = this.slotsByKey.get(slotKey);
      if (!slot || slot.ready || slot.failed) continue;
      this._activeDecodes++;
      const gen = this._gen;
      this._decodeAndPack(slotKey, slot, gen).finally(() => {
        if (gen !== this._gen) return;
        this._activeDecodes = Math.max(0, this._activeDecodes - 1);
        if (this.mounted && this._decodeQueue.length > 0) {
          this._pumpAtlasDecodes();
        }
      });
    }
  }

  async _loadDrawable(src) {
    // 1. Fast path: reuse already loaded PIXI / Foundry cached image source if available
    try {
      const cached = globalThis.PIXI?.Assets?.cache?.get?.(src) || globalThis.foundry?.canvas?.getTexture?.(src);
      const resSrc = cached?.baseTexture?.resource?.source;
      if (resSrc && (resSrc.videoWidth > 0 || resSrc.naturalWidth > 0 || resSrc.width > 0)) {
        return { drawable: resSrc, shouldClose: false };
      }
    } catch {}

    // 2. Off-main-thread raster decode with high-quality resize
    const lower = String(src).split("?")[0].toLowerCase();
    const isSvg = lower.endsWith(".svg");
    if (!isSvg && typeof fetch === "function" && typeof createImageBitmap === "function") {
      try {
        const res = await fetch(src);
        if (res.ok) {
          const blob = await res.blob();
          const bmp = await createImageBitmap(blob);
          return { drawable: bmp, shouldClose: true };
        }
      } catch {}
    }

    // 3. Fallback via HTMLImageElement (handles SVG, special URLs, etc.)
    if (typeof Image !== "undefined") {
      const img = await new Promise((resolve, reject) => {
        const el = new Image();
        el.crossOrigin = "anonymous";
        el.onload = () => resolve(el);
        el.onerror = reject;
        el.src = src;
      });
      return { drawable: img, shouldClose: false };
    }
    return { drawable: null, shouldClose: false };
  }

  _drawTintedSpritesheetFrame(ctx, pixiTex, tintCss, dx, dy, dw, dh) {
    const src = pixiTex?.baseTexture?.resource?.source;
    const f = pixiTex?.frame;
    if (!src || !f || !f.width || !f.height) return false;

    if (!tintCss) {
      ctx.drawImage(src, f.x, f.y, f.width, f.height, dx, dy, dw, dh);
      return true;
    }

    if (!this._tmpCanvas && typeof document !== "undefined") {
      this._tmpCanvas = document.createElement("canvas");
      this._tmpCanvas.width = CELL_PX;
      this._tmpCanvas.height = CELL_PX;
      this._tmpCtx = this._tmpCanvas.getContext("2d");
      if (this._tmpCtx) {
        this._tmpCtx.imageSmoothingEnabled = true;
        this._tmpCtx.imageSmoothingQuality = "high";
      }
    }
    const tctx = this._tmpCtx;
    if (!tctx) {
      ctx.drawImage(src, f.x, f.y, f.width, f.height, dx, dy, dw, dh);
      return true;
    }

    const sz = Math.min(CELL_PX, Math.max(1, Math.round(dw)));
    tctx.save();
    tctx.globalCompositeOperation = "source-over";
    tctx.clearRect(0, 0, CELL_PX, CELL_PX);
    tctx.drawImage(src, f.x, f.y, f.width, f.height, 0, 0, sz, sz);
    tctx.globalCompositeOperation = "multiply";
    tctx.fillStyle = tintCss;
    tctx.fillRect(0, 0, sz, sz);
    tctx.globalCompositeOperation = "destination-in";
    tctx.drawImage(src, f.x, f.y, f.width, f.height, 0, 0, sz, sz);
    tctx.restore();

    ctx.drawImage(this._tmpCanvas, 0, 0, sz, sz, dx, dy, dw, dh);
    return true;
  }

  async _decodeAndPack(slotKey, slot, gen) {
    if (!this.mounted || gen !== this._gen || !this.atlasCtx) return;
    let drawable = null;
    let shouldClose = false;

    try {
      const loaded = await this._loadDrawable(slot.spec.artSrc);
      drawable = loaded.drawable;
      shouldClose = loaded.shouldClose;
    } catch {
      if (this.slotsByKey.get(slotKey) === slot) slot.failed = true;
      return;
    }

    if (!drawable || !this.mounted || gen !== this._gen || !this.atlasCtx || this.slotsByKey.get(slotKey) !== slot) {
      if (shouldClose) try { drawable?.close?.(); } catch {}
      return;
    }

    try {
      const ctx = this.atlasCtx;
      const cellX = slot.col * CELL_PX;
      const cellY = slot.row * CELL_PX;
      const dstX = cellX + PAD_PX;
      const dstY = cellY + PAD_PX;
      const sw = drawable.videoWidth || drawable.naturalWidth || drawable.width || CONTENT_PX;
      const sh = drawable.videoHeight || drawable.naturalHeight || drawable.height || CONTENT_PX;
      const aspect = sw / Math.max(1, sh);

      ctx.save();
      ctx.clearRect(cellX, cellY, CELL_PX, CELL_PX);

      if (slot.spec.ringEnabled) {
        const ringInfo = getFoundryRingAssetInfo(slot.spec.sizeUnits);
        const cx = dstX + CONTENT_PX * 0.5;
        const cy = dstY + CONTENT_PX * 0.5;
        const subScale = slot.spec.subjectScale || 1;

        if (slot.spec.hasDistinctSubject) {
          // Pop-out Dynamic Token Ring (Hero in a Box / D&D 5e 2024):
          // Ring sits centered at exact 1x grid size (`CONTENT_PX / popoutQuadScale`); pop-out subject draws ON TOP UNCLIPPED!
          const quadScale = slot.spec.popoutQuadScale || 1.5;
          const ringBox = CONTENT_PX / quadScale;
          const rx = cx - ringBox * 0.5;
          const ry = cy - ringBox * 0.5;

          const drewBkg = ringInfo?.bkgTex && this._drawTintedSpritesheetFrame(ctx, ringInfo.bkgTex, slot.spec.bgColor, rx, ry, ringBox, ringBox);
          if (!drewBkg) {
            ctx.beginPath();
            ctx.arc(cx, cy, ringBox * 0.44, 0, Math.PI * 2);
            ctx.fillStyle = slot.spec.bgColor || "#22242a";
            ctx.fill();
          }

          const drewRing = ringInfo?.ringTex && this._drawTintedSpritesheetFrame(ctx, ringInfo.ringTex, slot.spec.ringColor, rx, ry, ringBox, ringBox);
          if (!drewRing) {
            ctx.beginPath();
            ctx.arc(cx, cy, ringBox * 0.45, 0, Math.PI * 2);
            ctx.lineWidth = Math.max(2, ringBox * 0.06);
            ctx.strokeStyle = slot.spec.ringColor || "#8a8578";
            ctx.stroke();
          }

          // Subject art spans exact native ratio without circular clipping
          const subjBox = CONTENT_PX * Math.min(1.0, subScale);
          let dw = subjBox;
          let dh = subjBox;
          if (aspect > 1) dh = dw / aspect;
          else if (aspect < 1) dw = dh * aspect;
          ctx.drawImage(drawable, cx - dw * 0.5, cy - dh * 0.5, dw, dh);
        } else {
          // Classic non-popout portrait inside Dynamic Token Ring: bkg -> clipped subject -> authentic ring sprite on top
          const ringBox = CONTENT_PX;
          const drewBkg = ringInfo?.bkgTex && this._drawTintedSpritesheetFrame(ctx, ringInfo.bkgTex, slot.spec.bgColor, dstX, dstY, ringBox, ringBox);
          if (!drewBkg) {
            ctx.beginPath();
            ctx.arc(cx, cy, ringBox * 0.44, 0, Math.PI * 2);
            ctx.fillStyle = slot.spec.bgColor || "#22242a";
            ctx.fill();
          }

          ctx.save();
          ctx.beginPath();
          ctx.arc(cx, cy, ringBox * 0.43, 0, Math.PI * 2);
          ctx.clip();
          const fit = ringBox * 0.88 * subScale;
          let dw = fit, dh = fit;
          if (aspect > 1) dw = fit * aspect;
          else if (aspect < 1) dh = fit / aspect;
          ctx.drawImage(drawable, cx - dw * 0.5, cy - dh * 0.5, dw, dh);
          ctx.restore();

          const drewRing = ringInfo?.ringTex && this._drawTintedSpritesheetFrame(ctx, ringInfo.ringTex, slot.spec.ringColor, dstX, dstY, ringBox, ringBox);
          if (!drewRing) {
            ctx.beginPath();
            ctx.arc(cx, cy, ringBox * 0.45, 0, Math.PI * 2);
            ctx.lineWidth = Math.max(2, ringBox * 0.06);
            ctx.strokeStyle = slot.spec.ringColor || "#8a8578";
            ctx.stroke();
          }
        }
      } else {
        // Draw authentic raw token art (e.g. top-down / standalone token) preserving full transparency & aspect
        let dw = CONTENT_PX;
        let dh = CONTENT_PX;
        if (aspect > 1) dh = CONTENT_PX / aspect;
        else if (aspect < 1) dw = CONTENT_PX * aspect;
        const ox = dstX + (CONTENT_PX - dw) * 0.5;
        const oy = dstY + (CONTENT_PX - dh) * 0.5;
        ctx.drawImage(drawable, ox, oy, dw, dh);
      }

      ctx.restore();

      slot.ready = true;
      this.atlasDirty = true;
      this._applySlotToDocs(slotKey, slot);
    } catch {
      slot.failed = true;
    } finally {
      if (shouldClose) try { drawable.close(); } catch {}
    }
  }

  _applySlotToDocs(slotKey, slot) {
    const ids = this.docsByKey.get(slotKey);
    if (!ids?.size || !this.atlasRectArr) return;
    for (const docId of ids) {
      const idx = this.docIndexById.get(docId);
      if (idx === undefined) continue;
      this._writeQuad4(this.atlasRectArr, idx, slot.u0, slot.v0, slot.uSpan, 1.0);
      this._bufDirty.atlasRect = true;
    }
  }

  _registerDocKey(docId, nextKey) {
    const prevKey = this.docKeyById.get(docId);
    if (prevKey === nextKey) return;
    if (prevKey) {
      const oldSet = this.docsByKey.get(prevKey);
      if (oldSet) {
        oldSet.delete(docId);
        if (oldSet.size === 0) this.docsByKey.delete(prevKey);
      }
    }
    if (nextKey) {
      this.docKeyById.set(docId, nextKey);
      let set = this.docsByKey.get(nextKey);
      if (!set) {
        set = new Set();
        this.docsByKey.set(nextKey, set);
      }
      set.add(docId);
    } else {
      this.docKeyById.delete(docId);
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
    this.docKeyById.clear();
    this.docsByKey.clear();
    this.count = 0;

    this._ensureCapacity(list.length);
    for (let i = 0; i < list.length; i++) {
      this._upsertDocInternal(list[i]);
    }
    if (this.mesh) {
      this.mesh.elevation = getFiniteLevelBaseElevation(canvas.level);
      this.mesh.size = this.count * 6;
      this.mesh.visible = this.count > 0 && this.activeVisibleCount > 0;
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
      // Clear stale state slot (e.g. reused after removeToken) so activeVisibleCount stays exact
      this._writeQuad4(this.stateArr, idx, 0, 0, 0, 0);
      this._bufDirty.state = true;
      if (this.mesh) {
        this.mesh.size = this.count * 6;
        this.mesh.visible = this.count > 0 && this.activeVisibleCount > 0;
      }
    }

    const grid = canvas.grid?.size || 100;
    const x = Number(doc._source?.x ?? doc.x ?? 0);
    const y = Number(doc._source?.y ?? doc.y ?? 0);
    const w = (Number(doc._source?.width ?? doc.width ?? 1) || 1) * grid;
    const h = (Number(doc._source?.height ?? doc.height ?? 1) || 1) * grid;
    const cx = x + w * 0.5;
    const cy = y + h * 0.5;
    const elev = Number(doc._source?.elevation ?? doc.elevation ?? 0);
    const lockRot = Boolean(doc._source?.lockRotation ?? doc.lockRotation);
    const rotRad = lockRot ? 0 : ((Number(doc._source?.rotation ?? doc.rotation ?? 0) || 0) * Math.PI / 180);

    const spec = getTokenRenderSpec(doc);
    this._registerDocKey(doc.id, spec.artSrc ? spec.slotKey : null);

    const slot = spec.artSrc ? this._requestAtlasSlot(spec) : null;
    const hasSlot = Boolean(slot?.ready);

    this._writeQuad2(this.centerArr, idx, cx, cy);
    this._writeQuad4(this.sizeInfoArr, idx, w * 0.5, h * 0.5, rotRad, elev);
    this._writeQuad4(this.atlasRectArr, idx, hasSlot ? slot.u0 : 0, hasSlot ? slot.v0 : 0, hasSlot ? slot.uSpan : 0, hasSlot ? 1.0 : 0.0);
    this._writeQuad4(this.flipAndPadArr, idx, spec.flipX, spec.flipY, spec.texScale, 0);

    this._bufDirty.center = true;
    this._bufDirty.sizeInfo = true;
    this._bufDirty.atlasRect = true;
    this._bufDirty.flipAndPad = true;
    return idx;
  }

  upsertToken(doc) {
    if (!this.mounted || !doc?.id) return;
    this._pendingUpserts.delete(doc.id);
    this._upsertDocInternal(doc);
    this._updateSingleTokenState(doc);
  }

  /**
   * Coalesce burst token upserts (batch create/update/draw) into a single microtask
   * so `_collectVisionCheckers()` and GPU buffer `flush()` run once instead of N times.
   */
  queueUpsertToken(doc) {
    if (!this.mounted || !doc?.id) return;
    this._pendingUpserts.set(doc.id, doc);
    if (this._upsertQueued) return;
    this._upsertQueued = true;
    const gen = this._gen;
    queueMicrotask(() => {
      this._upsertQueued = false;
      if (!this.mounted || gen !== this._gen || this._pendingUpserts.size === 0) return;
      const batch = Array.from(this._pendingUpserts.values());
      this._pendingUpserts.clear();
      const visCtx = this._collectVisionCheckers();
      for (let i = 0; i < batch.length; i++) {
        const d = batch[i];
        if (!d?.id) continue;
        this._upsertDocInternal(d);
        this._updateSingleTokenState(d, visCtx);
      }
      this.flush();
    });
  }

  removeToken(docId) {
    if (!this.mounted || !docId) return;
    this._pendingUpserts.delete(docId);
    const idx = this.docIndexById.get(docId);
    if (idx === undefined) return;

    const wasVisible = this.stateArr && this.stateArr[idx * 16] > 0.002;
    if (wasVisible) this.activeVisibleCount = Math.max(0, this.activeVisibleCount - 1);

    this._registerDocKey(docId, null);
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
      this.flipAndPadArr.copyWithin(idx * 16, lastIdx * 16, lastIdx * 16 + 16);
      this.stateArr.copyWithin(idx * 16, lastIdx * 16, lastIdx * 16 + 16);

      this._bufDirty.center = true;
      this._bufDirty.sizeInfo = true;
      this._bufDirty.atlasRect = true;
      this._bufDirty.flipAndPad = true;
      this._bufDirty.state = true;
    }

    this._writeQuad4(this.stateArr, lastIdx, 0, 0, 0, 0);
    this._bufDirty.state = true;
    this.docIds.length = lastIdx;
    this.count = lastIdx;
    if (this.mesh) {
      this.mesh.elevation = getFiniteLevelBaseElevation(canvas.level);
      this.mesh.size = this.count * 6;
      this.mesh.visible = this.count > 0 && this.activeVisibleCount > 0;
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
    const visionSourceDocIds = new Set();
    let hasActiveVision = false;

    if (tokenVision) {
      for (const vs of canvas.effects?.visionSources || []) {
        if (!vs?.active) continue;
        hasActiveVision = true;
        const srcDocId = vs.object?.document?.id;
        if (srcDocId) visionSourceDocIds.add(srcDocId);

        let losBounds = null;
        try {
          const b = vs.los?.getBounds?.();
          if (b && Number.isFinite(b.x) && Number.isFinite(b.y) && b.width > 0 && b.height > 0) {
            losBounds = b;
          }
        } catch {}

        // Foundry v14 PointVisionSource: `vs.radius` is ONLY darkvision/basic sight range (often 0 for humans!);
        // daylight / lit visibility uses `vs.lightRadius` / `vs.los` / `detectionModes.lightPerception.range` (often Infinity).
        const docModes = vs.object?.document?.detectionModes;
        const unlimitedLight = Boolean(
          docModes?.lightPerception?.enabled &&
          (docModes.lightPerception.range === null || docModes.lightPerception.range === undefined || !Number.isFinite(docModes.lightPerception.range))
        );
        const unlimitedBasic = Boolean(
          docModes?.basicSight?.enabled &&
          (docModes.basicSight.range === null || docModes.basicSight.range === undefined || !Number.isFinite(docModes.basicSight.range))
        );
        let r = Math.max(
          Number(vs.radius) || 0,
          Number(vs.lightRadius) || 0,
          Number(vs.data?.radius) || 0,
          Number(vs.data?.lightRadius) || 0,
          Number(vs.data?.externalRadius) || 0,
          200
        );
        if (unlimitedLight || unlimitedBasic) r = Infinity;

        visionBoxes.push({ x: vs.x, y: vs.y, r, bounds: losBounds });
      }
      for (const ls of canvas.effects?.lightSources || []) {
        if (!ls?.active || !ls.data?.vision) continue;
        let losBounds = null;
        try {
          const b = ls.los?.getBounds?.();
          if (b && Number.isFinite(b.x) && Number.isFinite(b.y) && b.width > 0 && b.height > 0) {
            losBounds = b;
          }
        } catch {}
        const r = Math.max(Number(ls.radius) || 0, Number(ls.data?.dim) || 0, Number(ls.data?.bright) || 0, 200);
        visionBoxes.push({ x: ls.x, y: ls.y, r, bounds: losBounds });
      }
    }
    return { tokenVision, isGM, hasActiveVision, visionBoxes, visionSourceDocIds };
  }

  _computeTokenAlpha(doc, visCtx) {
    if (!doc || !doc.viewed) return { alpha: 0, needsVision: 0, isParty: 0 };

    const isParty = isPartyTokenDoc(doc) ? 1.0 : 0.0;
    const isHidden = Boolean(doc._source?.hidden ?? doc.hidden);
    if (isHidden && !visCtx.isGM) return { alpha: 0, needsVision: 1, isParty };

    const owned = isOwnedByCurrentUserSafe(doc);
    const isVisionSource = Boolean(visCtx.visionSourceDocIds?.has?.(doc.id));
    const needsVision = (visCtx.tokenVision && !visCtx.isGM && !owned && !isVisionSource) ? 1.0 : 0.0;

    // Never render a GPU impostor beneath an already-mounted active native Token!
    // If Foundry or Showstopper intentionally hid the native token/mesh (e.g. camera occlusion above lens,
    // hidden flag, filter), the impostor MUST stay hidden too — only render when unmounted or culled for macro zoom.
    const obj = doc._object;
    const hasFadeOverride = this.fadeOverrides.has(doc.id);
    const isMountedOnLayer = Boolean(obj && !obj.destroyed && obj.parent === canvas.tokens?.objects);
    const hiddenByShowstopper = Boolean(
      obj && !obj.destroyed &&
      typeof obj._ssOcclusionAlpha === "number" &&
      Number.isFinite(obj._ssOcclusionAlpha) &&
      obj._ssOcclusionAlpha <= 0.05
    );
    if (isMountedOnLayer && !this.streamer?.isTokenDrawing?.(obj)) {
      if (obj.visible === false || hiddenByShowstopper) {
        return { alpha: 0, needsVision, isParty };
      }
      const nativeActive = Boolean(obj.renderable && (!obj.mesh || (!obj.mesh.destroyed && obj.mesh.renderable)));
      if (nativeActive && !hasFadeOverride) {
        return { alpha: 0, needsVision, isParty };
      }
    } else if (hiddenByShowstopper) {
      return { alpha: 0, needsVision, isParty };
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
      return { alpha: 0, needsVision, isParty };
    }

    // Strict Foundry v14 tokenVision CPU gate (prevents any leak into explored-only FoW or Invisible enemies!)
    if (visCtx.tokenVision && !isVisionSource) {
      if (!visCtx.isGM && !owned) {
        if (!visCtx.hasActiveVision) return { alpha: 0, needsVision, isParty };
        if (isTokenInvisibleSafe(doc)) return { alpha: 0, needsVision, isParty };
        if (!this._passesVisionCheck(cx, cy, elev, w, h, visCtx.visionBoxes, obj)) {
          return { alpha: 0, needsVision, isParty };
        }
      } else if (visCtx.isGM && visCtx.hasActiveVision && !obj?.controlled) {
        if (!this._passesVisionCheck(cx, cy, elev, w, h, visCtx.visionBoxes, obj)) {
          return { alpha: 0, needsVision, isParty };
        }
      }
    }

    const baseAlpha = Number.isFinite(doc.alpha) ? doc.alpha : Number(doc._source?.alpha ?? 1);
    const rawAlpha = isHidden ? Math.min(baseAlpha, 0.5) : baseAlpha;
    const overrideMult = hasFadeOverride ? this.fadeOverrides.get(doc.id) : 1.0;
    const alpha = Math.max(0, Math.min(1, rawAlpha * overrideMult));
    return { alpha, needsVision, isParty };
  }

  _passesVisionCheck(cx, cy, elev, w, h, visionBoxes, obj = null) {
    const pad = Math.max(w || 100, h || 100, 100);
    let inAnyBox = false;
    for (let i = 0; i < visionBoxes.length; i++) {
      const b = visionBoxes[i];
      if (b.bounds) {
        if (
          cx >= b.bounds.x - pad && cx <= b.bounds.x + b.bounds.width + pad &&
          cy >= b.bounds.y - pad && cy <= b.bounds.y + b.bounds.height + pad
        ) {
          inAnyBox = true;
          break;
        }
        continue;
      }
      if (!Number.isFinite(b.r)) {
        inAnyBox = true;
        break;
      }
      const dx = cx - b.x;
      const dy = cy - b.y;
      const rr = b.r + pad;
      if (dx * dx + dy * dy <= rr * rr) {
        inAnyBox = true;
        break;
      }
    }
    if (!inAnyBox) return false;
    const tv = canvas.visibility?.testVisibility;
    if (typeof tv !== "function") return true;
    try {
      const tolerance = Math.max(2, Math.min(w || 100, h || 100) * 0.35);
      const opts = (obj && !obj.destroyed) ? { tolerance, object: obj } : { tolerance };
      return Boolean(tv.call(canvas.visibility, { x: cx, y: cy, elevation: elev }, opts));
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
    const prevVisible = this.stateArr[o] > 0.002;
    const nextVisible = st.alpha > 0.002;
    if (
      Math.abs(this.stateArr[o] - st.alpha) > 0.001 ||
      this.stateArr[o + 1] !== st.needsVision ||
      this.stateArr[o + 2] !== st.isParty
    ) {
      this._writeQuad4(this.stateArr, idx, st.alpha, st.needsVision, st.isParty, 0);
      this._bufDirty.state = true;
      if (prevVisible !== nextVisible) {
        this.activeVisibleCount = Math.max(0, this.activeVisibleCount + (nextVisible ? 1 : -1));
        if (this.mesh) {
          this.mesh.visible = this.count > 0 && this.activeVisibleCount > 0;
        }
      }
    }
  }

  refreshVisibility(force = false) {
    if (!this.mounted || !canvas?.scene?.tokens || this.count === 0) {
      this.activeVisibleCount = 0;
      if (this.mesh) this.mesh.visible = false;
      return;
    }
    const now = performance.now();
    // Respect 120ms throttle even when _visibilityDirty is true (tick() will flush once cooldown elapses);
    // force=true still runs immediately for zero-blink Native <-> Impostor handoffs.
    if (!force && (now - this._lastVisSyncMs) < 120) return;
    this._visibilityDirty = false;
    this._lastVisSyncMs = now;

    const visCtx = this._collectVisionCheckers();
    const tokens = canvas.scene.tokens;
    let visCount = 0;
    for (let i = 0; i < this.count; i++) {
      const doc = tokens.get(this.docIds[i]);
      if (doc) {
        this._updateSingleTokenState(doc, visCtx);
        if (this.stateArr[i * 16] > 0.002) visCount++;
      }
    }
    this.activeVisibleCount = visCount;
    if (this.mesh) {
      this.mesh.visible = this.count > 0 && visCount > 0;
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
    if (this._bufDirty.flipAndPad && this.flipAndPadBuf) { this.flipAndPadBuf.update(); this._bufDirty.flipAndPad = false; }
    if (this._bufDirty.state && this.stateBuf) { this.stateBuf.update(); this._bufDirty.state = false; }
  }

  tick() {
    if (!this.mounted) return;
    if (this._visibilityDirty) this.refreshVisibility(false);
    this.flush();
  }

  getStats() {
    let readySlots = 0;
    for (const s of this.slotsByKey.values()) if (s.ready) readySlots++;
    return {
      mounted: this.mounted,
      trackedTokens: this.count,
      atlasSize: this.atlasSize,
      atlasSlots: this.slotsByKey.size,
      atlasReady: readySlots,
      pendingDecodes: this._decodeQueue.length + this._activeDecodes
    };
  }
}
