import { POI_ICON_META, inferPoiIcon, openPoiEditorDialog } from "./poi.mjs";
import { bakeSceneToBoundless, buildDefaultBakeDir } from "./scene-baker.mjs";

const MODULE_ID = "boundless";

function loc(key) {
  return game.i18n.localize(key);
}

function escapeHtml(str) {
  return String(str ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

async function promptBakeLevel(controller, level) {
  if (!level) return;
  const DialogV2 = foundry.applications.api.DialogV2;
  const body = game.i18n.format("BOUNDLESS.Config.BakeConfirmBody", { level: level.name || level.id });
  const content = `
    <p>${escapeHtml(body)}</p>
    <div class="form-group">
      <label>${escapeHtml(loc("BOUNDLESS.Config.BakeRemoveOriginals"))}</label>
      <div class="form-fields">
        <input type="checkbox" name="removeOriginals" checked>
      </div>
    </div>
  `;

  const result = await DialogV2.prompt({
    window: { title: loc("BOUNDLESS.Config.BakeConfirmTitle") },
    content,
    ok: {
      label: loc("BOUNDLESS.Config.BakeConfirmTitle"),
      callback: (event, button) => ({
        removeOriginals: Boolean(button.form.elements.removeOriginals?.checked)
      })
    },
    rejectClose: false
  });
  if (!result) return;

  const stats = await controller.bakeNativeToLevel(level.id, { removeOriginals: result.removeOriginals });
  ui.notifications.info(game.i18n.format("BOUNDLESS.Config.BakeDone", {
    level: level.name || level.id,
    tiles: stats.tiles,
    walls: stats.walls,
    lights: stats.lights,
    sounds: stats.sounds
  }));
}

async function openBakePyramidDialog(controller, scene, { singleLevelId = null } = {}) {
  if (!scene || !game.user?.isGM) return;
  const DialogV2 = foundry.applications.api.DialogV2;
  const defaultDir = buildDefaultBakeDir(scene);
  const levelObj = singleLevelId ? scene.levels?.get?.(singleLevelId) : null;
  const levelsCount = scene.levels?.size || 1;
  const desc = levelObj
    ? game.i18n.format("BOUNDLESS.Baker.DialogBodyLevel", { level: levelObj.name || levelObj.id })
    : game.i18n.format("BOUNDLESS.Baker.DialogBodyScene", { scene: scene.name || scene.id });

  const content = `
    <div class="boundless-baker-form">
      <p class="hint">${escapeHtml(desc)}</p>

      <div class="form-group">
        <label>${escapeHtml(loc("BOUNDLESS.Baker.TargetDir"))}</label>
        <div class="form-fields">
          <input type="text" name="targetDir" value="${escapeHtml(defaultDir)}" required>
        </div>
        <p class="hint">${escapeHtml(loc("BOUNDLESS.Baker.TargetDirHint"))}</p>
      </div>

      ${(!singleLevelId && levelsCount > 1) ? `
      <div class="form-group">
        <label>${escapeHtml(loc("BOUNDLESS.Baker.AllLevels"))}</label>
        <div class="form-fields">
          <input type="checkbox" name="allLevels" checked>
        </div>
        <p class="hint">${escapeHtml(loc("BOUNDLESS.Baker.AllLevelsHint"))}</p>
      </div>` : ""}

      <div class="form-group">
        <label>${escapeHtml(loc("BOUNDLESS.Baker.CreateCopy"))}</label>
        <div class="form-fields">
          <input type="checkbox" name="createCopy" checked>
        </div>
        <p class="hint">${escapeHtml(loc("BOUNDLESS.Baker.CreateCopyHint"))}</p>
      </div>

      <div class="form-group">
        <label>${escapeHtml(loc("BOUNDLESS.Baker.RemoveOriginals"))}</label>
        <div class="form-fields">
          <input type="checkbox" name="removeOriginals" checked>
        </div>
        <p class="hint">${escapeHtml(loc("BOUNDLESS.Baker.RemoveOriginalsHint"))}</p>
      </div>

      <div class="form-group">
        <label>${escapeHtml(loc("BOUNDLESS.Baker.ClearBackground"))}</label>
        <div class="form-fields">
          <input type="checkbox" name="clearBackground" checked>
        </div>
        <p class="hint">${escapeHtml(loc("BOUNDLESS.Baker.ClearBackgroundHint"))}</p>
      </div>

      <div class="form-group">
        <label>${escapeHtml(loc("BOUNDLESS.Baker.WebpQuality"))}</label>
        <div class="form-fields">
          <input type="range" name="quality" min="60" max="95" step="5" value="85">
          <span class="range-value">85%</span>
        </div>
      </div>
    </div>
  `;

  const opts = await DialogV2.prompt({
    window: { title: loc("BOUNDLESS.Baker.DialogTitle"), icon: "fa-solid fa-wand-magic-sparkles" },
    position: { width: 460 },
    content,
    render: (ev, dialog) => {
      const el = dialog?.element ?? ev?.target?.element;
      const range = el?.querySelector?.('input[name="quality"]');
      const out = el?.querySelector?.(".range-value");
      if (range && out) {
        range.addEventListener("input", () => { out.textContent = `${range.value}%`; });
      }
    },
    ok: {
      label: loc("BOUNDLESS.Baker.StartButton"),
      icon: "fa-solid fa-wand-magic-sparkles",
      callback: (event, button) => {
        const f = button.form.elements;
        return {
          targetDir: f.targetDir?.value?.trim() || defaultDir,
          allLevels: f.allLevels ? Boolean(f.allLevels.checked) : true,
          createCopy: Boolean(f.createCopy?.checked),
          removeOriginals: Boolean(f.removeOriginals?.checked),
          clearBackground: Boolean(f.clearBackground?.checked),
          quality: Math.max(0.6, Math.min(0.95, (Number(f.quality?.value) || 85) / 100))
        };
      }
    },
    rejectClose: false
  });
  if (!opts) return;

  const abortCtrl = new AbortController();
  const levelIds = singleLevelId
    ? [singleLevelId]
    : (opts.allLevels ? null : (canvas.scene?.id === scene.id && canvas.level?.id ? [canvas.level.id] : null));

  const progressDialog = new DialogV2({
    window: { title: loc("BOUNDLESS.Baker.ProgressTitle"), icon: "fa-solid fa-spinner fa-spin" },
    position: { width: 420 },
    content: `
      <div class="boundless-baker-progress">
        <p class="boundless-baker-status">${escapeHtml(loc("BOUNDLESS.Baker.StepPreparing"))}</p>
        <progress class="boundless-baker-bar" max="100" value="0"></progress>
        <span class="boundless-baker-pct">0%</span>
      </div>
    `,
    buttons: [{
      action: "cancel",
      label: loc("BOUNDLESS.Baker.CancelButton"),
      icon: "fa-solid fa-xmark",
      callback: () => { abortCtrl.abort(); }
    }]
  });
  await progressDialog.render(true);

  try {
    const stats = await bakeSceneToBoundless(controller, scene, {
      targetDir: opts.targetDir,
      levelIds,
      createCopy: opts.createCopy,
      removeOriginals: opts.removeOriginals,
      clearBackground: opts.clearBackground,
      quality: opts.quality,
      activateCopy: true,
      signal: abortCtrl.signal,
      onProgress: ({ pct, text }) => {
        const rootEl = progressDialog.element;
        if (!rootEl) return;
        const bar = rootEl.querySelector(".boundless-baker-bar");
        const pctEl = rootEl.querySelector(".boundless-baker-pct");
        const stEl = rootEl.querySelector(".boundless-baker-status");
        if (bar) bar.value = pct;
        if (pctEl) pctEl.textContent = `${pct}%`;
        if (stEl && text) stEl.textContent = text;
      }
    });
    await progressDialog.close().catch(() => {});
    ui.notifications.info(game.i18n.format("BOUNDLESS.Baker.Done", {
      scene: stats.scene.name,
      tilesUploaded: stats.tilesUploaded,
      walls: stats.walls,
      lights: stats.lights,
      tiles: stats.tiles,
      sounds: stats.sounds
    }));
  } catch (err) {
    await progressDialog.close().catch(() => {});
    if (err?.name === "AbortError") {
      ui.notifications.warn(loc("BOUNDLESS.Baker.Cancelled"));
    } else {
      console.error(`${MODULE_ID} | Scene bake failed:`, err);
      ui.notifications.error(game.i18n.format("BOUNDLESS.Baker.Failed", { error: err?.message || String(err) }));
    }
  }
}

function renderPoiListMarkup(pois) {
  if (!pois?.length) {
    return `<p class="boundless-muted">${escapeHtml(loc("BOUNDLESS.Config.PoiEmpty"))}</p>`;
  }
  return pois.map(p => {
    const iconKey = inferPoiIcon(p);
    const meta = POI_ICON_META[iconKey] || POI_ICON_META.pin;
    const dotColor = p.hidden ? "#b87aff" : (p.color || meta.defaultColor || "#f5c96b");
    return `
      <div class="boundless-poi-row" data-poi-id="${escapeHtml(p.id)}">
        <div class="boundless-poi-meta">
          <i class="fa-solid ${escapeHtml(p.hidden ? "fa-eye-slash" : meta.fa)}" style="color: ${escapeHtml(dotColor)};"></i>
          <span>${escapeHtml(p.name)}</span>
          <span class="boundless-poi-coords">(${Math.round(p.x)}, ${Math.round(p.y)})</span>
        </div>
        <div class="boundless-poi-btns">
          <button type="button" data-bl-action="flyPoi" data-poi-id="${escapeHtml(p.id)}" title="${escapeHtml(loc("BOUNDLESS.Config.PoiFly"))}">
            <i class="fa-solid fa-crosshairs"></i>
          </button>
          <button type="button" data-bl-action="editPoi" data-poi-id="${escapeHtml(p.id)}" title="${escapeHtml(loc("BOUNDLESS.Config.PoiEdit"))}">
            <i class="fa-solid fa-pen"></i>
          </button>
          <button type="button" data-bl-action="deletePoi" data-poi-id="${escapeHtml(p.id)}" title="${escapeHtml(loc("BOUNDLESS.Config.PoiDelete"))}">
            <i class="fa-solid fa-trash"></i>
          </button>
        </div>
      </div>
    `;
  }).join("");
}

export function registerConfigUI(controller) {
  Hooks.on("renderSceneConfig", (app, html) => {
    const root = html instanceof HTMLElement ? html : html?.[0];
    const scene = app.document;
    if (!root || !scene || root.querySelector('.tab[data-tab="boundless"]')) return;

    const nav = root.querySelector('nav.sheet-tabs, nav.tabs');
    const lastTab = root.querySelector('.tab[data-tab="misc"][data-group="sheet"]')
      || Array.from(root.querySelectorAll('.tab[data-group="sheet"]')).at(-1);
    if (!nav || !lastTab) return;

    const cfg = scene.flags?.[MODULE_ID] || {};
    const enabled = Boolean(cfg.enabled);
    const manifestUrl = cfg.manifestUrl || "";
    const maxLosPx = cfg.maxLosPx ?? 4500;
    const chunkedFog = cfg.chunkedFog !== false;
    const macroAtmosphere = cfg.macroAtmosphere !== false;
    const showPois = cfg.showPois !== false;
    const showCharacterPins = cfg.showCharacterPins !== false;
    const virtualizeTokens = cfg.virtualizeTokens !== false;
    const effectivePois = controller.getEffectivePOIs(scene);
    const hasCustomPois = Array.isArray(cfg.pois);
    const isActiveTab = app.tabGroups?.sheet === "boundless";

    // Add nav button matching native v14 SceneConfig markup
    const tabBtn = document.createElement("a");
    if (isActiveTab) tabBtn.className = "active";
    tabBtn.dataset.action = "tab";
    tabBtn.dataset.group = "sheet";
    tabBtn.dataset.tab = "boundless";
    tabBtn.innerHTML = `<i class="fa-solid fa-map"></i><span>${escapeHtml(loc("BOUNDLESS.TabLabel"))}</span>`;
    nav.appendChild(tabBtn);

    // Add tab content div matching native v14 SceneConfig markup
    const section = document.createElement("div");
    section.className = isActiveTab ? "tab scrollable active" : "tab scrollable";
    section.dataset.group = "sheet";
    section.dataset.tab = "boundless";

    section.innerHTML = `
      <fieldset class="boundless-fieldset">
        <legend>${escapeHtml(loc("BOUNDLESS.Config.SceneHeading"))}</legend>

        <div class="form-group">
          <label>${escapeHtml(loc("BOUNDLESS.Config.Enabled"))}</label>
          <div class="form-fields">
            <input type="checkbox" name="flags.${MODULE_ID}.enabled" ${enabled ? "checked" : ""}>
          </div>
          <p class="hint">${escapeHtml(loc("BOUNDLESS.Config.EnabledHint"))}</p>
        </div>

        <div class="form-group">
          <label>${escapeHtml(loc("BOUNDLESS.Config.ManifestUrl"))}</label>
          <div class="form-fields">
            <input type="text" name="flags.${MODULE_ID}.manifestUrl" value="${escapeHtml(manifestUrl)}" placeholder="modules/boundless/assets/pyramid/pyramid_manifest.json">
          </div>
          <p class="hint">${escapeHtml(loc("BOUNDLESS.Config.ManifestUrlHint"))}</p>
        </div>

        <div class="form-group">
          <label>${escapeHtml(loc("BOUNDLESS.Config.MaxLosPx"))}</label>
          <div class="form-fields">
            <input type="number" name="flags.${MODULE_ID}.maxLosPx" value="${escapeHtml(maxLosPx)}" min="500" max="50000" step="100">
          </div>
          <p class="hint">${escapeHtml(loc("BOUNDLESS.Config.MaxLosPxHint"))}</p>
        </div>

        <div class="form-group">
          <label>${escapeHtml(loc("BOUNDLESS.Config.ChunkedFog"))}</label>
          <div class="form-fields">
            <input type="checkbox" name="flags.${MODULE_ID}.chunkedFog" ${chunkedFog ? "checked" : ""}>
          </div>
          <p class="hint">${escapeHtml(loc("BOUNDLESS.Config.ChunkedFogHint"))}</p>
        </div>

        <div class="form-group">
          <label>${escapeHtml(loc("BOUNDLESS.Config.MacroAtmosphere"))}</label>
          <div class="form-fields">
            <input type="checkbox" name="flags.${MODULE_ID}.macroAtmosphere" ${macroAtmosphere ? "checked" : ""}>
          </div>
          <p class="hint">${escapeHtml(loc("BOUNDLESS.Config.MacroAtmosphereHint"))}</p>
        </div>

        <div class="form-group">
          <label>${escapeHtml(loc("BOUNDLESS.Config.ShowPois"))}</label>
          <div class="form-fields">
            <input type="checkbox" name="flags.${MODULE_ID}.showPois" ${showPois ? "checked" : ""}>
          </div>
          <p class="hint">${escapeHtml(loc("BOUNDLESS.Config.ShowPoisHint"))}</p>
        </div>

        <div class="form-group">
          <label>${escapeHtml(loc("BOUNDLESS.Config.ShowCharacterPins"))}</label>
          <div class="form-fields">
            <input type="checkbox" name="flags.${MODULE_ID}.showCharacterPins" ${showCharacterPins ? "checked" : ""}>
          </div>
          <p class="hint">${escapeHtml(loc("BOUNDLESS.Config.ShowCharacterPinsHint"))}</p>
        </div>

        <div class="form-group">
          <label>${escapeHtml(loc("BOUNDLESS.Config.VirtualizeTokens"))}</label>
          <div class="form-fields">
            <input type="checkbox" name="flags.${MODULE_ID}.virtualizeTokens" ${virtualizeTokens ? "checked" : ""}>
          </div>
          <p class="hint">${escapeHtml(loc("BOUNDLESS.Config.VirtualizeTokensHint"))}</p>
        </div>
      </fieldset>

      <fieldset class="boundless-fieldset">
        <legend>${escapeHtml(loc("BOUNDLESS.Config.PoiHeading"))}</legend>
        <div class="boundless-poi-list">${renderPoiListMarkup(effectivePois)}</div>
        <div class="boundless-actions">
          <button type="button" data-bl-action="addPoi">
            <i class="fa-solid fa-plus"></i> ${escapeHtml(loc("BOUNDLESS.Config.PoiAddHere"))}
          </button>
          <button type="button" data-bl-action="resetPois" ${hasCustomPois ? "" : "disabled"}>
            <i class="fa-solid fa-rotate-left"></i> ${escapeHtml(loc("BOUNDLESS.Config.PoiReset"))}
          </button>
        </div>
      </fieldset>

      <fieldset class="boundless-fieldset">
        <legend>${escapeHtml(loc("BOUNDLESS.Config.ActionsHeading"))}</legend>
        <div class="boundless-actions">
          <button type="button" class="boundless-primary-btn" data-bl-action="bakePyramid">
            <i class="fa-solid fa-wand-magic-sparkles"></i> ${escapeHtml(loc("BOUNDLESS.Baker.BakeSceneButton"))}
          </button>
          <button type="button" data-bl-action="bakeLevel">
            <i class="fa-solid fa-layer-group"></i> ${escapeHtml(loc("BOUNDLESS.Config.BakeLevel"))}
          </button>
          <button type="button" data-bl-action="resetFog">
            <i class="fa-solid fa-cloud"></i> ${escapeHtml(loc("BOUNDLESS.Config.ResetFog"))}
          </button>
        </div>
      </fieldset>
    `;

    lastTab.after(section);

    const refreshPoiDom = () => {
      const listEl = section.querySelector(".boundless-poi-list");
      const resetBtn = section.querySelector('button[data-bl-action="resetPois"]');
      const current = controller.getEffectivePOIs(scene);
      if (listEl) listEl.innerHTML = renderPoiListMarkup(current);
      if (resetBtn) resetBtn.disabled = !Array.isArray(scene.flags?.[MODULE_ID]?.pois);
    };

    section.addEventListener("click", async (ev) => {
      const btn = ev.target.closest("button[data-bl-action]");
      if (!btn) return;
      ev.preventDefault();
      const action = btn.dataset.blAction;

      if (action === "addPoi") {
        const added = await openPoiEditorDialog(controller, scene);
        if (added) refreshPoiDom();
      } else if (action === "editPoi") {
        const current = controller.getEffectivePOIs(scene);
        const target = current.find(p => p.id === btn.dataset.poiId);
        if (target) {
          const edited = await openPoiEditorDialog(controller, scene, target);
          if (edited) refreshPoiDom();
        }
      } else if (action === "deletePoi") {
        await controller.removePOI(btn.dataset.poiId, scene);
        refreshPoiDom();
      } else if (action === "resetPois") {
        await controller.resetPOIs(scene);
        refreshPoiDom();
      } else if (action === "flyPoi") {
        const current = controller.getEffectivePOIs(scene);
        const target = current.find(p => p.id === btn.dataset.poiId);
        if (target) controller.poiManager.flyTo(target);
      } else if (action === "resetFog") {
        if (canvas.scene?.id === scene.id && canvas.fog) {
          await canvas.fog.reset();
        } else {
          await controller.fogManager.reset({ broadcast: true, persist: true });
          ui.notifications.info(loc("BOUNDLESS.Config.ResetFogDone"));
        }
      } else if (action === "bakePyramid") {
        await openBakePyramidDialog(controller, scene);
      } else if (action === "bakeLevel") {
        if (canvas.scene?.id !== scene.id) return;
        await promptBakeLevel(controller, canvas.level);
      }
    });
  });

  Hooks.on("renderLevelConfig", (app, html) => {
    const root = html instanceof HTMLElement ? html : html?.[0];
    const level = app.document;
    if (!root || !level || root.querySelector(".boundless-level-fieldset")) return;

    const body = root.querySelector(".standard-form, .window-content form > div, form");
    const footer = root.querySelector("footer.form-footer");
    if (!body) return;

    const cfg = level.flags?.[MODULE_ID] || {};
    const enabled = Boolean(cfg.enabled);
    const manifestUrl = cfg.manifestUrl || "";
    const pyramidBaseUrl = cfg.pyramidBaseUrl || "";

    const fieldset = document.createElement("fieldset");
    fieldset.className = "boundless-fieldset boundless-level-fieldset";
    fieldset.innerHTML = `
      <legend>${escapeHtml(loc("BOUNDLESS.Config.LevelHeading"))}</legend>

      <div class="form-group">
        <label>${escapeHtml(loc("BOUNDLESS.Config.LevelEnabled"))}</label>
        <div class="form-fields">
          <input type="checkbox" name="flags.${MODULE_ID}.enabled" ${enabled ? "checked" : ""}>
        </div>
        <p class="hint">${escapeHtml(loc("BOUNDLESS.Config.LevelEnabledHint"))}</p>
      </div>

      <div class="form-group">
        <label>${escapeHtml(loc("BOUNDLESS.Config.ManifestUrl"))}</label>
        <div class="form-fields">
          <input type="text" name="flags.${MODULE_ID}.manifestUrl" value="${escapeHtml(manifestUrl)}" placeholder="">
        </div>
      </div>

      <div class="form-group">
        <label>${escapeHtml(loc("BOUNDLESS.Config.PyramidBaseUrl"))}</label>
        <div class="form-fields">
          <input type="text" name="flags.${MODULE_ID}.pyramidBaseUrl" value="${escapeHtml(pyramidBaseUrl)}" placeholder="">
        </div>
        <p class="hint">${escapeHtml(loc("BOUNDLESS.Config.PyramidBaseUrlHint"))}</p>
      </div>

      <div class="boundless-actions">
        <button type="button" class="boundless-primary-btn" data-bl-action="bakeThisLevelPyramid">
          <i class="fa-solid fa-wand-magic-sparkles"></i> ${escapeHtml(loc("BOUNDLESS.Baker.BakeLevelButton"))}
        </button>
        <button type="button" data-bl-action="bakeThisLevel">
          <i class="fa-solid fa-layer-group"></i> ${escapeHtml(loc("BOUNDLESS.Config.BakeThisLevel"))}
        </button>
      </div>
    `;

    if (footer && footer.parentElement) {
      footer.before(fieldset);
    } else {
      body.appendChild(fieldset);
    }

    fieldset.addEventListener("click", async (ev) => {
      const btn = ev.target.closest("button[data-bl-action]");
      if (!btn) return;
      ev.preventDefault();
      if (btn.dataset.blAction === "bakeThisLevelPyramid") {
        await openBakePyramidDialog(controller, level.parent || canvas.scene, { singleLevelId: level.id });
      } else if (btn.dataset.blAction === "bakeThisLevel") {
        await promptBakeLevel(controller, level);
      }
    });
  });
}
