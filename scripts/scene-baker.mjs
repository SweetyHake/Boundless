import { MODULE_ID, getLevelBaseElevation, resolveFoundryRoute } from "./utils.mjs";
import { extractLightStyle, computeLevelBakedPolys } from "./light-batch.mjs";

function attachBakedPolysIfPossible(spec, scene, level) {
  if (!spec || !scene) return;
  try {
    const gridSize = Number(scene.grid?.size || canvas?.dimensions?.size || 100);
    const gridDist = Number(scene.grid?.distance || canvas?.dimensions?.distance || 5);
    const pxPerFt = gridDist > 0 ? (gridSize / gridDist) : 20;
    const bp = computeLevelBakedPolys(spec, pxPerFt, { level });
    if (bp) spec.bakedPolys = bp;
  } catch (err) {
    console.warn(`${MODULE_ID} | Could not precompute bakedPolys for level ${level?.id}:`, err);
  }
}

const TILE_PX = 1024;
const UPLOAD_CONCURRENCY = 4;
const DOC_CREATE_BATCH_SIZE = 250;
const UNBAKE_MAX_IMAGE_PX = 8192;
const VIDEO_EXT_RE = /\.(webm|mp4|m4v|ogv)([?#]|$)/i;

function isVideoPath(src) {
  if (!src) return false;
  return VIDEO_EXT_RE.test(src) || Boolean(globalThis.foundry?.helpers?.media?.VideoHelper?.hasVideoExtension?.(src));
}

function encodePathSegments(rawPath) {
  return String(rawPath || "")
    .split("/")
    .map(seg => {
      if (!seg) return seg;
      try {
        return encodeURIComponent(decodeURIComponent(seg));
      } catch {
        return encodeURIComponent(seg);
      }
    })
    .join("/");
}

function getFilePickerImpl() {
  return foundry.applications?.apps?.FilePicker?.implementation
    ?? foundry.applications?.apps?.FilePicker
    ?? globalThis.FilePicker;
}

function slugifyPathPart(str, fallback = "scene") {
  const clean = String(str || "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-zA-Z0-9_-]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .toLowerCase()
    .slice(0, 36);
  return clean || fallback;
}

export function buildDefaultBakeDir(scene) {
  const worldId = game.world?.id || "world";
  const slug = slugifyPathPart(scene?.name, "scene");
  const shortId = (scene?.id || "map").slice(0, 6).toLowerCase();
  return `worlds/${worldId}/boundless/${slug}_${shortId}`;
}

async function ensureDirectoryRecursive(targetDir) {
  const FP = getFilePickerImpl();
  if (!FP?.createDirectory) throw new Error("FilePicker.createDirectory is unavailable.");
  const parts = String(targetDir || "").replace(/^\/+|\/+$/g, "").split("/").filter(Boolean);
  let cur = "";
  for (const part of parts) {
    cur = cur ? `${cur}/${part}` : part;
    const encCur = encodePathSegments(cur);
    try {
      await FP.createDirectory("data", encCur);
    } catch (err) {
      const msg = String(err?.message || err || "");
      if (!/exist|EEXIST|already/i.test(msg)) {
        // Double-check if directory is already browsable before throwing
        try {
          await FP.browse("data", encCur);
        } catch {
          throw err;
        }
      }
    }
  }
}

async function uploadFileSilent(targetDir, file) {
  const FP = getFilePickerImpl();
  if (!FP?.upload) throw new Error("FilePicker.upload is unavailable.");
  const encDir = encodePathSegments(targetDir);
  const res = await FP.upload("data", encDir, file, {}, { notify: false });
  if (!res || !res.path) {
    throw new Error(`Upload failed for ${targetDir}/${file?.name || "file"}`);
  }
  return res;
}

function createWorkCanvas(width, height, { willReadFrequently = false } = {}) {
  const ctxOpts = willReadFrequently ? { willReadFrequently: true } : undefined;
  if (typeof OffscreenCanvas !== "undefined") {
    const c = new OffscreenCanvas(width, height);
    const ctx = c.getContext("2d", ctxOpts);
    if (ctx) {
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = "high";
    }
    return { canvas: c, ctx, isOffscreen: true };
  }
  const c = document.createElement("canvas");
  c.width = width;
  c.height = height;
  const ctx = c.getContext("2d", ctxOpts);
  if (ctx) {
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";
  }
  return { canvas: c, ctx, isOffscreen: false };
}

async function canvasToWebpBlob(work, quality) {
  if (work.isOffscreen && typeof work.canvas.convertToBlob === "function") {
    return work.canvas.convertToBlob({ type: "image/webp", quality });
  }
  return new Promise((resolve, reject) => {
    work.canvas.toBlob(
      (blob) => (blob ? resolve(blob) : reject(new Error("Canvas toBlob failed"))),
      "image/webp",
      quality
    );
  });
}

async function loadImageSource(src, signal = null, { fallbackW = 0, fallbackH = 0 } = {}) {
  if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
  const resolvedSrc = resolveFoundryRoute(src);
  const lower = String(resolvedSrc || "").split(/[?#]/)[0].toLowerCase();
  const isSvg = lower.endsWith(".svg");
  if (!isSvg && typeof fetch === "function" && typeof createImageBitmap === "function") {
    try {
      const res = await fetch(resolvedSrc, signal ? { signal } : undefined);
      if (res.ok) {
        const blob = await res.blob();
        if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
        const bmp = await createImageBitmap(blob);
        if (signal?.aborted) {
          try { bmp.close(); } catch {}
          throw new DOMException("Aborted", "AbortError");
        }
        return { source: bmp, width: bmp.width, height: bmp.height, close: () => { try { bmp.close(); } catch {} } };
      }
    } catch (err) {
      if (err?.name === "AbortError" || signal?.aborted) throw new DOMException("Aborted", "AbortError");
    }
  }
  if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = "anonymous";
    const onAbort = () => {
      img.onload = null;
      img.onerror = null;
      try { img.src = ""; } catch {}
      reject(new DOMException("Aborted", "AbortError"));
    };
    const cleanup = () => {
      if (signal) signal.removeEventListener("abort", onAbort);
    };
    if (signal) {
      if (signal.aborted) { onAbort(); return; }
      signal.addEventListener("abort", onAbort, { once: true });
    }
    img.onload = () => {
      cleanup();
      let w = img.naturalWidth || img.width || 0;
      let h = img.naturalHeight || img.height || 0;
      if (isSvg) {
        const natW = img.naturalWidth || 0;
        const natH = img.naturalHeight || 0;
        if (!w || !h) {
          w = fallbackW || 1024;
          h = fallbackH || 1024;
        } else if (fallbackW > 0 && fallbackH > 0 && (w < fallbackW || h < fallbackH)) {
          // Vector SVG with tiny viewBox (e.g. 100x100 on a 4000x4000 scene) should bake at scene resolution
          const scale = Math.max(fallbackW / w, fallbackH / h);
          w = Math.round(w * scale);
          h = Math.round(h * scale);
        }
        // Rasterize upscaled SVG onto a work canvas because 9-arg drawImage indexes source rect in naturalWidth x naturalHeight
        if (w !== natW || h !== natH) {
          try {
            const clampScale = Math.min(1, 16384 / Math.max(1, w, h));
            const safeW = Math.max(1, Math.round(w * clampScale));
            const safeH = Math.max(1, Math.round(h * clampScale));
            const rast = createWorkCanvas(safeW, safeH);
            rast.ctx.clearRect(0, 0, safeW, safeH);
            rast.ctx.drawImage(img, 0, 0, safeW, safeH);
            resolve({
              source: rast.canvas,
              width: safeW,
              height: safeH,
              close: () => {
                rast.canvas.width = 0;
                rast.canvas.height = 0;
              }
            });
            return;
          } catch {}
        }
        try {
          if (!img.width) img.width = w;
          if (!img.height) img.height = h;
        } catch {}
      }
      resolve({
        source: img,
        width: w,
        height: h,
        close: () => {}
      });
    };
    img.onerror = () => {
      cleanup();
      reject(new Error(`Failed to load background image: ${resolvedSrc}`));
    };
    img.src = resolvedSrc;
  });
}

function computeFitDrawDimensions(fit, boundsW, boundsH, srcW, srcH) {
  const safeSrcW = Math.max(1, srcW || boundsW);
  const safeSrcH = Math.max(1, srcH || boundsH);
  const aspect = safeSrcW / safeSrcH;
  if (fit === "contain") {
    const scale = Math.min(boundsW / safeSrcW, boundsH / safeSrcH);
    return { drawW: safeSrcW * scale, drawH: safeSrcH * scale };
  }
  if (fit === "cover") {
    const scale = Math.max(boundsW / safeSrcW, boundsH / safeSrcH);
    return { drawW: safeSrcW * scale, drawH: safeSrcH * scale };
  }
  if (fit === "width") {
    return { drawW: boundsW, drawH: boundsW / aspect };
  }
  if (fit === "height") {
    return { drawW: boundsH * aspect, drawH: boundsH };
  }
  return { drawW: boundsW, drawH: boundsH };
}

/**
 * Compute exact non-empty tile grid bounds for a (possibly rectangular) map across zoom levels `0..maxZoomZ`.
 */
export function computePyramidPlan(boundsW, boundsH, imgW, imgH, tilePx = TILE_PX) {
  const pyramidSpan = Math.max(1, boundsW || 0, boundsH || 0);
  const effW = imgW ? imgW * (pyramidSpan / Math.max(1, boundsW || pyramidSpan)) : (boundsW || tilePx);
  const effH = imgH ? imgH * (pyramidSpan / Math.max(1, boundsH || pyramidSpan)) : (boundsH || tilePx);
  const maxDim = Math.max(effW, effH, tilePx);
  const maxZoomZ = Math.max(0, Math.min(7, Math.ceil(Math.log2(Math.max(1, maxDim / tilePx)))));
  const levels = [];
  let totalTiles = 0;

  for (let z = 0; z <= maxZoomZ; z++) {
    const nTiles = 1 << z;
    const tileWorldSize = pyramidSpan / nTiles;
    const maxTx = Math.min(nTiles - 1, Math.max(0, Math.floor((boundsW - 0.001) / tileWorldSize)));
    const maxTy = Math.min(nTiles - 1, Math.max(0, Math.floor((boundsH - 0.001) / tileWorldSize)));
    const count = (maxTx + 1) * (maxTy + 1);
    levels.push({ z, nTiles, tileWorldSize, maxTx, maxTy, count });
    totalTiles += count;
  }

  return { maxZoomZ, pyramidSpan, levels, totalTiles };
}

function buildMipProxy(source, srcW, srcH, maxProxyPx = 4096) {
  const longest = Math.max(srcW, srcH);
  if (longest <= maxProxyPx) return null;
  const scale = maxProxyPx / longest;
  const pw = Math.max(1, Math.round(srcW * scale));
  const ph = Math.max(1, Math.round(srcH * scale));
  const work = createWorkCanvas(pw, ph);
  work.ctx.clearRect(0, 0, pw, ph);
  work.ctx.drawImage(source, 0, 0, pw, ph);
  return { source: work.canvas, width: pw, height: ph };
}

async function runPool(items, concurrency, fn, signal) {
  let cursor = 0;
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (cursor < items.length) {
      if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
      const idx = cursor++;
      await fn(items[idx], idx);
    }
  });
  await Promise.all(workers);
}

function isCanvasEmptyAlpha(work) {
  const data = work.ctx.getImageData(0, 0, work.canvas.width, work.canvas.height).data;
  for (let i = 3; i < data.length; i += 4) {
    if (data[i] !== 0) return false;
  }
  return true;
}

async function sliceAndUploadPyramid({
  level,
  loadedImg,
  plan,
  pyramidDir,
  sceneBounds,
  quality,
  signal,
  skipEmptyAlpha = false,
  allPendingUploads,
  onTileProgress
}) {
  // Foundry v14 stores shared texture transforms (offset/scale/rotation/anchor/fit) in level.textures for both background and foreground
  const texCfg = level.textures || (skipEmptyAlpha ? level.foreground : level.background) || {};
  const bgOffX = Number(texCfg.offsetX) || 0;
  const bgOffY = Number(texCfg.offsetY) || 0;
  const bgScaleX = Number.isFinite(Number(texCfg.scaleX)) && Number(texCfg.scaleX) !== 0 ? Number(texCfg.scaleX) : 1;
  const bgScaleY = Number.isFinite(Number(texCfg.scaleY)) && Number(texCfg.scaleY) !== 0 ? Number(texCfg.scaleY) : 1;
  const bgRotRad = ((Number(texCfg.rotation) || 0) * Math.PI) / 180;
  const bgAnchorX = (texCfg.anchorX !== null && texCfg.anchorX !== undefined && texCfg.anchorX !== "" && Number.isFinite(Number(texCfg.anchorX))) ? Number(texCfg.anchorX) : 0.5;
  const bgAnchorY = (texCfg.anchorY !== null && texCfg.anchorY !== undefined && texCfg.anchorY !== "" && Number.isFinite(Number(texCfg.anchorY))) ? Number(texCfg.anchorY) : 0.5;
  const bgFit = texCfg.fit || "fill";
  const hasTransform = bgOffX !== 0 || bgOffY !== 0 || bgScaleX !== 1 || bgScaleY !== 1 || bgRotRad !== 0 || bgAnchorX !== 0.5 || bgAnchorY !== 0.5 || bgFit !== "fill";

  // Build clean <= 4096px mip proxy for lower zoom levels so z=0..2 stay sharp without aliasing
  const mipProxy = buildMipProxy(loadedImg.source, loadedImg.width, loadedImg.height, 4096);
  const work = createWorkCanvas(TILE_PX, TILE_PX, { willReadFrequently: skipEmptyAlpha });
  const sparseTiles = skipEmptyAlpha ? {} : null;
  let uploadedBaseUrl = null;

  try {
    await ensureDirectoryRecursive(pyramidDir);

    for (const lvl of plan.levels) {
      if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
      const zDir = `${pyramidDir}/${lvl.z}`;
      await ensureDirectoryRecursive(zDir);

      // Use anti-aliased mipProxy when downscaling > 2.5x from full source (respect max dimension for portrait maps)
      const useProxy = Boolean(mipProxy && (lvl.nTiles * TILE_PX) <= Math.max(mipProxy.width, mipProxy.height) * 1.15);
      const drawSrc = useProxy ? mipProxy.source : loadedImg.source;
      const srcW = useProxy ? mipProxy.width : loadedImg.width;
      const srcH = useProxy ? mipProxy.height : loadedImg.height;
      const fitted = computeFitDrawDimensions(bgFit, sceneBounds.w, sceneBounds.h, srcW, srcH);

      const coords = [];
      for (let ty = 0; ty <= lvl.maxTy; ty++) {
        for (let tx = 0; tx <= lvl.maxTx; tx++) {
          coords.push({ tx, ty });
        }
      }

      const pendingUploads = [];
      const flushUploads = async (minKeep = 0) => {
        while (pendingUploads.length > minKeep) {
          await pendingUploads.shift();
        }
      };

      for (const { tx, ty } of coords) {
        if (signal?.aborted) throw new DOMException("Aborted", "AbortError");

        const wx0 = tx * lvl.tileWorldSize;
        const wy0 = ty * lvl.tileWorldSize;
        const scaleToTile = TILE_PX / lvl.tileWorldSize;

        work.ctx.save();
        work.ctx.clearRect(0, 0, TILE_PX, TILE_PX);

        if (!hasTransform) {
          const ix0 = Math.max(0, wx0);
          const iy0 = Math.max(0, wy0);
          const ix1 = Math.min(sceneBounds.w, wx0 + lvl.tileWorldSize);
          const iy1 = Math.min(sceneBounds.h, wy0 + lvl.tileWorldSize);
          if (ix1 > ix0 && iy1 > iy0) {
            const sx = (ix0 / sceneBounds.w) * srcW;
            const sy = (iy0 / sceneBounds.h) * srcH;
            const sw = ((ix1 - ix0) / sceneBounds.w) * srcW;
            const sh = ((iy1 - iy0) / sceneBounds.h) * srcH;
            const dx = (ix0 - wx0) * scaleToTile;
            const dy = (iy0 - wy0) * scaleToTile;
            const dw = (ix1 - ix0) * scaleToTile;
            const dh = (iy1 - iy0) * scaleToTile;
            work.ctx.drawImage(drawSrc, sx, sy, sw, sh, dx, dy, dw, dh);
          }
        } else {
          work.ctx.scale(scaleToTile, scaleToTile);
          work.ctx.translate(-wx0, -wy0);
          work.ctx.beginPath();
          work.ctx.rect(0, 0, sceneBounds.w, sceneBounds.h);
          work.ctx.clip();
          work.ctx.translate(sceneBounds.w * 0.5 + bgOffX, sceneBounds.h * 0.5 + bgOffY);
          if (bgRotRad) work.ctx.rotate(bgRotRad);
          work.ctx.scale(bgScaleX, bgScaleY);
          work.ctx.drawImage(
            drawSrc,
            -fitted.drawW * bgAnchorX,
            -fitted.drawH * bgAnchorY,
            fitted.drawW,
            fitted.drawH
          );
        }
        work.ctx.restore();

        if (skipEmptyAlpha && isCanvasEmptyAlpha(work)) {
          onTileProgress?.(lvl.z, false);
          continue;
        }

        if (sparseTiles) {
          const zk = String(lvl.z);
          if (!sparseTiles[zk]) sparseTiles[zk] = [];
          sparseTiles[zk].push(`${tx}_${ty}`);
        }

        const blob = await canvasToWebpBlob(work, quality);
        const file = new File([blob], `${tx}_${ty}.webp`, { type: "image/webp" });

        const upPromise = uploadFileSilent(zDir, file).then((res) => {
          if (!uploadedBaseUrl && res?.path) {
            const suffix = `/${lvl.z}/${tx}_${ty}.webp`;
            if (res.path.endsWith(suffix)) {
              uploadedBaseUrl = res.path.slice(0, -suffix.length);
            }
          }
          onTileProgress?.(lvl.z, true);
        });
        // Prevent spurious UnhandledPromiseRejection if a later concurrent upload rejects before FIFO shift() awaits it
        upPromise.catch(() => {});
        pendingUploads.push(upPromise);
        allPendingUploads.push(upPromise);
        if (pendingUploads.length >= UPLOAD_CONCURRENCY) {
          await flushUploads(UPLOAD_CONCURRENCY - 1);
        }
      }
      await flushUploads(0);
    }

    return {
      sparseTiles,
      baseUrl: uploadedBaseUrl || encodePathSegments(pyramidDir)
    };
  } finally {
    if (work?.canvas) { work.canvas.width = 0; work.canvas.height = 0; }
    if (mipProxy?.source && "width" in mipProxy.source) {
      try { mipProxy.source.width = 0; mipProxy.source.height = 0; } catch {}
    }
  }
}

/**
 * Bake an existing Foundry v14 Scene (background/foreground image pyramids + walls/doors/lights/sounds/tiles)
 * directly in the browser via OffscreenCanvas + FilePicker.upload, producing a ready-to-use Boundless scene.
 */
export async function bakeSceneToBoundless(controller, sourceScene, {
  targetDir = null,
  levelIds = null,        // null = all levels on scene, or array of level IDs
  createCopy = true,
  removeOriginals = true,
  clearBackground = true,
  quality = 0.85,
  activateCopy = true,
  signal = null,
  onProgress = null
} = {}) {
  if (!game.user?.isGM) throw new Error("Only a GM can bake scenes into Boundless.");
  if (!sourceScene) throw new Error("No scene provided.");

  const report = (pct, text) => {
    if (signal?.aborted) return;
    try { onProgress?.({ pct: Math.max(0, Math.min(100, pct)), text }); } catch {}
  };

  const origLevels = Array.from(sourceScene.levels?.sorted || sourceScene.levels || []);
  const selectedOrigIndices = [];
  for (let i = 0; i < origLevels.length; i++) {
    if (!levelIds || levelIds.includes(origLevels[i].id)) selectedOrigIndices.push(i);
  }
  if (!selectedOrigIndices.length) throw new Error("No levels selected for baking.");

  // Guard against direct API re-baking of an already-baked scene (which would overwrite the manifest with empty geometry)
  const sceneHasBoundless = Boolean(sourceScene.flags?.[MODULE_ID]?.enabled || sourceScene.flags?.[MODULE_ID]?.manifestUrl);
  const allSelectedAlreadyBaked = selectedOrigIndices.every((idx) => {
    const lvl = origLevels[idx];
    const lFlags = lvl?.flags?.[MODULE_ID];
    const hasManifest = Boolean(lFlags?.manifestUrl || lFlags?.inlineManifest || (sceneHasBoundless && lFlags?.enabled !== false));
    const fgSrc = typeof lvl?.foreground === "string" ? lvl.foreground : lvl?.foreground?.src;
    const hasBg = Boolean(lvl?.background?.src && !VIDEO_EXT_RE.test(lvl.background.src));
    const hasFg = Boolean(fgSrc && !VIDEO_EXT_RE.test(fgSrc));
    return hasManifest && !hasBg && !hasFg;
  });
  if (allSelectedAlreadyBaked) {
    throw new Error("Scene is already baked for Boundless. Use bakeSceneEditsToManifest() to update edits or unbakeSceneFromBoundless() to restore.");
  }

  report(2, game.i18n.localize("BOUNDLESS.Baker.StepPreparing"));

  // 1. Clone scene upfront if requested so manifest level IDs and output directory match the cloned scene
  let targetScene = sourceScene;
  let createdClone = false;
  if (createCopy) {
    if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
    const copyName = `${sourceScene.name} (Boundless)`;
    targetScene = await sourceScene.clone({ name: copyName }, { save: true });
    if (!targetScene) throw new Error("Failed to clone scene.");
    createdClone = true;
  }

  const outDir = String(targetDir || buildDefaultBakeDir(targetScene)).replace(/^\/+|\/+$/g, "");

  const levelJobs = [];
  const allPendingUploads = [];
  let uploadedTiles = 0;
  let processedTiles = 0;
  const levelSpecs = {};
  const allTileIdsToDelete = [];
  const allWallIdsToDelete = [];
  const allLightIdsToDelete = [];
  const allSoundIdsToDelete = [];
  const levelsToClearBg = [];
  const levelsToClearFg = [];
  let totalBakedWalls = 0, totalBakedLights = 0, totalBakedTiles = 0, totalBakedSounds = 0;
  let targetLevels = [];
  let chosenLevels = [];
  let worldPx = 4000;

  try {
    targetLevels = Array.from(targetScene.levels?.sorted || targetScene.levels || []);
    chosenLevels = selectedOrigIndices
      .map(i => targetLevels[i])
      .filter(Boolean);
    if (!chosenLevels.length) throw new Error("Target scene has no matching levels.");

    const dims = targetScene.getDimensions?.() || {
      sceneX: 0,
      sceneY: 0,
      sceneWidth: targetScene.width || 4000,
      sceneHeight: targetScene.height || 4000,
      width: targetScene.width || 4000,
      height: targetScene.height || 4000
    };
    const sceneBounds = {
      x: dims.sceneX || 0,
      y: dims.sceneY || 0,
      w: dims.sceneWidth || targetScene.width || 4000,
      h: dims.sceneHeight || targetScene.height || 4000
    };
    worldPx = Math.max(dims.width || targetScene.width || 4000, dims.height || targetScene.height || 4000);

    await ensureDirectoryRecursive(outDir);

    // 2. Inspect backgrounds & compute total tile count for accurate progress reporting
    let grandTotalTiles = 0;

    for (let idx = 0; idx < chosenLevels.length; idx++) {
      if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
      const level = chosenLevels[idx];
      const bgSrc = level.background?.src || "";
      const fgSrc = level.foreground?.src || "";
      const hasRasterBg = Boolean(bgSrc && !isVideoPath(bgSrc));
      const hasRasterFg = Boolean(fgSrc && !isVideoPath(fgSrc));
      const levelSlug = targetLevels.length <= 1
        ? "pyramid"
        : `lvl_${idx}_${slugifyPathPart(level.name, "lvl")}_${level.id.slice(0, 6)}`;
      const levelPyramidDir = `${outDir}/${levelSlug}`;
      const levelFgPyramidDir = `${outDir}/${levelSlug}_fg`;

      let loadedImg = null;
      let plan = null;
      if (hasRasterBg) {
        report(5, game.i18n.format("BOUNDLESS.Baker.StepLoadingBg", { level: level.name || level.id }));
        loadedImg = await loadImageSource(bgSrc, signal, { fallbackW: sceneBounds.w, fallbackH: sceneBounds.h });
        plan = computePyramidPlan(sceneBounds.w, sceneBounds.h, loadedImg.width, loadedImg.height, TILE_PX);
        grandTotalTiles += plan.totalTiles;
      }

      let loadedFgImg = null;
      let fgPlan = null;
      if (hasRasterFg) {
        report(7, game.i18n.format("BOUNDLESS.Baker.StepLoadingBg", { level: `${level.name || level.id} (foreground)` }));
        try {
          loadedFgImg = await loadImageSource(fgSrc, signal, { fallbackW: sceneBounds.w, fallbackH: sceneBounds.h });
        } catch (err) {
          loadedImg?.close?.();
          throw err;
        }
        fgPlan = computePyramidPlan(sceneBounds.w, sceneBounds.h, loadedFgImg.width, loadedFgImg.height, TILE_PX);
        grandTotalTiles += fgPlan.totalTiles;
      }

      levelJobs.push({
        level,
        levelSlug,
        bgSrc,
        fgSrc,
        hasRasterBg,
        hasRasterFg,
        levelPyramidDir,
        levelFgPyramidDir,
        loadedImg,
        plan,
        loadedFgImg,
        fgPlan
      });
    }

    const onTileProgress = (z, didUpload) => {
      processedTiles++;
      if (didUpload) uploadedTiles++;
      const pct = 10 + Math.round((processedTiles / Math.max(1, grandTotalTiles)) * 78);
      report(pct, game.i18n.format("BOUNDLESS.Baker.StepUploading", {
        done: processedTiles,
        total: grandTotalTiles
      }));
    };

    // 3. Slice and upload WebP pyramid tiles + collect spatial data per level
    for (const job of levelJobs) {
      if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
      const { level, loadedImg, plan, levelPyramidDir, loadedFgImg, fgPlan, levelFgPyramidDir } = job;

      const hasBg = Boolean(loadedImg && plan);
      const hasFg = Boolean(loadedFgImg && fgPlan);

      let bgBaseUrl = null;
      if (hasBg) {
        const bgRes = await sliceAndUploadPyramid({
          level,
          loadedImg,
          plan,
          pyramidDir: levelPyramidDir,
          sceneBounds,
          quality,
          signal,
          skipEmptyAlpha: false,
          allPendingUploads,
          onTileProgress
        });
        bgBaseUrl = bgRes?.baseUrl || encodePathSegments(levelPyramidDir);
        job.loadedImg?.close?.();
        job.loadedImg = null;
        if (clearBackground) levelsToClearBg.push(level);
      }

      let fgSparseTiles = null;
      let fgBaseUrl = null;
      if (hasFg) {
        const fgRes = await sliceAndUploadPyramid({
          level,
          loadedImg: loadedFgImg,
          plan: fgPlan,
          pyramidDir: levelFgPyramidDir,
          sceneBounds,
          quality,
          signal,
          skipEmptyAlpha: true,
          allPendingUploads,
          onTileProgress
        });
        fgSparseTiles = fgRes?.sparseTiles || null;
        fgBaseUrl = fgRes?.baseUrl || encodePathSegments(levelFgPyramidDir);
        job.loadedFgImg?.close?.();
        job.loadedFgImg = null;
        if (clearBackground) levelsToClearFg.push(level);
      }

      // 4. Collect spatial walls, doors, lights (excluding negative darkness), sounds, and tiles for this level
      const spatial = controller.collectLevelSpatialData(targetScene, level);
      allTileIdsToDelete.push(...spatial.tileIdsToDelete);
      allWallIdsToDelete.push(...spatial.wallIdsToDelete);
      allLightIdsToDelete.push(...spatial.lightIdsToDelete);
      allSoundIdsToDelete.push(...spatial.soundIdsToDelete);
      totalBakedTiles += spatial.tiles.length;
      totalBakedWalls += spatial.wallIdsToDelete.length;
      totalBakedLights += spatial.lightIdsToDelete.length;
      totalBakedSounds += spatial.soundIdsToDelete.length;

      const spec = {
        worldPx,
        tilePx: TILE_PX,
        simGrid: spatial.simGrid,
        simSectorPx: spatial.simSectorPx,
        bounds: { ...sceneBounds },
        tiles: spatial.tiles,
        sectors: spatial.sectors
      };
      const normalizeColorCss = (raw) => {
        if (raw === undefined || raw === null || raw === "") return null;
        const c = foundry.utils.Color.from(raw);
        return c?.valid && c.valueOf() !== 0xffffff ? c.css : null;
      };
      if (hasBg) {
        spec.pyramidBaseUrl = bgBaseUrl;
        spec.maxZoomZ = plan.maxZoomZ;
        const bgTint = normalizeColorCss(level.background?.tint);
        if (bgTint) spec.backgroundTint = bgTint;
        if (Number.isFinite(level.background?.alphaThreshold) && level.background.alphaThreshold !== 0.75) {
          spec.backgroundAlphaThreshold = level.background.alphaThreshold;
        }
      }
      if (hasFg) {
        spec.foregroundPyramidBaseUrl = fgBaseUrl;
        spec.foregroundMaxZoomZ = fgPlan.maxZoomZ;
        if (fgSparseTiles) spec.foregroundTiles = fgSparseTiles;
        const fgTint = normalizeColorCss(level.foreground?.tint);
        if (fgTint) spec.foregroundTint = fgTint;
        if (Number.isFinite(level.foreground?.alphaThreshold) && level.foreground.alphaThreshold !== 0.75) {
          spec.foregroundAlphaThreshold = level.foreground.alphaThreshold;
        }
      }
      attachBakedPolysIfPossible(spec, targetScene, level);
      levelSpecs[level.id] = spec;
    }

    if (signal?.aborted) throw new DOMException("Aborted", "AbortError");

    // 5. Upload pyramid_manifest.json (preserve existing unbaked levels on partial multi-level in-place re-bakes)
    report(90, game.i18n.localize("BOUNDLESS.Baker.StepManifest"));
    const singleLevelId = chosenLevels.length === 1 ? chosenLevels[0].id : null;
    const isPartialMultiLevel = targetLevels.length > 1 && chosenLevels.length < targetLevels.length;
    let mergedLevelSpecs = levelSpecs;
    if (isPartialMultiLevel && !singleLevelId) {
      const existingUrl = targetScene.flags?.[MODULE_ID]?.manifestUrl;
      if (existingUrl) {
        try {
          const prevManifest = await fetchManifestJson(existingUrl, signal);
          if (prevManifest?.levels && typeof prevManifest.levels === "object") {
            mergedLevelSpecs = { ...prevManifest.levels, ...levelSpecs };
          } else if (prevManifest && typeof prevManifest === "object" && prevManifest.sectors) {
            const prevLid = targetScene.flags?.[MODULE_ID]?.levelId
              || targetLevels.find(l => !chosenLevels.includes(l))?.id;
            if (prevLid && !levelSpecs[prevLid]) {
              const { format: _fmt, ...flatSpec } = prevManifest;
              mergedLevelSpecs = { [prevLid]: flatSpec, ...levelSpecs };
            }
          }
        } catch (err) {
          if (err?.name === "AbortError" || signal?.aborted) throw new DOMException("Aborted", "AbortError");
        }
      }
    }
    const manifestObj = singleLevelId
      ? {
          format: "boundless-pyramid-v1",
          ...levelSpecs[singleLevelId]
        }
      : {
          format: "boundless-pyramid-v1",
          worldPx,
          tilePx: TILE_PX,
          levels: mergedLevelSpecs
        };

    const manifestName = (isPartialMultiLevel && singleLevelId)
      ? `${levelJobs[0]?.levelSlug || singleLevelId.slice(0, 6)}_manifest.json`
      : "pyramid_manifest.json";
    const manifestFile = new File(
      [JSON.stringify(manifestObj)],
      manifestName,
      { type: "application/json" }
    );
    if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
    const manifestUpRes = await uploadFileSilent(outDir, manifestFile);
    if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
    const manifestUrl = manifestUpRes?.path || `${encodePathSegments(outDir)}/${manifestName}`;
    controller.manifestCache?.delete?.(manifestUrl);

    // 6. Clean up original embedded documents & background on targetScene if requested
    report(94, game.i18n.localize("BOUNDLESS.Baker.StepUpdatingScene"));
    if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
    if (removeOriginals) {
      const bakedLevelIdSet = new Set(chosenLevels.map(l => l.id));
      const unbakedLevelIds = targetLevels.map(l => l.id).filter(lid => !bakedLevelIdSet.has(lid));
      const pruneOrDelete = async (docName, rawIds) => {
        const ids = Array.from(new Set(rawIds));
        if (!ids.length) return;
        if (!isPartialMultiLevel) {
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
            // In Foundry v14, empty doc.levels means the document appears on ALL levels — restrict to remaining unbaked levels!
            if (unbakedLevelIds.length === 0) toDelete.push(id);
            else toUpdate.push({ _id: id, levels: unbakedLevelIds });
            continue;
          }
          const remaining = docLevels.filter(lid => !bakedLevelIdSet.has(lid));
          if (remaining.length === 0) toDelete.push(id);
          else if (remaining.length < docLevels.length) toUpdate.push({ _id: id, levels: remaining });
        }
        if (toUpdate.length) await targetScene.updateEmbeddedDocuments(docName, toUpdate);
        if (toDelete.length) await targetScene.deleteEmbeddedDocuments(docName, toDelete);
      };

      await pruneOrDelete("Tile", allTileIdsToDelete);
      await pruneOrDelete("Wall", allWallIdsToDelete);
      await pruneOrDelete("AmbientLight", allLightIdsToDelete);
      await pruneOrDelete("AmbientSound", allSoundIdsToDelete);
    }

    if (clearBackground && (levelsToClearBg.length || levelsToClearFg.length)) {
      const clearMap = new Map();
      for (const lvl of levelsToClearBg) {
        clearMap.set(lvl.id, { lvl, bg: true, fg: false });
      }
      for (const lvl of levelsToClearFg) {
        const entry = clearMap.get(lvl.id) || { lvl, bg: false, fg: false };
        entry.fg = true;
        clearMap.set(lvl.id, entry);
      }
      for (const { lvl, bg, fg } of clearMap.values()) {
        const patchNull = {};
        const patchEmpty = {};
        if (bg) { patchNull["background.src"] = null; patchEmpty["background.src"] = ""; }
        if (fg) { patchNull["foreground.src"] = null; patchEmpty["foreground.src"] = ""; }
        try {
          await lvl.update(patchNull);
        } catch {
          try { await lvl.update(patchEmpty); } catch {}
        }
      }
    }

    // Clear stale virtual edits/door states via explicit `-=` deletion operators (Foundry merges updates by default!)
    const prevFlags = targetScene.flags?.[MODULE_ID] || {};
    const bakedLevelIds = chosenLevels.map(l => l.id);
    const scenePatch = {
      [`flags.${MODULE_ID}.showPois`]: prevFlags.showPois !== false,
      [`flags.${MODULE_ID}.chunkedFog`]: prevFlags.chunkedFog !== false,
      [`flags.${MODULE_ID}.virtualizeTokens`]: prevFlags.virtualizeTokens !== false,
      [`flags.${MODULE_ID}.manifestRev`]: Math.max(Date.now(), (Number(prevFlags.manifestRev) || 0) + 1)
    };
    for (const mapKey of ["wallEdits", "lightEdits", "soundEdits", "tileEdits"]) {
      if (prevFlags[mapKey] && typeof prevFlags[mapKey] === "object") {
        for (const lid of bakedLevelIds) {
          if (lid in prevFlags[mapKey]) {
            scenePatch[`flags.${MODULE_ID}.${mapKey}.-=${lid}`] = null;
          }
        }
      }
    }
    if (prevFlags.doorStates && typeof prevFlags.doorStates === "object") {
      for (const dKey of Object.keys(prevFlags.doorStates)) {
        const sep = dKey.indexOf(":");
        if (sep !== -1 && bakedLevelIds.includes(dKey.slice(0, sep))) {
          scenePatch[`flags.${MODULE_ID}.doorStates.-=${dKey}`] = null;
        }
      }
    }

    if (isPartialMultiLevel && singleLevelId) {
      const targetLvl = chosenLevels[0];
      const lvlPatch = {
        [`flags.${MODULE_ID}.enabled`]: true,
        [`flags.${MODULE_ID}.manifestUrl`]: manifestUrl
      };
      const prevLvlFlags = targetLvl.flags?.[MODULE_ID] || {};
      if ("inlineManifest" in prevLvlFlags) lvlPatch[`flags.${MODULE_ID}.-=inlineManifest`] = null;
      if ("pyramidBaseUrl" in prevLvlFlags) lvlPatch[`flags.${MODULE_ID}.-=pyramidBaseUrl`] = null;
      if ("foregroundPyramidBaseUrl" in prevLvlFlags) lvlPatch[`flags.${MODULE_ID}.-=foregroundPyramidBaseUrl`] = null;
      await targetLvl.update(lvlPatch);

      // Do NOT force scene.flags.boundless.enabled=true when scene has no manifestUrl (would activate 1000x1000 demo on unbaked levels);
      // controller.mount() already activates via `anyLevelFlag`!
      if (prevFlags.manifestUrl) scenePatch[`flags.${MODULE_ID}.enabled`] = true;
      await targetScene.update(scenePatch);
    } else {
      // Clear stale per-level overrides on baked levels so the new scene manifest takes effect cleanly
      for (const lvl of chosenLevels) {
        const prevLvlFlags = lvl.flags?.[MODULE_ID];
        if (!prevLvlFlags || typeof prevLvlFlags !== "object") continue;
        const lvlPatch = {};
        if ("inlineManifest" in prevLvlFlags) lvlPatch[`flags.${MODULE_ID}.-=inlineManifest`] = null;
        if ("manifestUrl" in prevLvlFlags) lvlPatch[`flags.${MODULE_ID}.-=manifestUrl`] = null;
        if ("pyramidBaseUrl" in prevLvlFlags) lvlPatch[`flags.${MODULE_ID}.-=pyramidBaseUrl`] = null;
        if ("foregroundPyramidBaseUrl" in prevLvlFlags) lvlPatch[`flags.${MODULE_ID}.-=foregroundPyramidBaseUrl`] = null;
        if (prevLvlFlags.enabled === false) lvlPatch[`flags.${MODULE_ID}.-=enabled`] = null;
        if (Object.keys(lvlPatch).length) await lvl.update(lvlPatch);
      }

      // Mark remaining unbaked levels on partial multi-level bakes as disabled so they stay eligible for future baking
      if (isPartialMultiLevel) {
        const coveredIds = new Set(Object.keys(mergedLevelSpecs));
        for (const lvl of targetLevels) {
          if (coveredIds.has(lvl.id)) continue;
          const lFlags = lvl.flags?.[MODULE_ID];
          if (lFlags?.manifestUrl || lFlags?.inlineManifest || lFlags?.enabled === false) continue;
          await lvl.update({ [`flags.${MODULE_ID}.enabled`]: false });
        }
      }

      scenePatch[`flags.${MODULE_ID}.enabled`] = true;
      scenePatch[`flags.${MODULE_ID}.manifestUrl`] = manifestUrl;
      if (singleLevelId) {
        scenePatch[`flags.${MODULE_ID}.levelId`] = singleLevelId;
      } else if ("levelId" in prevFlags) {
        scenePatch[`flags.${MODULE_ID}.-=levelId`] = null;
      }
      await targetScene.update(scenePatch);
    }

    if (!createCopy) {
      await controller.lightBatch?.clearPolyCacheDB?.(targetScene.id, game.world?.id);
    }

    report(100, game.i18n.localize("BOUNDLESS.Baker.StepDone"));

    const hasCanvas = Boolean(globalThis.canvas?.ready && !game.settings?.get?.("core", "noCanvas"));
    if (createCopy && activateCopy) {
      await targetScene.view();
    } else if (hasCanvas && canvas.scene?.id === targetScene.id) {
      await controller.mount(targetScene);
    }

    return {
      scene: targetScene,
      manifestUrl,
      tilesUploaded: uploadedTiles,
      levelsBaked: chosenLevels.length,
      tiles: totalBakedTiles,
      walls: totalBakedWalls,
      lights: totalBakedLights,
      sounds: totalBakedSounds
    };
  } catch (err) {
    if (allPendingUploads.length) {
      await Promise.allSettled(allPendingUploads);
    }
    if (createdClone && targetScene?.id) {
      try { await targetScene.delete(); } catch {}
    }
    throw err;
  } finally {
    for (const job of levelJobs) {
      job.loadedImg?.close?.();
      job.loadedFgImg?.close?.();
    }
  }
}

