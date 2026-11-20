const MODULE_ID = "boundless";
const POI_FADE_START_SCALE = 0.16; // Begin fading in below this scale
const POI_FADE_FULL_SCALE = 0.07;  // 100% visible at or below this scale

// Van Wijk & Nuij (2003) smooth zoom-and-pan curve parameters
const FLY_DEFAULT_RHO = 1.38;
const FLY_MIN_DURATION_MS = 1350;
const FLY_MAX_DURATION_MS = 3400;
const FLY_CANCEL_KEYS = new Set([
  "Escape",
  "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight",
  "KeyW", "KeyA", "KeyS", "KeyD"
]);

function smoothstep(edge0, edge1, x) {
  const t = Math.max(0, Math.min(1, (x - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
}

function sampleBezier(a1, a2, u) {
  return (((1 - 3 * a2 + 3 * a1) * u + (3 * a2 - 6 * a1)) * u + 3 * a1) * u;
}

function sampleBezierSlope(a1, a2, u) {
  return (3 * (1 - 3 * a2 + 3 * a1) * u + 2 * (3 * a2 - 6 * a1)) * u + 3 * a1;
}

function cubicBezier(x1, y1, x2, y2, t) {
  if (t <= 0) return 0;
  if (t >= 1) return 1;
  let u = t;
  for (let i = 0; i < 6; i++) {
    const err = sampleBezier(x1, x2, u) - t;
    if (Math.abs(err) < 1e-6) break;
    const slope = sampleBezierSlope(x1, x2, u);
    if (Math.abs(slope) < 1e-6) break;
    u = Math.max(0, Math.min(1, u - err / slope));
  }
  return sampleBezier(y1, y2, u);
}

// Smooth, unhurried cruise with an ultra-silky landing deceleration
function easeCameraFlight(t) {
  return cubicBezier(0.36, 0.0, 0.22, 1.0, t);
}

/**
 * Compute optimal Van Wijk & Nuij (2003) zoom-and-pan trajectory in (x, y, viewWidth).
 * Automatically dives straight in when already zoomed out, and traces a gentle parabolic
 * arc across the map when flying between two zoomed-in locations.
 */
function buildFlightPath({ x0, y0, scale0, x1, y1, scale1, viewportSize, minScale, maxScale, rho = FLY_DEFAULT_RHO }) {
  const V = Math.max(256, viewportSize || 1200);
  const w0 = V / Math.max(scale0, 1e-4);
  const w1 = V / Math.max(scale1, 1e-4);
  const dx = x1 - x0;
  const dy = y1 - y0;
  const u1 = Math.hypot(dx, dy);

  const logRatio = Math.abs(Math.log(scale1 / Math.max(scale0, 1e-4)));
  if (u1 < 2 && logRatio < 0.01) {
    return { trivial: true, S: 0, sample: () => ({ x: x1, y: y1, scale: scale1 }) };
  }

  // Degenerate case: pure zoom in place
  if (u1 < 1) {
    const k = w1 < w0 ? -1 : 1;
    const S = Math.abs(Math.log(w1 / w0)) / rho;
    return {
      trivial: false,
      S,
      sample(progress) {
        const s = S * progress;
        const w = w0 * Math.exp(k * rho * s);
        const scale = Math.max(minScale, Math.min(maxScale, V / w));
        return { x: x0 + dx * progress, y: y0 + dy * progress, scale };
      }
    };
  }

  const computeParams = (r) => {
    const r2 = r * r;
    const r4 = r2 * r2;
    const b0 = (w1 * w1 - w0 * w0 + r4 * u1 * u1) / (2 * w0 * r2 * u1);
    const b1 = (w1 * w1 - w0 * w0 - r4 * u1 * u1) / (2 * w1 * r2 * u1);
    const r0 = -Math.asinh(b0);
    const r1 = -Math.asinh(b1);
    const S = (r1 - r0) / r;
    return { rho: r, rho2: r2, r0, r1, S };
  };

  let p = computeParams(rho);

  // If the arc apex would zoom out past minScale, gently lower rho so the arc kisses minScale smoothly
  const wMax = V / Math.max(minScale, 1e-4);
  if (p.r0 < 0 && p.r1 > 0 && w0 * Math.cosh(p.r0) > wMax) {
    const fittedRho = Math.max(0.35, Math.min(rho, Math.sqrt((2 * wMax) / u1)));
    p = computeParams(fittedRho);
  }

  const coshR0 = Math.cosh(p.r0);
  const sinhR0 = Math.sinh(p.r0);
  const wScale = w0 / p.rho2;
  const uEnd = wScale * (coshR0 * Math.tanh(p.r1) - sinhR0);

  return {
    trivial: false,
    S: Math.max(0.001, p.S),
    sample(progress) {
      if (progress <= 0) return { x: x0, y: y0, scale: scale0 };
      if (progress >= 1) return { x: x1, y: y1, scale: scale1 };
      const s = p.S * progress;
      const arg = p.rho * s + p.r0;
      const w = (w0 * coshR0) / Math.cosh(arg);
      const u = wScale * (coshR0 * Math.tanh(arg) - sinhR0);
      const frac = Math.abs(uEnd) > 1e-6 ? Math.max(0, Math.min(1, u / uEnd)) : progress;
      const scale = Math.max(minScale, Math.min(maxScale, V / w));
      return {
        x: x0 + dx * frac,
        y: y0 + dy * frac,
        scale
      };
    }
  };
}

function getDefault1000Pois() {
  const loc = (k, fb) => game.i18n?.has?.(k) ? game.i18n.localize(k) : fb;
  return [
    { id: "def_city", name: loc("BOUNDLESS.DefaultPOI.City", "Столица"), x: 24000, y: 47200, targetScale: 0.45, color: "#f5c96b", kind: "major" },
    { id: "def_citadel", name: loc("BOUNDLESS.DefaultPOI.Citadel", "Цитадель"), x: 17600, y: 40100, targetScale: 0.55, color: "#f0a85a", kind: "minor" },
    { id: "def_gardens", name: loc("BOUNDLESS.DefaultPOI.Gardens", "Сады"), x: 29100, y: 40400, targetScale: 0.55, color: "#9ee08c", kind: "minor" },
    { id: "def_bridge", name: loc("BOUNDLESS.DefaultPOI.Bridge", "Речной мост"), x: 36500, y: 47900, targetScale: 0.55, color: "#8ad4f5", kind: "minor" },
    { id: "def_village", name: loc("BOUNDLESS.DefaultPOI.Village", "Деревня у озера"), x: 71500, y: 49600, targetScale: 0.5, color: "#f5c96b", kind: "major" },
    { id: "def_owlwell", name: loc("BOUNDLESS.DefaultPOI.OwlWell", "Колодец Совы"), x: 52400, y: 69300, targetScale: 0.6, color: "#c9b3ff", kind: "minor" },
    { id: "def_goblin", name: loc("BOUNDLESS.DefaultPOI.GoblinCamp", "Лагерь гоблинов"), x: 59500, y: 76550, targetScale: 0.6, color: "#ff8c78", kind: "minor" },
    { id: "def_north", name: loc("BOUNDLESS.DefaultPOI.NorthOutpost", "Северный форпост"), x: 51300, y: 18800, targetScale: 0.6, color: "#f0b47a", kind: "minor" }
  ];
}

export class PoiManager {
  controller = null;
  container = null;
  pins = []; // [{ poi, root, bg, label, hovered }]
  enabled = true;
  lastScale = -1;
  _flight = null;

  constructor(controller = null) {
    this.controller = controller;
  }

  mount(scene, manifest) {
    this.unmount();
    const cfg = scene?.flags?.[MODULE_ID] || {};
    this.enabled = cfg.showPois !== false;
    if (!this.enabled || !canvas?.controls) return;

    this.container = new PIXI.Container();
    this.container.zIndex = 650;
    this.container.eventMode = "passive";
    this.container.interactiveChildren = true;
    canvas.controls.addChild(this.container);

    this.rebuild(scene, manifest);
    this.updateScale(canvas.stage?.scale?.x || 1);
  }

  resolvePois(scene, manifest) {
    const cfg = scene?.flags?.[MODULE_ID] || {};
    const customPois = Array.isArray(cfg.pois) ? cfg.pois : null;
    if (customPois && customPois.length > 0) return customPois;
    if (Array.isArray(manifest?.pois) && manifest.pois.length > 0) return manifest.pois;
    // Built-in 1000x1000 map defaults when no custom POIs are set
    if (manifest?.worldCells === 1000 || (canvas.dimensions?.width === 100000 && canvas.dimensions?.height === 100000)) {
      return getDefault1000Pois();
    }
    return [];
  }

  rebuild(scene = canvas.scene, manifest = null) {
    if (!this.container) return;
    for (const p of this.pins) {
      p.root.parent?.removeChild(p.root);
      p.root.destroy({ children: true });
    }
    this.pins = [];

    const cfg = scene?.flags?.[MODULE_ID] || {};
    this.enabled = cfg.showPois !== false;
    if (!this.enabled) {
      this.container.visible = false;
      return;
    }

    const viewedLevelId = canvas.level?.id;
    const pois = this.resolvePois(scene, manifest);

    for (const poi of pois) {
      if (!poi || !Number.isFinite(poi.x) || !Number.isFinite(poi.y)) continue;
      if (poi.hidden && !game.user.isGM) continue;
      if (poi.levelId && viewedLevelId && poi.levelId !== viewedLevelId && !canvas.level?.visibility?.levels?.has(poi.levelId)) {
        continue;
      }
      this._createPin(poi);
    }

    this.lastScale = -1;
    this.updateScale(canvas.stage?.scale?.x || 1);
  }

  _createPin(poi) {
    const isMajor = poi.kind === "major";
    const accentHex = poi.hidden ? 0xb87aff : foundry.utils.Color.from(poi.color || "#f5c96b").valueOf();
    const fontSize = isMajor ? 15 : 12.5;

    const root = new PIXI.Container();
    root.position.set(poi.x, poi.y);
    root.eventMode = "static";
    root.cursor = "pointer";

    const style = new PIXI.TextStyle({
      fontFamily: "Signika, Palatino Linotype, serif",
      fontSize,
      fontWeight: isMajor ? "700" : "600",
      fill: poi.hidden ? "#e2c8ff" : "#f7ebd2",
      dropShadow: true,
      dropShadowColor: "#000000",
      dropShadowBlur: 3,
      dropShadowDistance: 1,
      letterSpacing: isMajor ? 0.6 : 0.3
    });

    const label = new PIXI.Text(poi.name || "", style);
    label.anchor.set(0.5, 0.5);

    const padX = isMajor ? 14 : 10;
    const padY = isMajor ? 6 : 4;
    const boxW = Math.max(44, label.width + padX * 2);
    const boxH = label.height + padY * 2;
    const pillY = -(boxH * 0.5 + 12);

    const bg = new PIXI.Graphics();
    const drawBg = (hover) => {
      bg.clear();
      // Diamond anchor marker at exact POI coordinate (0, 0)
      bg.lineStyle(1.5, accentHex, hover ? 1.0 : 0.85);
      bg.beginFill(hover ? accentHex : 0x16120e, 0.92);
      bg.drawPolygon([0, -6, 5, 0, 0, 6, -5, 0]);
      bg.endFill();

      // Pill badge above marker
      bg.lineStyle(hover ? 2 : 1.25, accentHex, hover ? 1.0 : 0.78);
      bg.beginFill(0x110e0b, hover ? 0.92 : 0.78);
      bg.drawRoundedRect(-boxW * 0.5, pillY - boxH * 0.5, boxW, boxH, 6);
      bg.endFill();
    };
    drawBg(false);
    label.position.set(0, pillY);

    root.addChild(bg, label);
    root.hitArea = new PIXI.Rectangle(-boxW * 0.5 - 4, pillY - boxH * 0.5 - 4, boxW + 8, boxH + 22);

    const entry = { poi, root, bg, label, hovered: false, isMajor };

    root.on("pointerover", () => {
      entry.hovered = true;
      drawBg(true);
      this._applyPinTransform(entry, canvas.stage?.scale?.x || 1);
      root.zIndex = 10;
      this.container.sortDirty = true;
    });
    root.on("pointerout", () => {
      entry.hovered = false;
      drawBg(false);
      this._applyPinTransform(entry, canvas.stage?.scale?.x || 1);
      root.zIndex = isMajor ? 2 : 1;
      this.container.sortDirty = true;
    });
    root.on("pointerdown", (ev) => {
      if (ev.button !== 0) return;
      ev.stopPropagation();
      this.flyTo(poi);
    });

    root.zIndex = isMajor ? 2 : 1;
    this.container.sortableChildren = true;
    this.container.addChild(root);
    this.pins.push(entry);
  }

  _applyPinTransform(entry, stageScale) {
    const inv = 1 / Math.max(stageScale, 0.0005);
    const hoverBoost = entry.hovered ? 1.08 : 1.0;
    entry.root.scale.set(inv * hoverBoost);
  }

  updateScale(stageScale) {
    if (!this.container || !this.enabled || !this.pins.length) return;
    if (Math.abs(stageScale - this.lastScale) < 0.00005) return;
    this.lastScale = stageScale;

    // Fade in smoothly as camera zooms out below POI_FADE_START_SCALE (0.16 -> 0.07)
    const globalAlpha = smoothstep(POI_FADE_START_SCALE, POI_FADE_FULL_SCALE, stageScale);
    if (globalAlpha <= 0.01) {
      this.container.visible = false;
      return;
    }

    this.container.visible = true;
    for (const entry of this.pins) {
      const poi = entry.poi;
      // Minor pins fade out slightly earlier on extreme zoom-out (<0.02) so major landmarks stay readable
      let a = globalAlpha;
      if (!entry.isMajor && stageScale < 0.025) {
        a *= smoothstep(0.012, 0.025, stageScale);
      }
      if (poi.hidden) a *= 0.8;
      if (a <= 0.01) {
        entry.root.visible = false;
        continue;
      }
      entry.root.visible = true;
      entry.root.alpha = a;
      this._applyPinTransform(entry, stageScale);
    }
  }

  cancelFlight() {
    const f = this._flight;
    if (!f) return;
    this._flight = null;
    f.cleanup();
    f.resolve(false);
  }

  async flyTo(poi, options = {}) {
    if (!poi || !canvas?.ready || !canvas.stage) return false;

    // Cancel any previous Boundless flight or native Foundry animatePan seamlessly
    this.cancelFlight();
    const AnimCls = foundry.canvas?.animation?.CanvasAnimation || globalThis.CanvasAnimation;
    try { AnimCls?.terminateAnimation?.("canvas.animatePan"); } catch {}

    if (poi.levelId && canvas.level?.id !== poi.levelId && canvas.scene?.levels?.has(poi.levelId)) {
      await canvas.scene.view({ level: poi.levelId });
      if (!canvas?.ready || !canvas.stage) return false;
    }

    const worldMinScale = this.controller?._worldMinScale ?? canvas.dimensions?.scale?.min ?? 0.008;
    const activeMinScale = canvas.dimensions?.scale?.min ?? worldMinScale;
    const maxScale = canvas.dimensions?.scale?.max ?? 2.5;

    const rawTargetScale = options.scale ?? poi.targetScale ?? 0.45;
    const clampedTargetScale = Math.max(activeMinScale, Math.min(maxScale, rawTargetScale));
    const constrained = canvas._constrainView
      ? canvas._constrainView({ x: poi.x, y: poi.y, scale: clampedTargetScale })
      : { x: poi.x, y: poi.y, scale: clampedTargetScale };

    const x0 = canvas.stage.pivot.x;
    const y0 = canvas.stage.pivot.y;
    const scale0 = canvas.stage.scale.x || 1;
    const x1 = constrained.x;
    const y1 = constrained.y;
    const scale1 = constrained.scale;

    if (!Number.isFinite(x0) || !Number.isFinite(y0) || !Number.isFinite(x1) || !Number.isFinite(y1)) {
      return false;
    }

    const [sw = 1600, sh = 1000] = canvas.screenDimensions || [];
    const viewportSize = Math.hypot(sw, sh) * 0.65;
    // Allow parabolic arc to soar above tokenMinScale during flight; restored cleanly on landing/cancel
    const flightMinScale = Math.min(activeMinScale, worldMinScale);

    const path = buildFlightPath({
      x0, y0, scale0,
      x1, y1, scale1,
      viewportSize,
      minScale: flightMinScale,
      maxScale,
      rho: options.rho ?? FLY_DEFAULT_RHO
    });

    if (path.trivial) {
      canvas.pan({ x: x1, y: y1, scale: scale1 });
      return true;
    }

    const duration = Number.isFinite(options.duration) && options.duration > 0
      ? options.duration
      : Math.max(FLY_MIN_DURATION_MS, Math.min(FLY_MAX_DURATION_MS, Math.round(920 + path.S * 580)));

    // Prewarm destination & approach pyramid tiles in VRAM while camera is still gliding in
    this.controller?.prewarmArea?.(x1, y1, scale1);

    const ticker = canvas.app?.ticker;
    const view = canvas.app?.view || canvas.app?.canvas;
    const temporarilyRelaxedMin = Boolean(canvas.dimensions?.scale && activeMinScale > flightMinScale);
    if (temporarilyRelaxedMin) {
      canvas.dimensions.scale.min = flightMinScale;
    }

    this.controller?.setCameraFlying?.(true);

    return new Promise((resolve) => {
      let startTime = null;
      let done = false;
      let rafId = null;

      const onUserWheel = () => this.cancelFlight();
      const onUserPointerDown = (ev) => {
        if (ev.button === 1 || ev.button === 2) this.cancelFlight();
      };
      const onUserKeyDown = (ev) => {
        if (!FLY_CANCEL_KEYS.has(ev.code)) return;
        const tag = ev.target?.tagName;
        if (tag === "INPUT" || tag === "TEXTAREA" || ev.target?.isContentEditable) return;
        this.cancelFlight();
      };

      const step = () => {
        if (done) return;
        if (!canvas?.ready || !canvas.stage) {
          finish(false);
          return;
        }
        const now = performance.now();
        if (startTime === null) startTime = now;
        const elapsed = now - startTime;
        const t = Math.max(0, Math.min(1, elapsed / duration));
        const eased = easeCameraFlight(t);
        const pose = path.sample(eased);
        canvas.pan(pose);

        if (t >= 1) {
          finish(true);
        } else if (!ticker) {
          rafId = requestAnimationFrame(step);
        }
      };

      const cleanup = () => {
        if (done) return;
        done = true;
        if (ticker) ticker.remove(step);
        if (rafId !== null) cancelAnimationFrame(rafId);
        view?.removeEventListener("wheel", onUserWheel, true);
        view?.removeEventListener("pointerdown", onUserPointerDown, true);
        window.removeEventListener("keydown", onUserKeyDown, true);
        if (temporarilyRelaxedMin && canvas?.dimensions?.scale) {
          canvas.dimensions.scale.min = activeMinScale;
        }
        this.controller?.setCameraFlying?.(false);
      };

      const finish = (completed) => {
        if (this._flight?.cleanup === cleanup) this._flight = null;
        cleanup();
        resolve(completed);
      };

      this._flight = { cleanup, resolve };

      view?.addEventListener("wheel", onUserWheel, { capture: true, passive: true });
      view?.addEventListener("pointerdown", onUserPointerDown, { capture: true, passive: true });
      window.addEventListener("keydown", onUserKeyDown, true);

      if (ticker) {
        ticker.add(step);
      } else {
        rafId = requestAnimationFrame(step);
      }
    });
  }

  unmount() {
    this.cancelFlight();
    if (this.container) {
      this.container.parent?.removeChild(this.container);
      this.container.destroy({ children: true });
      this.container = null;
    }
    this.pins = [];
    this.lastScale = -1;
  }
}
