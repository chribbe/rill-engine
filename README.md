# Rill

A WebGPU renderer for realistic urban environments — the foundation of a future
web-based, AI-native, Hammer-like editor. Milestone 1: an engine test map that
proves crisp, stable, grounded and fast rendering in the browser.

See **[docs/ENGINE.md](docs/ENGINE.md)** for architecture, decisions,
measurements, known issues and next steps.

## Run

```bash
npm install
npm run dev
```

Open http://127.0.0.1:5173 in a WebGPU-capable desktop browser (Chrome 113+).
`?map=sandbox` loads a minimal builtin-primitive scene.

## Controls

| Key | Action |
|---|---|
| Click | capture mouse (raw pointer lock) |
| WASD / Shift / Alt | move / run / slow |
| Space | jump (fly: up) |
| F | toggle fly (Q/E down/up) |
| 1–4 | clear / overcast / foggy / dusk |
| V / Shift+V | cycle debug views |
| G / B | wireframe / bounding boxes |
| M | toggle MSAA |
| Tab / H | stats / playground UI |
| P | save screenshot |

The playground panel (top right) exposes sun, sky, fog, exposure, wetness,
grading, shadows, texture filtering, lightmap options, debug views, stress tests
and viewpoints.

## Content pipeline

Requires Blender 5.x at `/Applications/Blender.app` (or set `BLENDER`).

```bash
npm run textures        # procedural texture set -> public/textures
npm run map             # Blender builds the test map -> public/assets/testmap, public/maps/testmap/map.json
npm run bake -- --samples 256   # Cycles lightmap bake -> public/maps/testmap/lightmaps
```

All generated content is committed, so the app runs without Blender.