// ============================================================================
// Pure helpers for Bake Edits & Unbake (fully unit-testable without Foundry)
// ============================================================================

function toPlainEditRecord(edits) {
  if (!edits) return null;
  if (edits instanceof Map) {
    const out = {};
    for (const [k, v] of edits) out[k] = v;
    return out;
  }
  return typeof edits === "object" ? edits : null;
}

function resolveOccModesArray(modeSpec) {
  const occConst = globalThis.CONST?.OCCLUSION_MODES || {};
  const valid = new Set(Object.values(occConst).filter(v => typeof v === "number" && v > 0));
  if (Array.isArray(modeSpec)) {
    const out = new Set();
    for (const m of modeSpec) {
      if (typeof m === "string" && m in occConst && valid.has(occConst[m])) out.add(occConst[m]);
      else if (typeof m === "number" && (valid.size ? valid.has(m) : m > 0)) out.add(m);
    }
    return Array.from(out);
  }
  if (typeof modeSpec === "number" && modeSpec > 0) {
    if (!valid.size) return [modeSpec];
    const out = [];
    for (const bit of valid) {
      if ((modeSpec & bit) === bit) out.push(bit);
    }
    return out;
  }
  if (typeof modeSpec === "string" && modeSpec in occConst && valid.has(occConst[modeSpec])) {
    return [occConst[modeSpec]];
  }
  return [];
}

