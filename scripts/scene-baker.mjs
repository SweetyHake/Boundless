const MODULE_ID = "boundless";
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
  return FP.upload("data", targetDir, file, {}, { notify: false });
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

async function loadImageSource(src) {
  const lower = String(src || "").split("?")[0].toLowerCase();
  const isSvg = lower.endsWith(".svg");
  if (!isSvg && typeof fetch === "function" && typeof createImageBitmap === "function") {
    try {
      const res = await fetch(src);
      if (res.ok) {
        const blob = await res.blob();
        const bmp = await createImageBitmap(blob);
        return { source: bmp, width: bmp.width, height: bmp.height, close: () => { try { bmp.close(); } catch {} } };
      }
    } catch {}
  }
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => resolve({
      source: img,
      width: img.naturalWidth || img.width,
      height: img.naturalHeight || img.height,
      close: () => {}
    });
    img.onerror = () => reject(new Error(`Failed to load background image: ${src}`));
    img.src = src;
  });
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

/**
 * Bake an existing Foundry v14 Scene (background image pyramid + walls/doors/lights/sounds/tiles)
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
  if (createCopy) {
    const copyName = `${sourceScene.name} (Boundless)`;
    targetScene = await sourceScene.clone({ name: copyName }, { save: true });
    if (!targetScene) throw new Error("Failed to clone scene.");
  }

  const targetLevels = Array.from(targetScene.levels?.sorted || targetScene.levels || []);
  const chosenLevels = selectedOrigIndices
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
  const worldPx = Math.max(dims.width || targetScene.width || 4000, dims.height || targetScene.height || 4000);

  await ensureDirectoryRecursive(outDir);

  // 2. Inspect backgrounds & compute total tile count for accurate progress reporting
  const levelJobs = [];
  let grandTotalTiles = 0;

  for (let idx = 0; idx < chosenLevels.length; idx++) {
    const level = chosenLevels[idx];
    const bgSrc = level.background?.src || (targetLevels.length === 1 ? targetScene.background?.src : "") || "";
    const hasRasterBg = Boolean(bgSrc && !VIDEO_EXT_RE.test(bgSrc));
    const levelSlug = chosenLevels.length === 1
      ? "pyramid"
      : `lvl_${idx}_${slugifyPathPart(level.name, level.id.slice(0, 6))}`;
    const levelPyramidDir = `${outDir}/${levelSlug}`;

    let loadedImg = null;
    let plan = null;
    if (hasRasterBg) {
      report(5, game.i18n.format("BOUNDLESS.Baker.StepLoadingBg", { level: level.name || level.id }));
      loadedImg = await loadImageSource(bgSrc);
      plan = computePyramidPlan(sceneBounds.w, sceneBounds.h, loadedImg.width, loadedImg.height, TILE_PX);
      grandTotalTiles += plan.totalTiles;
    }

    levelJobs.push({ level, bgSrc, hasRasterBg, levelPyramidDir, loadedImg, plan });
  }

  let uploadedTiles = 0;
  const levelSpecs = {};
  const allTileIdsToDelete = [];
  const allWallIdsToDelete = [];
  const allLightIdsToDelete = [];
  const allSoundIdsToDelete = [];
  const levelsToClearBg = [];
  let totalBakedWalls = 0, totalBakedLights = 0, totalBakedTiles = 0, totalBakedSounds = 0;

  try {
    // 3. Slice and upload WebP pyramid tiles + collect spatial data per level
    for (const job of levelJobs) {
      if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
      const { level, loadedImg, plan, levelPyramidDir } = job;

      if (loadedImg && plan) {
        const bg = level.background || targetScene.background || {};
        const bgOffX = Number(bg.offsetX) || 0;
        const bgOffY = Number(bg.offsetY) || 0;
        const bgScaleX = Number(bg.scaleX) || 1;
        const bgScaleY = Number(bg.scaleY) || 1;
        const bgRotRad = ((Number(bg.rotation) || 0) * Math.PI) / 180;
        const hasTransform = bgOffX !== 0 || bgOffY !== 0 || bgScaleX !== 1 || bgScaleY !== 1 || bgRotRad !== 0;

        // Build clean <= 4096px mip proxy for lower zoom levels so z=0..2 stay sharp without aliasing
        const mipProxy = buildMipProxy(loadedImg.source, loadedImg.width, loadedImg.height, 4096);
        const work = createWorkCanvas(TILE_PX, TILE_PX);

        await ensureDirectoryRecursive(levelPyramidDir);

        for (const lvl of plan.levels) {
          if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
          const zDir = `${levelPyramidDir}/${lvl.z}`;
          await ensureDirectoryRecursive(zDir);

          // Use anti-aliased mipProxy when downscaling > 2.5x from full source
          const useProxy = Boolean(mipProxy && (lvl.nTiles * TILE_PX) <= mipProxy.width * 1.15);
          const drawSrc = useProxy ? mipProxy.source : loadedImg.source;
          const srcW = useProxy ? mipProxy.width : loadedImg.width;
          const srcH = useProxy ? mipProxy.height : loadedImg.height;

          // Build tile coordinate list for this zoom level and encode/upload in small concurrent batches
          const coords = [];
          for (let ty = 0; ty <= lvl.maxTy; ty++) {
            for (let tx = 0; tx <= lvl.maxTx; tx++) {
              coords.push({ tx, ty });
            }
          }

          // Encode tile on main thread (single work canvas) & upload concurrently via small queue
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
              // Fast, pixel-exact crop from source image mapped onto sceneBounds (0..bounds.w, 0..bounds.h)
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
              // Full Foundry background transform (offset, scale, rotation around scene center)
              work.ctx.scale(scaleToTile, scaleToTile);
              work.ctx.translate(-wx0, -wy0);
              work.ctx.translate(sceneBounds.w * 0.5 + bgOffX, sceneBounds.h * 0.5 + bgOffY);
              if (bgRotRad) work.ctx.rotate(bgRotRad);
              work.ctx.scale(bgScaleX, bgScaleY);
              work.ctx.drawImage(drawSrc, -sceneBounds.w * 0.5, -sceneBounds.h * 0.5, sceneBounds.w, sceneBounds.h);
            }
            work.ctx.restore();

            const blob = await canvasToWebpBlob(work, quality);
            const file = new File([blob], `${tx}_${ty}.webp`, { type: "image/webp" });

            const upPromise = uploadFileSilent(zDir, file).then(() => {
              uploadedTiles++;
              const pct = 10 + Math.round((uploadedTiles / Math.max(1, grandTotalTiles)) * 78);
              report(pct, game.i18n.format("BOUNDLESS.Baker.StepUploading", {
                done: uploadedTiles,
                total: grandTotalTiles,
                z: lvl.z
              }));
            });
            pendingUploads.push(upPromise);
            if (pendingUploads.length >= UPLOAD_CONCURRENCY) {
              await flushUploads(UPLOAD_CONCURRENCY - 1);
            }
          }
          await flushUploads(0);
        }

        if (clearBackground) levelsToClearBg.push(level);
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
      levelSpecs[level.id] = spec;
    }
  } finally {
    for (const job of levelJobs) {
      job.loadedImg?.close?.();
    }
  }

  if (signal?.aborted) throw new DOMException("Aborted", "AbortError");

  // 5. Upload pyramid_manifest.json
  report(90, game.i18n.localize("BOUNDLESS.Baker.StepManifest"));
  const singleLevelId = chosenLevels.length === 1 ? chosenLevels[0].id : null;
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
    const uniq = (arr) => Array.from(new Set(arr));
    const tIds = uniq(allTileIdsToDelete);
    const wIds = uniq(allWallIdsToDelete);
    const lIds = uniq(allLightIdsToDelete);
    const sIds = uniq(allSoundIdsToDelete);
    if (tIds.length) await targetScene.deleteEmbeddedDocuments("Tile", tIds);
    if (wIds.length) await targetScene.deleteEmbeddedDocuments("Wall", wIds);
    if (lIds.length) await targetScene.deleteEmbeddedDocuments("AmbientLight", lIds);
    if (sIds.length) await targetScene.deleteEmbeddedDocuments("AmbientSound", sIds);
  }

  if (clearBackground && levelsToClearBg.length) {
    for (const lvl of levelsToClearBg) {
      try {
        await lvl.update({ "background.src": null });
      } catch {
        try { await lvl.update({ "background.src": "" }); } catch {}
      }
    }
    if (targetLevels.length === 1 && targetScene.background?.src) {
      try { await targetScene.update({ "background.src": null }); } catch {}
    }
  }

  // Enable Boundless on targetScene pointing at the freshly baked manifest
  const prevFlags = foundry.utils.deepClone(targetScene.flags?.[MODULE_ID] || {});
  const nextFlags = {
    ...prevFlags,
    enabled: true,
    manifestUrl,
    showPois: prevFlags.showPois !== false,
    chunkedFog: prevFlags.chunkedFog !== false,
    macroAtmosphere: prevFlags.macroAtmosphere !== false,
    virtualizeTokens: prevFlags.virtualizeTokens !== false
  };
  if (singleLevelId) nextFlags.levelId = singleLevelId;
  await targetScene.update({ [`flags.${MODULE_ID}`]: nextFlags });

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
}
