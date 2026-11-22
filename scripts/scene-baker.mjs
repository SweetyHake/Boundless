import { MODULE_ID } from "./utils.mjs";

const TILE_PX = 1024;
const UPLOAD_CONCURRENCY = 4;
const VIDEO_EXT_RE = /\.(webm|mp4|m4v|ogv)(\?|$)/i;

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
    try {
      await FP.createDirectory("data", cur);
    } catch (err) {
      const msg = String(err?.message || err || "");
      if (!/exist|EEXIST|already/i.test(msg)) {
        // Double-check if directory is already browsable before throwing
        try {
          await FP.browse("data", cur);
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
  const res = await FP.upload("data", targetDir, file, {}, { notify: false });
  if (!res || !res.path) {
    throw new Error(`Upload failed for ${targetDir}/${file?.name || "file"}`);
  }
  return res;
}

function createWorkCanvas(width, height) {
  if (typeof OffscreenCanvas !== "undefined") {
    const c = new OffscreenCanvas(width, height);
    const ctx = c.getContext("2d");
    if (ctx) {
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = "high";
    }
    return { canvas: c, ctx, isOffscreen: true };
  }
  const c = document.createElement("canvas");
  c.width = width;
  c.height = height;
  const ctx = c.getContext("2d");
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

async function loadImageSource(src, signal = null) {
  if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
  const lower = String(src || "").split("?")[0].toLowerCase();
  const isSvg = lower.endsWith(".svg");
  if (!isSvg && typeof fetch === "function" && typeof createImageBitmap === "function") {
    try {
      const res = await fetch(src, signal ? { signal } : undefined);
      if (res.ok) {
        const blob = await res.blob();
        if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
        const bmp = await createImageBitmap(blob);
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
      resolve({
        source: img,
        width: img.naturalWidth || img.width,
        height: img.naturalHeight || img.height,
        close: () => {}
      });
    };
    img.onerror = () => {
      cleanup();
      reject(new Error(`Failed to load background image: ${src}`));
    };
    img.src = src;
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
  const maxDim = Math.max(imgW || boundsW, imgH || boundsH, tilePx);
  const maxZoomZ = Math.max(0, Math.min(7, Math.ceil(Math.log2(Math.max(1, maxDim / tilePx)))));
  const pyramidSpan = Math.max(boundsW, boundsH);
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
  const texCfg = level.textures || level.background || {};
  const bgOffX = Number(texCfg.offsetX) || 0;
  const bgOffY = Number(texCfg.offsetY) || 0;
  const bgScaleX = Number.isFinite(Number(texCfg.scaleX)) && Number(texCfg.scaleX) !== 0 ? Number(texCfg.scaleX) : 1;
  const bgScaleY = Number.isFinite(Number(texCfg.scaleY)) && Number(texCfg.scaleY) !== 0 ? Number(texCfg.scaleY) : 1;
  const bgRotRad = ((Number(texCfg.rotation) || 0) * Math.PI) / 180;
  const bgAnchorX = Number.isFinite(Number(texCfg.anchorX)) ? Number(texCfg.anchorX) : 0.5;
  const bgAnchorY = Number.isFinite(Number(texCfg.anchorY)) ? Number(texCfg.anchorY) : 0.5;
  const bgFit = texCfg.fit || "fill";
  const hasTransform = bgOffX !== 0 || bgOffY !== 0 || bgScaleX !== 1 || bgScaleY !== 1 || bgRotRad !== 0 || bgAnchorX !== 0.5 || bgAnchorY !== 0.5 || bgFit !== "fill";

  // Build clean <= 4096px mip proxy for lower zoom levels so z=0..2 stay sharp without aliasing
  const mipProxy = buildMipProxy(loadedImg.source, loadedImg.width, loadedImg.height, 4096);
  const work = createWorkCanvas(TILE_PX, TILE_PX);
  const sparseTiles = skipEmptyAlpha ? {} : null;

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

      const upPromise = uploadFileSilent(zDir, file).then(() => {
        onTileProgress?.(lvl.z, true);
      });
      pendingUploads.push(upPromise);
      allPendingUploads.push(upPromise);
      if (pendingUploads.length >= UPLOAD_CONCURRENCY) {
        await flushUploads(UPLOAD_CONCURRENCY - 1);
      }
    }
    await flushUploads(0);
  }

  return sparseTiles;
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

  const outDir = String(targetDir || buildDefaultBakeDir(sourceScene)).replace(/^\/+|\/+$/g, "");
  const origLevels = Array.from(sourceScene.levels?.sorted || sourceScene.levels || []);
  const selectedOrigIndices = [];
  for (let i = 0; i < origLevels.length; i++) {
    if (!levelIds || levelIds.includes(origLevels[i].id)) selectedOrigIndices.push(i);
  }
  if (!selectedOrigIndices.length) throw new Error("No levels selected for baking.");

  report(2, game.i18n.localize("BOUNDLESS.Baker.StepPreparing"));

  // 1. Clone scene upfront if requested so manifest level IDs match the cloned scene's exact level IDs
  let targetScene = sourceScene;
  let createdClone = false;
  if (createCopy) {
    if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
    const copyName = `${sourceScene.name} (Boundless)`;
    targetScene = await sourceScene.clone({ name: copyName }, { save: true });
    if (!targetScene) throw new Error("Failed to clone scene.");
    createdClone = true;
  }

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
      const hasRasterBg = Boolean(bgSrc && !VIDEO_EXT_RE.test(bgSrc));
      const hasRasterFg = Boolean(fgSrc && !VIDEO_EXT_RE.test(fgSrc));
      const levelSlug = chosenLevels.length === 1
        ? "pyramid"
        : `lvl_${idx}_${slugifyPathPart(level.name, level.id.slice(0, 6))}`;
      const levelPyramidDir = `${outDir}/${levelSlug}`;
      const levelFgPyramidDir = `${outDir}/${levelSlug}_fg`;

      let loadedImg = null;
      let plan = null;
      if (hasRasterBg) {
        report(5, game.i18n.format("BOUNDLESS.Baker.StepLoadingBg", { level: level.name || level.id }));
        loadedImg = await loadImageSource(bgSrc, signal);
        plan = computePyramidPlan(sceneBounds.w, sceneBounds.h, loadedImg.width, loadedImg.height, TILE_PX);
        grandTotalTiles += plan.totalTiles;
      }

      let loadedFgImg = null;
      let fgPlan = null;
      if (hasRasterFg) {
        report(7, game.i18n.format("BOUNDLESS.Baker.StepLoadingBg", { level: `${level.name || level.id} (foreground)` }));
        loadedFgImg = await loadImageSource(fgSrc, signal);
        fgPlan = computePyramidPlan(sceneBounds.w, sceneBounds.h, loadedFgImg.width, loadedFgImg.height, TILE_PX);
        grandTotalTiles += fgPlan.totalTiles;
      }

      levelJobs.push({
        level,
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
        total: grandTotalTiles,
        z
      }));
    };

    // 3. Slice and upload WebP pyramid tiles + collect spatial data per level
    for (const job of levelJobs) {
      if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
      const { level, loadedImg, plan, levelPyramidDir, loadedFgImg, fgPlan, levelFgPyramidDir } = job;

      if (loadedImg && plan) {
        await sliceAndUploadPyramid({
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
        if (clearBackground) levelsToClearBg.push(level);
      }

      let fgSparseTiles = null;
      if (loadedFgImg && fgPlan) {
        fgSparseTiles = await sliceAndUploadPyramid({
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
      if (loadedImg && plan) {
        spec.pyramidBaseUrl = levelPyramidDir;
        spec.maxZoomZ = plan.maxZoomZ;
      }
      if (loadedFgImg && fgPlan) {
        spec.foregroundPyramidBaseUrl = levelFgPyramidDir;
        spec.foregroundMaxZoomZ = fgPlan.maxZoomZ;
        if (fgSparseTiles) spec.foregroundTiles = fgSparseTiles;
      }
      levelSpecs[level.id] = spec;
    }

    if (signal?.aborted) throw new DOMException("Aborted", "AbortError");

    // 5. Upload pyramid_manifest.json
    report(90, game.i18n.localize("BOUNDLESS.Baker.StepManifest"));
    const singleLevelId = chosenLevels.length === 1 ? chosenLevels[0].id : null;
    const isPartialMultiLevel = targetLevels.length > 1 && chosenLevels.length < targetLevels.length;
    const manifestObj = singleLevelId
      ? {
          format: "boundless-pyramid-v1",
          ...levelSpecs[singleLevelId]
        }
      : {
          format: "boundless-pyramid-v1",
          worldPx,
          tilePx: TILE_PX,
          levels: levelSpecs
        };

    const manifestFile = new File(
      [JSON.stringify(manifestObj)],
      "pyramid_manifest.json",
      { type: "application/json" }
    );
    await uploadFileSilent(outDir, manifestFile);
    const manifestUrl = `${outDir}/pyramid_manifest.json`;
    controller.manifestCache?.delete?.(manifestUrl);

    // 6. Clean up original embedded documents & background on targetScene if requested
    report(94, game.i18n.localize("BOUNDLESS.Baker.StepUpdatingScene"));
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
      [`flags.${MODULE_ID}.virtualizeTokens`]: prevFlags.virtualizeTokens !== false
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

      scenePatch[`flags.${MODULE_ID}.enabled`] = true;
      scenePatch[`flags.${MODULE_ID}.manifestUrl`] = manifestUrl;
      if (singleLevelId) {
        scenePatch[`flags.${MODULE_ID}.levelId`] = singleLevelId;
      } else if ("levelId" in prevFlags) {
        scenePatch[`flags.${MODULE_ID}.-=levelId`] = null;
      }
      await targetScene.update(scenePatch);
    }

    report(100, game.i18n.localize("BOUNDLESS.Baker.StepDone"));

    if (createCopy && activateCopy) {
      await targetScene.view();
    } else if (canvas.scene?.id === targetScene.id) {
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