function normalizePersistedDoorState(raw) {
  if (typeof raw === "boolean") return raw ? 1 : 0;
  if (typeof raw === "number" && Number.isFinite(raw)) return raw;
  return undefined;
}

function resolveWallItem(sk, kind, idx, raw, wallEditsObj, doorStatesObj, levelId) {
  const wKey = `${sk}:${kind}:${idx}`;
  const dKey = `${levelId}::${sk}_${kind === "w" ? "w" : ""}${idx}`;
  const legacyDKey = `${levelId}:${sk}:${kind === "w" ? "w:" : ""}${idx}`;
  const rawLiveDs = (doorStatesObj && dKey in doorStatesObj)
    ? doorStatesObj[dKey]
    : ((doorStatesObj && legacyDKey in doorStatesObj) ? doorStatesObj[legacyDKey] : undefined);
  const liveDs = normalizePersistedDoorState(rawLiveDs);
  const rawExtra = kind === "d" ? raw?.[6] : raw?.[9];
  const rawGid = (rawExtra && typeof rawExtra === "object" && rawExtra.gid) ? rawExtra.gid : undefined;

  if (wallEditsObj && Object.prototype.hasOwnProperty.call(wallEditsObj, wKey)) {
    const ov = wallEditsObj[wKey];
    if (ov === null) return null;
    return {
      c: Array.isArray(ov.c) ? ov.c.slice(0, 4) : [0, 0, 0, 0],
      move: ov.move ?? 20,
      sight: ov.sight ?? 20,
      light: ov.light ?? 20,
      sound: ov.sound ?? 20,
      dir: ov.dir || 0,
      door: ov.door || 0,
      ds: ov.door ? (liveDs !== undefined ? liveDs : (ov.ds || 0)) : 0,
      doorSound: ov.doorSound || "",
      threshold: ov.threshold || null,
      animation: (ov.animation?.type && ov.animation?.texture) ? ov.animation : null,
      gid: ov.gid || rawGid
    };
  }
  if (kind === "d") {
    const [x1, y1, x2, y2, doorType, defaultDs, extra] = raw;
    return {
      c: [x1, y1, x2, y2],
      move: extra?.move ?? 20,
      sight: extra?.sight ?? 20,
      light: extra?.light ?? 20,
      sound: extra?.sound ?? 20,
      dir: extra?.dir || 0,
      door: doorType || 1,
      ds: liveDs !== undefined ? liveDs : (defaultDs || 0),
      doorSound: extra?.doorSound || "",
      threshold: extra?.threshold || null,
      animation: (extra?.animation?.type && extra?.animation?.texture) ? extra.animation : null,
      gid: extra?.gid || undefined
    };
  }
  const [x1, y1, x2, y2, move, sight, light, sound, dir, extra] = raw;
  return {
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
    animation: null,
    gid: extra?.gid || undefined
  };
}

