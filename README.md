# Boundless

Seamless giant-world streaming engine for **Foundry VTT v14+** (`500×500` to `6000×6000+` cells at 144 FPS).

## Features

- **Quadtree Tile Pyramid & Web Worker Pool**: Off-main-thread `createImageBitmap` WebP/PNG/JPG decoding with priority queues, `AbortController` cancellation, smooth crossfades, and strict VRAM LRU eviction.
- **Continental Chunked Streaming (`boundless-chunked-v1`)**: Lazy-loaded spatial chunks with LRU RAM/VRAM budgets, `superGrid` biome tinting, and orbital `macroLights`.
- **Shadowed GPU Lighting (`MegaLightBatch`)**: Wall-shadowed light baking with sector frustum culling, animated flicker, and multi-level depth-mask floor occlusion.
- **Active Sim-Bubble & Native Layer Editors**: Streams walls, doors (with network sync), lights, sounds, and tiles on demand around tokens and editor tools without bloating scene databases.
- **Chunked Fog of War**: High-detail 50×50-cell exploration chunks bypassing Foundry's 4096 px limit, integrated with native `DISABLED` / `INDIVIDUAL` / `SHARED` fog modes and a GM fog brush.
- **Macro Atmosphere & POI Fast-Travel**: Time-of-day altitude mist, drifting cloud layers, and cinematic Van Wijk & Nuij POI camera flights.
- **Client-Side Lazy TokenLayer**: Keeps 100% native `TokenDocument`s in `scene.tokens` (full compatibility with third-party modules) while time-slicing viewport `Token#draw()` within a `4.5 ms/frame` budget, zoom LOD, frustum culling, and client-only LRU placeable eviction.
