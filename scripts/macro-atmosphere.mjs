const MODULE_ID = "boundless";
const ATMO_START_SCALE = 0.34; // Fully invisible (0 GPU cost) at tactical zoom >= 0.34

// ============================================================================
// 1. One-time fast CPU-baked 256x256 seamless Soft Cumulus Atlas (~10 ms, zero FXC shader hang!)
//    R: Broad, smooth billowy Perlin-Worley cumulus masses (no grainy noise)
//    G: Gentle medium-scale fluffy rim detail
//    B: Soft sun-offset height for clean painted 3D cloud shading
//    A: Soft misty veil / cirrus wisps
// ============================================================================

function _fract(x) {
  return x - Math.floor(x);
}

function _smoothstep(edge0, edge1, x) {
  const t = Math.max(0, Math.min(1, (x - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
}

function _hash21p(ix, iy, period) {
  const px = ((ix % period) + period) % period;
  const py = ((iy % period) + period) % period;
  let n = Math.imul(px, 374761393) + Math.imul(py, 668265263) + Math.imul(period, 1442695041);
  n = Math.imul(n ^ (n >>> 13), 1274126177);
  return ((n ^ (n >>> 16)) >>> 0) / 4294967296;
}

function _buildWorleyGrid(freq, seed) {
  const pts = new Float32Array(freq * freq * 2);
  for (let y = 0; y < freq; y++) {
    for (let x = 0; x < freq; x++) {
      const idx = (y * freq + x) * 2;
      pts[idx] = _hash21p(x + seed * 17, y + seed * 31, freq);
      pts[idx + 1] = _hash21p(x + seed * 53 + 7, y + seed * 19 + 13, freq);
    }
  }
  return pts;
}

function _pnoise(u, v, freq) {
  const px = _fract(u) * freq;
  const py = _fract(v) * freq;
  const ix = Math.floor(px);
  const iy = Math.floor(py);
  const fx = px - ix;
  const fy = py - iy;
  const ux = fx * fx * (3 - 2 * fx);
  const uy = fy * fy * (3 - 2 * fy);
  const a = _hash21p(ix, iy, freq);
  const b = _hash21p(ix + 1, iy, freq);
  const c = _hash21p(ix, iy + 1, freq);
  const d = _hash21p(ix + 1, iy + 1, freq);
  const ab = a + (b - a) * ux;
  const cd = c + (d - c) * ux;
  return ab + (cd - ab) * uy;
}

function _pfbm4(u, v, baseFreq) {
  let val = 0;
  let amp = 0.54;
  let freq = baseFreq;
  for (let i = 0; i < 4; i++) {
    val += amp * _pnoise(u, v, freq);
    freq *= 2;
    amp *= 0.48;
  }
  return val;
}

function _pworley(u, v, freq, grid) {
  const px = _fract(u) * freq;
  const py = _fract(v) * freq;
  const ix = Math.floor(px);
  const iy = Math.floor(py);
  const fx = px - ix;
  const fy = py - iy;
  let minD = 1.0;
  for (let dy = -1; dy <= 1; dy++) {
    const cy = ((iy + dy) % freq + freq) % freq;
    const row = cy * freq;
    for (let dx = -1; dx <= 1; dx++) {
      const cx = ((ix + dx) % freq + freq) % freq;
      const idx = (row + cx) * 2;
      const ox = dx + grid[idx] - fx;
      const oy = dy + grid[idx + 1] - fy;
      const d2 = ox * ox + oy * oy;
      if (d2 < minD) minD = d2;
    }
  }
  const d = Math.min(1.0, Math.sqrt(minD));
  return _smoothstep(1.0, 0.05, d);
}

// ============================================================================
// 2. Main Real-Time Atmosphere & Living Parting Cloud Curtains (1 draw call)
// ============================================================================

const MACRO_ATMO_VERT = `
precision highp float;

attribute vec2 aVertexPosition;

uniform mat3 translationMatrix;
uniform mat3 projectionMatrix;

varying vec2 vWorldPos;
varying vec2 vScreenNdc;

void main() {
  vWorldPos = aVertexPosition;
  vec3 pos = projectionMatrix * translationMatrix * vec3(aVertexPosition, 1.0);
  vScreenNdc = pos.xy;
  gl_Position = vec4(pos.xy, 0.0, 1.0);
}
`;

const MACRO_ATMO_FRAG = `
precision highp float;

varying vec2 vWorldPos;
varying vec2 vScreenNdc;

uniform sampler2D uCloudTex;
uniform float uTime;
uniform float uScale;
uniform float uDarkness;
uniform float uAspect;
uniform vec2 uWorldSize;
uniform vec2 uPivot;

// Sample smoothly drifting, gently morphing cloud pillows (clean, zero grainy noise)
vec3 sampleSoftCloud(vec2 uv, float t, float speed) {
  vec2 driftA = vec2(0.026, 0.009) * t * speed;
  vec2 driftB = vec2(0.015, -0.011) * t * speed;

  vec4 sA = texture2D(uCloudTex, uv + driftA);
  vec2 warp = (vec2(sA.g, sA.a) - 0.5) * 0.055;
  vec4 sB = texture2D(uCloudTex, uv * 1.45 + warp + driftB);

  float h    = sA.r * 0.68 + sB.r * 0.32;
  float hSun = sA.b * 0.68 + sB.b * 0.32;
  float rim  = sA.g * 0.60 + sB.g * 0.40;
  return vec3(h, hSun, rim);
}

void main() {
  if (uScale >= 0.34) discard;

  float macroFade = smoothstep(0.26, 0.042, uScale);
  float highFade  = smoothstep(0.16, 0.018, uScale);

  // Smooth, continuous logarithmic dive through the cloud layer (zero popping or flashing!)
  // 0.0 at scale <= 0.032 (above clouds) -> 1.0 at scale >= 0.34 (below clouds in city)
  float logS = log2(max(uScale, 0.005));
  float dive = clamp((logS + 4.965) / 3.41, 0.0, 1.0);
  float curtainEnv = smoothstep(0.02, 0.26, dive) * (1.0 - smoothstep(0.76, 1.0, dive));

  if (macroFade <= 0.001 && curtainEnv <= 0.001) discard;

  // Clean, luminous time-of-day cloud palette (no muddy gray/black dirt!)
  float d = clamp(uDarkness, 0.0, 1.0);
  float dusk = smoothstep(0.15, 0.50, d) * (1.0 - smoothstep(0.50, 0.85, d));

  vec3 shadowCol = mix(vec3(0.05, 0.10, 0.20), vec3(0.01, 0.02, 0.06), d);

  vec3 mistDay   = vec3(0.84, 0.90, 0.97);
  vec3 mistNight = vec3(0.16, 0.26, 0.46);
  vec3 mistDusk  = vec3(0.88, 0.62, 0.54);
  vec3 mistCol   = mix(mix(mistDay, mistNight, d), mistDusk, dusk * 0.60);

  vec3 topDay   = vec3(1.00, 1.00, 1.00);
  vec3 topNight = vec3(0.46, 0.58, 0.80);
  vec3 topDusk  = vec3(1.00, 0.86, 0.72);
  vec3 cloudTop = mix(mix(topDay, topNight, d), topDusk, dusk * 0.65);

  vec3 bodyDay   = vec3(0.93, 0.96, 0.99);
  vec3 bodyNight = vec3(0.30, 0.42, 0.64);
  vec3 bodyDusk  = vec3(0.94, 0.72, 0.64);
  vec3 cloudBody = mix(mix(bodyDay, bodyNight, d), bodyDusk, dusk * 0.65);

  vec3 shadeDay   = vec3(0.75, 0.83, 0.93);
  vec3 shadeNight = vec3(0.18, 0.27, 0.45);
  vec3 shadeDusk  = vec3(0.72, 0.52, 0.58);
  vec3 cloudShade = mix(mix(shadeDay, shadeNight, d), shadeDusk, dusk * 0.65);

  vec3 rgb = vec3(0.0);
  float alpha = 0.0;

  // --- 1. High-altitude world-locked drifting clouds & ground shadows (macro map) ---
  if (macroFade > 0.001) {
    vec2 uvWorld = vWorldPos / max(uWorldSize, vec2(1.0));
    float worldScaleFactor = max(1.0, max(uWorldSize.x, uWorldSize.y) / 180000.0);
    vec2 cloudUv  = vWorldPos * (0.000024 / worldScaleFactor);
    vec2 shadowUv = cloudUv + vec2(-0.065, -0.048);

    vec3 cLive = sampleSoftCloud(cloudUv,  uTime, 0.85);
    vec3 sLive = sampleSoftCloud(shadowUv, uTime, 0.85);

    float shadowMask = smoothstep(0.48, 0.72, sLive.x);
    float cloudMask  = smoothstep(0.50, 0.74, cLive.x + (cLive.z - 0.5) * 0.12);

    float wisp = texture2D(uCloudTex, cloudUv * 0.55 + vec2(uTime * 0.012, -uTime * 0.005)).a;
    float mistMask = smoothstep(0.38, 0.76, wisp);
    float edgeDist = min(min(uvWorld.x, 1.0 - uvWorld.x), min(uvWorld.y, 1.0 - uvWorld.y));
    float edgeMist = (1.0 - smoothstep(0.0, 0.06, edgeDist)) * 0.48;

    float lit = clamp(0.55 + (cLive.x - cLive.y) * 2.2, 0.0, 1.0);
    vec3 macroCol = mix(cloudShade, cloudTop, smoothstep(0.15, 0.85, lit));

    float aShadow = shadowMask * macroFade * mix(0.30, 0.14, d);
    float aMist   = clamp((mistMask * highFade * mix(0.12, 0.18, d)) + edgeMist * macroFade, 0.0, 0.45);
    float aCloud  = cloudMask * highFade * mix(0.38, 0.24, d);

    rgb = shadowCol * aShadow;
    alpha = aShadow;

    rgb = mistCol * aMist + rgb * (1.0 - aMist);
    alpha = aMist + alpha * (1.0 - aMist);

    rgb = macroCol * aCloud + rgb * (1.0 - aCloud);
    alpha = aCloud + alpha * (1.0 - aCloud);
  }

  // --- 2. Living Parting Cloud Curtains (Left/Right & Corner Banks gliding smoothly apart) ---
  if (curtainEnv > 0.001) {
    // NDC space: x in [-1..1], y in [-1..1]
    vec2 ndc = vScreenNdc;
    vec2 p = vec2(ndc.x * uAspect, ndc.y);

    // Horizontal-biased parting (Don't Starve style curtain sweep: left bank slides left, right bank slides right)
    float part = smoothstep(0.12, 1.0, dive);
    float partCurve = part * part;

    // Continuous living wind + subtle camera parallax so clouds always glide smoothly
    vec2 windBack  = vec2(0.046, 0.013) * uTime;
    vec2 windFront = vec2(0.086, 0.022) * uTime;
    vec2 camPar    = uPivot * 0.000016;

    // Wide elliptical screen-space distance (leaves a generous, airy horizontal window over the map)
    float sideDist = length(vec2(ndc.x * 1.06, ndc.y * 0.86));

    // Rigid horizontal + slight vertical curtain shift (no radial tunnel stretching!)
    float sideSign = smoothstep(-0.35, 0.35, ndc.x) * 2.0 - 1.0; // -1 on left half, +1 on right half
    vec2 slideBack  = vec2(sideSign * partCurve * 0.68, ndc.y * partCurve * 0.30);
    vec2 slideFront = vec2(sideSign * partCurve * 1.18, ndc.y * partCurve * 0.52);

    // Perspective magnification as camera descends through the cloud deck
    float uvScaleBack  = mix(0.42, 0.24, part);
    float uvScaleFront = mix(0.35, 0.18, part);

    vec2 uvBack  = (p - slideBack)  * uvScaleBack  + camPar * 0.7 + windBack  + vec2(0.12, 0.37);
    vec2 uvFront = (p - slideFront) * uvScaleFront + camPar * 1.2 + windFront + vec2(0.58, 0.19);

    vec3 backC  = sampleSoftCloud(uvBack,  uTime, 1.05);
    vec3 frontC = sampleSoftCloud(uvFront, uTime, 1.45);

    // Smoothly opening curtain threshold: starts airy (~0.56), opens wide past corners (~1.75)
    float openBack  = mix(0.52, 1.56, partCurve);
    float openFront = mix(0.60, 1.76, partCurve);

    // Crisp yet soft-feathered cumulus pillows sculpt the parting curtain edge (no tunnel ring, no dirt!)
    float edgeBack  = sideDist + (backC.x  - 0.48) * 0.76 + (backC.z  - 0.50) * 0.24;
    float edgeFront = sideDist + (frontC.x - 0.46) * 0.84 + (frontC.z - 0.50) * 0.28;

    float maskBack  = smoothstep(openBack  - 0.34, openBack  + 0.30, edgeBack)  * smoothstep(0.32, 0.62, backC.x);
    float maskFront = smoothstep(openFront - 0.17, openFront + 0.19, edgeFront) * smoothstep(0.38, 0.59, frontC.x + (frontC.z - 0.5) * 0.22);

    // Clean, soft painted cumulus shading (bright sunlit pillows, gentle sky-tinted undersides)
    float backLit  = clamp(0.54 + (backC.x  - backC.y)  * 2.2 + (backC.z  - 0.5) * 0.25, 0.0, 1.0);
    float frontLit = clamp(0.56 + (frontC.x - frontC.y) * 2.8 + (frontC.z - 0.5) * 0.32, 0.0, 1.0);

    vec3 colBack  = mix(cloudShade, cloudBody, smoothstep(0.18, 0.84, backLit));
    vec3 colFront = mix(cloudShade, cloudTop,  smoothstep(0.16, 0.82, frontLit));

    float intensity = curtainEnv * mix(1.0, 0.75, d);
    float aBack  = maskBack  * 0.46 * intensity;
    float aFront = maskFront * 0.78 * intensity;

    rgb = colBack * aBack + rgb * (1.0 - aBack);
    alpha = aBack + alpha * (1.0 - aBack);

    rgb = colFront * aFront + rgb * (1.0 - aFront);
    alpha = aFront + alpha * (1.0 - aFront);
  }

  gl_FragColor = vec4(rgb, alpha);
}
`;

let sharedCloudAtlas = null;

function getOrBakeCloudAtlas() {
  if (sharedCloudAtlas && !sharedCloudAtlas.destroyed && sharedCloudAtlas.baseTexture?.valid) {
    return sharedCloudAtlas;
  }

  const size = 256;
  const inv = 1 / size;
  const g3 = _buildWorleyGrid(3, 1);
  const g6 = _buildWorleyGrid(6, 2);
  const g9 = _buildWorleyGrid(9, 3);
  const hField = new Float32Array(size * size);
  const rgba = new Uint8Array(size * size * 4);

  for (let y = 0; y < size; y++) {
    const v = y * inv;
    const row = y * size;
    for (let x = 0; x < size; x++) {
      const u = x * inv;
      const wx = (_pfbm4(u + 0.17, v + 0.41, 3) - 0.5) * 0.075;
      const wy = (_pfbm4(u + 0.67, v + 0.23, 3) - 0.5) * 0.075;
      const uu = _fract(u + wx);
      const vv = _fract(v + wy);
      const w1 = _pworley(uu, vv, 3, g3);
      const w2 = _pworley(uu + 0.29, vv + 0.19, 6, g6);
      const f1 = _pfbm4(uu, vv, 3);
      const billow = w1 * 0.64 + w2 * 0.36;
      hField[row + x] = Math.max(0, Math.min(1, f1 + (billow - f1) * 0.56));
    }
  }

  const sunDx = Math.round(-0.025 * size);
  const sunDy = Math.round(-0.020 * size);

  for (let y = 0; y < size; y++) {
    const v = y * inv;
    const row = y * size;
    const sy = ((y + sunDy) % size + size) % size;
    const sRow = sy * size;
    for (let x = 0; x < size; x++) {
      const u = x * inv;
      const sx = ((x + sunDx) % size + size) % size;
      const h = hField[row + x];
      const hSun = hField[sRow + sx];
      const fFluf = _pfbm4(u + 0.43, v + 0.21, 5);
      const wFluf = _pworley(u, v, 9, g9);
      const fluffy = Math.max(0, Math.min(1, fFluf + (wFluf - fFluf) * 0.42));
      const wisp = Math.max(0, Math.min(1, _pfbm4(u, _fract(v * 1.5 + _pnoise(u, v, 3) * 0.18), 4)));

      const o = (row + x) * 4;
      rgba[o] = (h * 255 + 0.5) | 0;
      rgba[o + 1] = (fluffy * 255 + 0.5) | 0;
      rgba[o + 2] = (hSun * 255 + 0.5) | 0;
      rgba[o + 3] = (wisp * 255 + 0.5) | 0;
    }
  }

  const tex = PIXI.Texture.fromBuffer(rgba, size, size, {
    scaleMode: PIXI.SCALE_MODES.LINEAR,
    mipmap: PIXI.MIPMAP_MODES.ON,
    wrapMode: PIXI.WRAP_MODES.REPEAT
  });
  tex.baseTexture.wrapMode = PIXI.WRAP_MODES.REPEAT;
  tex.baseTexture.scaleMode = PIXI.SCALE_MODES.LINEAR;
  tex.baseTexture.mipmap = PIXI.MIPMAP_MODES.ON;
  tex.baseTexture.update();

  sharedCloudAtlas = tex;
  return tex;
}

export class MacroAtmosphereLayer {
  enabled = false;
  mesh = null;
  shader = null;
  _time = 0;
  _isUnderground = false;

  mount(scene) {
    this.unmount();
    if (!scene || !canvas?.effects) return;

    const cfg = scene.flags?.[MODULE_ID] || {};
    if (cfg.macroAtmosphere === false) return;

    const bottomElev = canvas.level?.elevation?.bottom ?? 0;
    this._isUnderground = bottomElev < 0;
    if (this._isUnderground) return;

    const worldW = canvas.dimensions?.width || scene.width || 100000;
    const worldH = canvas.dimensions?.height || scene.height || 100000;
    const [sw = 1600, sh = 1000] = canvas.screenDimensions || [];
    const pivot = canvas.stage?.pivot;
    const curScale = canvas.stage?.scale?.x || 1;

    const cloudTex = getOrBakeCloudAtlas();

    const geometry = new PIXI.Geometry()
      .addAttribute("aVertexPosition", new Float32Array([
        0, 0,
        worldW, 0,
        worldW, worldH,
        0, worldH,
      ]), 2)
      .addIndex(new Uint16Array([0, 1, 2, 0, 2, 3]));

    const uniforms = {
      uCloudTex: cloudTex,
      uTime: 0,
      uScale: curScale,
      uDarkness: canvas.environment?.darknessLevel ?? scene.environment?.darknessLevel ?? 0,
      uAspect: sw / Math.max(1, sh),
      uWorldSize: new Float32Array([worldW, worldH]),
      uPivot: new Float32Array([pivot?.x || 0, pivot?.y || 0])
    };

    const program = PIXI.Program.from(MACRO_ATMO_VERT, MACRO_ATMO_FRAG);
    this.shader = new PIXI.Shader(program, uniforms);

    const state = PIXI.State.for2d();
    state.blend = true;
    state.blendMode = PIXI.BLEND_MODES.NORMAL;

    this.mesh = new PIXI.Mesh(geometry, this.shader, state, PIXI.DRAW_MODES.TRIANGLES);
    this.mesh.name = "BoundlessMacroAtmosphere";
    this.mesh.eventMode = "none";
    this.mesh.zIndex = 18; // Above illumination/coloration/darkness, cleanly below visibility (FoW) and controls
    this.mesh.visible = false;

    canvas.effects.sortableChildren = true;
    canvas.effects.addChild(this.mesh);
    this.enabled = true;
    this.updateScale(curScale);
  }

  updateScale(scale) {
    if (!this.enabled || !this.mesh || !this.shader) return;
    const shouldShow = !this._isUnderground && scale < ATMO_START_SCALE;
    this.mesh.visible = shouldShow;
    if (shouldShow) {
      const u = this.shader.uniforms;
      u.uScale = scale;
      u.uDarkness = canvas.environment?.darknessLevel ?? 0;
      const [sw = 1600, sh = 1000] = canvas.screenDimensions || [];
      u.uAspect = sw / Math.max(1, sh);
      const pivot = canvas.stage?.pivot;
      if (pivot && u.uPivot) {
        u.uPivot[0] = pivot.x;
        u.uPivot[1] = pivot.y;
      }
    }
  }

  tick(dtMs) {
    if (!this.enabled || !this.mesh?.visible || !this.shader) return;
    this._time += Math.min(0.1, Math.max(0, dtMs * 0.001));
    this.shader.uniforms.uTime = this._time;
    this.shader.uniforms.uDarkness = canvas.environment?.darknessLevel ?? 0;
  }

  unmount() {
    this.enabled = false;
    this._isUnderground = false;
    if (this.mesh) {
      this.mesh.parent?.removeChild(this.mesh);
      this.mesh.destroy(true);
      this.mesh = null;
    }
    this.shader = null;
  }
}