function encodeWallToSector(seg) {
  const [x1, y1, x2, y2] = seg.c;
  if (seg.door > 0) {
    const extra = {};
    if (seg.move !== undefined && seg.move !== 20) extra.move = seg.move;
    if (seg.sight !== undefined && seg.sight !== 20) extra.sight = seg.sight;
    if (seg.light !== undefined && seg.light !== 20) extra.light = seg.light;
    if (seg.sound !== undefined && seg.sound !== 20) extra.sound = seg.sound;
    if (seg.dir) extra.dir = seg.dir;
    if (seg.doorSound) extra.doorSound = seg.doorSound;
    if (seg.gid) extra.gid = seg.gid;
    if (seg.animation?.type && seg.animation?.texture) extra.animation = { ...seg.animation };
    if (seg.threshold && (seg.threshold.light || seg.threshold.sight || seg.threshold.sound)) {
      extra.threshold = { ...seg.threshold };
    }
    return {
      kind: "d",
      tuple: Object.keys(extra).length
        ? [x1, y1, x2, y2, seg.door, seg.ds || 0, extra]
        : [x1, y1, x2, y2, seg.door, seg.ds || 0]
    };
  }
  const tuple = [x1, y1, x2, y2, seg.move, seg.sight, seg.light, seg.sound, seg.dir || 0];
  const extra = {};
  if (seg.threshold && (seg.threshold.light || seg.threshold.sight || seg.threshold.sound)) {
    extra.threshold = { ...seg.threshold };
  }
  if (seg.gid) extra.gid = seg.gid;
  if (Object.keys(extra).length) tuple.push(extra);
  return { kind: "w", tuple };
}

function resolveLightItem(sk, idx, raw, lightEditsObj, defaultElev) {
  const lKey = `${sk}:l:${idx}`;
  const rawGid = (raw?.[8] && typeof raw[8] === "object" && raw[8].gid) ? raw[8].gid : undefined;
  if (lightEditsObj && Object.prototype.hasOwnProperty.call(lightEditsObj, lKey)) {
    const ov = lightEditsObj[lKey];
    if (ov === null) return null;
    return {
      x: ov.x,
      y: ov.y,
      dim: ov.dim ?? 0,
      bright: ov.bright ?? 0,
      color: ov.color ?? null,
      alpha: ov.alpha ?? 0.5,
      anim: ov.anim || "",
      elevation: Number.isFinite(ov.elevation) ? ov.elevation : defaultElev,
      hidden: Boolean(ov.hidden),
      walls: ov.walls !== false,
      angle: ov.angle ?? 360,
      rotation: ov.rotation ?? 0,
      darkMin: ov.darkMin ?? 0,
      darkMax: ov.darkMax ?? 1,
      gid: ov.gid || rawGid,
      ...extractLightStyle(ov)
    };
  }
  const [x, y, dim, bright, color, alpha, anim, customElev, extra] = raw;
  const ex = extra && typeof extra === "object" ? extra : null;
  return {
    x,
    y,
    dim: dim || 0,
    bright: bright || 0,
    color: color ?? null,
    alpha: alpha ?? 0.5,
    anim: anim || "",
    elevation: Number.isFinite(customElev) ? customElev : defaultElev,
    hidden: Boolean(ex?.hidden),
    walls: ex?.walls !== false,
    angle: ex?.angle ?? 360,
    rotation: ex?.rotation ?? 0,
    darkMin: ex?.darkMin ?? 0,
    darkMax: ex?.darkMax ?? 1,
    gid: ex?.gid || undefined,
    ...extractLightStyle(ex)
  };
}

function encodeLightTuple(item) {
  const extra = {};
  if (item.hidden) extra.hidden = true;
  if (item.walls === false) extra.walls = false;
  if ((item.angle ?? 360) < 360) {
    extra.angle = item.angle;
    if (item.rotation) extra.rotation = item.rotation;
  }
  if ((item.darkMin ?? 0) > 0) extra.darkMin = item.darkMin;
  if ((item.darkMax ?? 1) < 1) extra.darkMax = item.darkMax;
  if (Number.isFinite(item.speed) && item.speed !== 3) extra.speed = item.speed;
  if (Number.isFinite(item.intensity) && item.intensity !== 3) extra.intensity = item.intensity;
  if (Number.isFinite(item.coloration) && item.coloration !== 1) extra.coloration = item.coloration;
  if (Number.isFinite(item.attenuation) && item.attenuation !== 0.5) extra.attenuation = item.attenuation;
  if (Number.isFinite(item.luminosity) && item.luminosity !== 0.5) extra.luminosity = item.luminosity;
  if (item.gid) extra.gid = item.gid;
  const tuple = [
    item.x,
    item.y,
    item.dim || 0,
    item.bright || 0,
    item.color ?? null,
    item.alpha ?? 0.5,
    item.anim || "",
    item.elevation
  ];
  if (Object.keys(extra).length) tuple.push(extra);
  return tuple;
}

function resolveSoundItem(sk, idx, raw, soundEditsObj, defaultElev) {
  const sKey = `${sk}:s:${idx}`;
  const rawGid = (raw?.[10] && typeof raw[10] === "object" && raw[10].gid) ? raw[10].gid : undefined;
  if (soundEditsObj && Object.prototype.hasOwnProperty.call(soundEditsObj, sKey)) {
    const ov = soundEditsObj[sKey];
    if (ov === null) return null;
    return {
      x: ov.x,
      y: ov.y,
      radius: ov.radius ?? 20,
      path: ov.path || "",
      volume: ov.volume ?? 0.6,
      walls: ov.walls !== false,
      easing: ov.easing !== false,
      darkMin: ov.darkMin ?? 0,
      darkMax: ov.darkMax ?? 1,
      elevation: Number.isFinite(ov.elevation) ? ov.elevation : defaultElev,
      hidden: Boolean(ov.hidden),
      gid: ov.gid || rawGid
    };
  }
  const [x, y, radius, path, volume, walls, easing, darkMin, darkMax, customElev, extra] = raw;
  const ex = extra && typeof extra === "object" ? extra : null;
  return {
    x,
    y,
    radius: Number.isFinite(radius) ? radius : 20,
    path: path || "",
    volume: volume ?? 0.6,
    walls: walls !== false,
    easing: easing !== false,
    darkMin: darkMin ?? 0,
    darkMax: darkMax ?? 1,
    elevation: Number.isFinite(customElev) ? customElev : defaultElev,
    hidden: Boolean(ex?.hidden),
    gid: ex?.gid || undefined
  };
}

function encodeSoundTuple(item) {
  const row = [
    item.x,
    item.y,
    Number.isFinite(item.radius) ? item.radius : 20,
    item.path || "",
    item.volume ?? 0.6,
    item.walls !== false,
    item.easing !== false,
    item.darkMin ?? 0,
    item.darkMax ?? 1,
    item.elevation
  ];
  const extra = {};
  if (item.hidden) extra.hidden = true;
  if (item.gid) extra.gid = item.gid;
  if (Object.keys(extra).length) row.push(extra);
  return row;
}

function resolveTileItem(tid, raw, tileEditsObj, defaultElev) {
  const tKey = `t:${tid}`;
  if (tileEditsObj && Object.prototype.hasOwnProperty.call(tileEditsObj, tKey)) {
    const ov = tileEditsObj[tKey];
    if (ov === null) return null;
    const preserved = {};
    if (raw && typeof raw === "object") {
      for (const k of ["minZ", "maxZ", "sortLayer", "hoverFade", "surfaceMode", "walkable", "gid"]) {
        if (raw[k] !== undefined) preserved[k] = raw[k];
      }
    }
    return { ...preserved, ...ov, elevation: Number.isFinite(ov.elevation) ? ov.elevation : defaultElev };
  }
  if (!raw || typeof raw !== "object") return null;
  return { ...raw, elevation: Number.isFinite(raw.elevation) ? raw.elevation : defaultElev };
}

function indexTileIntoSectors(tileSpec, tid, ensureSec, simGrid, simSectorPx) {
  const rot = tileSpec.rot || 0;
  const rawAx = tileSpec.anchorX != null ? tileSpec.anchorX : 0.5;
  const rawAy = tileSpec.anchorY != null ? tileSpec.anchorY : 0.5;
  const sxVal = (Number.isFinite(tileSpec.scaleX) && tileSpec.scaleX !== 0) ? tileSpec.scaleX : 1;
  const syVal = (Number.isFinite(tileSpec.scaleY) && tileSpec.scaleY !== 0) ? tileSpec.scaleY : 1;
  const effAx = sxVal < 0 ? (1 - rawAx) : rawAx;
  const effAy = syVal < 0 ? (1 - rawAy) : rawAy;
  const effW = Math.abs(tileSpec.w || 0) * Math.abs(sxVal);
  const effH = Math.abs(tileSpec.h || 0) * Math.abs(syVal);
  const pivX = tileSpec.anchorX == null ? (tileSpec.x + (tileSpec.w || 0) * 0.5) : tileSpec.x;
  const pivY = tileSpec.anchorY == null ? (tileSpec.y + (tileSpec.h || 0) * 0.5) : tileSpec.y;
  const rad = (rot * Math.PI) / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  const dx = (0.5 - effAx) * effW;
  const dy = (0.5 - effAy) * effH;
  const cx = pivX + (cos * dx - sin * dy);
  const cy = pivY + (sin * dx + cos * dy);
  const rx = (effW * Math.abs(cos) + effH * Math.abs(sin)) * 0.5;
  const ry = (effW * Math.abs(sin) + effH * Math.abs(cos)) * 0.5;
  const sx0 = Math.max(0, Math.min(simGrid - 1, Math.floor((cx - rx) / simSectorPx)));
  const sy0 = Math.max(0, Math.min(simGrid - 1, Math.floor((cy - ry) / simSectorPx)));
  const sx1 = Math.max(0, Math.min(simGrid - 1, Math.floor((cx + rx) / simSectorPx)));
  const sy1 = Math.max(0, Math.min(simGrid - 1, Math.floor((cy + ry) / simSectorPx)));
  for (let sy = sy0; sy <= sy1; sy++) {
    for (let sx = sx0; sx <= sx1; sx++) {
      ensureSec(sx, sy).t.push(tid);
    }
  }
}

export function virtualWallToDocData(seg, levelId) {
  const data = {
    c: seg.c.slice(0, 4),
    move: seg.move ?? 20,
    sight: seg.sight ?? 20,
    light: seg.light ?? 20,
    sound: seg.sound ?? 20,
    dir: seg.dir || 0,
    door: seg.door || 0,
    ds: seg.ds || 0,
    doorSound: seg.doorSound || "",
    levels: [levelId]
  };
  if (seg.threshold && (seg.threshold.light || seg.threshold.sight || seg.threshold.sound)) {
    data.threshold = {
      light: seg.threshold.light ?? null,
      sight: seg.threshold.sight ?? null,
      sound: seg.threshold.sound ?? null,
      attenuation: Boolean(seg.threshold.attenuation)
    };
  }
  if (seg.animation?.type && seg.animation?.texture) {
    data.animation = { ...seg.animation };
  }
  return data;
}

export function virtualLightToDocData(item, levelId) {
  const config = {
    dim: item.dim || 0,
    bright: item.bright || 0,
    angle: item.angle ?? 360,
    color: item.color || null,
    alpha: item.alpha ?? 0.5,
    attenuation: item.attenuation ?? 0.5,
    luminosity: item.luminosity ?? 0.5,
    darkness: { min: item.darkMin ?? 0, max: item.darkMax ?? 1 },
    animation: { type: item.anim || null, speed: item.speed ?? 3, intensity: item.intensity ?? 3 }
  };
  if (Number.isFinite(item.coloration)) config.coloration = item.coloration;
  return {
    x: item.x,
    y: item.y,
    elevation: item.elevation,
    rotation: item.rotation || 0,
    hidden: Boolean(item.hidden),
    walls: item.walls !== false,
    levels: [levelId],
    config
  };
}

