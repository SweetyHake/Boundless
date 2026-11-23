import { MODULE_ID } from "./utils.mjs";
import { PERF_CONFIG, resetPerfStats } from "./perf-patcher.mjs";
import { applyLightingRenderScale, clearTokenUiBitmapCaches } from "./perf-gpu.mjs";
import { restoreAllStandardCulling, updateStandardSceneCulling, syncDecorativeTileShaders } from "./perf-auto.mjs";

/**
 * Boundless A/B Regression Benchmark Suite for Foundry VTT v14.
 *
 * Measures every major Foundry mechanic with Boundless Performance Engine
 * OFF vs ON using ABBA interleaved rounds (eliminating JIT / GPU boost bias)
 * and flags any regression where ON is slower than vanilla OFF.
 *
 * Non-destructive: makes ZERO permanent database writes and restores all
 * settings, active layers, camera, and viewed scene when finished.
 *
 * Usage in Foundry console:
 *   await Boundless.perf.benchmark()
 *   await Boundless.perf.benchmark({ sceneIds: ["rklRestoredKeepC", "aunTombOfTheShad"] })
 */

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const nextFrame = () => new Promise((r) => requestAnimationFrame(r));

function median(arr) {
  if (!arr.length) return 0;
  const s = arr.slice().sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
}

function percentile(arr, p) {
  if (!arr.length) return 0;
  const s = arr.slice().sort((a, b) => a - b);
  const idx = Math.min(s.length - 1, Math.floor(s.length * p));
  return s[idx];
}

function avg(arr) {
  if (!arr.length) return 0;
  return arr.reduce((a, b) => a + b, 0) / arr.length;
}

async function setPerfMode(enabled) {
  PERF_CONFIG.perfEnabled = Boolean(enabled);
  if (!enabled) {
    clearTokenUiBitmapCaches();
    restoreAllStandardCulling();
  }
  applyLightingRenderScale();
  // Refresh wall sprites/graphics and note icons so toggle takes effect immediately
  const walls = globalThis.canvas?.walls?.placeables;
  if (walls?.length) {
    for (let i = 0; i < walls.length; i++) {
      walls[i].renderFlags?.set?.({ refreshLine: true, refreshEndpoints: true });
    }
  }
  const notes = globalThis.canvas?.notes?.placeables;
  if (notes?.length) {
    for (let i = 0; i < notes.length; i++) {
      const icon = notes[i].controlIcon;
      if (icon && !icon.destroyed) {
        try { icon._refresh?.(); } catch {}
      }
    }
  }
  syncDecorativeTileShaders(enabled);
  if (enabled) {
    updateStandardSceneCulling();
  }
  resetPerfStats();
  await nextFrame();
  await nextFrame();
}

/**
 * Run an ABBA interleaved A/B benchmark (`OFF -> ON -> ON -> OFF`) and average
 * the two OFF and two ON rounds to eliminate warmup/boost drift.
 */
async function runABBA(runner) {
  // Tiny warmup under OFF so JIT and shaders are already compiled
  await setPerfMode(false);
  await runner(true);

  const offRuns = [];
  const onRuns = [];

  await setPerfMode(false);
  offRuns.push(await runner(false));

  await setPerfMode(true);
  onRuns.push(await runner(false));

  await setPerfMode(true);
  onRuns.push(await runner(false));

  await setPerfMode(false);
  offRuns.push(await runner(false));

  const mergeObj = (list) => {
    const out = {};
    for (const k of Object.keys(list[0])) {
      if (typeof list[0][k] === "number") {
        out[k] = +(list.reduce((s, r) => s + r[k], 0) / list.length).toFixed(3);
      } else {
        out[k] = list[list.length - 1][k];
      }
    }
    return out;
  };
  return { off: mergeObj(offRuns), on: mergeObj(onRuns) };
}

function classifyMetric(offMs, onMs, { absToleranceMs = 0.25, warnPct = 5, failPct = 10 } = {}) {
  const diffMs = onMs - offMs;
  const pct = offMs > 0.001 ? ((offMs - onMs) / offMs) * 100 : 0; // positive = faster!
  const slowdownPct = -pct;
  let status = "PASS";
  if (diffMs > absToleranceMs && slowdownPct >= failPct) {
    status = "REGRESSION";
  } else if (diffMs > absToleranceMs * 0.6 && slowdownPct >= warnPct) {
    status = "WARN";
  }
  return {
    offMs: +offMs.toFixed(2),
    onMs: +onMs.toFixed(2),
    gainPct: +pct.toFixed(1),
    status
  };
}

