import { MODULE_ID, smoothstep, escapeHtml, loc, getLiveStageTransform } from "./utils.mjs";

// 3-tier hierarchical POI zoom visibility & landing defaults:
// 1) major  (Region / Capital)  -> visible from orbit; clicking lands at macro overview (0.085x) where sub-pins appear
// 2) minor  (District / Area)   -> appears as you descend into a region/capital (0.026..0.44x); lands at district/site view
// 3) detail (Building / Tavern) -> appears once inside a city/district (0.07..0.74x); lands close-up (0.68x)
export const POI_TIER_DEFAULTS = Object.freeze({
  major: {
    minScale: 0,
    fadeInEnd: 0,
    fadeOutStart: 0.115,
    maxScale: 0.175,
    defaultTargetScale: 0.085
  },
  minor: {
    minScale: 0.025,
    fadeInEnd: 0.055,
    fadeOutStart: 0.30,
    maxScale: 0.44,
    defaultTargetScale: 0.26
  },
  detail: {
    minScale: 0.070,
    fadeInEnd: 0.125,
    fadeOutStart: 0.56,
    maxScale: 0.74,
    defaultTargetScale: 0.68
  }
});

export function normalizePoiKind(kind) {
  if (kind === "detail") return "detail";
  if (kind === "minor") return "minor";
  return "major";
}

function computePoiTierAlpha(poi, stageScale) {
  const tierKey = normalizePoiKind(poi?.kind);
  const def = POI_TIER_DEFAULTS[tierKey];
  const minS = Number.isFinite(poi?.minScale) ? poi.minScale : def.minScale;
  const maxS = Number.isFinite(poi?.maxScale) ? poi.maxScale : def.maxScale;
  const fadeInEnd = Number.isFinite(poi?.minScale)
    ? (minS > 0 ? minS * 1.85 : 0)
    : def.fadeInEnd;
  const fadeOutStart = Number.isFinite(poi?.maxScale)
    ? maxS * 0.72
    : def.fadeOutStart;

  const aIn = minS > 0 ? smoothstep(minS, Math.max(minS + 0.005, fadeInEnd), stageScale) : 1.0;
  const aOut = maxS > 0 ? smoothstep(maxS, Math.min(maxS - 0.005, fadeOutStart), stageScale) : 1.0;
  return aIn * aOut;
}

// Van Wijk & Nuij (2003) smooth zoom-and-pan curve parameters
const FLY_DEFAULT_RHO = 1.38;
const FLY_MIN_DURATION_MS = 1350;
const FLY_MAX_DURATION_MS = 3400;
const FLY_CANCEL_KEYS = new Set([
  "Escape",
  "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight",
  "KeyW", "KeyA", "KeyS", "KeyD"
]);

export const POI_ICON_META = Object.freeze({
  city: { labelKey: "BOUNDLESS.PoiIcons.City", fa: "fa-chess-rook", defaultColor: "#f5c96b" },
  village: { labelKey: "BOUNDLESS.PoiIcons.Village", fa: "fa-house-chimney", defaultColor: "#e6c37a" },
  castle: { labelKey: "BOUNDLESS.PoiIcons.Castle", fa: "fa-fort-awesome", defaultColor: "#f0a85a" },
  tavern: { labelKey: "BOUNDLESS.PoiIcons.Tavern", fa: "fa-beer-mug-empty", defaultColor: "#ffae66" },
  dungeon: { labelKey: "BOUNDLESS.PoiIcons.Dungeon", fa: "fa-dungeon", defaultColor: "#c49bff" },
  camp: { labelKey: "BOUNDLESS.PoiIcons.Camp", fa: "fa-campground", defaultColor: "#ff8c78" },
  port: { labelKey: "BOUNDLESS.PoiIcons.Port", fa: "fa-anchor", defaultColor: "#8ad4f5" },
  nature: { labelKey: "BOUNDLESS.PoiIcons.Nature", fa: "fa-tree", defaultColor: "#8fe0a8" },
  bridge: { labelKey: "BOUNDLESS.PoiIcons.Bridge", fa: "fa-bridge", defaultColor: "#9cd4ff" },
  landmark: { labelKey: "BOUNDLESS.PoiIcons.Landmark", fa: "fa-compass", defaultColor: "#ffd275" },
  pin: { labelKey: "BOUNDLESS.PoiIcons.Pin", fa: "fa-location-dot", defaultColor: "#f5c96b" }
});

export function inferPoiIcon(poi) {
  if (poi?.icon && POI_ICON_META[poi.icon]) return poi.icon;
  const n = String(poi?.name || "").toLowerCase();
  if (/столиц|град|город|capital|city|town/.test(n)) return "city";
  if (/цитадел|бастион|замок|крепост|застав|форпост|предел|рубеж|citadel|castle|keep|fort|outpost|bastion/.test(n)) return "castle";
  if (/таверн|трактир|постоял|tavern|inn/.test(n)) return "tavern";
  if (/руин|курган|разлом|каньон|пещер|подземел|склеп|гробниц|ruin|dungeon|crypt|cave|barrow|rift|canyon/.test(n)) return "dungeon";
  if (/лагер|караван|стоянк|camp|caravan/.test(n)) return "camp";
  if (/порт|гаван|залив|бухт|мыс|берег|фьорд|port|harbor|bay|cove|cape|coast|fjord/.test(n)) return "port";
  if (/мост|тракт|переправ|bridge|road|crossing/.test(n)) return "bridge";
  if (/деревн|оазис|пруд|террас|посел|village|hamlet|oasis|terrace/.test(n)) return "village";
  if (/сад|рощ|чащ|лес|долин|луг|топ|болот|холм|дюн|garden|grove|forest|wood|valley|meadow|marsh|swamp|hill|dune/.test(n)) return "nature";
  if (/маяк|колодец|хребет|край|башн|lighthouse|well|ridge|peak|tower/.test(n)) return "landmark";
  return poi?.kind === "major" ? "city" : "pin";
}