export function virtualSoundToDocData(item, levelId) {
  return {
    x: item.x,
    y: item.y,
    elevation: item.elevation,
    radius: Number.isFinite(item.radius) ? item.radius : 20,
    path: item.path || "",
    volume: item.volume ?? 0.6,
    walls: item.walls !== false,
    easing: item.easing !== false,
    hidden: Boolean(item.hidden),
    darkness: { min: item.darkMin ?? 0, max: item.darkMax ?? 1 },
    levels: [levelId]
  };
}

export function virtualTileToDocData(item, levelId) {
  const ax = item.anchorX ?? 0.5;
  const ay = item.anchorY ?? 0.5;
  const docX = item.anchorX == null ? (item.x + item.w * 0.5) : item.x;
  const docY = item.anchorY == null ? (item.y + item.h * 0.5) : item.y;
  return {
    x: docX,
    y: docY,
    width: item.w,
    height: item.h,
    rotation: item.rot || 0,
    elevation: item.elevation,
    sort: item.sort || 0,
    alpha: item.alpha ?? 1,
    hidden: Boolean(item.hidden),
    levels: [levelId],
    texture: {
      src: item.src,
      tint: (item.tint !== undefined && item.tint !== null && item.tint !== "") ? item.tint : "#ffffff",
      alphaThreshold: item.alphaThreshold ?? 0.75,
      anchorX: ax,
      anchorY: ay,
      scaleX: item.scaleX ?? 1,
      scaleY: item.scaleY ?? 1,
      fit: item.fit ?? "fill"
    },
    occlusion: {
      modes: resolveOccModesArray(item.occlusionMode),
      alpha: item.occludedAlpha ?? 0.2
    },
    restrictions: {
      light: Boolean(item.restrictsLight),
      weather: Boolean(item.restrictsWeather)
    }
  };
}

/**
 * Pure transformation: merges virtual edits (`wallEdits`, `lightEdits`, `soundEdits`, `tileEdits`)
 * and optional newly-drawn native spatial data into a clean level manifest spec with recalculated sector keys.
 */
export function mergeEditsIntoLevelSpec(spec, {
  levelId = "",
  baseElevation = 0,
  wallEdits = null,
  lightEdits = null,
  soundEdits = null,
  tileEdits = null,
  doorStates = null,
  nativeSpatial = null
} = {}) {
  const worldPx = spec.worldPx || 100000;
  const simGrid = spec.simGrid || Math.max(4, Math.min(40, Math.ceil(worldPx / 2500)));
  const simSectorPx = spec.simSectorPx || Math.ceil(worldPx / simGrid);
  const wEdits = toPlainEditRecord(wallEdits);
  const lEdits = toPlainEditRecord(lightEdits);
  const sEdits = toPlainEditRecord(soundEdits);
  const tEdits = toPlainEditRecord(tileEdits);
  const dStates = toPlainEditRecord(doorStates);

  const newSectors = {};
  const ensureSec = (sx, sy) => {
    const cx = Math.max(0, Math.min(simGrid - 1, sx));
    const cy = Math.max(0, Math.min(simGrid - 1, sy));
    const k = `${cx}_${cy}`;
    return (newSectors[k] ??= { w: [], d: [], l: [], t: [], o: [], s: [] });
  };

  let walls = 0;
  let lights = 0;
  let sounds = 0;

  const pushWallSeg = (seg) => {
    const [x1, y1, x2, y2] = seg.c;
    if (!seg.door) {
      const segLen = Math.hypot(x2 - x1, y2 - y1);
      const parts = segLen > simSectorPx ? Math.ceil(segLen / simSectorPx) : 1;
      if (parts > 1) {
        for (let pi = 0; pi < parts; pi++) {
          const t0 = pi / parts;
          const t1 = (pi + 1) / parts;
          const ax = pi === 0 ? x1 : Math.round(x1 + (x2 - x1) * t0);
          const ay = pi === 0 ? y1 : Math.round(y1 + (y2 - y1) * t0);
          const bx = pi === parts - 1 ? x2 : Math.round(x1 + (x2 - x1) * t1);
          const by = pi === parts - 1 ? y2 : Math.round(y1 + (y2 - y1) * t1);
          const dst = ensureSec(Math.floor(((ax + bx) * 0.5) / simSectorPx), Math.floor(((ay + by) * 0.5) / simSectorPx));
          const subGid = seg.gid ? `${seg.gid}:${pi}` : undefined;
          const enc = encodeWallToSector({ ...seg, c: [ax, ay, bx, by], gid: subGid });
          dst[enc.kind].push(enc.tuple);
          walls++;
        }
        return;
      }
    }
    const cx = (x1 + x2) * 0.5;
    const cy = (y1 + y2) * 0.5;
    const dst = ensureSec(Math.floor(cx / simSectorPx), Math.floor(cy / simSectorPx));
    const enc = encodeWallToSector(seg);
    dst[enc.kind].push(enc.tuple);
    walls++;
  };

  const oldSectors = spec.sectors || {};
  for (const [sk, sec] of Object.entries(oldSectors)) {
    if (!sec) continue;
    if (sec.o?.length) {
      const target = (newSectors[sk] ??= { w: [], d: [], l: [], t: [], o: [], s: [] });
      target.o.push(...sec.o);
    }
    if (sec.w?.length) {
      for (let wi = 0; wi < sec.w.length; wi++) {
        const seg = resolveWallItem(sk, "w", wi, sec.w[wi], wEdits, dStates, levelId);
        if (!seg) continue;
        pushWallSeg(seg);
      }
    }
    if (sec.d?.length) {
      for (let di = 0; di < sec.d.length; di++) {
        const seg = resolveWallItem(sk, "d", di, sec.d[di], wEdits, dStates, levelId);
        if (!seg) continue;
        pushWallSeg(seg);
      }
    }
    if (sec.l?.length) {
      for (let li = 0; li < sec.l.length; li++) {
        const item = resolveLightItem(sk, li, sec.l[li], lEdits, baseElevation + 6);
        if (!item) continue;
        const dst = ensureSec(Math.floor(item.x / simSectorPx), Math.floor(item.y / simSectorPx));
        dst.l.push(encodeLightTuple(item));
        lights++;
      }
    }
    if (sec.s?.length) {
      for (let si = 0; si < sec.s.length; si++) {
        const item = resolveSoundItem(sk, si, sec.s[si], sEdits, baseElevation + 5);
        if (!item) continue;
        const dst = ensureSec(Math.floor(item.x / simSectorPx), Math.floor(item.y / simSectorPx));
        dst.s.push(encodeSoundTuple(item));
        sounds++;
      }
    }
  }

  const newTiles = [];
  const oldTiles = Array.isArray(spec.tiles) ? spec.tiles : [];
  for (let tid = 0; tid < oldTiles.length; tid++) {
    const resolved = resolveTileItem(tid, oldTiles[tid], tEdits, baseElevation);
    if (!resolved) continue;
    const nextTid = newTiles.length;
    newTiles.push(resolved);
    indexTileIntoSectors(resolved, nextTid, ensureSec, simGrid, simSectorPx);
  }

  // Optionally absorb newly drawn native Foundry documents into the same sector grid
  if (nativeSpatial) {
    for (const sec of Object.values(nativeSpatial.sectors || {})) {
      if (!sec) continue;
      for (const w of sec.w || []) {
        const [x1, y1, x2, y2, move, sight, light, sound, dir, extra] = w;
        pushWallSeg({
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
          animation: null,
          gid: extra?.gid || undefined
        });
      }
      for (const d of sec.d || []) {
        const cx = (d[0] + d[2]) * 0.5;
        const cy = (d[1] + d[3]) * 0.5;
        ensureSec(Math.floor(cx / simSectorPx), Math.floor(cy / simSectorPx)).d.push(d);
        walls++;
      }
      for (const l of sec.l || []) {
        ensureSec(Math.floor(l[0] / simSectorPx), Math.floor(l[1] / simSectorPx)).l.push(l);
        lights++;
      }
      for (const s of sec.s || []) {
        ensureSec(Math.floor(s[0] / simSectorPx), Math.floor(s[1] / simSectorPx)).s.push(s);
        sounds++;
      }
    }
    for (const tileSpec of nativeSpatial.tiles || []) {
      const nextTid = newTiles.length;
      newTiles.push(tileSpec);
      indexTileIntoSectors(tileSpec, nextTid, ensureSec, simGrid, simSectorPx);
    }
  }

  // Strip completely empty sectors to keep manifest JSON lean
  for (const [sk, sec] of Object.entries(newSectors)) {
    if (!sec.w.length && !sec.d.length && !sec.l.length && !sec.t.length && !sec.o.length && !sec.s.length) {
      delete newSectors[sk];
    }
  }

  const nextSpec = {
    ...spec,
    worldPx,
    simGrid,
    simSectorPx,
    tiles: newTiles,
    sectors: newSectors
  };
  delete nextSpec.bakedPolys;
  return {
    spec: nextSpec,
    counts: { walls, lights, sounds, tiles: newTiles.length }
  };
}

/**
 * Pure extractor: resolves all virtual Walls, AmbientLights, AmbientSounds, and Tiles
 * of a Boundless level spec (applying all pending `*Edits` and live `doorStates`) into native Foundry v14 doc payloads.
 */
export function extractNativeDocsFromLevelSpec(spec, {
  levelId = "",
  targetLevelId = levelId,
  baseElevation = 0,
  wallEdits = null,
  lightEdits = null,
  soundEdits = null,
  tileEdits = null,
  doorStates = null
} = {}) {
  const wEdits = toPlainEditRecord(wallEdits);
  const lEdits = toPlainEditRecord(lightEdits);
  const sEdits = toPlainEditRecord(soundEdits);
  const tEdits = toPlainEditRecord(tileEdits);
  const dStates = toPlainEditRecord(doorStates);

  const walls = [];
  const wallGids = [];
  const lights = [];
  const lightGids = [];
  const sounds = [];
  const soundGids = [];
  const tiles = [];
  const tileGids = [];

  for (const [sk, sec] of Object.entries(spec?.sectors || {})) {
    if (!sec) continue;
    if (sec.w?.length) {
      for (let wi = 0; wi < sec.w.length; wi++) {
        const seg = resolveWallItem(sk, "w", wi, sec.w[wi], wEdits, dStates, levelId);
        if (seg) {
          walls.push(virtualWallToDocData(seg, targetLevelId));
          wallGids.push(seg.gid || null);
        }
      }
    }
    if (sec.d?.length) {
      for (let di = 0; di < sec.d.length; di++) {
        const seg = resolveWallItem(sk, "d", di, sec.d[di], wEdits, dStates, levelId);
        if (seg) {
          walls.push(virtualWallToDocData(seg, targetLevelId));
          wallGids.push(seg.gid || null);
        }
      }
    }
    if (sec.l?.length) {
      for (let li = 0; li < sec.l.length; li++) {
        const item = resolveLightItem(sk, li, sec.l[li], lEdits, baseElevation + 6);
        if (item) {
          lights.push(virtualLightToDocData(item, targetLevelId));
          lightGids.push(item.gid || null);
        }
      }
    }
    if (sec.s?.length) {
      for (let si = 0; si < sec.s.length; si++) {
        const item = resolveSoundItem(sk, si, sec.s[si], sEdits, baseElevation + 5);
        if (item) {
          sounds.push(virtualSoundToDocData(item, targetLevelId));
          soundGids.push(item.gid || null);
        }
      }
    }
  }

  const rawTiles = Array.isArray(spec?.tiles) ? spec.tiles : [];
  for (let tid = 0; tid < rawTiles.length; tid++) {
    const item = resolveTileItem(tid, rawTiles[tid], tEdits, baseElevation);
    if (item && item.src) {
      tiles.push(virtualTileToDocData(item, targetLevelId));
      tileGids.push(item.gid || null);
    }
  }

  return { walls, wallGids, lights, lightGids, sounds, soundGids, tiles, tileGids };
}

export function getSceneManifestInfo(scene) {
  const cfg = scene?.flags?.[MODULE_ID] || {};
  const hasAnyLevelManifest = Array.from(scene?.levels || []).some(l => {
    const lc = l?.flags?.[MODULE_ID];
    return Boolean(lc?.manifestUrl || lc?.inlineManifest);
  });
  return {
    cfg,
    sceneManifestUrl: cfg.manifestUrl || ((cfg.enabled && !hasAnyLevelManifest) ? `modules/${MODULE_ID}/assets/pyramid/pyramid_manifest.json` : ""),
    sceneLevelId: cfg.levelId || null
  };
}

