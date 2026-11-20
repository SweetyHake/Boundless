const SOUND_PAD_WORLD_PX = 1600;

export class MegaAudioStreamer {
  activeSources = new Map(); // "${levelId}::${sk}_${si}" -> PointSoundSource
  lastKey = "";

  update(visibleLevelLayers, vp, resolveSoundFn = null) {
    if (!canvas?.ready || !canvas.sounds || !visibleLevelLayers?.length) return;
    const SoundSourceCls = foundry.canvas?.sources?.PointSoundSource;
    if (!SoundSourceCls) return;

    const pxPerFt = canvas.dimensions.size / canvas.dimensions.distance;
    const darkness = canvas.environment?.darknessLevel ?? 0;

    // Collect listener anchor points (viewport center + all controlled/player tokens)
    const anchors = [];
    if (vp) {
      anchors.push({
        x0: vp.x0 - SOUND_PAD_WORLD_PX,
        y0: vp.y0 - SOUND_PAD_WORLD_PX,
        x1: vp.x1 + SOUND_PAD_WORLD_PX,
        y1: vp.y1 + SOUND_PAD_WORLD_PX,
        levelId: null
      });
    }
    for (const tok of canvas.tokens?.placeables || []) {
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
                    elevation: Number.isFinite(raw[9]) ? raw[9] : ((level.elevation?.base ?? 0) + 5)
                  };
              if (!item || !item.path) continue;
              if (darkness < item.darkMin || darkness > item.darkMax) continue;
              needed.set(`${lid}::${sk}_${si}`, { layer, item });
            }
          }
        }
      }
    }

    const key = Array.from(needed.entries())
      .map(([k, { item }]) => `${k}:${item.x},${item.y},${item.radius},${item.volume},${item.path}`)
      .sort()
      .join("|");
    if (key === this.lastKey) return;
    this.lastKey = key;

    let changed = false;

    for (const [k, src] of this.activeSources) {
      if (!needed.has(k)) {
        try { src.destroy(); } catch {}
        this.activeSources.delete(k);
        changed = true;
      }
    }

    for (const [k, { layer, item }] of needed) {
      const existing = this.activeSources.get(k);
      const radiusPx = (item.radius || 20) * pxPerFt;
      if (existing) {
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
        changed = true;
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
        src.add();
        this.activeSources.set(k, src);
        changed = true;
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
    this.lastKey = "";
    if (hadAny && canvas?.ready) {
      canvas.perception?.update({ refreshSounds: true });
    }
  }
}
