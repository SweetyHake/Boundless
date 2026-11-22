/**
 * Minimal headless Foundry VTT v14 + PIXI mock for Node unit tests.
 */
export class MockPrimarySpriteMesh {
  constructor({ texture } = {}) {
    this.texture = texture || globalThis.PIXI.Texture.EMPTY;
    this.anchor = { set(x, y) { this.x = x; this.y = y; } };
    this.position = { set(x, y) { this.x = x; this.y = y; } };
    this.scale = { set(x, y) { this.x = x; this.y = y; } };
    this.visible = true;
    this.alpha = 1;
    this.unoccludedAlpha = 1;
    this.occludedAlpha = 1;
    this.pluginName = null;
    this.parent = null;
    this.destroyed = false;
  }
  updateCanvasTransform() {}
  destroy() { this.destroyed = true; }
}

export class MockLightSource {
  static destroyedIds = [];
  constructor({ sourceId }) {
    this.sourceId = sourceId;
    this.destroyed = false;
    this.data = null;
  }
  initialize(data) { this.data = data; }
  add() {}
  destroy() {
    this.destroyed = true;
    MockLightSource.destroyedIds.push(this.sourceId);
  }
}

export function installFoundryMocks() {
  const storage = new Map();
  globalThis.window = globalThis;
  globalThis.addEventListener = () => {};
  globalThis.removeEventListener = () => {};
  globalThis.document = { baseURI: "http://localhost:4444/" };
  globalThis.localStorage = {
    getItem: (k) => (storage.has(k) ? storage.get(k) : null),
    setItem: (k, v) => storage.set(k, String(v)),
    removeItem: (k) => storage.delete(k),
    clear: () => storage.clear()
  };

  globalThis.CONST = {
    OCCLUSION_MODES: { NONE: 0, FADE: 1, RADIAL: 2, VISION: 4, SURFACE: 8 },
    WALL_DOORS: { NONE: 0, DOOR: 1, SECRET: 2 },
    WALL_DOOR_STATES: { CLOSED: 0, OPEN: 1, LOCKED: 2 },
    WALL_SENSE_TYPES: { NONE: 0, LIMITED: 10, NORMAL: 20, PROXIMITY: 30, DISTANCE: 40 },
    WALL_MOVEMENT_TYPES: { NONE: 0, NORMAL: 20 },
    WALL_DIRECTIONS: { BOTH: 0, LEFT: 1, RIGHT: 2 }
  };

  globalThis.Hooks = { on() {}, once() {}, off() {}, callAll() {} };
  globalThis.ui = { controls: {}, notifications: { info() {}, warn() {}, error() {} } };
  globalThis.game = {
    world: { id: "test-world" },
    modules: new Map(),
    settings: { register() {}, get() { return false; } },
    i18n: { localize: (k) => k, has: () => false }
  };

  class MockBaseTexture {
    constructor(src, opts = {}) {
      this.resource = src;
      this.realWidth = src?.width || 1024;
      this.realHeight = src?.height || 1024;
      this.mipmap = opts.mipmap ?? 1;
      this.destroyed = false;
    }
    update() {}
    destroy() { this.destroyed = true; }
  }

  class MockTexture {
    constructor(baseTexture) {
      this.baseTexture = baseTexture || new MockBaseTexture();
      this.width = this.baseTexture.realWidth;
      this.height = this.baseTexture.realHeight;
      this.destroyed = false;
    }
    destroy(destroyBase) {
      this.destroyed = true;
      if (destroyBase) this.baseTexture?.destroy();
    }
  }
  MockTexture.EMPTY = new MockTexture(new MockBaseTexture({ width: 1, height: 1 }));
  MockTexture.WHITE = new MockTexture(new MockBaseTexture({ width: 1, height: 1 }));

  globalThis.PIXI = {
    BaseTexture: MockBaseTexture,
    Texture: MockTexture,
    Assets: { unload: async () => {} },
    MIPMAP_MODES: { ON: 1, OFF: 0 },
    SCALE_MODES: { LINEAR: 1 },
    WRAP_MODES: { CLAMP: 0 },
    ALPHA_MODES: { PMA: 1 },
    GC_MODES: { MANUAL: 1, AUTO: 0 },
    BLEND_MODES: { MAX_COLOR: 1, SCREEN: 2 },
    Rectangle: class {
      constructor(x, y, w, h) { this.x = x; this.y = y; this.width = w; this.height = h; }
    },
    Buffer: class {
      constructor(data) { this.data = data; }
      update() {}
    },
    Geometry: class {
      constructor() { this.attrs = {}; }
      addAttribute(name, buf, size) { this.attrs[name] = { buf, size }; return this; }
      addIndex(idx) { this.index = idx; return this; }
      destroy() {}
    },
    Shader: { from(v, f, u) { return { vertexSrc: v, fragmentSrc: f, uniforms: u }; } },
    Mesh: class {
      constructor(g, s) { this.geometry = g; this.shader = s; this.visible = true; }
      destroy() {}
    },
    Container: class { addChild(c) { return c; } removeChild(c) { return c; } destroy() {} },
    Graphics: class { destroy() {} }
  };

  globalThis.CONFIG = { Canvas: { lightSourceClass: MockLightSource } };

  let cspComputes = 0;
  class MockCSP {
    static get computeCount() { return cspComputes; }
    static resetComputeCount() { cspComputes = 0; }
    initialize(origin, cfg) { this.origin = origin; this.cfg = cfg; }
    compute() {
      cspComputes++;
      const r = this.cfg?.radius || 100;
      this.points = [
        this.origin.x, this.origin.y - r,
        this.origin.x + r, this.origin.y,
        this.origin.x, this.origin.y + r
      ];
    }
  }

  globalThis.foundry = {
    canvas: {
      groups: { PrimaryCanvasGroup: { SORT_LAYERS: { SCENE: 0, TILES: 500, TOKENS: 700 } } },
      primary: { PrimarySpriteMesh: MockPrimarySpriteMesh },
      sources: { PointLightSource: MockLightSource },
      loadTexture: async () => null,
      geometry: {
        edges: {
          Edge: class {
            constructor(a, b, opts) { this.a = a; this.b = b; Object.assign(this, opts); }
          }
        },
        ClockwiseSweepPolygon: MockCSP
      }
    },
    utils: {
      Color: { from: () => ({ rgb: [1, 0.8, 0.5], css: "#ffcc80" }) },
      mergeObject: Object.assign
    }
  };

  const primaryChildren = [];
  const makeLevel = (id, index, bottom, top) => ({
    id, index, isView: index === 0, isVisible: true,
    elevation: { bottom, top, base: bottom },
    edges: { set() {}, delete() {}, get() {}, getEdges() { return new Set(); } }
  });

  const lvl0 = makeLevel("lvl0", 0, 0, 20);
  globalThis.canvas = {
    ready: true,
    scene: { id: "sceneA", walls: [], lights: [] },
    dimensions: { width: 32000, height: 32000, size: 100, distance: 5 },
    grid: { size: 100, distance: 5 },
    screenDimensions: [1600, 1000],
    environment: { darknessLevel: 0.5 },
    stage: { scale: { x: 1, y: 1 }, pivot: { x: 8000, y: 8000 }, position: { x: 800, y: 500 } },
    level: lvl0,
    primary: {
      children: primaryChildren,
      levelTextures: [
        { name: "Level.0.background", visible: true },
        { name: "Level.0.foreground", visible: true }
      ],
      sortDirty: false,
      addChild(m) { m.parent = this; primaryChildren.push(m); return m; },
      removeChild(m) {
        const i = primaryChildren.indexOf(m);
        if (i >= 0) primaryChildren.splice(i, 1);
        m.parent = null;
      }
    },
    effects: {
      illumination: { lights: { children: [], addChild() {}, addChildAt() {} } },
      coloration: { children: [], addChild() {}, addChildAt() {} },
      visionSources: new Set()
    },
    tokens: { placeables: [] },
    masks: { depth: { renderDirty: false, _elevationDirty: false, mapElevation: () => 0.5 } },
    perception: { update() {} },
    pan({ x, y, scale }) {
      if (Number.isFinite(x)) this.stage.pivot.x = x;
      if (Number.isFinite(y)) this.stage.pivot.y = y;
      if (Number.isFinite(scale)) { this.stage.scale.x = scale; this.stage.scale.y = scale; }
    },
    app: { renderer: { resolution: 1 } }
  };

  return { storage, MockCSP, MockLightSource, makeLevel };
}