function isWritableDataPath(url) {
  const clean = String(url || "").replace(/^\/+/, "");
  if (!clean) return false;
  if (/^https?:\/\//i.test(clean)) return false;
  if (clean.startsWith("modules/") || clean.startsWith("systems/")) return false;
  return true;
}

export function getDirAndFilename(url, fallbackDir) {
  const clean = String(url || "").split("?")[0].replace(/^\/+/, "");
  const slash = clean.lastIndexOf("/");
  if (slash <= 0 || !isWritableDataPath(clean)) {
    return { dir: fallbackDir, filename: "pyramid_manifest.json", redirected: true };
  }
  let dir = clean.slice(0, slash)
    .split("/")
    .map(seg => {
      try { return decodeURIComponent(seg); } catch { return seg; }
    })
    .join("/");
  let filename = clean.slice(slash + 1) || "pyramid_manifest.json";
  try { filename = decodeURIComponent(filename); } catch {}
  return {
    dir,
    filename,
    redirected: false
  };
}

async function fetchManifestJson(url, signal = null) {
  const routed = resolveFoundryRoute(url);
  const sep = routed.includes("?") ? "&" : "?";
  const res = await fetch(`${routed}${sep}t=${Date.now()}`, signal ? { signal } : undefined);
  if (!res.ok) throw new Error(`Failed to fetch manifest (${res.status}): ${routed}`);
  return res.json();
}

function buildLevelEditClearPatch(prevFlags, levelIds) {
  const patch = {};
  const levelIdSet = new Set(levelIds);
  for (const mapKey of ["wallEdits", "lightEdits", "soundEdits", "tileEdits"]) {
    if (prevFlags?.[mapKey] && typeof prevFlags[mapKey] === "object") {
      for (const lid of levelIds) {
        if (lid in prevFlags[mapKey]) {
          patch[`flags.${MODULE_ID}.${mapKey}.-=${lid}`] = null;
        }
      }
    }
  }
  // Clear doorStates for edited levels since sector indices may shift after merging edits
  if (prevFlags?.doorStates && typeof prevFlags.doorStates === "object") {
    for (const dKey of Object.keys(prevFlags.doorStates)) {
      const sep = dKey.indexOf("::");
      const lid = sep > 0 ? dKey.slice(0, sep) : dKey.split(":")[0];
      if (lid && levelIdSet.has(lid)) {
        patch[`flags.${MODULE_ID}.doorStates.-=${dKey}`] = null;
      }
    }
  }
  return patch;
}

async function createEmbeddedBatched(scene, docName, items, { signal = null, onBatch = null } = {}) {
  let created = 0;
  for (let i = 0; i < items.length; i += DOC_CREATE_BATCH_SIZE) {
    if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
    const chunk = items.slice(i, i + DOC_CREATE_BATCH_SIZE);
    await scene.createEmbeddedDocuments(docName, chunk);
    created += chunk.length;
    onBatch?.(created, items.length);
  }
  return created;
}

/**
 * Stitch a Boundless WebP tile pyramid back into a single raster WebP image capped at `maxDim` px
 * so unbaked scenes restore their native `level.background.src` / `level.foreground.src` safely within WebGL limits.
 */
export function computeStitchPyramidPlan({
  maxZoomZ = 0,
  worldPx = 4096,
  tilePx = TILE_PX,
  bounds = null,
  maxDim = UNBAKE_MAX_IMAGE_PX
}) {
  const b = bounds || { x: 0, y: 0, w: worldPx, h: worldPx };
  // Pyramid tiles are indexed from (0, 0) relative to (b.x, b.y) over `pyramidSpan = max(b.w, b.h)`
  // (matching `computePyramidPlan`, `sliceAndUploadPyramid`, and `boundless-pyramid.mjs`), independent of scene padding!
  const pyramidSpan = Math.max(1, Number(b.w) || 0, Number(b.h) || 0) || Math.max(1, Number(worldPx) || tilePx);
  const safeMaxZ = Math.max(0, Number(maxZoomZ) || 0);
  let chosenZ = 0;
  for (let z = safeMaxZ; z >= 0; z--) {
    const scaleZ = (tilePx * (1 << z)) / pyramidSpan;
    const estW = Math.round(b.w * scaleZ);
    const estH = Math.round(b.h * scaleZ);
    if (Math.max(estW, estH) <= maxDim) {
      chosenZ = z;
      break;
    }
  }
  const rawScaleZ = (tilePx * (1 << chosenZ)) / pyramidSpan;
  const maxSpan = Math.max(1, Number(b.w) || 0, Number(b.h) || 0);
  const scaleZ = Math.min(rawScaleZ, maxDim / maxSpan);
  const outW = Math.max(1, Math.min(maxDim, Math.round(b.w * scaleZ)));
  const outH = Math.max(1, Math.min(maxDim, Math.round(b.h * scaleZ)));
  const tileWorld = pyramidSpan / (1 << chosenZ);
  const maxIdx = (1 << chosenZ) - 1;
  const x0 = 0;
  const y0 = 0;
  const x1 = Math.min(maxIdx, Math.max(0, Math.floor((b.w - 0.001) / tileWorld)));
  const y1 = Math.min(maxIdx, Math.max(0, Math.floor((b.h - 0.001) / tileWorld)));
  return { chosenZ, pyramidSpan, scaleZ, outW, outH, tileWorld, x0, y0, x1, y1 };
}

async function stitchPyramidToWebp({
  pyramidBaseUrl,
  maxZoomZ = 0,
  worldPx = 4096,
  tilePx = TILE_PX,
  bounds = null,
  sparseTiles = null,
  maxDim = UNBAKE_MAX_IMAGE_PX,
  quality = 0.88,
  signal = null
}) {
  const { chosenZ, scaleZ, outW, outH, tileWorld, x0, y0, x1, y1 } = computeStitchPyramidPlan({
    maxZoomZ,
    worldPx,
    tilePx,
    bounds,
    maxDim
  });

  const sparseSet = (() => {
    if (sparseTiles === null || sparseTiles === undefined) return null;
    const set = new Set();
    const normEntry = (raw) => {
      const s = String(raw || "").trim().replace(/^\/+/, "").replace(/\.webp$/i, "");
      if (!s) return "";
      if (s.includes("/")) return s;
      const parts = s.split("_");
      if (parts.length === 3) return `${parts[0]}/${parts[1]}_${parts[2]}`;
      return s;
    };
    if (Array.isArray(sparseTiles)) {
      for (const entry of sparseTiles) {
        const key = normEntry(entry);
        if (key) set.add(key);
      }
      return set;
    }
    if (typeof sparseTiles === "object") {
      const list = sparseTiles[String(chosenZ)] ?? sparseTiles[chosenZ];
      if (Array.isArray(list)) {
        for (const xy of list) {
          if (Array.isArray(xy) && xy.length >= 2) {
            set.add(`${chosenZ}/${xy[0]}_${xy[1]}`);
            continue;
          }
          const clean = String(xy || "").trim().replace(/\.webp$/i, "");
          if (clean) set.add(clean.includes("/") ? clean : `${chosenZ}/${clean}`);
        }
      }
      return set;
    }
    return null;
  })();

  const work = createWorkCanvas(outW, outH);
  try {
    work.ctx.clearRect(0, 0, outW, outH);
    let drawn = 0;

    const coords = [];
    for (let ty = y0; ty <= y1; ty++) {
      for (let tx = x0; tx <= x1; tx++) {
        if (sparseSet && !sparseSet.has(`${chosenZ}/${tx}_${ty}`)) continue;
        coords.push({ tx, ty });
      }
    }
    await runPool(coords, 4, async ({ tx, ty }) => {
      if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
      const url = `${pyramidBaseUrl}/${chosenZ}/${tx}_${ty}.webp`;
      let img = null;
      let lastErr = null;
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          img = await loadImageSource(url, signal);
          lastErr = null;
          break;
        } catch (err) {
          if (err?.name === "AbortError") throw err;
          lastErr = err;
          if (attempt === 0) await new Promise(r => setTimeout(r, 250));
        }
      }
      if (!img) {
        throw lastErr || new Error(`Failed to load pyramid tile while stitching: ${url}`);
      }
      try {
        const dx = tx * tileWorld * scaleZ;
        const dy = ty * tileWorld * scaleZ;
        const dw = tileWorld * scaleZ;
        const dh = tileWorld * scaleZ;
        work.ctx.drawImage(img.source, dx, dy, dw, dh);
        drawn++;
      } finally {
        img?.close?.();
      }
    }, signal);
    if (!drawn) return null;
    return await canvasToWebpBlob(work, quality);
  } finally {
    if (work?.canvas) {
      work.canvas.width = 0;
      work.canvas.height = 0;
    }
  }
}

/**
 * Check whether a scene is eligible for Bake Edits / Unbake (Boundless enabled, not chunked/superGrid).
 */
export function isSceneBoundlessEditable(scene) {
  if (!scene) return false;
  const cfg = scene.flags?.[MODULE_ID];
  const anyLevel = scene.levels?.some?.(l => l.flags?.[MODULE_ID]?.enabled);
  return Boolean(cfg?.enabled || anyLevel);
}

/**
 * Return levels on a scene that are not yet backed by Boundless (supports incremental optimization of multi-level scenes).
 */
export function getUnbakedSceneLevels(scene) {
  if (!scene) return [];
  const sceneEnabled = Boolean(scene.flags?.[MODULE_ID]?.enabled);
  const levels = Array.from(scene.levels || []);
  return levels.filter(l => {
    const lc = l?.flags?.[MODULE_ID];
    return !(lc?.enabled === true || (sceneEnabled && lc?.enabled !== false));
  });
}

/**
 * Bake accumulated virtual edits (`wallEdits`, `lightEdits`, `soundEdits`, `tileEdits`)
 * and optionally newly created native documents back into clean Boundless manifest JSON(s),
 * clearing the scene edit delta flags afterwards.
 */