function measureGlRender(renderFn, iters = 30) {
  const renderer = canvas.app.renderer;
  const gl = renderer.gl;
  const origDE = gl.drawElements.bind(gl);
  const origDA = gl.drawArrays.bind(gl);

  // Warmup
  for (let i = 0; i < 4; i++) { renderFn(); renderer.batch.flush(); gl.finish(); }

  let draws = 0;
  gl.drawElements = (...a) => { draws++; return origDE(...a); };
  gl.drawArrays = (...a) => { draws++; return origDA(...a); };
  renderFn();
  renderer.batch.flush();
  gl.drawElements = origDE;
  gl.drawArrays = origDA;

  const times = [];
  for (let i = 0; i < iters; i++) {
    const t0 = performance.now();
    renderFn();
    renderer.batch.flush();
    gl.finish();
    times.push(performance.now() - t0);
  }
  const medMs = median(times);
  return { ms: medMs, fps: +(1000 / Math.max(0.05, medMs)).toFixed(0), drawCalls: draws };
}

async function runRealMouseDrag(tok, steps = 28) {
  const view = canvas.app.view;
  const rect = view.getBoundingClientRect();
  const wt = canvas.stage.worldTransform;
  const sx = rect.left + (tok.center.x * wt.a + wt.tx);
  const sy = rect.top + (tok.center.y * wt.d + wt.ty);

  view.dispatchEvent(new PointerEvent("pointermove", { bubbles: true, clientX: sx, clientY: sy, pointerId: 1, pointerType: "mouse", isPrimary: true }));
  await nextFrame();
  view.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, button: 0, buttons: 1, clientX: sx, clientY: sy, pointerId: 1, pointerType: "mouse", isPrimary: true }));
  await nextFrame();

  const dts = [];
  let prev = performance.now();
  for (let i = 1; i <= steps; i++) {
    const cx = sx + Math.cos(i * 0.22) * 240 + i * 4;
    const cy = sy + Math.sin(i * 0.22) * 240;
    view.dispatchEvent(new PointerEvent("pointermove", { bubbles: true, button: 0, buttons: 1, clientX: cx, clientY: cy, pointerId: 1, pointerType: "mouse", isPrimary: true }));
    await nextFrame();
    const now = performance.now();
    dts.push(now - prev);
    prev = now;
  }

  window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", code: "Escape", bubbles: true }));
  view.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, button: 0, buttons: 0, clientX: sx, clientY: sy, pointerId: 1, pointerType: "mouse", isPrimary: true }));
  await nextFrame();

  const avgMs = avg(dts);
  const p95Ms = percentile(dts, 0.95);
  const worstMs = Math.max(...dts);
  return { ms: avgMs, p95Ms, worstMs, fps: +(1000 / Math.max(0.1, avgMs)).toFixed(1) };
}

/**
 * Run all Foundry mechanics benchmarks on the currently viewed scene.
 */
