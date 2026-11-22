import test from "node:test";
import assert from "node:assert/strict";
import { installFoundryMocks } from "./helpers/foundry-mock.mjs";

installFoundryMocks();

const {
  mergeEditsIntoLevelSpec,
  extractNativeDocsFromLevelSpec,
  bakeSceneEditsToManifest,
  virtualWallToDocData,
  virtualLightToDocData,
  virtualSoundToDocData,
  virtualTileToDocData
} = await import("../scripts/scene-baker.mjs");

test("mergeEditsIntoLevelSpec applies edits, deletions, door conversions, re-bucketing, and native absorption", () => {
  const baseSpec = {
    worldPx: 10000,
    simGrid: 4,
    simSectorPx: 2500,
    tiles: [
      { src: "props/table.webp", x: 500, y: 500, w: 200, h: 200, anchorX: 0.5, anchorY: 0.5, minZ: 4 },
      { src: "props/trash.webp", x: 800, y: 800, w: 100, h: 100, anchorX: 0.5, anchorY: 0.5 }
    ],
    sectors: {
      "0_0": {
        w: [
          [100, 100, 300, 100, 20, 20, 20, 20, 0], // converted to door + moved to sector 2_0
          [400, 400, 500, 400, 20, 20, 20, 20, 0]  // deleted
        ],
        d: [
          [200, 200, 300, 200, 1, 0] // kept
        ],
        l: [
          [150, 150, 40, 20, "#ffaa00", 0.5, "torch", 6, { speed: 5, attenuation: 0.7 }] // edited & moved to 1_1
        ],
        s: [
          [300, 300, 25, "audio/fire.ogg", 0.7, true, true, 0, 1, 5] // deleted
        ],
        t: [0, 1],
        o: ["house_1"]
      }
    }
  };

  const { spec, counts } = mergeEditsIntoLevelSpec(baseSpec, {
    levelId: "lvl1",
    baseElevation: 0,
    wallEdits: {
      "0_0:w:0": { c: [5100, 100, 5300, 100], move: 20, sight: 20, light: 20, sound: 20, dir: 0, door: 1, ds: 2, doorSound: "wood" },
      "0_0:w:1": null
    },
    lightEdits: {
      "0_0:l:0": { x: 3000, y: 3000, dim: 60, bright: 30, color: "#00ccff", alpha: 0.8, anim: "pulse", speed: 6, intensity: 4, attenuation: 0.3, luminosity: 0.65, coloration: 2 }
    },
    soundEdits: {
      "0_0:s:0": null
    },
    tileEdits: {
      "t:0": { src: "props/table_v2.webp", x: 6000, y: 6000, w: 200, h: 200, anchorX: 0.5, anchorY: 0.5, elevation: 5 },
      "t:1": null
    },
    nativeSpatial: {
      sectors: {
        "3_3": {
          w: [[8000, 8000, 8200, 8000, 20, 20, 20, 20, 0]],
          d: [],
          l: [],
          s: [[8100, 8100, 30, "audio/wind.ogg", 0.5, true, true, 0, 1, 5]],
          t: [],
          o: []
        }
      },
      tiles: []
    }
  });

  // 1 kept door + 1 wall converted to door + 1 native wall = 3 walls total
  assert.equal(counts.walls, 3);
  assert.equal(counts.lights, 1);
  assert.equal(counts.sounds, 1);
  assert.equal(counts.tiles, 1);

  // Overlay reference in 0_0 preserved; converted door moved into 2_0
  assert.deepEqual(spec.sectors["0_0"].o, ["house_1"]);
  assert.equal(spec.sectors["0_0"].w.length, 0);
  assert.equal(spec.sectors["0_0"].d.length, 1);
  assert.equal(spec.sectors["2_0"].d.length, 1);
  assert.equal(spec.sectors["2_0"].d[0][4], 1); // door type
  assert.equal(spec.sectors["2_0"].d[0][5], 2); // locked ds
  assert.equal(spec.sectors["2_0"].d[0][6].doorSound, "wood");

  // Light moved to 1_1 with full 9th-element style preserved
  assert.equal(spec.sectors["1_1"].l.length, 1);
  assert.equal(spec.sectors["1_1"].l[0][6], "pulse");
  assert.equal(spec.sectors["1_1"].l[0][8].speed, 6);
  assert.equal(spec.sectors["1_1"].l[0][8].coloration, 2);

  // Tile preserved minZ metadata from raw spec and re-indexed into sector 2_2
  assert.equal(spec.tiles[0].src, "props/table_v2.webp");
  assert.equal(spec.tiles[0].minZ, 4);
  assert.deepEqual(spec.sectors["2_2"].t, [0]);

  // Native wall + sound absorbed into 3_3
  assert.equal(spec.sectors["3_3"].w.length, 1);
  assert.equal(spec.sectors["3_3"].s.length, 1);
});