export async function bakeSceneEditsToManifest(controller, scene, {
  absorbNative = true,
  onProgress = null,
  signal = null
} = {}) {
  if (!scene) throw new Error("No scene provided.");
  if (!game.user?.isGM) throw new Error("Only a GM can bake edits into a Boundless manifest.");

  const report = (pct, text) => {
    try { onProgress?.({ pct: Math.max(0, Math.min(100, Math.round(pct))), text }); } catch {}
  };

  report(5, game.i18n.localize("BOUNDLESS.Baker.StepPreparing"));
  const { cfg, sceneManifestUrl, sceneLevelId } = getSceneManifestInfo(scene);
  const allLevels = Array.from(scene.levels || []);
  const prevFlags = scene.flags?.[MODULE_ID] || {};
  const fallbackDir = buildDefaultBakeDir(scene);

  const editedLevelIds = [];
  const nativeTileIdsToDelete = [];
  const nativeWallIdsToDelete = [];
  const nativeLightIdsToDelete = [];
  const nativeSoundIdsToDelete = [];
  let totalWalls = 0;
  let totalLights = 0;
  let totalSounds = 0;
  let totalTiles = 0;

  const collectNativeForLevel = (level, simGrid) => {
    if (!absorbNative) return null;
    const spatial = controller.collectLevelSpatialData(scene, level, { simGrid });
    nativeTileIdsToDelete.push(...spatial.tileIdsToDelete);
    nativeWallIdsToDelete.push(...spatial.wallIdsToDelete);
    nativeLightIdsToDelete.push(...spatial.lightIdsToDelete);
    nativeSoundIdsToDelete.push(...spatial.soundIdsToDelete);
    return spatial;
  };

  const scenePatch = {};
  const processedByLevelManifest = new Set();

  // 1. Handle per-level manifests and inline manifests first (including Kartograf exports where
  //    `level.flags.boundless.manifestUrl` inherits `scene.flags.boundless.enabled` without per-level `enabled: true`)
  // Stage 1: Fetch, validate, and merge all level manifests in memory first so partial failures never corrupt persisted manifests.
  // Deduplicate target manifest files by canonical `${dir}/${filename}` so multi-level scenes sharing one manifest file merge cleanly.
  const pendingWrites = [];
  const pendingFileMap = new Map();

  const getOrCreateFileEntry = async (manifestUrl, fallbackPath) => {
    const { dir, filename, redirected } = getDirAndFilename(manifestUrl, fallbackPath);
    const fileKey = `${dir}/${filename}`;
    let entry = pendingFileMap.get(fileKey);
    if (!entry) {
      const rawManifest = await fetchManifestJson(manifestUrl, signal);
      if (rawManifest.chunks?.baseUrl || rawManifest.superGrid) {
        throw new Error("Chunked and superGrid manifests cannot be edited in place.");
      }
      entry = {
        kind: "file",
        dir,
        filename,
        manifest: rawManifest,
        origUrls: new Set([manifestUrl]),
        levelTargets: [],
        sceneTarget: null
      };
      pendingFileMap.set(fileKey, entry);
      pendingWrites.push(entry);
    } else {
      entry.origUrls.add(manifestUrl);
    }
    return { entry, redirected };
  };

  for (let i = 0; i < allLevels.length; i++) {
    if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
    const lvl = allLevels[i];
    const lcfg = lvl.flags?.[MODULE_ID];
    const levelActive = (lcfg?.enabled === true) || (Boolean(cfg.enabled) && lcfg?.enabled !== false);
    if (!levelActive || !lcfg) continue;
    const lid = lvl.id;
    const baseElev = getLevelBaseElevation(lvl);

    if (lcfg.inlineManifest) {
      if (lcfg.inlineManifest.chunks?.baseUrl || lcfg.inlineManifest.superGrid) {
        throw new Error("Chunked and superGrid manifests cannot be edited in place.");
      }
      report(20 + Math.round((i / Math.max(1, allLevels.length)) * 30), game.i18n.format("BOUNDLESS.BakeEdits.StepLevel", { level: lvl.name || lid }));
      const nativeSpatial = collectNativeForLevel(lvl, lcfg.inlineManifest.simGrid || null);
      const merged = mergeEditsIntoLevelSpec(lcfg.inlineManifest, {
        levelId: lid,
        baseElevation: baseElev,
        wallEdits: prevFlags.wallEdits?.[lid],
        lightEdits: prevFlags.lightEdits?.[lid],
        soundEdits: prevFlags.soundEdits?.[lid],
        tileEdits: prevFlags.tileEdits?.[lid],
        doorStates: prevFlags.doorStates,
        nativeSpatial
      });
      attachBakedPolysIfPossible(merged.spec, scene, lvl);
      pendingWrites.push({ kind: "inline", lvl, spec: merged.spec });
      totalWalls += merged.counts.walls;
      totalLights += merged.counts.lights;
      totalSounds += merged.counts.sounds;
      totalTiles += merged.counts.tiles;
      editedLevelIds.push(lid);
      processedByLevelManifest.add(lid);
    } else if (lcfg.manifestUrl) {
      report(20 + Math.round((i / Math.max(1, allLevels.length)) * 30), game.i18n.format("BOUNDLESS.BakeEdits.StepLevel", { level: lvl.name || lid }));
      const levelFallback = `${fallbackDir}/lvl_${i}_${slugifyPathPart(lvl.name, "lvl")}_${lid.slice(0, 6)}`;
      const { entry, redirected } = await getOrCreateFileEntry(lcfg.manifestUrl, levelFallback);
      const rawManifest = entry.manifest;
      const isMultiLevel = Boolean(rawManifest.levels && typeof rawManifest.levels === "object");
      const targetSpec = isMultiLevel ? (rawManifest.levels[lid] || null) : rawManifest;
      if (!targetSpec) continue;
      if (targetSpec.chunks?.baseUrl || targetSpec.superGrid) {
        throw new Error("Chunked and superGrid manifests cannot be edited in place.");
      }
      const nativeSpatial = collectNativeForLevel(lvl, targetSpec.simGrid || null);
      const merged = mergeEditsIntoLevelSpec(targetSpec, {
        levelId: lid,
        baseElevation: baseElev,
        wallEdits: prevFlags.wallEdits?.[lid],
        lightEdits: prevFlags.lightEdits?.[lid],
        soundEdits: prevFlags.soundEdits?.[lid],
        tileEdits: prevFlags.tileEdits?.[lid],
        doorStates: prevFlags.doorStates,
        nativeSpatial
      });
      attachBakedPolysIfPossible(merged.spec, scene, lvl);
      entry.manifest = isMultiLevel
        ? { ...rawManifest, levels: { ...rawManifest.levels, [lid]: merged.spec } }
        : merged.spec;
      entry.levelTargets.push({ lvl, origUrl: lcfg.manifestUrl, redirected });
      totalWalls += merged.counts.walls;
      totalLights += merged.counts.lights;
      totalSounds += merged.counts.sounds;
      totalTiles += merged.counts.tiles;
      editedLevelIds.push(lid);
      processedByLevelManifest.add(lid);
    }
  }

  // 2. Handle scene-level manifestUrl for any remaining active levels not already handled per-level
  const hasRemainingSceneLevels = allLevels.some(lvl =>
    !processedByLevelManifest.has(lvl.id) && lvl.flags?.[MODULE_ID]?.enabled !== false
  );
  if (cfg.enabled && sceneManifestUrl && hasRemainingSceneLevels) {
    report(55, game.i18n.localize("BOUNDLESS.Baker.StepManifest"));
    const { dir: sceneDir, filename: sceneFilename, redirected: sceneRedirected } = getDirAndFilename(sceneManifestUrl, fallbackDir);
    const sceneFileKey = `${sceneDir}/${sceneFilename}`;
    const existingEntry = pendingFileMap.get(sceneFileKey);
    const rawManifest = existingEntry ? existingEntry.manifest : await fetchManifestJson(sceneManifestUrl, signal);
    if (rawManifest.chunks?.baseUrl || rawManifest.superGrid) {
      throw new Error("Chunked and superGrid manifests cannot be edited in place.");
    }
    let updatedManifest = rawManifest;
    let sceneManifestTouched = false;
    const sceneTouchedLevelIds = [];
    if (rawManifest.levels && typeof rawManifest.levels === "object") {
      const nextLevels = { ...rawManifest.levels };
      for (const lvl of allLevels) {
        const lid = lvl.id;
        if (processedByLevelManifest.has(lid) || !nextLevels[lid]) continue;
        if (lvl.flags?.[MODULE_ID]?.enabled === false) continue;
        const spec = nextLevels[lid];
        if (spec.chunks?.baseUrl || spec.superGrid) continue;
        const nativeSpatial = collectNativeForLevel(lvl, spec.simGrid || null);
        const merged = mergeEditsIntoLevelSpec(spec, {
          levelId: lid,
          baseElevation: getLevelBaseElevation(lvl),
          wallEdits: prevFlags.wallEdits?.[lid],
          lightEdits: prevFlags.lightEdits?.[lid],
          soundEdits: prevFlags.soundEdits?.[lid],
          tileEdits: prevFlags.tileEdits?.[lid],
          doorStates: prevFlags.doorStates,
          nativeSpatial
        });
        attachBakedPolysIfPossible(merged.spec, scene, lvl);
        nextLevels[lid] = merged.spec;
        totalWalls += merged.counts.walls;
        totalLights += merged.counts.lights;
        totalSounds += merged.counts.sounds;
        totalTiles += merged.counts.tiles;
        editedLevelIds.push(lid);
        sceneTouchedLevelIds.push(lid);
        sceneManifestTouched = true;
      }
      updatedManifest = { ...rawManifest, levels: nextLevels };
    } else {
      const targetLvl = (sceneLevelId && scene.levels.get(sceneLevelId))
        || (typeof scene.initialLevel === "string" ? scene.levels.get(scene.initialLevel) : scene.initialLevel)
        || scene.firstLevel
        || allLevels[0];
      if (targetLvl && !processedByLevelManifest.has(targetLvl.id) && targetLvl.flags?.[MODULE_ID]?.enabled !== false) {
        const lid = targetLvl.id;
        const nativeSpatial = collectNativeForLevel(targetLvl, rawManifest.simGrid || null);
        const merged = mergeEditsIntoLevelSpec(rawManifest, {
          levelId: lid,
          baseElevation: getLevelBaseElevation(targetLvl),
          wallEdits: prevFlags.wallEdits?.[lid],
          lightEdits: prevFlags.lightEdits?.[lid],
          soundEdits: prevFlags.soundEdits?.[lid],
          tileEdits: prevFlags.tileEdits?.[lid],
          doorStates: prevFlags.doorStates,
          nativeSpatial
        });
        attachBakedPolysIfPossible(merged.spec, scene, targetLvl);
        updatedManifest = merged.spec;
        totalWalls += merged.counts.walls;
        totalLights += merged.counts.lights;
        totalSounds += merged.counts.sounds;
        totalTiles += merged.counts.tiles;
        editedLevelIds.push(lid);
        sceneTouchedLevelIds.push(lid);
        sceneManifestTouched = true;
      }
    }

    if (sceneManifestTouched) {
      if (existingEntry) {
        existingEntry.manifest = updatedManifest;
        existingEntry.origUrls.add(sceneManifestUrl);
        existingEntry.sceneTarget = { origUrl: sceneManifestUrl, redirected: sceneRedirected, levelIds: sceneTouchedLevelIds };
      } else {
        const entry = {
          kind: "file",
          dir: sceneDir,
          filename: sceneFilename,
          manifest: updatedManifest,
          origUrls: new Set([sceneManifestUrl]),
          levelTargets: [],
          sceneTarget: { origUrl: sceneManifestUrl, redirected: sceneRedirected, levelIds: sceneTouchedLevelIds }
        };
        pendingFileMap.set(sceneFileKey, entry);
        pendingWrites.push(entry);
      }
    }
  }

  if (!editedLevelIds.length) {
    throw new Error("No Boundless manifest found on this scene.");
  }

  // Stage 2: Commit validated manifests now that all levels passed validation.
  // Track committed levels so a mid-commit failure still clears their stale index-based edits.
  if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
  const committedLevelIds = [];
  try {
    for (const w of pendingWrites) {
      if (w.kind === "inline") {
        // Force full replacement (`==`) so deleted sectors/keys never survive Foundry recursive deep merge
        await w.lvl.update({ [`flags.${MODULE_ID}.==inlineManifest`]: w.spec });
        if (w.lvl?.id) committedLevelIds.push(w.lvl.id);
      } else if (w.kind === "file") {
        if (!w.levelTargets.length && !w.sceneTarget) continue;
        await ensureDirectoryRecursive(w.dir);
        const file = new File([JSON.stringify(w.manifest)], w.filename, { type: "application/json" });
        const upRes = await uploadFileSilent(w.dir, file);
        const finalUrl = upRes?.path || `${encodePathSegments(w.dir)}/${encodeURIComponent(w.filename)}`;
        for (const origUrl of w.origUrls) controller.manifestCache?.delete?.(origUrl);
        controller.manifestCache?.delete?.(finalUrl);
        const cleanFinal = String(finalUrl || "").split("?")[0].replace(/^\/+/, "");
        const sameUrl = (orig) => String(orig || "").split("?")[0].replace(/^\/+/, "") === cleanFinal;
        for (const lt of w.levelTargets) {
          if (lt.lvl?.id) committedLevelIds.push(lt.lvl.id);
          if (lt.redirected || !sameUrl(lt.origUrl)) {
            await lt.lvl.update?.({ [`flags.${MODULE_ID}.manifestUrl`]: finalUrl });
          }
        }
        if (w.sceneTarget) {
          if (w.sceneTarget.levelIds?.length) committedLevelIds.push(...w.sceneTarget.levelIds);
          if (w.sceneTarget.redirected || !sameUrl(w.sceneTarget.origUrl)) {
            scenePatch[`flags.${MODULE_ID}.manifestUrl`] = finalUrl;
          }
        }
      }
    }
  } catch (err) {
    if (committedLevelIds.length) {
      const recoveryPatch = { ...scenePatch, ...buildLevelEditClearPatch(prevFlags, committedLevelIds) };
      if (Object.keys(recoveryPatch).length) {
        try { await scene.update(recoveryPatch); } catch {}
      }
    }
    throw err;
  }

  // 3. Remove or prune absorbed native documents (do NOT abort here — manifests are already committed on disk/flags)
  report(85, game.i18n.localize("BOUNDLESS.Baker.StepUpdatingScene"));
  if (absorbNative) {
    const editedLevelIdSet = new Set(editedLevelIds);
    const unbakedLevelIds = allLevels.map(l => l.id).filter(lid => !editedLevelIdSet.has(lid));
    const isPartial = unbakedLevelIds.length > 0;
    const pruneOrDelete = async (docName, rawIds) => {
      const unique = Array.from(new Set(rawIds));
      if (!unique.length) return;
      if (!isPartial) {
        await scene.deleteEmbeddedDocuments(docName, unique);
        return;
      }
      const collection = scene.getEmbeddedCollection?.(docName);
      const toDelete = [];
      const toUpdate = [];
      for (const id of unique) {
        const doc = collection?.get?.(id);
        if (!doc) continue;
        const docLevels = doc.levels ? Array.from(doc.levels) : [];
        if (!docLevels.length) {
          toUpdate.push({ _id: id, levels: unbakedLevelIds });
          continue;
        }
        const remaining = docLevels.filter(lid => !editedLevelIdSet.has(lid));
        if (remaining.length === 0) toDelete.push(id);
        else if (remaining.length < docLevels.length) toUpdate.push({ _id: id, levels: remaining });
      }
      if (toUpdate.length) await scene.updateEmbeddedDocuments(docName, toUpdate);
      if (toDelete.length) await scene.deleteEmbeddedDocuments(docName, toDelete);
    };
    await pruneOrDelete("Tile", nativeTileIdsToDelete);
    await pruneOrDelete("Wall", nativeWallIdsToDelete);
    await pruneOrDelete("AmbientLight", nativeLightIdsToDelete);
    await pruneOrDelete("AmbientSound", nativeSoundIdsToDelete);
  }

  Object.assign(scenePatch, buildLevelEditClearPatch(prevFlags, editedLevelIds));
  scenePatch[`flags.${MODULE_ID}.manifestRev`] = Math.max(Date.now(), (Number(prevFlags.manifestRev) || 0) + 1);
  if (Object.keys(scenePatch).length) {
    await scene.update(scenePatch);
  }

  await controller.lightBatch?.clearPolyCacheDB?.(scene.id, game.world?.id);
  if (globalThis.canvas?.ready && !game.settings?.get?.("core", "noCanvas") && canvas.scene?.id === scene.id) {
    await controller.mount(scene);
  }

  report(100, game.i18n.localize("BOUNDLESS.Baker.StepDone"));
  return {
    scene,
    levelsBaked: editedLevelIds.length,
    walls: totalWalls,
    lights: totalLights,
    sounds: totalSounds,
    tiles: totalTiles
  };
}

/**
 * Unbake a Boundless scene back into a standard native Foundry v14 scene:
 * restores virtual walls, doors, lights, ambient sounds, and tiles as native embedded documents,
 * stitches pyramid tiles back into `level.background.src` / `level.foreground.src` when missing,
 * and removes Boundless flags.
 */
