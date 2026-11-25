import {
  bakeSceneToBoundless,
  bakeSceneEditsToManifest,
  unbakeSceneFromBoundless,
  buildDefaultBakeDir,
  isSceneBoundlessEditable
} from "./scene-baker.mjs";
import { MODULE_ID, loc, escapeHtml } from "./utils.mjs";

const activeBakeScenes = new Set();

function resolveSceneFromContextEl(li) {
  const el = li instanceof HTMLElement ? li : li?.[0];
  if (!el || el.dataset?.levelId) return null;
  const sceneId = el.dataset?.sceneId || el.dataset?.entryId || el.dataset?.documentId;
  return sceneId ? (game.scenes?.get?.(sceneId) ?? null) : null;
}

async function runWithProgressDialog(titleKey, runner, sceneId = null) {
  if (sceneId && activeBakeScenes.has(sceneId)) {
    return { ok: false, err: new Error("A bake or unbake operation is already running for this scene.") };
  }
  if (sceneId) activeBakeScenes.add(sceneId);
  const DialogV2 = foundry.applications.api.DialogV2;
  const abortCtrl = new AbortController();
  const progressDialog = new DialogV2({
    window: { title: loc(titleKey), icon: "fa-solid fa-spinner fa-spin" },
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
      type: "button",
      default: false,
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

  const onProgress = ({ pct, text }) => {
    const rootEl = progressDialog.element;
    if (!rootEl) return;
    const bar = rootEl.querySelector(".boundless-baker-bar");
    const pctEl = rootEl.querySelector(".boundless-baker-pct");
    const stEl = rootEl.querySelector(".boundless-baker-status");
    if (bar) bar.value = pct;
    if (pctEl) pctEl.textContent = `${pct}%`;
    if (stEl && text) stEl.textContent = text;
  };

  try {
    const result = await runner({ signal: abortCtrl.signal, onProgress });
    finished = true;
    await progressDialog.close().catch(() => {});
    return { ok: true, result };
  } catch (err) {
    finished = true;
    await progressDialog.close().catch(() => {});
    return { ok: false, err };
  } finally {
    if (sceneId) activeBakeScenes.delete(sceneId);
  }
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

  const outcome = await runWithProgressDialog("BOUNDLESS.Optimize.ProgressTitle", ({ signal, onProgress }) =>
    bakeSceneToBoundless(controller, scene, {
      targetDir: buildDefaultBakeDir(scene),
      levelIds: null,
      createCopy: opts.createCopy,
      removeOriginals: true,
      clearBackground: true,
      quality: 0.85,
      activateCopy: true,
      signal,
      onProgress
    }),
    scene.id
  );

  if (outcome.ok) {
    ui.notifications.info(game.i18n.format("BOUNDLESS.Optimize.Done", {
      scene: outcome.result.scene.name
    }));
  } else if (outcome.err?.name === "AbortError") {
    ui.notifications.warn(loc("BOUNDLESS.Optimize.Cancelled"));
  } else {
    console.error(`${MODULE_ID} | Scene optimization failed:`, outcome.err);
    ui.notifications.error(game.i18n.format("BOUNDLESS.Optimize.Failed", {
      error: outcome.err?.message || String(outcome.err)
    }));
  }
}

export async function openBakeEditsDialog(controller, scene) {
  if (!scene || !game.user?.isGM) return;
  const DialogV2 = foundry.applications.api.DialogV2;

  const desc = game.i18n.format("BOUNDLESS.BakeEdits.DialogBody", {
    scene: scene.name || scene.id
  });

  const content = `
    <div class="boundless-baker-form">
      <p class="hint">${escapeHtml(desc)}</p>
      <div class="form-group">
        <label>${escapeHtml(loc("BOUNDLESS.BakeEdits.AbsorbNative"))}</label>
        <div class="form-fields">
          <input type="checkbox" name="absorbNative" checked>
        </div>
        <p class="hint">${escapeHtml(loc("BOUNDLESS.BakeEdits.AbsorbNativeHint"))}</p>
      </div>
    </div>
  `;

  const opts = await DialogV2.prompt({
    window: { title: loc("BOUNDLESS.BakeEdits.DialogTitle"), icon: "fa-solid fa-floppy-disk" },
    position: { width: 420 },
    content,
    ok: {
      label: loc("BOUNDLESS.BakeEdits.StartButton"),
      icon: "fa-solid fa-floppy-disk",
      callback: (_event, button) => ({
        absorbNative: Boolean(button.form.elements.absorbNative?.checked)
      })
    },
    rejectClose: false
  });
  if (!opts) return;

  const outcome = await runWithProgressDialog("BOUNDLESS.BakeEdits.ProgressTitle", ({ signal, onProgress }) =>
    bakeSceneEditsToManifest(controller, scene, {
      absorbNative: opts.absorbNative,
      signal,
      onProgress
    }),
    scene.id
  );

  if (outcome.ok) {
    const r = outcome.result;
    ui.notifications.info(game.i18n.format("BOUNDLESS.BakeEdits.Done", {
      scene: r.scene.name,
      walls: r.walls,
      lights: r.lights,
      sounds: r.sounds,
      tiles: r.tiles
    }));
  } else if (outcome.err?.name === "AbortError") {
    ui.notifications.warn(loc("BOUNDLESS.BakeEdits.Cancelled"));
  } else {
    console.error(`${MODULE_ID} | Bake edits failed:`, outcome.err);
    ui.notifications.error(game.i18n.format("BOUNDLESS.BakeEdits.Failed", {
      error: outcome.err?.message || String(outcome.err)
    }));
  }
}

export async function openUnbakeSceneDialog(controller, scene) {
  if (!scene || !game.user?.isGM) return;
  const DialogV2 = foundry.applications.api.DialogV2;

  const desc = game.i18n.format("BOUNDLESS.Unbake.DialogBody", {
    scene: scene.name || scene.id
  });

  const content = `
    <div class="boundless-baker-form">
      <p class="hint">${escapeHtml(desc)}</p>
      <div class="form-group">
        <label>${escapeHtml(loc("BOUNDLESS.Unbake.CreateCopy"))}</label>
        <div class="form-fields">
          <input type="checkbox" name="createCopy" checked>
        </div>
        <p class="hint">${escapeHtml(loc("BOUNDLESS.Unbake.CreateCopyHint"))}</p>
      </div>
      <div class="form-group">
        <label>${escapeHtml(loc("BOUNDLESS.Unbake.RestoreImages"))}</label>
        <div class="form-fields">
          <input type="checkbox" name="restoreImages" checked>
        </div>
        <p class="hint">${escapeHtml(loc("BOUNDLESS.Unbake.RestoreImagesHint"))}</p>
      </div>
    </div>
  `;

  const opts = await DialogV2.prompt({
    window: { title: loc("BOUNDLESS.Unbake.DialogTitle"), icon: "fa-solid fa-box-open" },
    position: { width: 420 },
    content,
    ok: {
      label: loc("BOUNDLESS.Unbake.StartButton"),
      icon: "fa-solid fa-box-open",
      callback: (_event, button) => ({
        createCopy: Boolean(button.form.elements.createCopy?.checked),
        restoreImages: Boolean(button.form.elements.restoreImages?.checked)
      })
    },
    rejectClose: false
  });
  if (!opts) return;

  const outcome = await runWithProgressDialog("BOUNDLESS.Unbake.ProgressTitle", ({ signal, onProgress }) =>
    unbakeSceneFromBoundless(controller, scene, {
      createCopy: opts.createCopy,
      restoreImages: opts.restoreImages,
      activateCopy: true,
      signal,
      onProgress
    }),
    scene.id
  );

  if (outcome.ok) {
    const r = outcome.result;
    ui.notifications.info(game.i18n.format("BOUNDLESS.Unbake.Done", {
      scene: r.scene.name,
      walls: r.walls,
      lights: r.lights,
      sounds: r.sounds,
      tiles: r.tiles
    }));
  } else if (outcome.err?.name === "AbortError") {
    ui.notifications.warn(loc("BOUNDLESS.Unbake.Cancelled"));
  } else {
    console.error(`${MODULE_ID} | Scene unbake failed:`, outcome.err);
    ui.notifications.error(game.i18n.format("BOUNDLESS.Unbake.Failed", {
      error: outcome.err?.message || String(outcome.err)
    }));
  }
}

export function registerConfigUI(controller) {
  const addSceneContextOptions = (_app, options) => {
    if (!Array.isArray(options)) return;

    const pushOption = (label, icon, predicate, action) => {
      if (options.some(opt => (opt.name ?? opt.label) === label)) return;
      const run = (li) => {
        const scene = resolveSceneFromContextEl(li);
        if (scene) action(scene);
      };
      options.push({
        name: label,
        label,
        icon,
        condition: predicate,
        visible: predicate,
        callback: (li) => run(li),
        onClick: (_event, li) => run(li)
      });
    };

    const canOptimize = (li) => {
      if (!game.user?.isGM) return false;
      const scene = resolveSceneFromContextEl(li);
      return Boolean(scene && !activeBakeScenes.has(scene.id) && !isSceneBoundlessEditable(scene));
    };

    const canManageBoundless = (li) => {
      if (!game.user?.isGM) return false;
      const scene = resolveSceneFromContextEl(li);
      return Boolean(scene && !activeBakeScenes.has(scene.id) && isSceneBoundlessEditable(scene));
    };

    pushOption(
      loc("BOUNDLESS.Optimize.ContextMenu"),
      '<i class="fa-solid fa-bolt"></i>',
      canOptimize,
      (scene) => openOptimizeSceneDialog(controller, scene)
    );

    pushOption(
      loc("BOUNDLESS.BakeEdits.ContextMenu"),
      '<i class="fa-solid fa-floppy-disk"></i>',
      canManageBoundless,
      (scene) => openBakeEditsDialog(controller, scene)
    );

    pushOption(
      loc("BOUNDLESS.Unbake.ContextMenu"),
      '<i class="fa-solid fa-box-open"></i>',
      canManageBoundless,
      (scene) => openUnbakeSceneDialog(controller, scene)
    );
  };

  // Foundry v14 AppV2 scene sidebar directory & top scene navigation context menus
  Hooks.on("getSceneDirectoryContextOptions", addSceneContextOptions);
  Hooks.on("getSceneNavigationContextOptions", addSceneContextOptions);
  Hooks.on("getSceneContextOptions", addSceneContextOptions);
}
