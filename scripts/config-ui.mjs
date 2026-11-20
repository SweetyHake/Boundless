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

async function promptAddPoi(controller, scene) {
  const DialogV2 = foundry.applications.api.DialogV2;
  const content = `
    <div class="form-group">
      <label>${escapeHtml(loc("BOUNDLESS.Config.PoiNamePrompt"))}</label>
      <div class="form-fields">
        <input type="text" name="name" value="${escapeHtml(loc("BOUNDLESS.Config.PoiDefaultName"))}" autofocus>
      </div>
    </div>
    <div class="form-group">
      <label>${escapeHtml(loc("BOUNDLESS.Config.PoiHidden"))}</label>
      <div class="form-fields">
        <input type="checkbox" name="hidden">
      </div>
    </div>
  `;

  const res = await DialogV2.prompt({
    window: { title: loc("BOUNDLESS.Config.PoiAddHere") },
    content,
    ok: {
      label: loc("BOUNDLESS.Config.PoiAddHere"),
      callback: (event, button) => ({
        name: button.form.elements.name?.value?.trim() || loc("BOUNDLESS.Config.PoiDefaultName"),
        hidden: Boolean(button.form.elements.hidden?.checked)
      })
    },
    rejectClose: false
  });
  if (!res) return null;

  const pivot = canvas.ready && canvas.scene?.id === scene.id
    ? canvas.stage.pivot
    : { x: (scene.width || 100000) * 0.5, y: (scene.height || 100000) * 0.5 };
  const targetScale = canvas.ready && canvas.scene?.id === scene.id
    ? Math.max(0.25, Math.min(1.2, Number(canvas.stage.scale.x.toFixed(2))))
    : 0.45;

  return controller.addPOI({
    name: res.name,
    x: Math.round(pivot.x),
    y: Math.round(pivot.y),
    levelId: canvas.scene?.id === scene.id ? canvas.level?.id : null,
    targetScale,
    hidden: res.hidden
  }, scene);
}

function renderPoiListMarkup(pois) {
  if (!pois?.length) {
    return `<p class="boundless-muted">${escapeHtml(loc("BOUNDLESS.Config.PoiEmpty"))}</p>`;
  }
  return pois.map(p => `
    <div class="boundless-poi-row" data-poi-id="${escapeHtml(p.id)}">
      <div class="boundless-poi-meta">
        <i class="fa-solid ${p.hidden ? "fa-eye-slash" : "fa-location-dot"}"></i>
        <span>${escapeHtml(p.name)}</span>
        <span class="boundless-poi-coords">(${Math.round(p.x)}, ${Math.round(p.y)})</span>
      </div>
      <div class="boundless-poi-btns">
        <button type="button" data-bl-action="flyPoi" data-poi-id="${escapeHtml(p.id)}" title="${escapeHtml(loc("BOUNDLESS.Config.PoiFly"))}">
          <i class="fa-solid fa-crosshairs"></i>
        </button>
        <button type="button" data-bl-action="deletePoi" data-poi-id="${escapeHtml(p.id)}" title="${escapeHtml(loc("BOUNDLESS.Config.PoiDelete"))}">
          <i class="fa-solid fa-trash"></i>
        </button>
      </div>
    </div>
  `).join("");
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
    const virtualizeTokens = cfg.virtualizeTokens !== false;
    const customPois = Array.isArray(cfg.pois) ? cfg.pois : [];
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
          <label>${escapeHtml(loc("BOUNDLESS.Config.VirtualizeTokens"))}</label>
          <div class="form-fields">
            <input type="checkbox" name="flags.${MODULE_ID}.virtualizeTokens" ${virtualizeTokens ? "checked" : ""}>
          </div>
          <p class="hint">${escapeHtml(loc("BOUNDLESS.Config.VirtualizeTokensHint"))}</p>
        </div>
      </fieldset>

      <fieldset class="boundless-fieldset">
        <legend>${escapeHtml(loc("BOUNDLESS.Config.PoiHeading"))}</legend>
        <div class="boundless-poi-list">${renderPoiListMarkup(customPois)}</div>
        <div class="boundless-actions">
          <button type="button" data-bl-action="addPoi">
            <i class="fa-solid fa-plus"></i> ${escapeHtml(loc("BOUNDLESS.Config.PoiAddHere"))}
          </button>
        </div>
      </fieldset>

      <fieldset class="boundless-fieldset">
        <legend>${escapeHtml(loc("BOUNDLESS.Config.ActionsHeading"))}</legend>
        <div class="boundless-actions">
          <button type="button" data-bl-action="resetFog">
            <i class="fa-solid fa-cloud"></i> ${escapeHtml(loc("BOUNDLESS.Config.ResetFog"))}
          </button>
          <button type="button" data-bl-action="bakeLevel">
            <i class="fa-solid fa-layer-group"></i> ${escapeHtml(loc("BOUNDLESS.Config.BakeLevel"))}
          </button>
        </div>
      </fieldset>
    `;

    lastTab.after(section);

    const refreshPoiDom = () => {
      const listEl = section.querySelector(".boundless-poi-list");
      const current = Array.isArray(scene.flags?.[MODULE_ID]?.pois) ? scene.flags[MODULE_ID].pois : [];
      if (listEl) listEl.innerHTML = renderPoiListMarkup(current);
    };

    section.addEventListener("click", async (ev) => {
      const btn = ev.target.closest("button[data-bl-action]");
      if (!btn) return;
      ev.preventDefault();
      const action = btn.dataset.blAction;

      if (action === "addPoi") {
        const added = await promptAddPoi(controller, scene);
        if (added) refreshPoiDom();
      } else if (action === "deletePoi") {
        await controller.removePOI(btn.dataset.poiId, scene);
        refreshPoiDom();
      } else if (action === "flyPoi") {
        const current = Array.isArray(scene.flags?.[MODULE_ID]?.pois) ? scene.flags[MODULE_ID].pois : [];
        const target = current.find(p => p.id === btn.dataset.poiId);
        if (target) controller.poiManager.flyTo(target);
      } else if (action === "resetFog") {
        if (canvas.scene?.id === scene.id && canvas.fog) {
          await canvas.fog.reset();
        } else {
          await controller.fogManager.reset({ broadcast: true, persist: true });
          ui.notifications.info(loc("BOUNDLESS.Config.ResetFogDone"));
        }
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
      const btn = ev.target.closest('button[data-bl-action="bakeThisLevel"]');
      if (!btn) return;
      ev.preventDefault();
      await promptBakeLevel(controller, level);
    });
  });
}