export async function unbakeSceneFromBoundless(controller, scene, {
  createCopy = true,
  activateCopy = true,
  restoreImages = true,
  maxImageDim = UNBAKE_MAX_IMAGE_PX,
  onProgress = null,
  signal = null
} = {}) {
  if (!scene) throw new Error("No scene provided.");
  if (!game.user?.isGM) throw new Error("Only a GM can unbake a Boundless scene.");

  const report = (pct, text) => {
    try { onProgress?.({ pct: Math.max(0, Math.min(100, Math.round(pct))), text }); } catch {}
  };

  report(5, game.i18n.localize("BOUNDLESS.Baker.StepPreparing"));
  const { cfg, sceneManifestUrl, sceneLevelId } = getSceneManifestInfo(scene);
  const srcLevels = Array.from(scene.levels || []);
  const prevFlags = scene.flags?.[MODULE_ID] || {};

  // 1. Load manifests lazily and resolve per-level specs before cloning so unsupported formats fail cleanly
  let sceneManifest = null;
  let sceneManifestLoaded = false;

  const defaultFlatLevelId = sceneLevelId
    || (typeof scene.initialLevel === "string" ? scene.initialLevel : scene.initialLevel?.id)
    || scene.firstLevel?.id
    || srcLevels[0]?.id;

  const levelSpecEntries = [];
  for (let i = 0; i < srcLevels.length; i++) {
    if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
    const lvl = srcLevels[i];
    const lcfg = lvl.flags?.[MODULE_ID];
    const levelActive = (lcfg?.enabled === true) || (Boolean(cfg.enabled) && lcfg?.enabled !== false);
    if (!levelActive) continue;
    let spec = null;
    if (lcfg?.inlineManifest) {
      spec = lcfg.inlineManifest;
    } else if (lcfg?.manifestUrl) {
      const lm = await fetchManifestJson(lcfg.manifestUrl, signal);
      spec = (lm.levels && typeof lm.levels === "object") ? (lm.levels[lvl.id] || null) : lm;
    } else if (cfg.enabled && sceneManifestUrl) {
      if (!sceneManifestLoaded) {
        sceneManifest = await fetchManifestJson(sceneManifestUrl, signal);
        sceneManifestLoaded = true;
        if (sceneManifest.chunks?.baseUrl || sceneManifest.superGrid) {
          throw new Error("Chunked and superGrid scenes are too large to unbake into native Foundry documents.");
        }
      }
      if (sceneManifest) {
        if (sceneManifest.levels && typeof sceneManifest.levels === "object") {
          spec = sceneManifest.levels[lvl.id] || null;
        } else if (lvl.id === defaultFlatLevelId) {
          spec = sceneManifest;
        }
      }
    }
    if (!spec) continue;
    if (spec.chunks?.baseUrl || spec.superGrid) {
      throw new Error("Chunked and superGrid scenes are too large to unbake into native Foundry documents.");
    }
    levelSpecEntries.push({ srcLevel: lvl, idx: i, spec });
  }

  if (!levelSpecEntries.length) {
    throw new Error("No Boundless level data found on this scene.");
  }

  // 2. Optionally clone scene first so original Boundless scene stays untouched
  let targetScene = scene;
  let createdClone = false;
  let didUnmountActive = false;
  const levelIdMap = new Map();
  const createdDocIds = { Tile: [], Wall: [], AmbientLight: [], AmbientSound: [] };
  const modifiedLevelsRollback = [];
  let savedSceneFlagsForRollback = null;

  try {
    if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
    if (createCopy) {
      const cloneName = `${scene.name} (Native)`;
      targetScene = await scene.clone({ name: cloneName }, { save: true });
      if (!targetScene) throw new Error("Failed to clone scene.");
      createdClone = true;
      const dstLevels = Array.from(targetScene.levels || []);
      for (let i = 0; i < srcLevels.length; i++) {
        const dst = targetScene.levels.get(srcLevels[i].id) || dstLevels[i];
        if (dst) levelIdMap.set(srcLevels[i].id, dst.id);
      }
    } else {
      for (const l of srcLevels) levelIdMap.set(l.id, l.id);
      if (globalThis.canvas?.ready && canvas.scene?.id === targetScene.id && controller?.active) {
        controller.unmount();
        didUnmountActive = true;
      }
    }

    const outDir = `${buildDefaultBakeDir(targetScene)}_unbaked`;
    const allWalls = [];
    const allLights = [];
    const allSounds = [];
    const allTiles = [];
    const wallsByGid = new Map();
    const lightsByGid = new Map();
    const soundsByGid = new Map();
    const tilesByGid = new Map();
    const docSigWithoutLevels = (doc) => {
      const copy = { ...doc };
      delete copy.levels;
      return JSON.stringify(copy);
    };
    const pendingLevelPatches = [];

    // 3. Extract native documents and optionally stitch pyramid textures back into background/foreground
    for (let i = 0; i < levelSpecEntries.length; i++) {
      if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
      const { srcLevel, spec } = levelSpecEntries[i];
      const srcLid = srcLevel.id;
      const dstLid = levelIdMap.get(srcLid) || srcLid;
      const dstLevel = targetScene.levels.get(dstLid);
      if (!dstLevel) continue;

      report(15 + Math.round((i / levelSpecEntries.length) * 40), game.i18n.format("BOUNDLESS.Unbake.StepLevel", { level: dstLevel.name || dstLid }));

      const extracted = extractNativeDocsFromLevelSpec(spec, {
        levelId: srcLid,
        targetLevelId: dstLid,
        baseElevation: getLevelBaseElevation(dstLevel),
        wallEdits: prevFlags.wallEdits?.[srcLid],
        lightEdits: prevFlags.lightEdits?.[srcLid],
        soundEdits: prevFlags.soundEdits?.[srcLid],
        tileEdits: prevFlags.tileEdits?.[srcLid],
        doorStates: prevFlags.doorStates
      });
      for (let wi = 0; wi < extracted.walls.length; wi++) {
        const doc = extracted.walls[wi];
        const gid = extracted.wallGids?.[wi];
        if (gid) {
          const mergeKey = `${gid}\0${docSigWithoutLevels(doc)}`;
          const prevDoc = wallsByGid.get(mergeKey);
          if (prevDoc) {
            if (!prevDoc.levels.includes(dstLid)) prevDoc.levels.push(dstLid);
            continue;
          }
          wallsByGid.set(mergeKey, doc);
        }
        allWalls.push(doc);
      }
      for (let li = 0; li < extracted.lights.length; li++) {
        const doc = extracted.lights[li];
        const gid = extracted.lightGids?.[li];
        if (gid) {
          const mergeKey = `${gid}\0${docSigWithoutLevels(doc)}`;
          const prevDoc = lightsByGid.get(mergeKey);
          if (prevDoc) {
            if (!prevDoc.levels.includes(dstLid)) prevDoc.levels.push(dstLid);
            continue;
          }
          lightsByGid.set(mergeKey, doc);
        }
        allLights.push(doc);
      }
      for (let si = 0; si < extracted.sounds.length; si++) {
        const doc = extracted.sounds[si];
        const gid = extracted.soundGids?.[si];
        if (gid) {
          const mergeKey = `${gid}\0${docSigWithoutLevels(doc)}`;
          const prevDoc = soundsByGid.get(mergeKey);
          if (prevDoc) {
            if (!prevDoc.levels.includes(dstLid)) prevDoc.levels.push(dstLid);
            continue;
          }
          soundsByGid.set(mergeKey, doc);
        }
        allSounds.push(doc);
      }
      for (let ti = 0; ti < extracted.tiles.length; ti++) {
        const doc = extracted.tiles[ti];
        const gid = extracted.tileGids?.[ti];
        if (gid) {
          const mergeKey = `${gid}\0${docSigWithoutLevels(doc)}`;
          const prevDoc = tilesByGid.get(mergeKey);
          if (prevDoc) {
            if (!prevDoc.levels.includes(dstLid)) prevDoc.levels.push(dstLid);
            continue;
          }
          tilesByGid.set(mergeKey, doc);
        }
        allTiles.push(doc);
      }

      if (restoreImages) {
        const lvlPatch = {};
        const lvlSlug = slugifyPathPart(dstLevel.name, dstLid.slice(0, 6));
        const srcLcfg = srcLevel.flags?.[MODULE_ID] || {};
        const bgPyramidUrl = srcLcfg.pyramidBaseUrl || spec.pyramidBaseUrl;
        const fgPyramidUrl = srcLcfg.foregroundPyramidBaseUrl || spec.foregroundPyramidBaseUrl;
        const effectiveBounds = srcLcfg.bounds || spec.bounds || null;
        if (!dstLevel.background?.src && bgPyramidUrl) {
          const blob = await stitchPyramidToWebp({
            pyramidBaseUrl: bgPyramidUrl,
            maxZoomZ: spec.maxZoomZ ?? 0,
            worldPx: spec.worldPx || targetScene.width || 4096,
            tilePx: spec.tilePx || TILE_PX,
            bounds: effectiveBounds,
            maxDim: maxImageDim,
            signal
          });
          if (blob) {
            await ensureDirectoryRecursive(outDir);
            const fname = `bg_${i}_${lvlSlug}.webp`;
            const res = await uploadFileSilent(outDir, new File([blob], fname, { type: "image/webp" }));
            lvlPatch["background.src"] = res.path;
            if (spec.backgroundTint) lvlPatch["background.tint"] = spec.backgroundTint;
            if (Number.isFinite(spec.backgroundAlphaThreshold)) lvlPatch["background.alphaThreshold"] = spec.backgroundAlphaThreshold;
          }
        }
        if (!dstLevel.foreground?.src && fgPyramidUrl) {
          const fgBlob = await stitchPyramidToWebp({
            pyramidBaseUrl: fgPyramidUrl,
            maxZoomZ: spec.foregroundMaxZoomZ ?? spec.maxZoomZ ?? 0,
            worldPx: spec.worldPx || targetScene.width || 4096,
            tilePx: spec.tilePx || TILE_PX,
            bounds: effectiveBounds,
            sparseTiles: spec.foregroundTiles || null,
            maxDim: maxImageDim,
            signal
          });
          if (fgBlob) {
            await ensureDirectoryRecursive(outDir);
            const fname = `fg_${i}_${lvlSlug}.webp`;
            const res = await uploadFileSilent(outDir, new File([fgBlob], fname, { type: "image/webp" }));
            lvlPatch["foreground.src"] = res.path;
            if (spec.foregroundTint) lvlPatch["foreground.tint"] = spec.foregroundTint;
            if (Number.isFinite(spec.foregroundAlphaThreshold)) lvlPatch["foreground.alphaThreshold"] = spec.foregroundAlphaThreshold;
          }
        }
        if (Object.keys(lvlPatch).length) {
          // Baked pyramids already incorporate `level.textures` transforms (offset/scale/rotation/anchor/fit);
          // reset them only when no untouched background or foreground texture still relies on them.
          const hasUntouchedBg = Boolean(dstLevel.background?.src && !lvlPatch["background.src"]);
          const hasUntouchedFg = Boolean(dstLevel.foreground?.src && !lvlPatch["foreground.src"]);
          if (dstLevel.textures && !hasUntouchedBg && !hasUntouchedFg) {
            lvlPatch["textures.offsetX"] = 0;
            lvlPatch["textures.offsetY"] = 0;
            lvlPatch["textures.scaleX"] = 1;
            lvlPatch["textures.scaleY"] = 1;
            lvlPatch["textures.rotation"] = 0;
            lvlPatch["textures.anchorX"] = 0.5;
            lvlPatch["textures.anchorY"] = 0.5;
            lvlPatch["textures.fit"] = "fill";
          }
          pendingLevelPatches.push({ dstLevel, lvlPatch });
        }
      }
    }

    // 4. Create native embedded documents in safe chunks
    const totalDocs = allWalls.length + allLights.length + allSounds.length + allTiles.length;
    let createdDocs = 0;
    const onDocs = (batchDelta) => {
      createdDocs += batchDelta;
      const pct = 58 + Math.round((createdDocs / Math.max(1, totalDocs)) * 32);
      report(pct, game.i18n.format("BOUNDLESS.Unbake.StepDocuments", { done: createdDocs, total: totalDocs }));
    };

    const runBatched = async (docName, list) => {
      if (!list.length) return;
      for (let i = 0; i < list.length; i += DOC_CREATE_BATCH_SIZE) {
        if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
        const chunk = list.slice(i, i + DOC_CREATE_BATCH_SIZE);
        const created = await targetScene.createEmbeddedDocuments(docName, chunk);
        if (Array.isArray(created)) {
          for (const d of created) {
            if (d?.id) createdDocIds[docName].push(d.id);
          }
        }
        onDocs(chunk.length);
      }
    };

    await runBatched("Tile", allTiles);
    await runBatched("Wall", allWalls);
    await runBatched("AmbientLight", allLights);
    await runBatched("AmbientSound", allSounds);

    if (signal?.aborted) throw new DOMException("Aborted", "AbortError");

    // 5. Commit restored level textures and clear Boundless flags from levels & scene without triggering mid-unbake remounts
    report(93, game.i18n.localize("BOUNDLESS.Baker.StepUpdatingScene"));
    const patchByLevelId = new Map();
    for (const { dstLevel, lvlPatch } of pendingLevelPatches) {
      patchByLevelId.set(dstLevel.id, { lvl: dstLevel, patch: { ...lvlPatch } });
    }
    for (const lvl of targetScene.levels || []) {
      if (lvl.flags?.[MODULE_ID]) {
        const entry = patchByLevelId.get(lvl.id) || { lvl, patch: {} };
        entry.patch[`flags.-=${MODULE_ID}`] = null;
        patchByLevelId.set(lvl.id, entry);
      }
    }

    const suppressForScene = (sceneId) => {
      if (!controller || !sceneId) return;
      if (!controller._suppressAutoMountCounts) controller._suppressAutoMountCounts = new Map();
      controller._suppressAutoMountCounts.set(sceneId, (controller._suppressAutoMountCounts.get(sceneId) || 0) + 1);
    };
    const releaseForScene = (sceneId) => {
      const counts = controller?._suppressAutoMountCounts;
      if (!counts || !sceneId) return;
      const next = (counts.get(sceneId) || 0) - 1;
      if (next > 0) counts.set(sceneId, next);
      else counts.delete(sceneId);
    };

    suppressForScene(targetScene.id);
    try {
      if (targetScene.flags?.[MODULE_ID]) {
        if (!createCopy) {
          savedSceneFlagsForRollback = foundry.utils.deepClone(targetScene.flags[MODULE_ID]);
        }
        await targetScene.update({ [`flags.-=${MODULE_ID}`]: null });
      }
      for (const { lvl, patch } of patchByLevelId.values()) {
        if (!createCopy) {
          const rollback = {};
          for (const key of Object.keys(patch)) {
            if (key === `flags.-=${MODULE_ID}`) {
              if (lvl.flags?.[MODULE_ID]) rollback[`flags.${MODULE_ID}`] = foundry.utils.deepClone(lvl.flags[MODULE_ID]);
            } else {
              rollback[key] = foundry.utils.getProperty(lvl, key);
            }
          }
          modifiedLevelsRollback.push({ lvl, rollback });
        }
        await lvl.update(patch);
      }
    } finally {
      releaseForScene(targetScene.id);
    }

    if (!createCopy) {
      await controller.lightBatch?.clearPolyCacheDB?.(targetScene.id, game.world?.id);
    }

    report(100, game.i18n.localize("BOUNDLESS.Baker.StepDone"));

    const hasCanvas = Boolean(globalThis.canvas?.ready && !game.settings?.get?.("core", "noCanvas"));
    if (createCopy && activateCopy) {
      await targetScene.view();
    } else if (hasCanvas && canvas.scene?.id === targetScene.id) {
      controller.unmount({ clearTextures: true });
      await canvas.draw();
    }

    return {
      scene: targetScene,
      levelsUnbaked: levelSpecEntries.length,
      walls: allWalls.length,
      lights: allLights.length,
      sounds: allSounds.length,
      tiles: allTiles.length
    };
  } catch (err) {
    if (createdClone && targetScene?.id) {
      try { await targetScene.delete(); } catch {}
    } else if (!createdClone && targetScene?.deleteEmbeddedDocuments) {
      for (const docName of ["AmbientSound", "AmbientLight", "Wall", "Tile"]) {
        if (createdDocIds[docName].length) {
          try { await targetScene.deleteEmbeddedDocuments(docName, createdDocIds[docName]); } catch {}
        }
      }
      const counts = controller ? (controller._suppressAutoMountCounts ??= new Map()) : null;
      if (counts && targetScene?.id) counts.set(targetScene.id, (counts.get(targetScene.id) || 0) + 1);
      try {
        for (const { lvl, rollback } of modifiedLevelsRollback) {
          if (Object.keys(rollback).length) {
            try { await lvl.update(rollback); } catch {}
          }
        }
        if (savedSceneFlagsForRollback) {
          try { await targetScene.update({ [`flags.${MODULE_ID}`]: savedSceneFlagsForRollback }); } catch {}
        }
      } finally {
        if (counts && targetScene?.id) {
          const next = (counts.get(targetScene.id) || 0) - 1;
          if (next > 0) counts.set(targetScene.id, next);
          else counts.delete(targetScene.id);
        }
      }
      if (didUnmountActive && globalThis.canvas?.ready && canvas.scene?.id === targetScene.id && !controller?.active) {
        try { await controller.mount(targetScene); } catch {}
      }
    }
    throw err;
  }
}