export async function benchmarkCurrentScene(opts = {}) {
  const scene = globalThis.canvas?.scene;
  if (!scene || !globalThis.canvas?.ready) {
    throw new Error("Canvas is not ready.");
  }

  const savedPerfEnabled = PERF_CONFIG.perfEnabled;
  const savedLayer = canvas.activeLayer;
  const savedCamera = {
    x: canvas.stage.pivot.x,
    y: canvas.stage.pivot.y,
    scale: canvas.stage.scale.x
  };
  const savedDragPreview = game.settings.get("core", "tokenDragPreview");

  const rows = [];
  const pushRow = (mechanic, offRes, onRes, extra = {}, thresholds = {}) => {
    const cls = classifyMetric(offRes.ms, onRes.ms, thresholds);
    rows.push({
      scene: scene.name,
      mechanic,
      offMs: cls.offMs,
      onMs: cls.onMs,
      gainPct: cls.gainPct,
      offFps: offRes.fps ?? null,
      onFps: onRes.fps ?? null,
      offDraws: offRes.drawCalls ?? null,
      onDraws: onRes.drawCalls ?? null,
      status: cls.status,
      ...extra
    });
  };

  try {
    const renderer = canvas.app.renderer;
    const stage = canvas.app.stage;

    // M1: Full-frame gameplay render (TokenLayer active, pan/zoom view)
    canvas.tokens.activate();
    await nextFrame();
    {
      const { off, on } = await runABBA(async (warmup) =>
        measureGlRender(() => renderer.render(stage), warmup ? 4 : 28)
      );
      pushRow("1. Full Frame (Gameplay)", off, on, {}, { absToleranceMs: 0.35, warnPct: 6, failPct: 12 });
    }

    // M2: WallsLayer full frame + draw calls (when scene has native walls)
    if ((canvas.walls?.placeables?.length ?? 0) >= 10) {
      canvas.walls.activate();
      await nextFrame();
      const { off, on } = await runABBA(async (warmup) =>
        measureGlRender(() => renderer.render(stage), warmup ? 4 : 28)
      );
      pushRow(`2. Walls Layer (${canvas.walls.placeables.length} walls)`, off, on, {}, { absToleranceMs: 0.35 });
    }

    // M3: TokenLayer UI batching + draw calls (when scene has >= 4 tokens)
    canvas.tokens.activate();
    await nextFrame();
    const tokens = canvas.tokens?.placeables ?? [];
    if (tokens.length >= 4) {
      const { off, on } = await runABBA(async (warmup) =>
        measureGlRender(() => canvas.tokens.objects.render(renderer), warmup ? 4 : 60)
      );
      pushRow(`3. Token UI Layer (${tokens.length} tokens)`, off, on, {}, { absToleranceMs: 0.15 });
    }

    // Pick a visible token with an actor for drag / path / vision mechanics
    const dragTok = tokens.find((t) => t.visible && t.document?.sight?.enabled) || tokens.find((t) => t.visible) || null;
    if (dragTok) {
      canvas.pan({ x: dragTok.center.x, y: dragTok.center.y, scale: 0.8 });
      await sleep(200);

      // M4: Standard Token Drag (tokenDragPreview = false)
      await game.settings.set("core", "tokenDragPreview", false);
      await sleep(100);
      {
        const { off, on } = await runABBA(async (warmup) => runRealMouseDrag(dragTok, warmup ? 6 : 26));
        pushRow(
          "4. Token Drag (Standard)",
          off,
          on,
          { offWorstMs: +off.worstMs.toFixed(1), onWorstMs: +on.worstMs.toFixed(1) },
          { absToleranceMs: 0.9, warnPct: 7, failPct: 14 }
        );
      }

      // M5: Heavy Token Drag with Live Vision & Fog (tokenDragPreview = true)
      if (dragTok.document?.sight?.enabled) {
        await game.settings.set("core", "tokenDragPreview", true);
        await sleep(100);
        const { off, on } = await runABBA(async (warmup) => runRealMouseDrag(dragTok, warmup ? 6 : 26));
        pushRow(
          "5. Token Drag (Live Vision+Fog)",
          off,
          on,
          { offWorstMs: +off.worstMs.toFixed(1), onWorstMs: +on.worstMs.toFixed(1) },
          { absToleranceMs: 1.0, warnPct: 7, failPct: 14 }
        );
      }

      // M6: Movement Path Measurement (measureMovementPath x 150)
      const wp = [
        { x: dragTok.x, y: dragTok.y, elevation: 0 },
        { x: dragTok.x + 200, y: dragTok.y + 100, elevation: 0 },
        { x: dragTok.x + 400, y: dragTok.y + 250, elevation: 0 },
        { x: dragTok.x + 650, y: dragTok.y + 150, elevation: 0 }
      ];
      {
        const { off, on } = await runABBA(async (warmup) => {
          const n = warmup ? 10 : 150;
          const t0 = performance.now();
          for (let i = 0; i < n; i++) dragTok.measureMovementPath(wp);
          return { ms: performance.now() - t0 };
        });
        pushRow("6. Measure Path (150x)", off, on, {}, { absToleranceMs: 0.4 });
      }
    }

    // M7: Bulk Marquee Selection + ReleaseAll
    if (tokens.length >= 4) {
      const { off, on } = await runABBA(async (warmup) => {
        const n = warmup ? 1 : 5;
        const times = [];
        for (let i = 0; i < n; i++) {
          canvas.tokens.releaseAll();
          const t0 = performance.now();
          canvas.tokens.selectObjects({ x: 0, y: 0, width: scene.width || 10000, height: scene.height || 10000 });
          canvas.tokens.releaseAll();
          times.push(performance.now() - t0);
        }
        return { ms: avg(times) };
      });
      pushRow(`7. Marquee Select (${tokens.length} tokens)`, off, on, {}, { absToleranceMs: 0.4 });
    }

    // M8: Perception Refresh (restrictVisibility + refreshLighting)
    {
      const { off, on } = await runABBA(async (warmup) => {
        const n = warmup ? 2 : 20;
        const t0 = performance.now();
        for (let i = 0; i < n; i++) {
          canvas.visibility.restrictVisibility();
          canvas.effects.refreshLighting();
        }
        return { ms: (performance.now() - t0) / n };
      });
      pushRow("8. Perception & Lighting Refresh", off, on, {}, { absToleranceMs: 0.25 });
    }

    // M9: TextEditor.enrichHTML (40x)
    {
      const sample = `<p>Benchmark [[/r 2d6 + 4]] and @UUID[Scene.${scene.id}]{${scene.name}} with repeated journal markup.</p>`;
      const { off, on } = await runABBA(async (warmup) => {
        const n = warmup ? 3 : 40;
        const t0 = performance.now();
        for (let i = 0; i < n; i++) await foundry.applications.ux.TextEditor.enrichHTML(sample);
        return { ms: performance.now() - t0 };
      });
      pushRow("9. TextEditor.enrichHTML (40x)", off, on, {}, { absToleranceMs: 0.5 });
    }
  } finally {
    await game.settings.set("core", "tokenDragPreview", savedDragPreview);
    await setPerfMode(savedPerfEnabled);
    try { savedLayer?.activate?.(); } catch {}
    try { canvas.pan(savedCamera); } catch {}
  }

  const regressions = rows.filter((r) => r.status === "REGRESSION");
  const warnings = rows.filter((r) => r.status === "WARN");
  return {
    scene: scene.name,
    passed: regressions.length === 0,
    regressions,
    warnings,
    rows
  };
}