function drawPoiGlyph(g, iconKey, r, color) {
  g.lineStyle(0);
  g.beginFill(color, 1);

  switch (iconKey) {
    case "city": {
      // Three-tower city silhouette
      g.drawRect(-r * 0.28, -r * 0.65, r * 0.56, r * 1.35);
      g.drawPolygon([-r * 0.32, -r * 0.65, 0, -r * 1.05, r * 0.32, -r * 0.65]);
      g.drawRect(-r * 0.82, -r * 0.25, r * 0.44, r * 0.95);
      g.drawPolygon([-r * 0.86, -r * 0.25, -r * 0.6, -r * 0.6, -r * 0.34, -r * 0.25]);
      g.drawRect(r * 0.38, -r * 0.25, r * 0.44, r * 0.95);
      g.drawPolygon([r * 0.34, -r * 0.25, r * 0.6, -r * 0.6, r * 0.86, -r * 0.25]);
      break;
    }
    case "village": {
      // Cozy cottage with pitched roof
      g.drawPolygon([0, -r * 0.92, r * 0.88, -r * 0.08, -r * 0.88, -r * 0.08]);
      g.drawRect(-r * 0.62, -r * 0.1, r * 1.24, r * 0.82);
      g.endFill();
      g.beginFill(0x130f0b, 0.95);
      g.drawRect(-r * 0.18, r * 0.18, r * 0.36, r * 0.54);
      break;
    }
    case "castle": {
      // Crenellated fortress tower
      g.drawRect(-r * 0.72, -r * 0.42, r * 1.44, r * 1.14);
      g.drawRect(-r * 0.78, -r * 0.82, r * 0.38, r * 0.42);
      g.drawRect(-r * 0.19, -r * 0.82, r * 0.38, r * 0.42);
      g.drawRect(r * 0.4, -r * 0.82, r * 0.38, r * 0.42);
      g.endFill();
      g.beginFill(0x130f0b, 0.95);
      g.drawRoundedRect(-r * 0.24, r * 0.08, r * 0.48, r * 0.66, r * 0.22);
      break;
    }
    case "tavern": {
      // Tankard / mug silhouette
      g.drawRoundedRect(-r * 0.56, -r * 0.55, r * 0.92, r * 1.24, r * 0.15);
      g.drawCircle(-r * 0.34, -r * 0.62, r * 0.26);
      g.drawCircle(0, -r * 0.7, r * 0.28);
      g.drawCircle(r * 0.26, -r * 0.6, r * 0.22);
      g.endFill();
      g.lineStyle(r * 0.24, color, 1);
      g.drawRoundedRect(r * 0.28, -r * 0.32, r * 0.44, r * 0.68, r * 0.2);
      return;
    }
    case "dungeon": {
      // Gothic ruin arch / cavern entrance
      g.drawRoundedRect(-r * 0.78, -r * 0.82, r * 1.56, r * 1.54, r * 0.74);
      g.endFill();
      g.beginFill(0x130f0b, 0.95);
      g.drawRoundedRect(-r * 0.42, -r * 0.36, r * 0.84, r * 1.12, r * 0.4);
      g.endFill();
      g.beginFill(color, 0.9);
      g.drawPolygon([0, -r * 0.22, r * 0.16, r * 0.04, 0, r * 0.3, -r * 0.16, r * 0.04]);
      break;
    }
    case "camp": {
      // Pointed tent with crossed poles
      g.drawPolygon([0, -r * 0.82, r * 0.88, r * 0.72, -r * 0.88, r * 0.72]);
      g.endFill();
      g.beginFill(0x130f0b, 0.95);
      g.drawPolygon([0, r * 0.02, r * 0.34, r * 0.74, -r * 0.34, r * 0.74]);
      g.endFill();
      g.lineStyle(r * 0.18, color, 1);
      g.moveTo(-r * 0.22, -r * 0.96);
      g.lineTo(r * 0.16, -r * 0.58);
      g.moveTo(r * 0.22, -r * 0.96);
      g.lineTo(-r * 0.16, -r * 0.58);
      return;
    }
    case "port": {
      // Anchor
      g.endFill();
      g.lineStyle(r * 0.22, color, 1);
      g.drawCircle(0, -r * 0.64, r * 0.22);
      g.moveTo(0, -r * 0.42);
      g.lineTo(0, r * 0.68);
      g.moveTo(-r * 0.46, -r * 0.16);
      g.lineTo(r * 0.46, -r * 0.16);
      const a0 = 0.18 * Math.PI;
      g.moveTo(r * 0.62 * Math.cos(a0), r * 0.12 + r * 0.62 * Math.sin(a0));
      g.arc(0, r * 0.12, r * 0.62, a0, 0.82 * Math.PI);
      return;
    }
    case "nature": {
      // Layered pine tree
      g.drawPolygon([0, -r * 0.96, r * 0.56, -r * 0.24, -r * 0.56, -r * 0.24]);
      g.drawPolygon([0, -r * 0.5, r * 0.78, r * 0.38, -r * 0.78, r * 0.38]);
      g.drawRect(-r * 0.16, r * 0.36, r * 0.32, r * 0.46);
      break;
    }
    case "bridge": {
      // Arched stone bridge
      g.drawRect(-r * 0.88, -r * 0.38, r * 1.76, r * 0.98);
      g.drawRect(-r * 0.92, -r * 0.58, r * 1.84, r * 0.22);
      g.endFill();
      g.beginFill(0x130f0b, 0.95);
      g.drawCircle(0, r * 0.64, r * 0.56);
      break;
    }
    case "landmark": {
      // 4-point compass star
      g.drawPolygon([
        0, -r * 0.96,
        r * 0.24, -r * 0.24,
        r * 0.96, 0,
        r * 0.24, r * 0.24,
        0, r * 0.96,
        -r * 0.24, r * 0.24,
        -r * 0.96, 0,
        -r * 0.24, -r * 0.24
      ]);
      break;
    }
    default: {
      // Classic diamond gem
      g.drawPolygon([0, -r * 0.86, r * 0.66, 0, 0, r * 0.86, -r * 0.66, 0]);
      g.endFill();
      g.beginFill(0x130f0b, 0.85);
      g.drawCircle(0, 0, r * 0.22);
      break;
    }
  }
  g.endFill();
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

/**
 * GTA 5-style 3-phase character switch trajectory:
 *   1. Smooth vertical pull-up from current position (skipped automatically if already zoomed out)
 *   2. Sky-level horizontal cruise over the world toward the destination character
 *   3. Gradual, unhurried vertical descent onto the target character with silky landing cushion
 * Overlapping C1-smooth phase windows keep transitions completely seamless with zero corner stops.
 */
function buildGtaFlightPath({ x0, y0, scale0, x1, y1, scale1, viewportSize, minScale, maxScale }) {
  const V = Math.max(256, viewportSize || 1200);
  const dx = x1 - x0;
  const dy = y1 - y0;
  const dist = Math.hypot(dx, dy);
  const logRatio = Math.abs(Math.log(scale1 / Math.max(scale0, 1e-4)));

  if (dist < 2 && logRatio < 0.01) {
    return { trivial: true, S: 0, durationMs: 0, rawTime: true, sample: () => ({ x: x1, y: y1, scale: scale1 }) };
  }

  const safeMin = Math.max(1e-4, minScale);
  const lowScale = Math.min(scale0, scale1);
  const w0 = V / Math.max(scale0, 1e-4);

  // Pick flight altitude proportional to travel distance so the camera rises meaningfully
  // above rooftops / districts / provinces before cruising across, without needlessly pulling
  // even higher when already zoomed out and clicking a character visible on screen.
  let apexScale;
  if (dist < 480 && scale0 >= 0.42 && scale1 >= 0.42) {
    // Short room-scale hop: subtle lift -> glide -> settle (responsive in combat)
    apexScale = Math.max(safeMin, lowScale * 0.62);
  } else {
    const distAltitude = (V * 0.40) / Math.max(dist, 1);
    const alreadyElevatedAndVisible = scale0 <= 0.22 && dist <= w0 * 0.75;
    let desiredApex;
    if (alreadyElevatedAndVisible) {
      // Already looking from macro overview with character in view: glide over and descend smoothly
      desiredApex = lowScale;
    } else if (dist > 60) {
      const pullUpCap = scale0 > 0.22 ? Math.min(0.24, lowScale / 2.5) : lowScale;
      desiredApex = Math.min(distAltitude, pullUpCap);
    } else {
      desiredApex = lowScale;
    }
    const floorApex = Math.max(safeMin * 1.12, 0.012);
    apexScale = Math.max(floorApex, Math.min(lowScale, desiredApex));
  }

  const logS0 = Math.log(Math.max(scale0, 1e-4));
  const logS1 = Math.log(Math.max(scale1, 1e-4));
  const logApex = Math.log(Math.max(apexScale, 1e-4));

  const upSpan = Math.max(0, logS0 - logApex);
  const downSpan = Math.max(0, logS1 - logApex);
  const needUp = upSpan > 0.06;
  const needCruise = dist > 14;
  const needDown = downSpan > 0.06;

  const wApex = V / Math.max(apexScale, 1e-4);
  const cruiseScreens = dist / Math.max(wApex, 1);

  const wUp = needUp ? (0.58 + upSpan * 0.42) : 0;
  const wCruise = needCruise ? (0.44 + Math.min(1.4, Math.log1p(cruiseScreens) * 0.46)) : 0;
  // Unhurried, gradual descent so the camera eases smoothly down onto the character
  const wDown = needDown ? (0.82 + downSpan * 0.56) : 0;
  const wSum = Math.max(0.001, wUp + wCruise + wDown);

  const fUp = wUp / wSum;
  const fDown = wDown / wSum;

  // Gentle phase overlaps for silky C1-smooth flow between pull-up, sky cruise, and gradual descent
  const upEnd = needUp ? Math.min(0.64, fUp * 1.18) : 0;
  const downStart = needDown ? Math.max(upEnd * 0.76, 1.0 - fDown * 1.18) : 1.0;

  const cruiseStart = needUp ? (fUp * 0.68) : 0.0;
  const cruiseEnd = needDown ? Math.max(cruiseStart + 0.14, 1.0 - fDown * 0.72) : 1.0;
  const cruiseLen = Math.max(0.05, cruiseEnd - cruiseStart);
  const downLen = Math.max(0.05, 1.0 - downStart);

  // Adaptive cinematic duration (~2.5-5.4s) with generous time for smooth zoom-out and zoom-in
  const isShortHop = dist < 480 && scale0 >= 0.42 && scale1 >= 0.42;
  const rawDuration = isShortHop
    ? Math.round(920 + dist * 0.55)
    : Math.round(1450 + upSpan * 720 + Math.log1p(cruiseScreens) * 700 + downSpan * 860);
  const durationMs = isShortHop
    ? Math.max(900, Math.min(1300, rawDuration))
    : Math.max(2400, Math.min(5400, rawDuration));

  // Velvet S-curves with gentle mid-phase slope (no sudden drop or snap)
  const easePullUp = (u) => cubicBezier(0.42, 0.0, 0.36, 1.0, u);
  const easeCruise = (u) => cubicBezier(0.45, 0.0, 0.32, 1.0, u);
  const easeDescent = (u) => cubicBezier(0.38, 0.0, 0.28, 1.0, u);

  return {
    trivial: false,
    rawTime: true,
    S: upSpan + downSpan + Math.log1p(cruiseScreens),
    durationMs,
    sample(t) {
      if (t <= 0) return { x: x0, y: y0, scale: scale0 };
      if (t >= 1) return { x: x1, y: y1, scale: scale1 };

      const uUp = needUp ? easePullUp(Math.max(0, Math.min(1, t / Math.max(0.05, upEnd)))) : 1.0;
      const uDown = needDown ? easeDescent(Math.max(0, Math.min(1, (t - downStart) / downLen))) : 0.0;
      const uMove = needCruise
        ? easeCruise(Math.max(0, Math.min(1, (t - cruiseStart) / cruiseLen)))
        : 1.0;

      const logScale = logApex + (logS0 - logApex) * (1.0 - uUp) + (logS1 - logApex) * uDown;
      const scale = Math.max(minScale, Math.min(maxScale, Math.exp(logScale)));

      return {
        x: x0 + dx * uMove,
        y: y0 + dy * uMove,
        scale
      };
    }
  };
}

function getProvinceSubPoiTemplates() {
  return [
    { suffix: "citadel", name: loc("BOUNDLESS.DefaultPOI.Citadel", "Цитадель"), x: 17600, y: 40100, targetScale: 0.45, color: "#f0a85a", kind: "minor", icon: "castle" },
    { suffix: "gardens", name: loc("BOUNDLESS.DefaultPOI.Gardens", "Королевские сады"), x: 29100, y: 40400, targetScale: 0.45, color: "#9ee08c", kind: "minor", icon: "nature" },
    { suffix: "bridge", name: loc("BOUNDLESS.DefaultPOI.Bridge", "Речной мост"), x: 36500, y: 47900, targetScale: 0.48, color: "#8ad4f5", kind: "minor", icon: "bridge" },
    { suffix: "plaza", name: loc("BOUNDLESS.DefaultPOI.MainPlaza", "Главная площадь"), x: 24000, y: 48200, targetScale: 0.24, color: "#f5c96b", kind: "minor", icon: "landmark" },
    { suffix: "tavern_east", name: loc("BOUNDLESS.DefaultPOI.TavernEast", "Таверна «Золотой ковш»"), x: 28673, y: 52000, targetScale: 0.68, color: "#ffae66", kind: "detail", icon: "tavern" },
    { suffix: "tavern_north", name: loc("BOUNDLESS.DefaultPOI.TavernNorth", "Таверна «Синий грифон»"), x: 20805, y: 41503, targetScale: 0.68, color: "#ffae66", kind: "detail", icon: "tavern" },
    { suffix: "tavern_west", name: loc("BOUNDLESS.DefaultPOI.TavernWest", "Таверна у Западных ворот"), x: 16785, y: 51488, targetScale: 0.68, color: "#ffae66", kind: "detail", icon: "tavern" },
    { suffix: "village", name: loc("BOUNDLESS.DefaultPOI.Village", "Деревня у озера"), x: 74500, y: 50500, targetScale: 0.11, color: "#f5c96b", kind: "minor", icon: "village" },
    { suffix: "sawmill", name: loc("BOUNDLESS.DefaultPOI.Sawmill", "Лесопилка"), x: 71500, y: 49600, targetScale: 0.58, color: "#e6c37a", kind: "detail", icon: "village" },
    { suffix: "lake_inn", name: loc("BOUNDLESS.DefaultPOI.LakeInn", "Трактир у озера"), x: 81051, y: 53119, targetScale: 0.68, color: "#ffae66", kind: "detail", icon: "tavern" },
    { suffix: "owlwell", name: loc("BOUNDLESS.DefaultPOI.OwlWell", "Колодец Совы"), x: 52400, y: 69300, targetScale: 0.52, color: "#c9b3ff", kind: "minor", icon: "landmark" },
    { suffix: "goblin", name: loc("BOUNDLESS.DefaultPOI.GoblinCamp", "Лагерь гоблинов"), x: 59500, y: 76550, targetScale: 0.52, color: "#ff8c78", kind: "minor", icon: "camp" },
    { suffix: "north", name: loc("BOUNDLESS.DefaultPOI.NorthOutpost", "Северный форпост"), x: 51300, y: 18800, targetScale: 0.52, color: "#f0b47a", kind: "minor", icon: "castle" }
  ];
}

export function getDefault1000Pois() {
  const subs = getProvinceSubPoiTemplates();
  return [
    { id: "def_city", name: loc("BOUNDLESS.DefaultPOI.City", "Столица"), x: 24000, y: 47200, targetScale: 0.085, color: "#f5c96b", kind: "major", icon: "city" },
    { id: "def_village", name: loc("BOUNDLESS.DefaultPOI.Village", "Деревня у озера"), x: 74500, y: 50500, targetScale: 0.11, color: "#f5c96b", kind: "major", icon: "village" },
    ...subs
      .filter(s => s.suffix !== "village")
      .map(({ suffix, ...rest }) => ({ id: `def_${suffix}`, ...rest }))
  ];
}

function rectsOverlap(a, b, pad = 0) {
  return !(
    a.x1 + pad < b.x0 - pad ||
    a.x0 - pad > b.x1 + pad ||
    a.y1 + pad < b.y0 - pad ||
    a.y0 - pad > b.y1 + pad
  );
}

/**
 * Shared DialogV2 modal for creating or editing a POI pin (used both from map right-click/tool and SceneConfig).
 */
export async function openPoiEditorDialog(controller, scene, initial = {}) {
  if (!scene) return null;
  const DialogV2 = foundry.applications.api.DialogV2;
  const isEdit = Boolean(initial.id);
  const currentScale = canvas.ready && canvas.scene?.id === scene?.id
    ? Math.max(0.15, Math.min(1.5, Number(canvas.stage.scale.x.toFixed(2))))
    : 0.45;
  const defaultIcon = inferPoiIcon(initial);
  const defaultKind = normalizePoiKind(initial.kind || (isEdit ? "major" : "minor"));
  const defaultColor = initial.color || POI_ICON_META[defaultIcon]?.defaultColor || "#f5c96b";
  const tierDef = POI_TIER_DEFAULTS[defaultKind];
  const defaultScale = Number(initial.targetScale ?? initial.scale ?? (isEdit ? currentScale : tierDef.defaultTargetScale)) || tierDef.defaultTargetScale;

  const iconOptions = Object.entries(POI_ICON_META).map(([key, meta]) => {
    const sel = key === defaultIcon ? "selected" : "";
    return `<option value="${escapeHtml(key)}" ${sel}>${escapeHtml(loc(meta.labelKey, key))}</option>`;
  }).join("");

  const journalOptions = [
    `<option value="">${escapeHtml(loc("BOUNDLESS.Config.PoiJournalNone", "Не привязан"))}</option>`,
    ...Array.from(game.journal || []).map(j => {
      const sel = j.uuid === initial.journalUuid ? "selected" : "";
      return `<option value="${escapeHtml(j.uuid)}" ${sel}>${escapeHtml(j.name)}</option>`;
    })
  ].join("");

  const content = `
    <div class="boundless-poi-dialog">
      <div class="form-group">
        <label>${escapeHtml(loc("BOUNDLESS.Config.PoiNamePrompt", "Название локации"))}</label>
        <div class="form-fields">
          <input type="text" name="name" value="${escapeHtml(initial.name || loc("BOUNDLESS.Config.PoiDefaultName", "Новая локация"))}" autofocus>
        </div>
      </div>

      <div class="form-group">
        <label>${escapeHtml(loc("BOUNDLESS.Config.PoiSubtitle", "Подзаголовок"))}</label>
        <div class="form-fields">
          <input type="text" name="subtitle" value="${escapeHtml(initial.subtitle || "")}" placeholder="${escapeHtml(loc("BOUNDLESS.Config.PoiSubtitlePlaceholder", "Необязательно"))}">
        </div>
      </div>

      <div class="form-group">
        <label>${escapeHtml(loc("BOUNDLESS.Config.PoiCategory", "Иконка и уровень"))}</label>
        <div class="form-fields">
          <select name="icon">${iconOptions}</select>
          <select name="kind">
            <option value="major" ${defaultKind === "major" ? "selected" : ""}>${escapeHtml(loc("BOUNDLESS.Config.PoiKindMajor", "Регион / Столица (издалека)"))}</option>
            <option value="minor" ${defaultKind === "minor" ? "selected" : ""}>${escapeHtml(loc("BOUNDLESS.Config.PoiKindMinor", "Локация / Район (средний зум)"))}</option>
            <option value="detail" ${defaultKind === "detail" ? "selected" : ""}>${escapeHtml(loc("BOUNDLESS.Config.PoiKindDetail", "Здание / Точка (вблизи)"))}</option>
          </select>
        </div>
      </div>

      <div class="form-group">
        <label>${escapeHtml(loc("BOUNDLESS.Config.PoiColorScale", "Цвет и масштаб прилёта"))}</label>
        <div class="form-fields">
          <input type="color" name="color" value="${escapeHtml(defaultColor)}">
          <input type="number" name="targetScale" value="${escapeHtml(defaultScale)}" min="0.02" max="2.5" step="0.001">
          <button type="button" class="boundless-use-cur-scale" title="${escapeHtml(loc("BOUNDLESS.Config.PoiUseCurrentScale", "Взять текущий масштаб камеры"))}">
            <i class="fa-solid fa-magnifying-glass"></i>
          </button>
        </div>
      </div>

      <div class="form-group">
        <label>${escapeHtml(loc("BOUNDLESS.Config.PoiJournal", "Журнал"))}</label>
        <div class="form-fields">
          <select name="journalUuid">${journalOptions}</select>
        </div>
      </div>

      <div class="form-group">
        <label>${escapeHtml(loc("BOUNDLESS.Config.PoiHidden", "Скрытая (только для мастера)"))}</label>
        <div class="form-fields">
          <input type="checkbox" name="hidden" ${initial.hidden ? "checked" : ""}>
        </div>
      </div>
    </div>
  `;

  const title = isEdit
    ? loc("BOUNDLESS.Config.PoiEditTitle", "Редактировать метку локации")
    : loc("BOUNDLESS.Config.PoiAddHere", "Добавить метку локации");

  const res = await DialogV2.prompt({
    window: { title },
    content,
    render: (_event, dialog) => {
      const el = dialog?.element || dialog;
      const scaleBtn = el?.querySelector?.(".boundless-use-cur-scale");
      const scaleInput = el?.querySelector?.('input[name="targetScale"]');
      const kindSelect = el?.querySelector?.('select[name="kind"]');
      let scaleManuallyEdited = isEdit;
      scaleInput?.addEventListener("input", () => { scaleManuallyEdited = true; });
      kindSelect?.addEventListener("change", () => {
        if (scaleManuallyEdited || !scaleInput) return;
        const k = normalizePoiKind(kindSelect.value);
        scaleInput.value = String(POI_TIER_DEFAULTS[k].defaultTargetScale);
      });
      scaleBtn?.addEventListener("click", (ev) => {
        ev.preventDefault();
        if (canvas.ready && scaleInput) {
          scaleManuallyEdited = true;
          scaleInput.value = String(Math.max(0.02, Math.min(2.5, Number(canvas.stage.scale.x.toFixed(3)))));
        }
      });
    },
    ok: {
      label: isEdit ? loc("BOUNDLESS.Config.PoiSave", "Сохранить") : loc("BOUNDLESS.Config.PoiCreate", "Создать"),
      callback: (_event, button) => {
        const f = button.form.elements;
        const kind = normalizePoiKind(f.kind?.value);
        const fallbackScale = POI_TIER_DEFAULTS[kind].defaultTargetScale;
        return {
          name: f.name?.value?.trim() || loc("BOUNDLESS.Config.PoiDefaultName", "Новая локация"),
          subtitle: f.subtitle?.value?.trim() || "",
          icon: f.icon?.value || "pin",
          kind,
          color: f.color?.value || defaultColor,
          targetScale: Math.max(0.02, Math.min(2.5, Number(f.targetScale?.value) || fallbackScale)),
          journalUuid: f.journalUuid?.value || "",
          hidden: Boolean(f.hidden?.checked)
        };
      }
    },
    rejectClose: false
  });

  if (!res || (globalThis.game?.scenes && !globalThis.game.scenes.has(scene.id))) return null;

  if (isEdit) {
    await controller.updatePOI(initial.id, res, scene);
    return { ...initial, ...res };
  }

  const pivot = canvas.ready && canvas.scene?.id === scene.id
    ? canvas.stage.pivot
    : { x: (scene.width || 100000) * 0.5, y: (scene.height || 100000) * 0.5 };

  return controller.addPOI({
    ...res,
    x: Number.isFinite(initial.x) ? Math.round(initial.x) : Math.round(pivot.x),
    y: Number.isFinite(initial.y) ? Math.round(initial.y) : Math.round(pivot.y),
    levelId: initial.levelId ?? (canvas.scene?.id === scene.id ? canvas.level?.id : null)
  }, scene);
}

export class PoiManager {
  controller = null;
  container = null;
  pins = []; // [{ poi, root, medalGroup, pillGroup, hitBoxFull, hitBoxCompact, hovered, dragging, isMajor, iconKey, ... }]
  enabled = true;
  placementActive = false;
  lastScale = -1;
  lastPivotX = NaN;
  lastPivotY = NaN;
  _layoutDirty = true;
  _flight = null;
  _flightSeq = 0;
  _dragState = null;
  _contextMenuEl = null;
  _placementHintEl = null;
  _placementListeners = null;
  _pendingLevelSwitch = null;
  _superGridInfo = null;        // { cols, rows, regionPx } when using superGrid manifest defaults
  _superGridSubProvinces = new Map(); // "col_row" -> { lastUsedMs, entries: [] }
  _pendingSubPins = [];
  _subPinRaf = null;
  _subPinGen = 0;

  constructor(controller = null) {
    this.controller = controller;
  }

  mount(scene, manifest) {
    // Preserve an in-progress cross-level flight that targeted this exact scene & level
    const keepFlight = Boolean(
      this._flight &&
      this._flight.sceneId === scene?.id &&
      (!this._flight.levelId || this._flight.levelId === canvas.level?.id)
    );
    const prevEnabled = this.enabled;
    const wasPlacementActive = this.placementActive;
    this.unmount({ keepFlight, skipControlsRefresh: true });
    const cfg = scene?.flags?.[MODULE_ID] || {};
    this.enabled = Boolean(cfg.showPois !== false && canvas?.controls);
    if (!this.enabled) {
      if ((prevEnabled !== this.enabled || wasPlacementActive) && ui?.controls?.rendered) {
        ui.controls.render({ reset: true });
      }
      return;
    }

    this.container = new PIXI.Container();
    this.container.zIndex = 650;
    this.container.sortableChildren = true;
    this.container.eventMode = "passive";
    this.container.interactiveChildren = true;
    canvas.controls.addChild(this.container);

    this.rebuild(scene, manifest);
    this.updateViewport();
    if ((prevEnabled !== this.enabled || wasPlacementActive) && ui?.controls?.rendered) {
      ui.controls.render({ reset: true });
    }
  }

  resolvePois(scene, manifest) {
    const cfg = scene?.flags?.[MODULE_ID] || {};
    if (Array.isArray(cfg.pois)) return cfg.pois;
    if (Array.isArray(manifest?.pois) && manifest.pois.length > 0) {
      // On continental superGrid worlds (e.g. 6000x6000), province pins should land at city overview (0.085x)
      // so sub-location pins appear inside the province instead of diving straight onto rooftops
      if (manifest.superGrid) {
        return manifest.pois.map(p => ({
          ...p,
          kind: "major",
          _isSecondaryProvince: p.kind === "minor",
          targetScale: Number.isFinite(p.targetScale) ? p.targetScale : 0.085
        }));
      }
      return manifest.pois;
    }
    // Built-in 1000x1000 map defaults when no custom POIs are set
    const isActiveScene = Boolean(scene?.id && scene.id === canvas.scene?.id);
    const w = isActiveScene ? canvas.dimensions?.width : scene?.width;
    const h = isActiveScene ? canvas.dimensions?.height : scene?.height;
    if (manifest?.worldCells === 1000 || (w === 100000 && h === 100000)) {
      return getDefault1000Pois();
    }
    return [];
  }

  _clearSuperGridSubPins() {
    this._subPinGen++;
    this._pendingSubPins = [];
    if (this._subPinRaf !== null) {
      if (typeof cancelAnimationFrame === "function") {
        try { cancelAnimationFrame(this._subPinRaf); } catch {}
      } else {
        clearTimeout(this._subPinRaf);
      }
      this._subPinRaf = null;
    }
    for (const bucket of this._superGridSubProvinces.values()) {
      for (const p of bucket.entries) {
        p.root.parent?.removeChild(p.root);
        p.root.destroy({ children: true });
      }
    }
    this._superGridSubProvinces.clear();
  }

  _scheduleSubPinPump() {
    if (this._subPinRaf !== null || this._pendingSubPins.length === 0) return;
    const gen = this._subPinGen;
    const sched = typeof requestAnimationFrame === "function" ? requestAnimationFrame : (fn) => setTimeout(fn, 16);
    this._subPinRaf = sched(() => {
      this._subPinRaf = null;
      if (gen !== this._subPinGen || !this.container || !this.enabled) return;
      const t0 = performance.now();
      let created = 0;
      const maxPerFrame = this.controller?.isActivelyMoving?.() ? 1 : 3;
      while (this._pendingSubPins.length > 0 && created < maxPerFrame) {
        const job = this._pendingSubPins.shift();
        const bucket = this._superGridSubProvinces.get(job.key);
        if (!bucket) continue;
        bucket.entries.push(this._createPin(job.subPoi, job.orderIndex));
        created++;
        if ((performance.now() - t0) >= 1.5) break;
      }
      if (created > 0) {
        this._layoutDirty = true;
        this.updateViewport();
      }
      if (this._pendingSubPins.length > 0) {
        this._scheduleSubPinPump();
      }
    });
  }

  rebuild(scene = canvas.scene, manifest = null) {
    this._closeContextMenu();
    this._cancelDrag();
    this._clearSuperGridSubPins();
    if (!this.container) return;
    for (const p of this.pins) {
      p.root.parent?.removeChild(p.root);
      p.root.destroy({ children: true });
    }
    this.pins = [];

    const cfg = scene?.flags?.[MODULE_ID] || {};
    const prevEnabled = this.enabled;
    const wasPlacementActive = this.placementActive;
    this.enabled = cfg.showPois !== false;
    if (!this.enabled) {
      this.setPlacementActive(false, { skipUpdate: true });
      this.container.visible = false;
      if ((prevEnabled !== this.enabled || wasPlacementActive) && ui?.controls?.rendered) {
        ui.controls.render({ reset: true });
      }
      return;
    }
    if (prevEnabled !== this.enabled && ui?.controls?.rendered) {
      ui.controls.render({ reset: true });
    }

    const activeManifest = manifest ?? this.controller?.manifest;
    const sg = (!Array.isArray(cfg.pois) && activeManifest?.superGrid) ? activeManifest.superGrid : null;
    this._superGridInfo = sg
      ? { cols: sg.cols || 6, rows: sg.rows || 6, regionPx: sg.regionPx || 100000 }
      : null;

    const viewedLevelId = canvas.level?.id;
    const pois = this.resolvePois(scene, activeManifest);

    for (let i = 0; i < pois.length; i++) {
      const poi = pois[i];
      if (!poi || !Number.isFinite(poi.x) || !Number.isFinite(poi.y)) continue;
      if (poi.hidden && !game.user.isGM) continue;
      if (poi.levelId && viewedLevelId && poi.levelId !== viewedLevelId && !canvas.level?.visibility?.levels?.has(poi.levelId)) {
        continue;
      }
      this.pins.push(this._createPin(poi, i));
    }

    this._layoutDirty = true;
    this.lastScale = -1;
    this.updateViewport();
  }

  _syncSuperGridSubPins(stageScale, wt, sw, sh) {
    if (!this._superGridInfo || !this.container) return;
    // Only materialize sub-location pins for provinces currently on screen when descending below 0.022x
    if (stageScale < 0.022 && !this.placementActive) return;

    const { cols, rows, regionPx } = this._superGridInfo;
    const xMinWorld = (0 - wt.tx) / Math.max(wt.a, 1e-5);
    const xMaxWorld = (sw - wt.tx) / Math.max(wt.a, 1e-5);
    const yMinWorld = (0 - wt.ty) / Math.max(wt.d, 1e-5);
    const yMaxWorld = (sh - wt.ty) / Math.max(wt.d, 1e-5);

    const c0 = Math.max(0, Math.floor(xMinWorld / regionPx));
    const c1 = Math.min(cols - 1, Math.floor(xMaxWorld / regionPx));
    const r0 = Math.max(0, Math.floor(yMinWorld / regionPx));
    const r1 = Math.min(rows - 1, Math.floor(yMaxWorld / regionPx));

    if (c1 < c0 || r1 < r0) return;
    const visibleCount = (c1 - c0 + 1) * (r1 - r0 + 1);
    // Avoid spawning across all 36 provinces if somehow zoomed out with placementActive
    if (visibleCount > 9) return;

    const now = performance.now();
    const templates = getProvinceSubPoiTemplates();

    for (let r = r0; r <= r1; r++) {
      for (let c = c0; c <= c1; c++) {
        const key = `${c}_${r}`;
        const existing = this._superGridSubProvinces.get(key);
        if (existing) {
          existing.lastUsedMs = now;
          continue;
        }
        const ox = c * regionPx;
        const oy = r * regionPx;
        const bucket = { lastUsedMs: now, entries: [] };
        this._superGridSubProvinces.set(key, bucket);
        for (let i = 0; i < templates.length; i++) {
          const tpl = templates[i];
          const subPoi = {
            id: `sg_${key}_${tpl.suffix}`,
            name: tpl.name,
            x: ox + tpl.x,
            y: oy + tpl.y,
            targetScale: tpl.targetScale,
            color: tpl.color,
            kind: tpl.kind,
            icon: tpl.icon,
            _virtualSub: true
          };
          this._pendingSubPins.push({ key, subPoi, orderIndex: 1000 + i });
        }
      }
    }
    if (this._pendingSubPins.length > 0) {
      this._scheduleSubPinPump();
    }

    // LRU evict distant province sub-pins when not actively mid-pan (avoids WebGL texture destroy stalls)
    const maxKeep = Math.max(6, visibleCount);
    if (this._superGridSubProvinces.size > maxKeep && !this.controller?.isActivelyMoving?.()) {
      const sorted = Array.from(this._superGridSubProvinces.entries()).sort((a, b) => a[1].lastUsedMs - b[1].lastUsedMs);
      while (sorted.length > maxKeep) {
        const [evictKey, bucket] = sorted.shift();
        for (const p of bucket.entries) {
          p.root.parent?.removeChild(p.root);
          p.root.destroy({ children: true });
        }
        this._superGridSubProvinces.delete(evictKey);
      }
      if (this._pendingSubPins.length > 0) {
        this._pendingSubPins = this._pendingSubPins.filter(j => this._superGridSubProvinces.has(j.key));
      }
    }
  }

  _createPin(poi, orderIndex = 0) {
    const tier = normalizePoiKind(poi.kind);
    const isMajor = tier === "major" && !poi._isSecondaryProvince;
    const isDetail = tier === "detail";
    const iconKey = inferPoiIcon(poi);
    const baseColorStr = poi.hidden ? "#b87aff" : (poi.color || POI_ICON_META[iconKey]?.defaultColor || "#f5c96b");
    const parsedColor = foundry.utils.Color.from(baseColorStr);
    const accentHex = parsedColor?.valid ? parsedColor.valueOf() : 0xf5c96b;
    const hasJournal = Boolean(poi.journalUuid);
    const hasSubtitle = Boolean(poi.subtitle);

    const root = new PIXI.Container();
    root.position.set(poi.x, poi.y);
    root.eventMode = "static";
    root.cursor = "pointer";

    // --- 1. Anchor + Medal group (always shown in both full & compact decluttered modes) ---
    const medalGroup = new PIXI.Container();
    const medalR = isMajor ? 13.5 : (isDetail ? 9.2 : 11);
    const medalY = -(medalR + (isDetail ? 7 : 9));
    const medalG = new PIXI.Graphics();
    const glyphG = new PIXI.Graphics();
    glyphG.position.set(0, medalY);
    medalGroup.addChild(medalG, glyphG);

    const drawMedal = (hover) => {
      medalG.clear();
      // Subtle ambient glow on hover
      if (hover) {
        medalG.beginFill(accentHex, 0.22);
        medalG.drawCircle(0, medalY, medalR + 6);
        medalG.endFill();
      }

      // Drop shadow under anchor & medal
      medalG.beginFill(0x000000, 0.52);
      medalG.drawCircle(0, medalY + 2, medalR + 2.5);
      medalG.endFill();

      // Stem connecting exact coordinate (0, 0) to medal
      medalG.lineStyle(1.6, accentHex, hover ? 1.0 : 0.78);
      medalG.moveTo(0, -4);
      medalG.lineTo(0, medalY + medalR);

      // Exact coordinate diamond anchor at (0, 0)
      medalG.lineStyle(1.5, accentHex, hover ? 1.0 : 0.9);
      medalG.beginFill(hover ? accentHex : 0x14100c, 0.95);
      medalG.drawPolygon([0, -5, 4.5, 0, 0, 5, -4.5, 0]);
      medalG.endFill();

      // Medal outer rim & dark interior
      medalG.lineStyle(hover ? 2.2 : 1.5, accentHex, hover ? 1.0 : 0.9);
      medalG.beginFill(hover ? 0x1d1711 : 0x130f0b, 0.94);
      medalG.drawCircle(0, medalY, medalR);
      medalG.endFill();

      // Inner delicate ring for major locations
      if (isMajor) {
        medalG.lineStyle(0.8, accentHex, hover ? 0.55 : 0.35);
        medalG.drawCircle(0, medalY, medalR - 2.6);
      }

      // Vector category glyph
      glyphG.clear();
      drawPoiGlyph(glyphG, iconKey, medalR * 0.55, hover ? 0xfff6e0 : accentHex);
    };
    drawMedal(false);

    // --- 2. Pill label group (hidden in compact decluttered mode, revealed on hover) ---
    const pillGroup = new PIXI.Container();
    const textResolution = Math.min(2, window.devicePixelRatio || 2);

    const titleStyle = new PIXI.TextStyle({
      fontFamily: "Signika, Palatino Linotype, serif",
      fontSize: isMajor ? 14.5 : (isDetail ? 11.5 : 12.5),
      fontWeight: isMajor ? "700" : (isDetail ? "500" : "600"),
      fill: poi.hidden ? "#e8d2ff" : (isDetail ? "#efe3cc" : "#faf0dc"),
      dropShadow: true,
      dropShadowColor: "#000000",
      dropShadowBlur: 3,
      dropShadowDistance: 1,
      letterSpacing: isMajor ? 0.5 : (isDetail ? 0.15 : 0.25)
    });

    const label = new PIXI.Text(poi.name || "", titleStyle);
    label.resolution = textResolution;
    label.anchor.set(0.5, 0.5);

    let subLabel = null;
    if (hasSubtitle) {
      const subStyle = new PIXI.TextStyle({
        fontFamily: "Signika, sans-serif",
        fontSize: 10.5,
        fontWeight: "400",
        fill: "#cfc4b2",
        dropShadow: true,
        dropShadowColor: "#000000",
        dropShadowBlur: 2,
        dropShadowDistance: 1
      });
      subLabel = new PIXI.Text(poi.subtitle, subStyle);
      subLabel.resolution = textResolution;
      subLabel.anchor.set(0.5, 0.5);
    }

    const padX = isMajor ? 14 : (isDetail ? 9 : 11);
    const padY = isMajor ? 5.5 : (isDetail ? 3 : 4);
    const badgeExtraRight = (hasJournal ? 12 : 0) + (poi.hidden ? 12 : 0);
    const contentW = Math.max(label.width, subLabel ? subLabel.width : 0) + badgeExtraRight;
    const contentH = label.height + (subLabel ? subLabel.height + 1 : 0);
    const boxW = Math.max(52, contentW + padX * 2);
    const boxH = contentH + padY * 2;
    const pillY = medalY - medalR - boxH * 0.5 - 6;

    const pillBg = new PIXI.Graphics();
    const drawPill = (hover) => {
      pillBg.clear();
      // Drop shadow
      pillBg.beginFill(0x000000, 0.45);
      pillBg.drawRoundedRect(-boxW * 0.5, pillY - boxH * 0.5 + 2.5, boxW, boxH, 7);
      pillBg.endFill();

      // Main dark plate
      pillBg.lineStyle(hover ? 2 : 1.25, accentHex, hover ? 1.0 : 0.8);
      pillBg.beginFill(hover ? 0x19140f : 0x100d0a, hover ? 0.94 : 0.84);
      pillBg.drawRoundedRect(-boxW * 0.5, pillY - boxH * 0.5, boxW, boxH, 7);
      pillBg.endFill();

      // Subtle inner highlight line along top edge
      pillBg.lineStyle(0.8, 0xffffff, hover ? 0.16 : 0.08);
      pillBg.moveTo(-boxW * 0.5 + 8, pillY - boxH * 0.5 + 1.5);
      pillBg.lineTo(boxW * 0.5 - 8, pillY - boxH * 0.5 + 1.5);

      // Decorative side diamonds for major landmarks
      if (isMajor) {
        pillBg.lineStyle(0);
        pillBg.beginFill(accentHex, hover ? 1.0 : 0.88);
        const sx = boxW * 0.5;
        pillBg.drawPolygon([-sx, pillY - 3, -sx + 3, pillY, -sx, pillY + 3, -sx - 3, pillY]);
        pillBg.drawPolygon([sx, pillY - 3, sx + 3, pillY, sx, pillY + 3, sx - 3, pillY]);
        pillBg.endFill();
      }

      // Small scroll/book dot on right side if linked to a JournalEntry
      let iconCursorX = boxW * 0.5 - 10;
      if (hasJournal) {
        pillBg.lineStyle(1, accentHex, 0.9);
        pillBg.beginFill(accentHex, 0.25);
        pillBg.drawRoundedRect(iconCursorX - 4, pillY - 4.5, 8, 9, 1.5);
        pillBg.endFill();
        iconCursorX -= 12;
      }
      if (poi.hidden) {
        pillBg.lineStyle(1.2, 0xd9b3ff, 0.9);
        pillBg.drawCircle(iconCursorX, pillY, 3.5);
        pillBg.moveTo(iconCursorX - 4.5, pillY + 4.5);
        pillBg.lineTo(iconCursorX + 4.5, pillY - 4.5);
      }
    };
    drawPill(false);

    const textOffsetX = -badgeExtraRight * 0.4;
    if (subLabel) {
      label.position.set(textOffsetX, pillY - subLabel.height * 0.5 - 0.5);
      subLabel.position.set(textOffsetX, pillY + label.height * 0.5 + 0.5);
      pillGroup.addChild(pillBg, label, subLabel);
    } else {
      label.position.set(textOffsetX, pillY);
      pillGroup.addChild(pillBg, label);
    }

    root.addChild(medalGroup, pillGroup);

    const fullTopY = pillY - boxH * 0.5;
    const hitFull = new PIXI.Rectangle(-boxW * 0.5 - 5, fullTopY - 4, boxW + 10, (4 - fullTopY) + 8);
    const hitCompact = new PIXI.Rectangle(-(medalR + 6), medalY - medalR - 6, (medalR + 6) * 2, (4 - (medalY - medalR)) + 10);
    root.hitArea = hitFull;

    const entry = {
      poi,
      tier,
      orderIndex,
      iconKey,
      root,
      medalGroup,
      pillGroup,
      drawMedal,
      drawPill,
      hitFull,
      hitCompact,
      boxW,
      boxH,
      pillY,
      medalR,
      medalY,
      fullTopY,
      hovered: false,
      dragging: false,
      isMajor,
      isDetail,
      mode: "full" // "full" | "compact" | "hidden"
    };

    root.on("pointerover", () => {
      if (!this.container || root.destroyed) return;
      entry.hovered = true;
      drawMedal(true);
      drawPill(true);
      pillGroup.visible = true;
      root.hitArea = hitFull;
      root.zIndex = 500;
      this.container.sortDirty = true;
      this._applyPinTransform(entry, canvas.stage?.scale?.x || 1);
    });

    root.on("pointerout", () => {
      if (!this.container || root.destroyed) return;
      entry.hovered = false;
      if (entry.dragging) return;
      drawMedal(false);
      drawPill(false);
      if (entry.mode === "compact") {
        pillGroup.visible = false;
        root.hitArea = hitCompact;
      }
      root.zIndex = isMajor ? 30 : (isDetail ? 10 : 20);
      if (this.container) this.container.sortDirty = true;
      this._applyPinTransform(entry, canvas.stage?.scale?.x || 1);
      this._layoutDirty = true;
      this.updateViewport();
    });

    root.on("pointerdown", (ev) => {
      if (ev.button === 2) {
        ev.stopPropagation();
        ev.preventDefault?.();
        ev.originalEvent?.preventDefault?.();
        this._openContextMenu(entry, ev);
        return;
      }
      if (ev.button !== 0) return;
      ev.stopPropagation();
      this._closeContextMenu();

      if (ev.shiftKey && poi.journalUuid) {
        this._openLinkedJournal(poi.journalUuid);
        return;
      }

      const canDrag = game.user?.isGM && !poi._virtualSub && (ev.altKey || this.placementActive);
      if (canDrag) {
        this._startPinDrag(entry, ev);
      } else {
        this.flyTo(poi);
      }
    });

    root.on("rightdown", (ev) => {
      ev.stopPropagation();
      ev.preventDefault?.();
    });

    root.on("rightup", (ev) => {
      ev.stopPropagation();
      ev.preventDefault?.();
    });

    root.zIndex = isMajor ? 30 : (isDetail ? 10 : 20);
    this.container.addChild(root);
    return entry;
  }

  async _openLinkedJournal(uuid) {
    if (!uuid) return;
    try {
      const doc = await fromUuid(uuid);
      if (!doc) return;
      if (doc.testUserPermission && !doc.testUserPermission(game.user, "OBSERVER") && !game.user.isGM) {
        ui.notifications?.warn?.(loc("BOUNDLESS.Config.PoiJournalNoAccess", "Нет доступа к этому журналу."));
        return;
      }
      doc.sheet?.render?.(true);
    } catch (err) {
      console.warn(`[${MODULE_ID}] Failed to open linked journal:`, err);
    }
  }

  _startPinDrag(entry, ev) {
    this._cancelDrag();
    const startPointerId = ev.pointerId ?? ev.data?.pointerId;
    const startClientX = ev.clientX ?? ev.global?.x ?? 0;
    const startClientY = ev.clientY ?? ev.global?.y ?? 0;
    const origX = entry.poi.x;
    const origY = entry.poi.y;
    const getRestoredZIndex = () => (entry.hovered ? 500 : (entry.isMajor ? 30 : (entry.isDetail ? 10 : 20)));
    let moved = false;

    const toWorld = (clientX, clientY) => {
      const view = canvas.app?.view || canvas.app?.canvas;
      if (!view || !canvas?.stage) return null;
      const rect = view.getBoundingClientRect();
      const sx = clientX - rect.left;
      const sy = clientY - rect.top;
      const pt = canvas.stage.toLocal(new PIXI.Point(sx, sy));
      if (!pt || !Number.isFinite(pt.x) || !Number.isFinite(pt.y)) return null;
      return pt;
    };

    const onMove = (moveEv) => {
      if (startPointerId !== undefined && moveEv.pointerId !== undefined && moveEv.pointerId !== startPointerId) return;
      if (moveEv.buttons !== undefined && (moveEv.buttons & 1) === 0) {
        onCancel();
        return;
      }
      const dist = Math.hypot(moveEv.clientX - startClientX, moveEv.clientY - startClientY);
      if (!moved && dist < 5) return;
      if (!moved) {
        moved = true;
        entry.dragging = true;
        entry.root.zIndex = 600;
        if (this.container) this.container.sortDirty = true;
      }
      const pt = toWorld(moveEv.clientX, moveEv.clientY);
      if (pt) {
        entry.root.position.set(pt.x, pt.y);
      }
    };

    const onUp = async (upEv) => {
      if (startPointerId !== undefined && upEv.pointerId !== undefined && upEv.pointerId !== startPointerId) return;
      if (upEv.button !== 0) return;
      if (!moved) {
        cleanup(false, false);
        if (!this.placementActive) this.flyTo(entry.poi);
        return;
      }
      const pt = toWorld(upEv.clientX, upEv.clientY);
      const rawX = pt ? pt.x : (Number.isFinite(entry.root.position?.x) ? entry.root.position.x : origX);
      const rawY = pt ? pt.y : (Number.isFinite(entry.root.position?.y) ? entry.root.position.y : origY);
      const nx = Math.round(rawX);
      const ny = Math.round(rawY);
      if (!Number.isFinite(nx) || !Number.isFinite(ny)) {
        cleanup(false, true);
        return;
      }
      entry.root.position.set(nx, ny);
      cleanup(false, false);
      try {
        const updated = await this.controller?.updatePOI?.(entry.poi.id, { x: nx, y: ny });
        if (!updated && !entry.root.destroyed) {
          entry.root.position.set(origX, origY);
          this._layoutDirty = true;
          this.updateViewport();
        }
      } catch {
        if (!entry.root.destroyed) {
          entry.root.position.set(origX, origY);
          this._layoutDirty = true;
          this.updateViewport();
        }
      }
    };

    const onCancel = (cancelEv) => {
      if (cancelEv?.pointerId !== undefined && startPointerId !== undefined && cancelEv.pointerId !== startPointerId) return;
      cleanup(false, true);
    };

    const cleanup = (skipUpdate = false, revert = false) => {
      entry.dragging = false;
      if (!entry.root.destroyed) {
        if (revert) entry.root.position.set(origX, origY);
        if (!entry.hovered) {
          entry.drawMedal?.(false);
          entry.drawPill?.(false);
          if (entry.mode === "compact") {
            if (entry.pillGroup) entry.pillGroup.visible = false;
            entry.root.hitArea = entry.hitCompact;
          }
        }
        entry.root.zIndex = getRestoredZIndex();
        if (this.container) this.container.sortDirty = true;
      }
      window.removeEventListener("pointermove", onMove, true);
      window.removeEventListener("pointerup", onUp, true);
      window.removeEventListener("pointercancel", onCancel, true);
      window.removeEventListener("blur", onCancel);
      if (this._dragState?.cleanup === cleanup) this._dragState = null;
      this._layoutDirty = true;
      if (!skipUpdate) this.updateViewport();
    };

    this._dragState = { entry, cleanup };
    window.addEventListener("pointermove", onMove, true);
    window.addEventListener("pointerup", onUp, true);
    window.addEventListener("pointercancel", onCancel, true);
    window.addEventListener("blur", onCancel);
  }

  _cancelDrag(skipUpdate = false) {
    if (this._dragState) {
      this._dragState.cleanup(skipUpdate, true);
      this._dragState = null;
    }
  }

  _closeContextMenu() {
    if (this._contextMenuEl) {
      this._contextMenuEl.remove();
      this._contextMenuEl = null;
    }
    if (this._contextMenuDismiss) {
      window.removeEventListener("pointerdown", this._contextMenuDismiss, true);
      window.removeEventListener("wheel", this._contextMenuDismiss, true);
      window.removeEventListener("keydown", this._contextMenuKey, true);
      this._contextMenuDismiss = null;
      this._contextMenuKey = null;
    }
  }

  _openContextMenu(entry, ev) {
    this._closeContextMenu();
    const poi = entry.poi;
    const isGM = Boolean(game.user?.isGM);
    const items = [];

    items.push({
      id: "fly",
      icon: "fa-crosshairs",
      label: loc("BOUNDLESS.Config.PoiFly", "Перелететь"),
      run: () => this.flyTo(poi)
    });

    if (poi.journalUuid) {
      items.push({
        id: "journal",
        icon: "fa-book-open",
        label: loc("BOUNDLESS.Config.PoiOpenJournal", "Открыть журнал"),
        run: () => this._openLinkedJournal(poi.journalUuid)
      });
    }

    if (isGM && !poi._virtualSub) {
      items.push({ divider: true });
      items.push({
        id: "edit",
        icon: "fa-pen-to-square",
        label: loc("BOUNDLESS.Config.PoiEdit", "Редактировать"),
        run: () => openPoiEditorDialog(this.controller, canvas.scene, poi)
      });
      items.push({
        id: "toggleHidden",
        icon: poi.hidden ? "fa-eye" : "fa-eye-slash",
        label: poi.hidden
          ? loc("BOUNDLESS.Config.PoiShowPlayers", "Показать игрокам")
          : loc("BOUNDLESS.Config.PoiHidePlayers", "Скрыть от игроков"),
        run: () => this.controller?.updatePOI?.(poi.id, { hidden: !poi.hidden })
      });
      items.push({
        id: "delete",
        icon: "fa-trash",
        danger: true,
        label: loc("BOUNDLESS.Config.PoiDelete", "Удалить"),
        run: () => this.controller?.removePOI?.(poi.id)
      });
    }

    const menu = document.createElement("div");
    menu.className = "boundless-poi-menu";
    menu.innerHTML = `
      <div class="boundless-poi-menu-header">${escapeHtml(poi.name || "")}</div>
      ${items.map(it => it.divider
        ? `<div class="boundless-poi-menu-divider"></div>`
        : `<button type="button" class="boundless-poi-menu-item${it.danger ? " is-danger" : ""}" data-act="${escapeHtml(it.id)}">
             <i class="fa-solid ${escapeHtml(it.icon)}"></i>
             <span>${escapeHtml(it.label)}</span>
           </button>`
      ).join("")}
    `;

    document.body.appendChild(menu);
    const clientX = ev.clientX ?? ev.data?.originalEvent?.clientX ?? (window.innerWidth * 0.5);
    const clientY = ev.clientY ?? ev.data?.originalEvent?.clientY ?? (window.innerHeight * 0.5);
    const rect = menu.getBoundingClientRect();
    const left = Math.max(8, Math.min(window.innerWidth - rect.width - 8, clientX + 4));
    const top = Math.max(8, Math.min(window.innerHeight - rect.height - 8, clientY + 4));
    menu.style.left = `${left}px`;
    menu.style.top = `${top}px`;

    menu.addEventListener("click", (clickEv) => {
      const btn = clickEv.target.closest("button[data-act]");
      if (!btn) return;
      clickEv.stopPropagation();
      const item = items.find(i => i.id === btn.dataset.act);
      this._closeContextMenu();
      item?.run?.();
    });

    this._contextMenuEl = menu;
    this._contextMenuDismiss = (downEv) => {
      if (menu.contains(downEv.target)) return;
      this._closeContextMenu();
    };
    this._contextMenuKey = (keyEv) => {
      if (keyEv.code === "Escape") {
        keyEv.preventDefault();
        keyEv.stopPropagation();
        this._closeContextMenu();
      }
    };
    setTimeout(() => {
      if (this._contextMenuEl !== menu) return;
      window.addEventListener("pointerdown", this._contextMenuDismiss, true);
      window.addEventListener("wheel", this._contextMenuDismiss, true);
      window.addEventListener("keydown", this._contextMenuKey, true);
    }, 0);
  }

  setPlacementActive(active, { skipUpdate = false } = {}) {
    const next = Boolean(active && game.user?.isGM && this.controller?.active);
    if (next === this.placementActive) return;
    this.placementActive = next;
    const view = canvas.app?.view || canvas.app?.canvas;

    if (next) {
      if (view) view.style.cursor = "crosshair";
      this._showPlacementHint(true);

      const onPointerDown = (ev) => {
        if (!this.placementActive || ev.button !== 0) return;
        if (!canvas?.ready || !canvas.stage) return;
        if (ev.target !== view) return;
        if (this._poiDialogOpen) return;
        if (this._contextMenuEl) {
          ev.preventDefault();
          ev.stopPropagation();
          this._closeContextMenu();
          return;
        }
        // Ignore clicks on existing pins (including superGrid sub-pins; handled by PIXI pointerdown for dragging)
        const rect = view.getBoundingClientRect();
        const sx = ev.clientX - rect.left;
        const sy = ev.clientY - rect.top;
        const worldPt = canvas.stage.toLocal(new PIXI.Point(sx, sy));
        if (!Number.isFinite(worldPt?.x) || !Number.isFinite(worldPt?.y)) return;
        const stageScale = canvas.stage.scale?.x || 1;
        const pivot = canvas.stage.pivot;
        const [sw = window.innerWidth, sh = window.innerHeight] = canvas.screenDimensions || [];
        const wt = getLiveStageTransform(stageScale, pivot?.x || 0, pivot?.y || 0, sw, sh);
        const allPins = this._superGridSubProvinces.size > 0
          ? [...this.pins, ...Array.from(this._superGridSubProvinces.values()).flatMap(b => b.entries)]
          : this.pins;
        for (const p of allPins) {
          if (!p.root?.visible) continue;
          const pinX = Number.isFinite(p.root.position?.x) ? p.root.position.x : p.poi.x;
          const pinY = Number.isFinite(p.root.position?.y) ? p.root.position.y : p.poi.y;
          const px = wt.a * pinX + wt.tx;
          const py = wt.d * pinY + wt.ty;
          const hb = p.root.hitArea;
          const boost = p.dragging ? 1.12 : (p.hovered ? 1.07 : 1.0);
          if (hb && sx >= px + hb.x * boost && sx <= px + (hb.x + hb.width) * boost && sy >= py + hb.y * boost && sy <= py + (hb.y + hb.height) * boost) {
            return;
          }
        }
        ev.preventDefault();
        ev.stopPropagation();
        this._poiDialogOpen = true;
        Promise.resolve(openPoiEditorDialog(this.controller, canvas.scene, {
          x: Math.round(worldPt.x),
          y: Math.round(worldPt.y),
          levelId: canvas.level?.id || null
        })).finally(() => {
          this._poiDialogOpen = false;
        });
      };

      const onKeyDown = (ev) => {
        if (ev.code === "Escape" && this.placementActive) {
          if (this._contextMenuEl) {
            ev.preventDefault();
            ev.stopPropagation();
            this._closeContextMenu();
            return;
          }
          const target = ev.target;
          const tag = target?.tagName;
          if (
            tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || target?.isContentEditable ||
            target?.closest?.("dialog") || document.querySelector("dialog[open]")
          ) {
            return;
          }
          ev.preventDefault();
          ev.stopPropagation();
          this.setPlacementActive(false);
          if (ui?.controls?.rendered) ui.controls.render({ reset: true });
        }
      };

      window.addEventListener("pointerdown", onPointerDown, true);
      window.addEventListener("keydown", onKeyDown, true);
      this._placementListeners = { onPointerDown, onKeyDown, view };
    } else {
      if (this._placementListeners) {
        window.removeEventListener("pointerdown", this._placementListeners.onPointerDown, true);
        window.removeEventListener("keydown", this._placementListeners.onKeyDown, true);
        if (this._placementListeners.view && this._placementListeners.view.style.cursor === "crosshair") {
          this._placementListeners.view.style.cursor = "";
        }
        this._placementListeners = null;
      }
      this._showPlacementHint(false);
    }

    this._layoutDirty = true;
    if (!skipUpdate) this.updateViewport();
  }

  _showPlacementHint(show) {
    if (!show) {
      this._placementHintEl?.remove();
      this._placementHintEl = null;
      return;
    }
    if (this._placementHintEl) return;
    const el = document.createElement("div");
    el.className = "boundless-tool-hint";
    el.innerHTML = `<i class="fa-solid fa-map-pin"></i><span>${escapeHtml(loc("BOUNDLESS.PoiToolHint", "Режим меток. ЛКМ по карте создать, перетащить метку переместить, ПКМ меню, Esc выход."))}</span>`;
    document.body.appendChild(el);
    this._placementHintEl = el;
  }

  _applyPinTransform(entry, stageScale) {
    const inv = 1 / Math.max(stageScale, 0.0005);
    const boost = entry.dragging ? 1.12 : (entry.hovered ? 1.07 : 1.0);
    entry.root.scale.set(inv * boost);
  }

  updateScale(stageScale) {
    this.updateViewport(null, stageScale);
  }

  /**
   * Scale pins inversely to zoom, apply 3-tier hierarchical zoom visibility (major -> minor -> detail),
   * lazy-spawn superGrid province sub-pins, and run fast O(N log N) screen-space decluttering.
   */
  updateViewport(_vp = null, overrideScale = null) {
    if (!this.container || !this.enabled || !canvas?.stage) return;
    if (!this.pins.length && !this._superGridInfo) return;

    const stageScale = overrideScale ?? (canvas.stage.scale?.x || 1);
    const pivot = canvas.stage.pivot;
    const px = pivot?.x || 0;
    const py = pivot?.y || 0;

    if (
      !this._layoutDirty &&
      Math.abs(stageScale - this.lastScale) < 0.00005 &&
      Math.abs(px - this.lastPivotX) < 1 &&
      Math.abs(py - this.lastPivotY) < 1
    ) {
      return;
    }
    this.lastScale = stageScale;
    this.lastPivotX = px;
    this.lastPivotY = py;
    this._layoutDirty = false;

    const [sw = window.innerWidth, sh = window.innerHeight] = canvas.screenDimensions || [];
    const wt = getLiveStageTransform(stageScale, px, py, sw, sh);

    // Lazily populate sub-location pins for visible superGrid provinces when descending
    if (this._superGridInfo) {
      this._syncSuperGridSubPins(stageScale, wt, sw, sh);
    }

    const includeSubPins = this._superGridSubProvinces.size > 0 && (stageScale >= 0.022 || this.placementActive);
    if (!includeSubPins && this._superGridSubProvinces.size > 0) {
      for (const bucket of this._superGridSubProvinces.values()) {
        for (const p of bucket.entries) {
          if (p.root && !p.root.destroyed) p.root.visible = false;
        }
      }
    }

    // 1. Project pins to screen space, evaluate per-tier zoom visibility & cull offscreen (0 spread allocations)
    const onScreen = [];
    const evalEntry = (entry) => {
      const poi = entry.poi;
      const pinX = Number.isFinite(entry.root?.position?.x) ? entry.root.position.x : poi.x;
      const pinY = Number.isFinite(entry.root?.position?.y) ? entry.root.position.y : poi.y;
      const sx = wt.a * pinX + wt.tx;
      const sy = wt.d * pinY + wt.ty;
      if (!entry.dragging && (sx < -240 || sx > sw + 240 || sy < -180 || sy > sh + 180)) {
        entry.root.visible = false;
        return;
      }

      let a = this.placementActive ? 0.96 : computePoiTierAlpha(poi, stageScale);
      if (!this.placementActive && poi._isSecondaryProvince && stageScale < 0.020) {
        a *= smoothstep(0.009, 0.020, stageScale);
      }
      if (poi.hidden) a *= 0.85;
      if (a <= 0.01 && !entry.hovered && !entry.dragging) {
        entry.root.visible = false;
        return;
      }
      onScreen.push({ entry, sx, sy, alpha: Math.max(0.05, a) });
    };
    for (let i = 0; i < this.pins.length; i++) evalEntry(this.pins[i]);
    if (includeSubPins) {
      for (const bucket of this._superGridSubProvinces.values()) {
        for (let i = 0; i < bucket.entries.length; i++) evalEntry(bucket.entries[i]);
      }
    }

    if (onScreen.length === 0) {
      this.container.visible = false;
      return;
    }
    this.container.visible = true;

    // 2. Priority sort: dragged/hovered -> active tier (higher alpha wins during crossfade) -> major > minor > detail -> index
    const tierWeight = (e) => (e.isMajor ? 3 : (e.isDetail ? 1 : 2));
    onScreen.sort((a, b) => {
      const pa = (a.entry.dragging ? 8 : 0) + (a.entry.hovered ? 4 : 0);
      const pb = (b.entry.dragging ? 8 : 0) + (b.entry.hovered ? 4 : 0);
      if (pa !== pb) return pb - pa;
      // When zoomed in past major overview (>0.10x), give sub-locations priority over fading major labels
      if (stageScale > 0.10) {
        if (Math.abs(b.alpha - a.alpha) > 0.18) return b.alpha - a.alpha;
      }
      const twDiff = tierWeight(b.entry) - tierWeight(a.entry);
      if (twDiff !== 0) return twDiff;
      return a.entry.orderIndex - b.entry.orderIndex;
    });

    // 3. O(N) screen-space greedy decluttering via 2D spatial hash grid (96px cells): full pill -> compact medal -> hidden
    const CELL = 96;
    const fullGrid = new Map();
    const medalGrid = new Map();
    const insertGrid = (grid, r) => {
      const cx0 = Math.floor(r.x0 / CELL), cy0 = Math.floor(r.y0 / CELL);
      const cx1 = Math.floor(r.x1 / CELL), cy1 = Math.floor(r.y1 / CELL);
      for (let cy = cy0; cy <= cy1; cy++) {
        for (let cx = cx0; cx <= cx1; cx++) {
          const gk = ((cx + 32768) << 16) ^ (cy + 32768);
          let arr = grid.get(gk);
          if (!arr) { arr = []; grid.set(gk, arr); }
          arr.push(r);
        }
      }
    };
    const overlapsGrid = (grid, r, pad) => {
      if (grid.size === 0) return false;
      const cx0 = Math.floor((r.x0 - pad) / CELL), cy0 = Math.floor((r.y0 - pad) / CELL);
      const cx1 = Math.floor((r.x1 + pad) / CELL), cy1 = Math.floor((r.y1 + pad) / CELL);
      for (let cy = cy0; cy <= cy1; cy++) {
        for (let cx = cx0; cx <= cx1; cx++) {
          const arr = grid.get(((cx + 32768) << 16) ^ (cy + 32768));
          if (!arr) continue;
          for (let i = 0; i < arr.length; i++) {
            if (rectsOverlap(r, arr[i], pad)) return true;
          }
        }
      }
      return false;
    };
    const margin = 6;

    for (let idx = 0; idx < onScreen.length; idx++) {
      const { entry, sx, sy, alpha } = onScreen[idx];
      const fullRect = {
        x0: sx - entry.boxW * 0.5,
        y0: sy + entry.fullTopY,
        x1: sx + entry.boxW * 0.5,
        y1: sy + 6
      };
      const medalRect = {
        x0: sx - entry.medalR,
        y0: sy + entry.medalY - entry.medalR,
        x1: sx + entry.medalR,
        y1: sy + 6
      };

      if (entry.hovered || entry.dragging) {
        entry.mode = "full";
        entry.root.visible = true;
        entry.root.alpha = 1;
        entry.pillGroup.visible = true;
        entry.root.hitArea = entry.hitFull;
        this._applyPinTransform(entry, stageScale);
        insertGrid(fullGrid, fullRect);
        insertGrid(medalGrid, medalRect);
        continue;
      }

      const blocksFull = overlapsGrid(fullGrid, fullRect, margin)
        || overlapsGrid(medalGrid, fullRect, 3);

      if (!blocksFull) {
        entry.mode = "full";
        entry.root.visible = true;
        entry.root.alpha = alpha;
        entry.pillGroup.visible = true;
        entry.root.hitArea = entry.hitFull;
        this._applyPinTransform(entry, stageScale);
        insertGrid(fullGrid, fullRect);
        insertGrid(medalGrid, medalRect);
        continue;
      }

      const blocksMedal = overlapsGrid(medalGrid, medalRect, 4);
      if (!blocksMedal || this.placementActive) {
        entry.mode = "compact";
        entry.root.visible = true;
        entry.root.alpha = alpha * 0.92;
        entry.pillGroup.visible = false;
        entry.root.hitArea = entry.hitCompact;
        this._applyPinTransform(entry, stageScale);
        insertGrid(medalGrid, medalRect);
        continue;
      }

      entry.mode = "hidden";
      entry.root.visible = false;
    }
  }

  cancelFlight(bumpSeq = true) {
    if (bumpSeq) this._flightSeq++;
    const f = this._flight;
    if (!f) return;
    this._flight = null;
    f.cleanup();
    f.resolve(false);
  }

  _canViewLevelLazy(scene, targetLevel) {
    if (!scene || !targetLevel) return false;
    // Fast path: if Foundry already computed _availableLevels, use Scene#availableLevels (applies SceneManager#_getAvailableLevels)
    if (scene._availableLevels && scene.availableLevels?.has) {
      return Boolean(scene.availableLevels.has(targetLevel));
    }
    const isGM = Boolean(game.user?.isGM);
    if (isGM || !scene.tokenVision) {
      if (scene.availableLevels?.has) {
        return Boolean(scene.availableLevels.has(targetLevel));
      }
      const allLevels = new Set(scene.levels?.sorted || scene.levels?.values?.() || []);
      const allowed = canvas?.manager?._getAvailableLevels?.(allLevels) ?? allLevels;
      return allowed.has(targetLevel);
    }

    // Non-GM with tokenVision and uncached _availableLevels: resolve OBSERVER token levels WITHOUT waking lazy ActorDelta!
    const obsLvl = globalThis.CONST?.DOCUMENT_OWNERSHIP_LEVELS?.OBSERVER ?? 2;
    const inheritLvl = globalThis.CONST?.DOCUMENT_OWNERSHIP_LEVELS?.INHERIT ?? -1;
    const user = game.user;
    const baseSet = new Set();
    for (const tok of scene.tokens || []) {
      if (!tok?.level) continue;
      let hasObs = false;
      if (!tok.isLazyDelta) {
        try { hasObs = Boolean(tok.testUserPermission?.(user, "OBSERVER")); } catch {}
      } else {
        const deltaOwn = tok._source?.delta?.ownership;
        const baseOwn = tok.baseActor?.ownership;
        const uid = user?.id;
        if (uid && typeof deltaOwn?.[uid] === "number" && deltaOwn[uid] !== inheritLvl) {
          hasObs = deltaOwn[uid] >= obsLvl;
        } else if (uid && typeof baseOwn?.[uid] === "number" && baseOwn[uid] !== inheritLvl) {
          hasObs = baseOwn[uid] >= obsLvl;
        } else if (typeof deltaOwn?.default === "number" && deltaOwn.default !== inheritLvl) {
          hasObs = deltaOwn.default >= obsLvl;
        } else if (typeof baseOwn?.default === "number" && baseOwn.default !== inheritLvl) {
          hasObs = baseOwn.default >= obsLvl;
        } else if (!baseOwn && typeof tok.baseActor?.testUserPermission === "function") {
          try { hasObs = Boolean(tok.baseActor.testUserPermission(user, "OBSERVER")); } catch {}
        }
      }
      if (hasObs) {
        const lvl = scene.levels?.get?.(tok.level);
        if (lvl) baseSet.add(lvl);
      }
    }
    const allowed = canvas?.manager?._getAvailableLevels?.(baseSet) ?? baseSet;
    return allowed.has(targetLevel);
  }

  async flyTo(poi, options = {}) {
    if (!poi || !canvas?.ready || !canvas.stage) return false;
    if (!Number.isFinite(poi.x) || !Number.isFinite(poi.y)) return false;

    const seq = ++this._flightSeq;
    const originSceneId = canvas.scene?.id;

    // Cancel any previous Boundless flight or native Foundry animatePan seamlessly
    this.cancelFlight(false);
    const AnimCls = foundry.canvas?.animation?.CanvasAnimation || globalThis.CanvasAnimation;
    try { AnimCls?.terminateAnimation?.("canvas.animatePan"); } catch {}

    if (poi.levelId && canvas.level?.id !== poi.levelId && canvas.scene?.levels?.has(poi.levelId)) {
      const targetLevel = canvas.scene.levels.get(poi.levelId);
      if (!this._canViewLevelLazy(canvas.scene, targetLevel)) return false;

      // Mark pending level switch so canvasTearDown / controller.mount -> poiManager.unmount() won't bump _flightSeq
      this._pendingLevelSwitch = { seq, sceneId: originSceneId, levelId: poi.levelId };
      try {
        await canvas.scene.view({ level: poi.levelId });
        // Wait for async Boundless controller.mount() triggered by canvasReady so PoiManager.mount() finishes before animation starts
        if (this.controller?._mountPromise) {
          try { await this.controller._mountPromise; } catch {}
        }
      } finally {
        if (this._pendingLevelSwitch?.seq === seq) this._pendingLevelSwitch = null;
      }
      if (seq !== this._flightSeq || !canvas?.ready || !canvas.stage) return false;
      if (canvas.scene?.id !== originSceneId || canvas.level?.id !== poi.levelId) return false;
    }

    const worldMinScale = (this.controller?.active ? this.controller._worldMinScale : null) ?? canvas.dimensions?.scale?.min ?? 0.008;
    const activeMinScale = canvas.dimensions?.scale?.min ?? worldMinScale;
    const maxScale = canvas.dimensions?.scale?.max ?? 2.5;

    const x0 = canvas.stage.pivot.x;
    const y0 = canvas.stage.pivot.y;
    const scale0 = canvas.stage.scale.x || 1;

    const tierKey = normalizePoiKind(poi.kind);
    const tierDefaultScale = POI_TIER_DEFAULTS[tierKey].defaultTargetScale;
    const parsedTargetScale = Number(options.scale ?? poi.targetScale ?? poi.scale);
    let rawTargetScale = (Number.isFinite(parsedTargetScale) && parsedTargetScale > 0) ? parsedTargetScale : tierDefaultScale;

    // Multi-step drill-down: if clicking a major/minor overview pin we are already hovering near at its landing scale,
    // glide one step deeper into the location!
    if (options.scale === undefined && tierKey !== "detail") {
      const dist = Math.hypot((poi.x ?? 0) - x0, (poi.y ?? 0) - y0);
      if (dist < 4200 && scale0 >= rawTargetScale * 0.82 && scale0 < 0.55) {
        rawTargetScale = Math.min(0.68, Math.max(scale0 * 2.4, rawTargetScale * 2.8));
      }
    }

    const clampedTargetScale = Math.max(activeMinScale, Math.min(maxScale, rawTargetScale));
    const constrained = canvas._constrainView
      ? canvas._constrainView({ x: poi.x, y: poi.y, scale: clampedTargetScale })
      : { x: poi.x, y: poi.y, scale: clampedTargetScale };

    const x1 = constrained.x;
    const y1 = constrained.y;
    const scale1 = constrained.scale;

    if (
      !Number.isFinite(x0) || !Number.isFinite(y0) ||
      !Number.isFinite(x1) || !Number.isFinite(y1) ||
      !Number.isFinite(scale0) || scale0 <= 0 ||
      !Number.isFinite(scale1) || scale1 <= 0
    ) {
      return false;
    }

    if (options.instant) {
      canvas.pan({ x: x1, y: y1, scale: scale1 });
      return true;
    }

    const [sw = 1600, sh = 1000] = canvas.screenDimensions || [];
    const viewportSize = Math.hypot(sw, sh) * 0.65;
    const flightMinScale = Math.min(activeMinScale, worldMinScale);
    const rho = (Number.isFinite(options.rho) && options.rho > 0.1) ? options.rho : FLY_DEFAULT_RHO;

    const useGtaStyle = options.style === "gta5";
    const path = useGtaStyle
      ? buildGtaFlightPath({
        x0, y0, scale0,
        x1, y1, scale1,
        viewportSize: Math.min(sw, sh),
        minScale: flightMinScale,
        maxScale
      })
      : buildFlightPath({
        x0, y0, scale0,
        x1, y1, scale1,
        viewportSize,
        minScale: flightMinScale,
        maxScale,
        rho
      });

    if (path.trivial || !Number.isFinite(path.S)) {
      canvas.pan({ x: x1, y: y1, scale: scale1 });
      return true;
    }

    const duration = Number.isFinite(options.duration) && options.duration > 0
      ? options.duration
      : (useGtaStyle && path.durationMs > 0
        ? path.durationMs
        : Math.max(FLY_MIN_DURATION_MS, Math.min(FLY_MAX_DURATION_MS, Math.round(920 + path.S * 580))));

    // Guard against any concurrent flight that could have started while awaiting
    if (seq !== this._flightSeq) return false;
    this.cancelFlight(false);

    // Prewarm destination & approach pyramid tiles in VRAM while camera is still gliding in
    this.controller?.prewarmArea?.(x1, y1, scale1);

    const ticker = canvas.app?.ticker;
    const view = canvas.app?.view || canvas.app?.canvas;
    const relaxedScaleObj = canvas.dimensions?.scale || null;
    const temporarilyRelaxedMin = Boolean(relaxedScaleObj && activeMinScale > flightMinScale);
    if (temporarilyRelaxedMin) {
      relaxedScaleObj.min = flightMinScale;
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
        const progress = path.rawTime ? t : easeCameraFlight(t);
        try {
          const pose = path.sample(progress);
          canvas.pan(pose);
        } catch {
          finish(false);
          return;
        }

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
        if (temporarilyRelaxedMin && canvas?.scene?.id === originSceneId && canvas?.dimensions?.scale === relaxedScaleObj) {
          relaxedScaleObj.min = activeMinScale;
        }
        this.controller?.setCameraFlying?.(false);
      };

      const finish = (completed) => {
        if (this._flight?.cleanup === cleanup) this._flight = null;
        cleanup();
        resolve(completed);
      };

      this._flight = { cleanup, resolve, sceneId: originSceneId, levelId: poi.levelId || canvas.level?.id || null };

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

  unmount({ keepFlight = false, skipControlsRefresh = false } = {}) {
    const shouldRefreshControls = !skipControlsRefresh && (this.enabled || this.placementActive);
    this.enabled = false;
    this._superGridInfo = null;
    this.setPlacementActive(false, { skipUpdate: true });
    this._closeContextMenu();
    this._cancelDrag(true);
    if (!keepFlight) this.cancelFlight(!this._pendingLevelSwitch);
    this._clearSuperGridSubPins();
    if (this.container) {
      try { this.container.parent?.removeChild(this.container); } catch {}
      if (!this.container.destroyed) {
        try { this.container.destroy({ children: true }); } catch {}
      }
      this.container = null;
    }
    this.pins = [];
    this.lastScale = -1;
    this.lastPivotX = NaN;
    this.lastPivotY = NaN;
    this._layoutDirty = true;
    if (shouldRefreshControls && ui?.controls?.rendered) {
      ui.controls.render({ reset: true });
    }
  }
}

export function registerPoiControls(controller) {
  Hooks.on("getSceneControlButtons", (controls) => {
    const notes = controls?.notes;
    if (!notes?.tools) return;

    const poiMgr = controller.poiManager;
    notes.tools.boundlessPoiTool = {
      name: "boundlessPoiTool",
      order: 6.5,
      title: "BOUNDLESS.PoiTool",
      icon: "fa-solid fa-map-pin",
      toggle: true,
      active: Boolean(poiMgr?.placementActive),
      visible: Boolean(game.user?.isGM && controller.active && poiMgr?.enabled),
      onChange: (_event, active) => {
        poiMgr?.setPlacementActive(Boolean(active));
      }
    };
  });
}