test("extractNativeDocsFromLevelSpec restores Foundry v14 document schemas accurately", () => {
  const spec = {
    worldPx: 4000,
    simGrid: 2,
    simSectorPx: 2000,
    tiles: [
      { src: "tiles/rug.webp", x: 100, y: 200, w: 300, h: 200, rot: 45, occlusionMode: ["FADE", "RADIAL"], restrictsLight: true }
    ],
    sectors: {
      "0_0": {
        w: [[10, 20, 30, 40, 20, 20, 20, 20, 1, { threshold: { light: 10, sight: 15, attenuation: true } }]],
        d: [[50, 60, 70, 80, 1, 0]],
        l: [[400, 500, 30, 15, "#ff8844", 0.6, "chroma", 12, { angle: 90, rotation: 180, speed: 7, intensity: 4, attenuation: 0.25, luminosity: 0.8, coloration: 3 }]],
        s: [[600, 700, 40, "audio/tavern.ogg", 0.8, false, true, 0.2, 0.9, 10, { hidden: true }]]
      }
    }
  };

  const extracted = extractNativeDocsFromLevelSpec(spec, {
    levelId: "srcLvl",
    targetLevelId: "dstLvl",
    baseElevation: 10,
    doorStates: { "srcLvl:0_0:0": 1 }
  });

  assert.equal(extracted.walls.length, 2);
  assert.deepEqual(extracted.walls[0].levels, ["dstLvl"]);
  assert.equal(extracted.walls[0].threshold.light, 10);
  // Door inherited live open state ds = 1
  assert.equal(extracted.walls[1].door, 1);
  assert.equal(extracted.walls[1].ds, 1);

  assert.equal(extracted.lights.length, 1);
  const l = extracted.lights[0];
  assert.equal(l.rotation, 180);
  assert.equal(l.config.angle, 90);
  assert.equal(l.config.attenuation, 0.25);
  assert.equal(l.config.luminosity, 0.8);
  assert.equal(l.config.coloration, 3);
  assert.deepEqual(l.config.animation, { type: "chroma", speed: 7, intensity: 4 });

  assert.equal(extracted.sounds.length, 1);
  assert.equal(extracted.sounds[0].hidden, true);
  assert.deepEqual(extracted.sounds[0].darkness, { min: 0.2, max: 0.9 });

  // Raw tile without anchorX/anchorY converts top-left (100, 200) -> center pivot (250, 300)
  assert.equal(extracted.tiles.length, 1);
  assert.equal(extracted.tiles[0].x, 250);
  assert.equal(extracted.tiles[0].y, 300);
  assert.equal(extracted.tiles[0].texture.anchorX, 0.5);
  assert.equal(extracted.tiles[0].restrictions.light, true);
});

test("bakeSceneEditsToManifest handles per-level manifestUrl inheriting scene.flags.boundless.enabled (Kartograf layout)", async () => {
  const prevFetch = globalThis.fetch;
  const prevFP = globalThis.FilePicker;
  const prevUser = globalThis.game.user;
  const uploaded = new Map();
  const manifests = {
    "maps/estate/m0.json": {
      worldPx: 4000,
      simGrid: 2,
      simSectorPx: 2000,
      tiles: [],
      sectors: { "0_0": { w: [], d: [], l: [[100, 100, 20, 10, "#ffaa00", 0.5, ""]], s: [], t: [], o: [] } }
    },
    "maps/estate/m1.json": {
      worldPx: 4000,
      simGrid: 2,
      simSectorPx: 2000,
      tiles: [],
      sectors: { "0_0": { w: [], d: [], l: [[500, 500, 30, 15, "#ffc870", 0.4, "torch"]], s: [], t: [], o: [] } }
    }
  };

  try {
    globalThis.game.user = { isGM: true };
    globalThis.fetch = async (url) => {
      const clean = String(url).split("?")[0];
      const data = manifests[clean];
      if (!data) return { ok: false, status: 404 };
      return { ok: true, json: async () => structuredClone(data) };
    };
    globalThis.FilePicker = {
      createDirectory: async () => {},
      browse: async () => {},
      upload: async (_src, dir, file) => {
        const text = await file.text();
        const path = `${dir}/${file.name}`;
        uploaded.set(path, JSON.parse(text));
        return { path };
      }
    };
    globalThis.foundry.applications = { apps: { FilePicker: globalThis.FilePicker } };

    let scenePatch = null;
    const levels = [
      { id: "lvl0", name: "Basement", elevation: { bottom: 0, top: 9, base: 0 }, flags: { boundless: { manifestUrl: "maps/estate/m0.json?v=1" } } },
      { id: "lvl1", name: "Floor 1", elevation: { bottom: 10, top: 19, base: 10 }, flags: { boundless: { manifestUrl: "maps/estate/m1.json?v=1" } } }
    ];
    const scene = {
      id: "scEstate",
      name: "Estate",
      levels,
      flags: {
        boundless: {
          enabled: true,
          manifestUrl: "maps/estate/m0.json?v=1",
          lightEdits: {
            lvl1: {
              "0_0:l:0": { x: 600, y: 600, dim: 45, bright: 20, color: "#00ffff", alpha: 0.7, anim: "pulse", elevation: 16 }
            }
          }
        }
      },
      async update(patch) { scenePatch = patch; },
      async deleteEmbeddedDocuments() {}
    };
    const controller = {
      manifestCache: new Map([["maps/estate/m0.json?v=1", {}], ["maps/estate/m1.json?v=1", {}]]),
      lightBatch: { clearPolyCacheDB: async () => {} },
      collectLevelSpatialData: () => ({ sectors: {}, tiles: [], tileIdsToDelete: [], wallIdsToDelete: [], lightIdsToDelete: [], soundIdsToDelete: [] }),
      mount: async () => {}
    };

    const res = await bakeSceneEditsToManifest(controller, scene, { absorbNative: false });
    assert.equal(res.levelsBaked, 2);
    assert.ok(uploaded.has("maps/estate/m0.json"));
    assert.ok(uploaded.has("maps/estate/m1.json"));
    // Floor 1 edit was actually merged into m1.json and cleared from scene flags
    assert.equal(uploaded.get("maps/estate/m1.json").sectors["0_0"].l[0][0], 600);
    assert.equal(uploaded.get("maps/estate/m1.json").sectors["0_0"].l[0][6], "pulse");
    assert.equal(scenePatch["flags.boundless.lightEdits.-=lvl1"], null);
    assert.equal(controller.manifestCache.size, 0);
  } finally {
    globalThis.fetch = prevFetch;
    globalThis.FilePicker = prevFP;
    globalThis.game.user = prevUser;
  }
});
