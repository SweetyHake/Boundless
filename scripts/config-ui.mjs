import { bakeSceneToBoundless, buildDefaultBakeDir } from "./scene-baker.mjs";
import { MODULE_ID, loc, escapeHtml } from "./utils.mjs";

function resolveSceneFromContextEl(li) {
  const el = li instanceof HTMLElement ? li : li?.[0];
  if (!el || el.dataset?.levelId) return null;
  const sceneId = el.dataset?.sceneId || el.dataset?.entryId || el.dataset?.documentId;
  return sceneId ? (game.scenes?.get?.(sceneId) ?? null) : null;
}

export async function openOptimizeSceneDialog(controller, scene) {
  if (!scene || !game.user?.isGM) return;
  const DialogV2 = foundry.applications.api.DialogV2;

  const desc = game.i18n.format("BOUNDLESS.Optimize.DialogBody", {
    scene: scene.name || scene.id
  });

  const content = `
    <div class="boundless-baker-form">
      <p class="hint">${escapeHtml(desc)}</p>
      <div class="form-group">
        <label>${escapeHtml(loc("BOUNDLESS.Optimize.CreateCopy"))}</label>
        <div class="form-fields">
          <input type="checkbox" name="createCopy" checked>
        </div>
        <p class="hint">${escapeHtml(loc("BOUNDLESS.Optimize.CreateCopyHint"))}</p>
      </div>
    </div>
  `;

  const opts = await DialogV2.prompt({
    window: { title: loc("BOUNDLESS.Optimize.DialogTitle"), icon: "fa-solid fa-bolt" },
    position: { width: 420 },
    content,
    ok: {
      label: loc("BOUNDLESS.Optimize.StartButton"),
      icon: "fa-solid fa-bolt",
      callback: (_event, button) => ({
        createCopy: Boolean(button.form.elements.createCopy?.checked)
      })
    },
    rejectClose: false
  });
  if (!opts) return;

  const abortCtrl = new AbortController();
  const progressDialog = new DialogV2({
    window: { title: loc("BOUNDLESS.Optimize.ProgressTitle"), icon: "fa-solid fa-spinner fa-spin" },
    position: { width: 400 },
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

  let finished = false;
  progressDialog.addEventListener?.("close", () => {
    if (!finished) abortCtrl.abort();
  }, { once: true });
  await progressDialog.render(true);

  try {
    const stats = await bakeSceneToBoundless(controller, scene, {
      targetDir: buildDefaultBakeDir(scene),
      levelIds: null,
      createCopy: opts.createCopy,
      removeOriginals: true,
      clearBackground: true,
      quality: 0.85,
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
    finished = true;
    await progressDialog.close().catch(() => {});
    ui.notifications.info(game.i18n.format("BOUNDLESS.Optimize.Done", {
      scene: stats.scene.name
    }));
  } catch (err) {
    finished = true;
    await progressDialog.close().catch(() => {});
    if (err?.name === "AbortError") {
      ui.notifications.warn(loc("BOUNDLESS.Optimize.Cancelled"));
    } else {
      console.error(`${MODULE_ID} | Scene optimization failed:`, err);
      ui.notifications.error(game.i18n.format("BOUNDLESS.Optimize.Failed", {
        error: err?.message || String(err)
      }));
    }
  }
}

export function registerConfigUI(controller) {
  const addSceneOptimizeOption = (_app, options) => {
    if (!Array.isArray(options)) return;
    const label = loc("BOUNDLESS.Optimize.ContextMenu");
    if (options.some(opt => (opt.name ?? opt.label) === label)) return;

    const canOptimize = (li) => {
      if (!game.user?.isGM) return false;
      const scene = resolveSceneFromContextEl(li);
      if (!scene) return false;
      return !scene.flags?.[MODULE_ID]?.enabled;
    };

    const runOptimize = (li) => {
      const scene = resolveSceneFromContextEl(li);
      if (scene) openOptimizeSceneDialog(controller, scene);
    };

    options.push({
      name: label,
      label,
      icon: '<i class="fa-solid fa-bolt"></i>',
      condition: canOptimize,
      visible: canOptimize,
      callback: (li) => runOptimize(li),
      onClick: (_event, li) => runOptimize(li)
    });
  };

  // Foundry v14 AppV2 scene sidebar directory & top scene navigation context menus
  Hooks.on("getSceneDirectoryContextOptions", addSceneOptimizeOption);
  Hooks.on("getSceneNavigationContextOptions", addSceneOptimizeOption);
  Hooks.on("getSceneContextOptions", addSceneOptimizeOption);
}