/**
 * Run the full A/B benchmark across one or multiple scenes and print a clean console report.
 */
export async function runPerfBenchmark(opts = {}) {
  const origSceneId = globalThis.canvas?.scene?.id;
  const sceneIds = Array.isArray(opts.sceneIds) && opts.sceneIds.length
    ? opts.sceneIds
    : [origSceneId].filter(Boolean);

  const allRows = [];
  try {
    for (const id of sceneIds) {
      const sc = game.scenes.get(id);
      if (!sc) continue;
      if (canvas.scene?.id !== id) {
        await sc.view();
        await sleep(500);
      }
      const res = await benchmarkCurrentScene(opts);
      allRows.push(...res.rows);
    }
  } finally {
    if (origSceneId && canvas.scene?.id !== origSceneId) {
      await game.scenes.get(origSceneId)?.view();
    }
  }

  const regressions = allRows.filter((r) => r.status === "REGRESSION");
  const warnings = allRows.filter((r) => r.status === "WARN");

  if (!opts.silent) {
    console.info(`${MODULE_ID} | A/B Performance Benchmark (${regressions.length} regressions, ${warnings.length} warnings):`);
    console.table(allRows.map((r) => ({
      Scene: r.scene,
      Mechanic: r.mechanic,
      "OFF ms": r.offMs,
      "ON ms": r.onMs,
      "Gain %": `${r.gainPct >= 0 ? "+" : ""}${r.gainPct}%`,
      "Draws OFF->ON": r.offDraws != null ? `${r.offDraws} -> ${r.onDraws}` : "",
      Status: r.status
    })));
  }

  return {
    passed: regressions.length === 0,
    regressionCount: regressions.length,
    warningCount: warnings.length,
    regressions,
    warnings,
    rows: allRows
  };
}
