# Changelog

## 1.2.0

- Add zero-config performance engine for all Foundry VTT v14 scenes: token UI layer batching, 2x sprite atlas for walls, control icons, doors, D&D 5e map location pins, and token status effects, precomputed Noise/FBM LUT for animated light shaders, CPU perception and drag optimization, standard-scene culling, and idle VRAM cleanup
- Match vanilla Foundry VTT v14 visuals 1-to-1 across wall lines, endpoints, control/door/pin/effect icons, 3-slice token resource bars, and native 1.0x lighting scale on High/Max modes
- Switch scene optimization and unbaking to an in-place single-scene workflow with lossless restoration of original background and foreground images
- Add IndexedDB light polygon cache (`poly-cache-db.mjs`), prebaked `bakedPolys`, idle adjacent-level prewarming, VRAM budget profiles, predictive tile prefetching, and manifest edit baking
- Add smart two-stage `Ctrl+A` selection, macro-zoom impostor box/click selection, and `O(K)` bulk selection batching
- Add full support for all 23 light animations and 4 darkness animations, smooth light-batch crossfading, and frame-budgeted tile/roof/door/token streaming
- Add built-in ABBA regression benchmark (`Boundless.perf.benchmark()`)
- Modularize core architecture and fix multi-level lighting, fog, visibility, WebGL context recovery, `ForcedDeletion` sync, and non-GM edge cases

## 1.1.3

- Add extended light parameter support (`speed`, `intensity`, `coloration`, `attenuation`, `luminosity`) for live lights, `MegaLightBatch`, light editor, and scene baker
- Add `dynamicLightMount` and `dynamicLightRetire` event bus hooks

## 1.1.2

- Add per-level `foreground` tile pyramid support (`foregroundPyramidBaseUrl`, sparse index, worker negative cache) and automatic foreground slicing in `scene-baker.mjs`
- Fix lower-level light bleed at max zoom-out (`z=0`) on multi-level scenes

## 1.1.1

- Optimize zoom and rendering for 144 FPS: eliminate `gl.readPixels` hover stalls, move LRU pruning to idle time, enable manual texture GC, cap worker roof decodes to 2048 px, and route static props through PIXI `batch`
- Add hidden lower-level opacity-mask culling and public `Boundless.on/off` event bus
- Fix `CanvasDepthMask` pooling (`pluginName = null`), door visibility at low zoom, and LOD thresholds

## 1.1.0

- Rename module to **Boundless** (`boundless`, `window.Boundless`) with automatic flag migration from `sh-megamap`
- Add Web Worker tile decoding pool (`createImageBitmap`, priority queue, `AbortController`, LRU VRAM eviction)
- Add client-side `Lazy TokenLayer` keeping 100% native `TokenDocument`s with viewport time-sliced `Token#draw()`, zoom LOD, and client-only LRU placeable eviction
- Add continental `superGrid` chunked streaming (`boundless-chunked-v1`), GPU `MegaLightBatch`, multi-level `Scene.levels` support, chunked Fog of War, macro atmosphere, POI fast-travel, ambient audio streaming, and native on-demand layer editors

## 1.0.0

- Initial giant-world (500×500) streaming prototype for Foundry VTT v14
