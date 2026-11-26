import { getEffectiveScale, getLevelBaseElevation, hasTokenPermissionLazy, hasPlayerOwnerLazy } from "./utils.mjs";

const SOUND_PAD_WORLD_PX = 1600;
const SOUND_VP_MIN_SCALE = 0.25;

export class MegaAudioStreamer {
  activeSources = new Map(); // "${levelId}::${sk}_${si}" -> PointSoundSource
  lastKey = null;

  update(visibleLevelLayers, vp, resolveSoundFn = null, soundEditsMap = globalThis.Boundless?.soundEdits) {
    if (!canvas?.ready || !canvas.sounds) return;
    if (!visibleLevelLayers?.length) {
      if (this.activeSources.size > 0) this.unmount();
      return;
    }
    const SoundSourceCls = foundry.canvas?.sources?.PointSoundSource;
    if (!SoundSourceCls) return;

    // Fast O(1) bailout on maps with zero virtual sounds (avoids token/sector scans on every pan)
    let hasAnySounds = false;
    let maxSoundRadPx = SOUND_PAD_WORLD_PX;
    const editRev = globalThis.Boundless?.soundEditsRev || 0;
    const pxPerFtPre = (canvas.dimensions?.size || 100) / Math.max(0.001, Number(canvas.dimensions?.distance) || 5);
    for (let i = 0; i < visibleLevelLayers.length; i++) {
      const l = visibleLevelLayers[i];
      const sectors = l?.spec?.sectors;
      if (!sectors) continue;
      if (l._hasVirtualSoundsRev !== editRev || l._hasVirtualSoundsRef !== sectors) {
        let found = false;
        let maxR = 0;
        for (const k in sectors) {
          const sl = sectors[k]?.s;
          if (sl?.length > 0) {
            found = true;
            for (let si = 0; si < sl.length; si++) {
              const r = Number(sl[si]?.[2]);
              if (Number.isFinite(r) && r > maxR) maxR = r;
            }
          }
        }
        const lvlEdits = soundEditsMap?.get?.(l.level?.id);
        if (lvlEdits?.size) {
          for (const ov of lvlEdits.values()) {
            if (!ov || ov.hidden) continue;
            found = true;
            const r = Number(ov.radius);
            if (Number.isFinite(r) && r > maxR) maxR = r;
          }
        }
        l._hasVirtualSounds = found;
        l._maxSoundRadiusUnits = maxR;
        l._hasVirtualSoundsRev = editRev;
        l._hasVirtualSoundsRef = sectors;
      }
      if (l._hasVirtualSounds) {
        hasAnySounds = true;
        const rPx = (l._maxSoundRadiusUnits || 0) * pxPerFtPre + 200;
        if (rPx > maxSoundRadPx) maxSoundRadPx = rPx;
      }
    }
    if (!hasAnySounds && this.activeSources.size === 0) {
      this.lastKey = "";
      this._lastFastKey = "";
      return;
    }

    const pxPerFt = pxPerFtPre;
    const padPx = Math.min(8000, maxSoundRadPx);
    const darkness = canvas.environment?.darknessLevel ?? 0;

    // Collect listener anchor points (viewport only on tactical zoom or livePreview + all controlled/player tokens)
    const anchors = [];
    if (vp) {
      const vpScale = Number(vp.scale ?? canvas.stage?.scale?.x ?? 1);
      const effScale = getEffectiveScale(vpScale);
      if (effScale >= SOUND_VP_MIN_SCALE) {
        anchors.push({
          x0: vp.x0 - padPx,
          y0: vp.y0 - padPx,
          x1: vp.x1 + padPx,
          y1: vp.y1 + padPx,
          levelId: null
        });
      } else if (canvas.sounds.livePreview && canvas.mousePosition) {
        const mx = Number(canvas.mousePosition.x);
        const my = Number(canvas.mousePosition.y);
        if (Number.isFinite(mx) && Number.isFinite(my)) {
          anchors.push({
            x0: mx - padPx,
            y0: my - padPx,
            x1: mx + padPx,
            y1: my + padPx,
            levelId: canvas.level?.id || null
          });
        }
      }
    }
    for (const tok of canvas.tokens?.placeables || []) {
      if (!tok || tok.destroyed || !tok.center) continue;
      const doc = tok.document;
      const isActiveListener = tok.controlled || (
        game.user?.isGM
          ? Boolean(
              hasPlayerOwnerLazy(doc) ||
              (doc?._source?.delta?.ownership && game.users?.some?.(u => !u.isGM && hasTokenPermissionLazy(doc, u, "OWNER")))
            )
          : hasTokenPermissionLazy(doc, game.user, "OBSERVER")
      );
      if (!isActiveListener) continue;
      anchors.push({
        x0: tok.center.x - padPx,
        y0: tok.center.y - padPx,
        x1: tok.center.x + padPx,
        y1: tok.center.y + padPx,
        levelId: tok.document?.level || canvas.level?.id
      });
    }

    if (anchors.length === 0 && this.activeSources.size === 0) {
      this.lastKey = "";
      this._lastFastKey = "";
      return;
    }

    // Fast quantized early-exit on 120 FPS panning: skip full sector/Map/sort rebuild when listener grid cells are unchanged
    let attachedCount = 0;
    for (const src of this.activeSources.values()) {
      if (src?.attached !== false) attachedCount++;
    }
    let fastKey = `${Number(darkness.toFixed(4))}|${globalThis.Boundless?.soundEditsRev || 0}|${this.activeSources.size}:${attachedCount}|${visibleLevelLayers.length}`;
    for (let i = 0; i < visibleLevelLayers.length; i++) {
      fastKey += `,${visibleLevelLayers[i]?.level?.id || ""}`;
    }
    for (let i = 0; i < anchors.length; i++) {
      const a = anchors[i];
      fastKey += `;${a.levelId || ""}:${Math.floor(a.x0 / 500)}:${Math.floor(a.y0 / 500)}:${Math.floor(a.x1 / 500)}:${Math.floor(a.y1 / 500)}`;
    }
    if (this.lastKey !== null && this._lastFastKey === fastKey) return;

    const needed = new Map(); // soundKey -> { layer, item }

    for (const layer of visibleLevelLayers) {
      const sectors = layer.spec?.sectors;
      if (!sectors) continue;
      const { simGrid, simSectorPx, level } = layer;
      const lid = level?.id;
      if (!lid || !Number.isFinite(simSectorPx) || simSectorPx <= 0 || !Number.isFinite(simGrid) || simGrid <= 0) continue;
      const visitedSectors = new Set();

      for (const a of anchors) {
        if (a.levelId && a.levelId !== lid) continue;
        const sx0 = Math.max(0, Math.floor(a.x0 / simSectorPx));
        const sy0 = Math.max(0, Math.floor(a.y0 / simSectorPx));
        const sx1 = Math.min(simGrid - 1, Math.floor(a.x1 / simSectorPx));
        const sy1 = Math.min(simGrid - 1, Math.floor(a.y1 / simSectorPx));
        for (let sy = sy0; sy <= sy1; sy++) {
          for (let sx = sx0; sx <= sx1; sx++) {
            const sk = `${sx}_${sy}`;
            if (visitedSectors.has(sk)) continue;
            visitedSectors.add(sk);
            const list = sectors[sk]?.s;
            if (!list?.length) continue;
            for (let si = 0; si < list.length; si++) {
              const raw = list[si];
              const item = resolveSoundFn
                ? resolveSoundFn(lid, sk, si, raw, level)
                : {
                    x: raw[0], y: raw[1], radius: Number.isFinite(raw[2]) ? raw[2] : 20, path: raw[3],
                    volume: raw[4] ?? 0.6, walls: raw[5] !== false, easing: raw[6] !== false,
                    darkMin: raw[7] ?? 0, darkMax: raw[8] ?? 1,
                    elevation: Number.isFinite(raw[9]) ? raw[9] : (getLevelBaseElevation(level) + 5),
                    hidden: Boolean(raw[10]?.hidden)
                  };
              if (!item || !item.path || item.hidden) continue;
              const radiusFt = Number.isFinite(item.radius) ? item.radius : 20;
              if (radiusFt <= 0) continue;
              if (darkness < item.darkMin || darkness > item.darkMax) continue;
              needed.set(`${lid}::${sk}_${si}`, { layer, item });
            }
          }
        }
      }

      // Include sounds edited and dragged outside their original home sector into an active listener anchor
      const lvlSoundEdits = soundEditsMap?.get?.(lid);
      if (lvlSoundEdits?.size && anchors.length > 0) {
        for (const [sKey, ov] of lvlSoundEdits) {
          if (!ov) continue;
          const parts = sKey.split(":");
          if (parts.length !== 3) continue;
          const [sk, , idxStr] = parts;
          if (visitedSectors.has(sk)) continue;
          const si = Number(idxStr);
          const raw = sectors[sk]?.s?.[si] ?? null;
          const item = resolveSoundFn
            ? resolveSoundFn(lid, sk, si, raw, level)
            : {
                x: ov.x, y: ov.y, radius: Number.isFinite(ov.radius) ? ov.radius : 20, path: ov.path || "",
                volume: ov.volume ?? 0.6, walls: ov.walls !== false, easing: ov.easing !== false,
                darkMin: ov.darkMin ?? 0, darkMax: ov.darkMax ?? 1,
                elevation: Number.isFinite(ov.elevation) ? ov.elevation : (getLevelBaseElevation(level) + 5),
                hidden: Boolean(ov.hidden)
              };
          if (!item || !item.path || item.hidden) continue;
          const radiusFt = Number.isFinite(item.radius) ? item.radius : 20;
          if (radiusFt <= 0) continue;
          if (darkness < item.darkMin || darkness > item.darkMax) continue;
          const rPx = radiusFt * pxPerFt;
          let inAnchor = false;
          for (let ai = 0; ai < anchors.length; ai++) {
            const a = anchors[ai];
            if (a.levelId && a.levelId !== lid) continue;
            if (item.x + rPx >= a.x0 && item.x - rPx <= a.x1 && item.y + rPx >= a.y0 && item.y - rPx <= a.y1) {
              inAnchor = true;
              break;
            }
          }
          if (inAnchor) needed.set(`${lid}::${sk}_${si}`, { layer, item });
        }
      }
    }

    const entrySigs = new Map();
    const keyParts = [];
    for (const [k, { item }] of needed) {
      const s = `${item.x},${item.y},${item.radius},${item.volume},${item.path},${item.walls ? 1 : 0},${item.easing ? 1 : 0},${item.elevation}`;
      entrySigs.set(k, s);
      keyParts.push(`${k}:${s}`);
    }
    const key = keyParts.sort().join("|");
    if (this.lastKey !== null && key === this.lastKey && (key !== "" || this.activeSources.size === 0)) {
      this._lastFastKey = fastKey;
      return;
    }

    let changed = false;
    let complete = true;
    if (!this._sourceSigs) this._sourceSigs = new Map();

    for (const [k, src] of this.activeSources) {
      if (!needed.has(k)) {
        try { src.destroy(); } catch {}
        this.activeSources.delete(k);
        this._sourceSigs.delete(k);
        changed = true;
      }
    }

    for (const [k, { layer, item }] of needed) {
      const existing = this.activeSources.get(k);
      const itemSig = entrySigs.get(k);
      const radiusPx = (Number.isFinite(item.radius) ? item.radius : 20) * pxPerFt;
      if (existing) {
        if (this._sourceSigs.get(k) === itemSig && existing.attached !== false) {
          continue;
        }
        try {
          existing.initialize({
            x: item.x, y: item.y,
            level: layer.level.id,
            elevation: item.elevation,
            radius: radiusPx,
            walls: Boolean(item.walls),
            path: item.path,
            volume: item.volume,
            easing: Boolean(item.easing)
          });
          if (existing.shape && existing.attached === false) existing.add();
          if (existing.shape && existing.attached !== false) {
            this._sourceSigs.set(k, itemSig);
            changed = true;
          } else {
            try { existing.destroy(); } catch {}
            this.activeSources.delete(k);
            this._sourceSigs.delete(k);
            complete = false;
            changed = true;
          }
        } catch (err) {
          console.warn("boundless | Failed to update streamed sound:", item.path, err);
          try { existing.destroy(); } catch {}
          this.activeSources.delete(k);
          this._sourceSigs.delete(k);
          complete = false;
          changed = true;
        }
        continue;
      }
      let src = null;
      try {
        src = new SoundSourceCls({ sourceId: `MegaSound.${k}` });
        src.initialize({
          x: item.x, y: item.y,
          level: layer.level.id,
          elevation: item.elevation,
          radius: radiusPx,
          walls: Boolean(item.walls),
          path: item.path,
          volume: item.volume,
          easing: Boolean(item.easing)
        });
        if (src.shape) {
          src.add();
          if (src.attached !== false) {
            this.activeSources.set(k, src);
            this._sourceSigs.set(k, itemSig);
            changed = true;
          } else {
            try { src.destroy(); } catch {}
            complete = false;
          }
        } else {
          try { src.destroy(); } catch {}
          complete = false;
        }
      } catch (err) {
        console.warn("boundless | Failed to mount streamed sound:", item.path, err);
        if (src) { try { src.destroy(); } catch {} }
        complete = false;
      }
    }

    this.lastKey = complete ? key : null;
    this._lastFastKey = complete ? fastKey : null;

    if (changed) {
      canvas.perception?.update({ refreshSounds: true });
    }
  }

  unmount() {
    let hadAny = this.activeSources.size > 0;
    for (const src of this.activeSources.values()) {
      try { src.destroy(); } catch {}
    }
    this.activeSources.clear();
    this._sourceSigs?.clear?.();
    this._lastFastKey = null;
    this.lastKey = null;
    if (hadAny && canvas?.ready) {
      canvas.perception?.update({ refreshSounds: true });
    }
  }
}
