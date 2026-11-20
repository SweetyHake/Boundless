const MODULE_ID = "boundless";
const CHAR_PIN_FADE_START = 0.38; // Begin showing world-space character portrait below this scale
const CHAR_PIN_FADE_FULL = 0.20;  // 100% opaque at or below this scale
const FOCUS_TARGET_SCALE = 0.85;  // Close tactical zoom when clicking character icon
const MAX_GM_FALLBACK_PCS = 6;

function smoothstep(edge0, edge1, x) {
  const t = Math.max(0, Math.min(1, (x - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
}

function escapeHtml(str) {
  return String(str ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function loc(key, fallback = "") {
  return game.i18n?.has?.(key) ? game.i18n.localize(key) : (fallback || key);
}

function isDefaultAvatar(src) {
  if (!src) return true;
  return /mystery-man\.svg$/i.test(src);
}

function resolvePortraitSrc(tokenDoc, actor) {
  const actorImg = actor?.img || tokenDoc?.baseActor?.img;
  const ringSubject = tokenDoc?.ring?.enabled
    ? (tokenDoc?._source?.ring?.subject?.texture || tokenDoc?.ring?.subject?.texture)
    : null;
  const tokImg = ringSubject || tokenDoc?.texture?.src;
  if (actorImg && !isDefaultAvatar(actorImg)) return actorImg;
  if (tokImg && !isDefaultAvatar(tokImg)) return tokImg;
  return actorImg || tokImg || "icons/svg/mystery-man.svg";
}

function loadImageElement(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => resolve(img);
    img.onerror = (err) => reject(err);
    img.src = src;
  });
}

async function bakeCircularAvatarTexture(src, sizePx = 128) {
  let source = null;
  try {
    source = await loadImageElement(src);
  } catch {
    const tex = await foundry.canvas.loadTexture(src).catch(() => null);
    source = tex?.baseTexture?.resource?.source || null;
  }
  if (!source) return null;

  const iw = source.naturalWidth || source.videoWidth || source.width || 0;
  const ih = source.naturalHeight || source.videoHeight || source.height || 0;
  if (iw <= 0 || ih <= 0) return null;

  const c = document.createElement("canvas");
  c.width = sizePx;
  c.height = sizePx;
  const ctx = c.getContext("2d");
  if (!ctx) return null;

  ctx.save();
  ctx.beginPath();
  ctx.arc(sizePx * 0.5, sizePx * 0.5, sizePx * 0.5 - 1, 0, Math.PI * 2);
  ctx.closePath();
  ctx.clip();

  // Dark backing so transparent pop-out / top-down tokens stay crisp and legible
  ctx.fillStyle = "#14110d";
  ctx.fillRect(0, 0, sizePx, sizePx);

  // Smart cover crop: bias toward upper chest/head for tall vertical portraits
  let sx = 0;
  let sy = 0;
  let sw = iw;
  let sh = ih;
  if (ih > iw * 1.12) {
    sw = iw;
    sh = iw;
    sy = Math.max(0, (ih - sh) * 0.16);
  } else if (iw > ih * 1.12) {
    sh = ih;
    sw = ih;
    sx = Math.max(0, (iw - sw) * 0.5);
  }

  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(source, sx, sy, sw, sh, 0, 0, sizePx, sizePx);
  ctx.restore();

  return PIXI.Texture.from(c);
}

function getTokenWorldCenter(tokenDoc) {
  const obj = tokenDoc?._object;
  if (obj && !obj.destroyed && obj.center && Number.isFinite(obj.center.x) && Number.isFinite(obj.center.y)) {
    return { x: obj.center.x, y: obj.center.y };
  }
  const gridSize = canvas.grid?.size || tokenDoc?.parent?.grid?.size || 100;
  const w = (Number(tokenDoc?.width) || 1) * gridSize;
  const h = (Number(tokenDoc?.height) || 1) * gridSize;
  return {
    x: (Number(tokenDoc?.x) || 0) + w * 0.5,
    y: (Number(tokenDoc?.y) || 0) + h * 0.5
  };
}

function formatWorldDistance(dx, dy) {
  const distPx = Math.hypot(dx, dy);
  const gridSize = canvas.grid?.size || canvas.scene?.grid?.size || 100;
  const gridDist = canvas.grid?.distance || canvas.scene?.grid?.distance || 5;
  const units = canvas.grid?.units || canvas.scene?.grid?.units || "";
  const val = Math.round((distPx / Math.max(1, gridSize)) * gridDist);
  if (val >= 10000) {
    return `${(val / 1000).toFixed(1)}k${units ? " " + units : ""}`;
  }
  return `${val}${units ? " " + units : ""}`;
}

export class CharacterPinManager {
  controller = null;
  container = null;
  edgeLayerEl = null;
  entries = []; // [{ id, tokenDoc, actor, user, isSelf, colorCss, colorHex, portraitSrc, root, pulseRing, namePill, edgeEl, arrowEl, distEl, hovered }]
  enabled = true;
  _tickerFn = null;
  _pulsePhase = 0;
  _lastSidebarCheckMs = 0;
  _cachedRightInset = 24;
  _rebuildQueued = false;
  _avatarTexCache = new Map(); // src -> Promise<PIXI.Texture | null>
  _avatarTexOwned = [];        // PIXI.Texture[] to destroy cleanly on unmount

  constructor(controller = null) {
    this.controller = controller;
  }

  mount(scene) {
    this.unmount();
    const cfg = scene?.flags?.[MODULE_ID] || {};
    this.enabled = cfg.showCharacterPins !== false;
    if (!this.enabled || !canvas?.controls) return;

    this.container = new PIXI.Container();
    this.container.zIndex = 670;
    this.container.sortableChildren = true;
    this.container.eventMode = "passive";
    this.container.interactiveChildren = true;
    canvas.controls.addChild(this.container);

    const edgeEl = document.createElement("div");
    edgeEl.id = "boundless-char-edge-layer";
    edgeEl.className = "boundless-char-edge-layer";
    document.body.appendChild(edgeEl);
    this.edgeLayerEl = edgeEl;

    this._tickerFn = (delta) => this._stepPulse(delta);
    canvas.app?.ticker?.add?.(this._tickerFn);

    this.rebuild(scene);
    this.updateViewport();
  }

  scheduleRebuild() {
    if (!this.enabled || !this.controller?.active) return;
    if (this._rebuildQueued) return;
    this._rebuildQueued = true;
    queueMicrotask(() => {
      this._rebuildQueued = false;
      if (!this.enabled || !this.controller?.active || !canvas?.scene) return;
      this.rebuild(canvas.scene);
    });
  }

  _collectTrackedTargets(scene) {
    if (!scene?.tokens?.size) return [];
    const tokens = Array.from(scene.tokens);
    const viewedLevelId = canvas.level?.id || null;
    const isGM = Boolean(game.user?.isGM);
    const results = [];
    const seenTokenIds = new Set();

    const findBestTokenForActor = (actorId) => {
      let fallback = null;
      for (const tok of tokens) {
        if (tok.actorId !== actorId) continue;
        if (!isGM && tok.hidden) continue;
        if (viewedLevelId && tok.level === viewedLevelId) return tok;
        if (!fallback) fallback = tok;
      }
      return fallback;
    };

    const pushEntry = (tokenDoc, user, isSelf) => {
      if (!tokenDoc || seenTokenIds.has(tokenDoc.id)) return;
      seenTokenIds.add(tokenDoc.id);
      const actor = tokenDoc.baseActor || tokenDoc.actor || null;
      const rawColor = user?.color?.css || (typeof user?.color === "string" ? user.color : null) || (isSelf ? "#f5c96b" : "#58d5ff");
      results.push({
        id: tokenDoc.id,
        tokenDoc,
        actor,
        user,
        isSelf,
        name: tokenDoc.name || actor?.name || loc("BOUNDLESS.CharPin.FallbackName", "Персонаж"),
        colorCss: rawColor,
        colorHex: foundry.utils.Color.from(rawColor).valueOf(),
        portraitSrc: resolvePortraitSrc(tokenDoc, actor)
      });
    };

    // 1. Always prioritize the current user's assigned character (`game.user.character`)
    if (game.user?.character) {
      const tok = findBestTokenForActor(game.user.character.id);
      if (tok) pushEntry(tok, game.user, true);
    }

    // 2. For non-GM players without an assigned character, fall back to their first owned PC token on scene
    if (!isGM && results.length === 0) {
      let ownFallback = null;
      for (const tok of tokens) {
        if (tok.hidden) continue;
        if (!tok.testUserPermission?.(game.user, "OWNER")) continue;
        if (viewedLevelId && tok.level === viewedLevelId) {
          ownFallback = tok;
          break;
        }
        if (!ownFallback) ownFallback = tok;
      }
      if (ownFallback) pushEntry(ownFallback, game.user, true);
    }

    // 3. For GM: also show every player's assigned character present on the scene
    if (isGM) {
      for (const u of (game.users || [])) {
        if (!u?.character || u.id === game.user?.id) continue;
        const tok = findBestTokenForActor(u.character.id);
        if (tok) pushEntry(tok, u, false);
      }
      // Fallback for solo GM test worlds with no player characters assigned: show up to MAX_GM_FALLBACK_PCS PC tokens
      if (results.length === 0) {
        let count = 0;
        for (const tok of tokens) {
          const base = tok.baseActor;
          const isPc = tok.actorLink || base?.type === "character" || base?.hasPlayerOwner;
          if (!isPc) continue;
          const ownerUser = Array.from(game.users || []).find(u => !u.isGM && tok.testUserPermission?.(u, "OWNER")) || game.user;
          pushEntry(tok, ownerUser, count === 0);
          count++;
          if (count >= MAX_GM_FALLBACK_PCS) break;
        }
      }
    }

    return results;
  }

  rebuild(scene = canvas.scene) {
    if (!this.container || !this.edgeLayerEl) return;

    for (const e of this.entries) {
      e.root?.parent?.removeChild(e.root);
      e.root?.destroy?.({ children: true });
      e.edgeEl?.remove();
    }
    this.entries = [];

    const cfg = scene?.flags?.[MODULE_ID] || {};
    this.enabled = cfg.showCharacterPins !== false;
    if (!this.enabled) {
      this.container.visible = false;
      this.edgeLayerEl.style.display = "none";
      return;
    }
    this.edgeLayerEl.style.display = "";

    const targets = this._collectTrackedTargets(scene);
    for (const target of targets) {
      this._createEntry(target);
    }

    this.updateViewport();
  }

  _createEntry(target) {
    const { tokenDoc, isSelf, colorHex, colorCss, name, portraitSrc } = target;
    const radius = isSelf ? 20 : 17;
    const circleY = -(radius + 11);

    const root = new PIXI.Container();
    const pos = getTokenWorldCenter(tokenDoc);
    root.position.set(pos.x, pos.y);
    root.eventMode = "static";
    root.cursor = "pointer";
    root.zIndex = isSelf ? 30 : 15;

    // Animated soft halo ring
    const pulseRing = new PIXI.Graphics();
    pulseRing.lineStyle(2, colorHex, 0.75);
    pulseRing.drawCircle(0, 0, radius + 3);
    pulseRing.position.set(0, circleY);

    // Pin frame + pointer tip at exact token center (0, 0)
    const frameG = new PIXI.Graphics();
    const drawFrame = (hover) => {
      frameG.clear();
      // Drop shadow
      frameG.beginFill(0x000000, 0.55);
      frameG.drawCircle(0, circleY + 2.5, radius + 3.5);
      frameG.endFill();

      // Teardrop pointer pointing down to (0, 0)
      frameG.beginFill(colorHex, hover ? 1.0 : 0.94);
      frameG.drawPolygon([
        -7, circleY + radius - 2,
        7, circleY + radius - 2,
        0, -1
      ]);
      frameG.endFill();

      // Exact center dot
      frameG.beginFill(0xffffff, 0.95);
      frameG.drawCircle(0, 0, 2.5);
      frameG.endFill();

      // Dark backing disc inside circle
      frameG.beginFill(0x14110d, 0.98);
      frameG.drawCircle(0, circleY, radius);
      frameG.endFill();

      // Outer contrast shadow rim + player-colored ring
      frameG.lineStyle(hover ? 3.5 : 2.8, colorHex, 1.0);
      frameG.drawCircle(0, circleY, radius + 0.5);

      if (isSelf) {
        frameG.lineStyle(1, 0xffffff, hover ? 0.65 : 0.35);
        frameG.drawCircle(0, circleY, radius - 2.2);
      }
    };
    drawFrame(false);

    // Pre-baked anti-aliased circular portrait sprite (no PIXI stencil mask artifacts at macro zoom!)
    const sprite = new PIXI.Sprite(PIXI.Texture.EMPTY);
    sprite.anchor.set(0.5, 0.5);
    sprite.position.set(0, circleY);
    const diam = (radius - 1.5) * 2;
    sprite.width = diam;
    sprite.height = diam;

    this._getCircularAvatarTexture(portraitSrc).then((tex) => {
      if (!tex || sprite.destroyed) return;
      sprite.texture = tex;
      sprite.width = diam;
      sprite.height = diam;
    }).catch(() => {});

    // Compact nameplate above circle
    const namePill = new PIXI.Container();
    const label = new PIXI.Text(name, new PIXI.TextStyle({
      fontFamily: "Signika, sans-serif",
      fontSize: isSelf ? 12.5 : 11.5,
      fontWeight: "700",
      fill: "#fff8eb",
      dropShadow: true,
      dropShadowColor: "#000000",
      dropShadowBlur: 2,
      dropShadowDistance: 1
    }));
    label.resolution = Math.min(2, window.devicePixelRatio || 2);
    label.anchor.set(0.5, 0.5);

    const pw = Math.max(36, label.width + 14);
    const ph = label.height + 6;
    const py = circleY - radius - ph * 0.5 - 6;

    const pillG = new PIXI.Graphics();
    pillG.lineStyle(1.2, colorHex, 0.9);
    pillG.beginFill(0x110e0b, 0.88);
    pillG.drawRoundedRect(-pw * 0.5, py - ph * 0.5, pw, ph, 5);
    pillG.endFill();

    label.position.set(0, py);
    namePill.addChild(pillG, label);
    namePill.visible = isSelf;

    root.addChild(pulseRing, frameG, sprite, namePill);
    root.hitArea = new PIXI.Rectangle(-(radius + 8), circleY - radius - 8, (radius + 8) * 2, radius * 2 + 24);

    // Off-screen edge indicator HTML element
    const edgeEl = document.createElement("button");
    edgeEl.type = "button";
    edgeEl.className = `boundless-char-edge${isSelf ? " is-self" : ""}`;
    edgeEl.style.setProperty("--bl-char-color", colorCss);
    edgeEl.style.display = "none";
    edgeEl.innerHTML = `
      <span class="boundless-char-edge-arrow"></span>
      <span class="boundless-char-edge-ring">
        <img class="boundless-char-edge-img" src="${escapeHtml(portraitSrc)}" alt="${escapeHtml(name)}" draggable="false">
      </span>
      <span class="boundless-char-edge-level-badge" style="display:none;"><i class="fa-solid fa-layer-group"></i></span>
      <span class="boundless-char-edge-tip">
        <span class="boundless-char-edge-name">${escapeHtml(name)}</span>
        <span class="boundless-char-edge-sub"></span>
      </span>
    `;
    const arrowEl = edgeEl.querySelector(".boundless-char-edge-arrow");
    const levelBadgeEl = edgeEl.querySelector(".boundless-char-edge-level-badge");
    const subEl = edgeEl.querySelector(".boundless-char-edge-sub");

    const entry = {
      ...target,
      root,
      pulseRing,
      frameG,
      drawFrame,
      namePill,
      edgeEl,
      arrowEl,
      levelBadgeEl,
      subEl,
      radius,
      hovered: false,
      worldVisible: false
    };

    root.on("pointerover", () => {
      entry.hovered = true;
      drawFrame(true);
      namePill.visible = true;
      root.zIndex = 600;
      this.container.sortDirty = true;
      this._applyPinScale(entry, canvas.stage?.scale?.x || 1);
    });

    root.on("pointerout", () => {
      entry.hovered = false;
      drawFrame(false);
      namePill.visible = isSelf;
      root.zIndex = isSelf ? 30 : 15;
      this.container.sortDirty = true;
      this._applyPinScale(entry, canvas.stage?.scale?.x || 1);
    });

    root.on("pointerdown", (ev) => {
      if (ev.button !== 0) return;
      ev.stopPropagation();
      this.focusEntry(entry, { instant: Boolean(ev.shiftKey) });
    });

    edgeEl.addEventListener("click", (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      this.focusEntry(entry, { instant: Boolean(ev.shiftKey) });
    });

    this.container.addChild(root);
    this.edgeLayerEl.appendChild(edgeEl);
    this.entries.push(entry);
  }

  _getCircularAvatarTexture(src) {
    if (!src) return Promise.resolve(null);
    if (this._avatarTexCache.has(src)) return this._avatarTexCache.get(src);
    const promise = bakeCircularAvatarTexture(src, 128).then((tex) => {
      if (tex) this._avatarTexOwned.push(tex);
      return tex;
    }).catch(() => null);
    this._avatarTexCache.set(src, promise);
    return promise;
  }

  _applyPinScale(entry, stageScale) {
    const inv = 1 / Math.max(stageScale, 0.0005);
    const boost = entry.hovered ? 1.12 : 1.0;
    entry.root.scale.set(inv * boost);
  }

  _stepPulse(delta) {
    if (!this.container?.visible || !this.entries.length) return;
    let anyVisible = false;
    for (const e of this.entries) {
      if (e.worldVisible) {
        anyVisible = true;
        break;
      }
    }
    if (!anyVisible) return;

    this._pulsePhase = (this._pulsePhase + (delta || 1) * 0.032) % (Math.PI * 2);
    const wave = (Math.sin(this._pulsePhase) + 1) * 0.5; // 0..1
    const ringScale = 1.0 + wave * 0.24;
    const ringAlpha = 0.55 * (1 - wave * 0.82);

    for (const e of this.entries) {
      if (!e.worldVisible) continue;
      e.pulseRing.scale.set(ringScale);
      e.pulseRing.alpha = ringAlpha;
      // Follow live animated token movement seamlessly
      const pos = getTokenWorldCenter(e.tokenDoc);
      e.root.position.set(pos.x, pos.y);
    }
  }

  _getSafeScreenBounds() {
    const now = performance.now();
    if (now - this._lastSidebarCheckMs > 250) {
      this._lastSidebarCheckMs = now;
      const sidebar = document.getElementById("sidebar");
      const sbRect = sidebar?.getBoundingClientRect?.();
      this._cachedRightInset = (sbRect && sbRect.width > 50) ? Math.round(sbRect.width + 32) : 44;
    }
    const sw = window.innerWidth || 1280;
    const sh = window.innerHeight || 720;
    return {
      left: 88,
      right: Math.max(200, sw - this._cachedRightInset),
      top: 66,
      bottom: Math.max(160, sh - 92),
      sw,
      sh
    };
  }

  updateViewport() {
    if (!this.enabled || !this.entries.length || !canvas?.stage) return;

    const stageScale = canvas.stage.scale?.x || 1;
    const wt = canvas.stage.worldTransform;
    const viewedLevelId = canvas.level?.id || null;
    const pivot = canvas.stage.pivot;
    const worldAlpha = smoothstep(CHAR_PIN_FADE_START, CHAR_PIN_FADE_FULL, stageScale);
    const safe = this._getSafeScreenBounds();
    const cx = (safe.left + safe.right) * 0.5;
    const cy = (safe.top + safe.bottom) * 0.5;
    const halfW = Math.max(40, (safe.right - safe.left) * 0.5);
    const halfH = Math.max(40, (safe.bottom - safe.top) * 0.5);

    let anyWorldVisible = false;
    const placedEdges = [];
    let otherLevelCount = 0;

    for (const entry of this.entries) {
      const doc = entry.tokenDoc;
      if (!doc || !doc.parent) {
        entry.root.visible = false;
        entry.worldVisible = false;
        entry.edgeEl.style.display = "none";
        continue;
      }

      const pos = getTokenWorldCenter(doc);
      entry.root.position.set(pos.x, pos.y);

      const isOtherLevel = Boolean(doc.level && viewedLevelId && doc.level !== viewedLevelId);

      if (isOtherLevel) {
        entry.root.visible = false;
        entry.worldVisible = false;
        const levelObj = canvas.scene?.levels?.get?.(doc.level);
        const levelName = levelObj?.name || loc("BOUNDLESS.CharPin.OtherLevel", "Другой уровень");
        const ex = safe.left + 8 + otherLevelCount * 56;
        const ey = safe.bottom - 6;
        otherLevelCount++;

        entry.edgeEl.style.display = "";
        entry.edgeEl.style.transform = `translate3d(${Math.round(ex)}px, ${Math.round(ey)}px, 0) translate(-50%, -50%)`;
        entry.edgeEl.classList.remove("tip-left", "tip-right", "tip-bottom");
        entry.edgeEl.classList.add("tip-right");
        entry.arrowEl.style.display = "none";
        entry.levelBadgeEl.style.display = "";
        entry.subEl.textContent = levelName;
        continue;
      }

      const sx = wt.a * pos.x + wt.tx;
      const sy = wt.d * pos.y + wt.ty;
      const inView = sx >= safe.left - 24 && sx <= safe.right + 24 && sy >= safe.top - 24 && sy <= safe.bottom + 24;

      if (inView) {
        entry.edgeEl.style.display = "none";
        if (worldAlpha > 0.01) {
          entry.root.visible = true;
          entry.worldVisible = true;
          entry.root.alpha = entry.hovered ? 1 : worldAlpha;
          this._applyPinScale(entry, stageScale);
          anyWorldVisible = true;
        } else {
          entry.root.visible = false;
          entry.worldVisible = false;
        }
      } else {
        // Off-screen: hide world pin, show sticky edge indicator pointing toward character
        entry.root.visible = false;
        entry.worldVisible = false;

        const dx = sx - cx;
        const dy = sy - cy;
        const angle = Math.atan2(dy, dx);
        const absDx = Math.abs(dx) || 1e-4;
        const absDy = Math.abs(dy) || 1e-4;
        const scaleEdge = Math.min(halfW / absDx, halfH / absDy);
        let ex = cx + dx * scaleEdge;
        let ey = cy + dy * scaleEdge;

        // Avoid stacking multiple off-screen indicators on top of each other
        for (const prev of placedEdges) {
          const d = Math.hypot(ex - prev.x, ey - prev.y);
          if (d < 54) {
            const onHorizontalEdge = Math.abs(ey - safe.top) < 6 || Math.abs(ey - safe.bottom) < 6;
            if (onHorizontalEdge) {
              ex = Math.max(safe.left, Math.min(safe.right, ex + 56));
            } else {
              ey = Math.max(safe.top, Math.min(safe.bottom, ey + 56));
            }
          }
        }
        placedEdges.push({ x: ex, y: ey });

        entry.edgeEl.style.display = "";
        entry.edgeEl.style.transform = `translate3d(${Math.round(ex)}px, ${Math.round(ey)}px, 0) translate(-50%, -50%)`;
        entry.arrowEl.style.display = "";
        entry.arrowEl.style.transform = `rotate(${angle}rad)`;
        entry.levelBadgeEl.style.display = "none";
        entry.subEl.textContent = formatWorldDistance(pos.x - (pivot?.x || 0), pos.y - (pivot?.y || 0));

        // Direct hover tooltip inward so it never clips off the viewport edge
        entry.edgeEl.classList.remove("tip-left", "tip-right", "tip-bottom");
        if (ex > cx + halfW * 0.55) {
          entry.edgeEl.classList.add("tip-left");
        } else if (ex < cx - halfW * 0.55) {
          entry.edgeEl.classList.add("tip-right");
        } else if (ey < cy) {
          entry.edgeEl.classList.add("tip-bottom");
        }
      }
    }

    if (this.container) {
      this.container.visible = anyWorldVisible;
    }
  }

  onTokenUpdated(doc, changes) {
    if (!this.enabled || !doc) return;
    const entry = this.entries.find(e => e.id === doc.id);
    if (!entry) {
      if ("actorId" in changes || "actorLink" in changes || "hidden" in changes) {
        this.scheduleRebuild();
      }
      return;
    }
    if ("texture" in changes || "name" in changes || "hidden" in changes) {
      this.scheduleRebuild();
      return;
    }
    if ("x" in changes || "y" in changes || "level" in changes || "width" in changes || "height" in changes) {
      this.updateViewport();
    }
  }

  onTokenCreatedOrDeleted() {
    this.scheduleRebuild();
  }

  onUserOrActorUpdated() {
    this.scheduleRebuild();
  }

  async focusEntry(entry, { instant = false, scale = FOCUS_TARGET_SCALE } = {}) {
    const doc = entry?.tokenDoc;
    if (!doc || !canvas?.ready) return false;

    const pos = getTokenWorldCenter(doc);
    const target = {
      x: pos.x,
      y: pos.y,
      levelId: doc.level || null,
      targetScale: scale
    };

    const completed = await this.controller?.poiManager?.flyTo?.(target, { instant, scale });
    if (!canvas?.ready) return Boolean(completed);

    // Ensure token placeable is mounted and control it for instant play
    try {
      this.controller?.tokenStreamer?.scheduleSync?.(this.controller.getViewportWorldRect(0.28), true);
      const tokObj = doc._object || canvas.tokens?.get?.(doc.id);
      if (tokObj && !tokObj.destroyed && tokObj.isOwner && (!doc.level || doc.level === canvas.level?.id)) {
        tokObj.control({ releaseOthers: true });
      }
    } catch {}

    this.updateViewport();
    return Boolean(completed);
  }

  async focusCharacter(userOrActorId = null, options = {}) {
    if (!this.entries.length) this.rebuild(canvas.scene);
    let entry = null;
    if (!userOrActorId) {
      entry = this.entries.find(e => e.isSelf) || this.entries[0] || null;
    } else {
      entry = this.entries.find(e =>
        e.id === userOrActorId ||
        e.actor?.id === userOrActorId ||
        e.user?.id === userOrActorId ||
        e.name?.toLowerCase() === String(userOrActorId).toLowerCase()
      ) || null;
    }
    if (!entry) return false;
    return this.focusEntry(entry, options);
  }

  unmount() {
    if (this._tickerFn) {
      canvas.app?.ticker?.remove?.(this._tickerFn);
      this._tickerFn = null;
    }
    if (this.container) {
      this.container.parent?.removeChild(this.container);
      this.container.destroy({ children: true });
      this.container = null;
    }
    if (this.edgeLayerEl) {
      this.edgeLayerEl.remove();
      this.edgeLayerEl = null;
    }
    for (const tex of this._avatarTexOwned) {
      try { tex.destroy(true); } catch {}
    }
    this._avatarTexOwned = [];
    this._avatarTexCache.clear();
    this.entries = [];
  }
}
