import { getEffectiveScale } from "./utils.mjs";

const SOUND_PAD_WORLD_PX = 1600;
const SOUND_VP_MIN_SCALE = 0.25;

export class MegaAudioStreamer {
  activeSources = new Map(); // "${levelId}::${sk}_${si}" -> PointSoundSource
  lastKey = "";

  update(visibleLevelLayers, vp, resolveSoundFn = null) {
    if (!canvas?.ready || !canvas.sounds) return;
    if (!visibleLevelLayers?.length) {
      if (this.activeSources.size > 0) this.unmount();
      return;
    }
    const SoundSourceCls = foundry.canvas?.sources?.PointSoundSource;
    if (!SoundSourceCls) return;

    const pxPerFt = (canvas.dimensions?.size || 100) / Math.max(0.001, Number(canvas.dimensions?.distance) || 5);
    const darkness = canvas.environment?.darknessLevel ?? 0;

    // Collect listener anchor points (viewport only on tactical zoom or livePreview + all controlled/player tokens)
    const anchors = [];
    if (vp) {
      const vpScale = Number(vp.scale ?? canvas.stage?.scale?.x ?? 1);
      const effScale = getEffectiveScale(vpScale);
      if (effScale >= SOUND_VP_MIN_SCALE) {
        anchors.push({
          x0: vp.x0 - SOUND_PAD_WORLD_PX,
          y0: vp.y0 - SOUND_PAD_WORLD_PX,
          x1: vp.x1 + SOUND_PAD_WORLD_PX,
          y1: vp.y1 + SOUND_PAD_WORLD_PX,
          levelId: null
        });
      } else if (canvas.sounds.livePreview && canvas.mousePosition) {
        const mx = Number(canvas.mousePosition.x);
        const my = Number(canvas.mousePosition.y);
        if (Number.isFinite(mx) && Number.isFinite(my)) {
          anchors.push({
            x0: mx - SOUND_PAD_WORLD_PX,
            y0: my - SOUND_PAD_WORLD_PX,
            x1: mx + SOUND_PAD_WORLD_PX,
            y1: my + SOUND_PAD_WORLD_PX,
            levelId: canvas.level?.id || null
          });
        }
      }
    }
    for (const tok of canvas.tokens?.placeables || []) {
      if (!tok || tok.destroyed || !tok.center) continue;
      const isActiveListener = tok.controlled || (!game.user?.isGM && tok.isOwner) || Boolean(tok.document?.hasPlayerOwner);
      if (!isActiveListener) continue;
      anchors.push({
        x0: tok.center.x - SOUND_PAD_WORLD_PX,
        y0: tok.center.y - SOUND_PAD_WORLD_PX,
        x1: tok.center.x + SOUND_PAD_WORLD_PX,
        y1: tok.center.y + SOUND_PAD_WORLD_PX,
        levelId: tok.document?.level || canvas.level?.id
      });
    }

    if (anchors.length === 0 && this.activeSources.size === 0) return;

    const needed = new Map(); // soundKey -> { layer, item }

    for (const layer of visibleLevelLayers) {
      const sectors = layer.spec?.sectors;
      if (!sectors) continue;
      const { simGrid, simSectorPx, level } = layer;
      const lid = level.id;

      for (const a of anchors) {
        if (a.levelId && a.levelId !== lid) continue;
        const sx0 = Math.max(0, Math.floor(a.x0 / simSectorPx));
        const sy0 = Math.max(0, Math.floor(a.y0 / simSectorPx));
        const sx1 = Math.min(simGrid - 1, Math.floor(a.x1 / simSectorPx));
        const sy1 = Math.min(simGrid - 1, Math.floor(a.y1 / simSectorPx));
        for (let sy = sy0; sy <= sy1; sy++) {
          for (let sx = sx0; sx <= sx1; sx++) {
            const sk = `${sx}_${sy}`;
            const list = sectors[sk]?.s;
            if (!list?.length) continue;
            for (let si = 0; si < list.length; si++) {
              const raw = list[si];
              const item = resolveSoundFn
                ? resolveSoundFn(lid, sk, si, raw, level)
                : {
                    x: raw[0], y: raw[1], radius: raw[2] || 20, path: raw[3],
                    volume: raw[4] ?? 0.6, walls: raw[5] !== false, easing: raw[6] !== false,
                    darkMin: raw[7] ?? 0, darkMax: raw[8] ?? 1,
                    elevation: Number.isFinite(raw[9]) ? raw[9] : ((level.elevation?.base ?? 0) + 5),
                    hidden: Boolean(raw[10]?.hidden)
                  };
              if (!item || !item.path || item.hidden) continue;
              if (darkness < item.darkMin || darkness > item.darkMax) continue;
              needed.set(`${lid}::${sk}_${si}`, { layer, item });
            }
          }
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
    if (key === this.lastKey) return;
    this.lastKey = key;

    let changed = false;
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
      const radiusPx = (item.radius || 20) * pxPerFt;
      if (existing) {
        if (this._sourceSigs.get(k) === itemSig && existing.attached) {
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
          if (existing.shape && !existing.attached) existing.add();
          this._sourceSigs.set(k, itemSig);
          changed = true;
        } catch (err) {
          console.warn("boundless | Failed to update streamed sound:", item.path, err);
          try { existing.destroy(); } catch {}
          this.activeSources.delete(k);
          this._sourceSigs.delete(k);
          changed = true;
        }
        continue;
      }
      try {
        const src = new SoundSourceCls({ sourceId: `MegaSound.${k}` });
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
          this.activeSources.set(k, src);
          this._sourceSigs.set(k, itemSig);
          changed = true;
        } else {
          try { src.destroy(); } catch {}
        }
      } catch (err) {
        console.warn("boundless | Failed to mount streamed sound:", item.path, err);
      }
    }

    if (changed) {
      canvas.perception.update({ refreshSounds: true });
    }
  }

  unmount() {
    let hadAny = this.activeSources.size > 0;
    for (const src of this.activeSources.values()) {
      try { src.destroy(); } catch {}
    }
    this.activeSources.clear();
    this._sourceSigs?.clear?.();
    this.lastKey = "";
    if (hadAny && canvas?.ready) {
      canvas.perception?.update({ refreshSounds: true });
    }
  }
}
