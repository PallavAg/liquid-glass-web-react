# liquid-glass-web-react

Apple-style liquid glass for React — a lens that refracts **live DOM**.

[![CI](https://github.com/PallavAg/liquid-glass-web-react/actions/workflows/ci.yml/badge.svg)](https://github.com/PallavAg/liquid-glass-web-react/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/liquid-glass-web-react)](https://www.npmjs.com/package/liquid-glass-web-react)
[![license](https://img.shields.io/npm/l/liquid-glass-web-react?v=1)](./LICENSE)

<img width="480" height="286" alt="demo2" src="https://github.com/user-attachments/assets/041d6bf7-fded-4d73-912c-d439591e74a4" />

## Demo
https://agpallav.com/liquid-glass

## Universal
Most liquid-glass libraries lean on an SVG `backdrop-filter`, which only works in Chromium.
**liquid-glass-web-react** generates a displacement map on the fly and feeds it to an SVG `feDisplacementMap`
filter applied to the content itself, so it works in **Chrome, Safari, and Firefox**, desktop and
mobile, with no flags and no fallbacks.

- **Live content** — the lens bends pixels the browser already painted. Text stays selectable,
  links stay clickable, video keeps playing.
- **Fast to animate** — moving the lens only shifts the filter region. The map regenerates only
  when the lens changes *shape*, never when it changes *place*.
- **Tiny** — zero dependencies, tree-shakeable, ~5 kB min+gzip.
- **Implementation** - inspired by Aave's excellent [writeup](https://aave.com/design/building-glass-for-the-web).

## Installation

```sh
npm install liquid-glass-web-react
```

## Quick start

```tsx
import { LiquidGlass } from "liquid-glass-web-react";

<LiquidGlass draggable>
  <img src="https://picsum.photos/id/1015/1200/700" />
</LiquidGlass>;
```

That's it — a draggable glass lens over your content. Everything is customizable:

```tsx
<LiquidGlass
  x={0.3}                    // lens center, fraction of the container
  y={0.5}
  width={200}                // lens size in px
  height={140}
  radius={48}                // corner radius ("auto" = pill)
  strength={0.12}            // refraction strength
  chromaticAberration={0.3}  // color fringing at the edges
  curvature={0.8}            // 0 = flat profile, 1 = spherical dome
  glow={0.15}                // inner specular glow
  edgeHighlight={0.3}        // bright rim
>
  <Dashboard />
</LiquidGlass>
```

### As a selection indicator

The lens makes a great moving highlight — drive `x` from state (or animate it through the
imperative handle for zero re-renders):

```tsx
const lens = useRef<LiquidGlassHandle>(null);

<LiquidGlass ref={lens} x={(selected + 0.5) / options.length} width={104} height={46}>
  <ToggleGroup options={options} onSelect={setSelected} />
</LiquidGlass>;

// per-frame, bypassing React:
lens.current?.setPosition(x, 0.5);
```

### Without React

The React component is a thin wrapper over `LiquidGlassEngine`, which is plain DOM:

```ts
import { LiquidGlassEngine } from "liquid-glass-web-react";

const engine = new LiquidGlassEngine({ container, filtered, defsHost });
engine.setPosition(0.5, 0.5);
engine.setOptions({ width: 200, strength: 0.12 });
```

## API

### `<LiquidGlass>` props

All props are optional.

| Prop | Type | Default | Description |
| --- | --- | --- | --- |
| `x`, `y` | `number` | `0.5` | Lens center as a fraction of the container (0–1). |
| `width`, `height` | `number` | `160`, `120` | Lens size in px. |
| `radius` | `number \| "auto"` | `"auto"` | Corner radius in px; `"auto"` is a full pill. |
| `strength` | `number` | `0.1` | Refraction strength (fraction of container size). |
| `chromaticAberration` | `number` | `0.2` | Per-channel scale offset, 0–1. |
| `blur` | `number` | `0` | Blur of the refracted content, px. |
| `depth` | `number` | `10` | Width of the refracting edge band, px. |
| `curvature` | `number` | `0.65` | Lens profile: 0 linear → 1 spherical dome. |
| `splay` | `number` | `1` | Keeps edge refraction perpendicular to the edge, 0–1. |
| `glow` | `number` | `0.1` | Inner specular glow, 0–1. |
| `edgeHighlight` | `number` | `0.25` | Bright rim along the lens edge, 0–1. |
| `specular` | `number` | `1` | Master intensity of the specular pass. |
| `specularAngle` | `number` | `45` | Light direction, degrees. |
| `draggable` | `boolean` | `false` | Let the user drag the lens. |
| `shadow` | `boolean \| string` | `true` | Lens drop shadow; pass a `box-shadow` string to customize. |
| `quality` | `number` | `512` | Displacement map resolution. |
| `onMove` | `(x, y) => void` | — | Fires as the lens moves. |
| `onMapGenerated` | `(url) => void` | — | Fires with the map PNG data URL on regeneration. |

Plus any `<div>` prop (`className`, `style`, …). The component renders a
`position: relative` wrapper around your children.

### Imperative handle

`ref` exposes `{ element, engine, setPosition(x, y) }`. `setPosition` is safe to call once per
frame; it never regenerates the map and never re-renders React.

### Low-level exports

`LiquidGlassEngine`, `computeDisplacementMap`, `renderDisplacementMap`, `DEFAULT_OPTIONS` — for
custom renderers (e.g. WebGL) or non-React use.

## How it works

1. A small PNG **displacement map** is computed from the lens geometry: red/green channels encode
   how far each pixel bends, blue carries a baked specular highlight, and alpha is the exact lens
   shape (used to clip the result, so blur and refraction follow the rounded geometry). Outside
   the lens the map is neutral, so those pixels don't move. The map has four-fold symmetry, so
   only a quarter of it is actually computed.
2. An SVG filter built around **`feDisplacementMap`** reads that map and bends the element's own
   painted pixels — three displacement taps at slightly different scales produce the chromatic
   fringe, a composite lifts the blue channel into a highlight, and the lens shape is composited
   over the untouched original.
3. Moving the lens only updates the filter's subregion attributes in place, which is why dragging
   holds a steady frame rate. On Safari/WebKit the filter also gets a fresh ID per update —
   Safari caches filter output by ID and would otherwise serve stale frames.

The technique follows Aave's excellent write-up,
[Building Glass for the Web](https://aave.com/design/building-glass-for-the-web).

## Notes & limitations

- **SSR**: safe with Next.js/Remix — all DOM work happens in effects. The bundle is marked
  `"use client"`.
- **Safari** caps the size of the source an SVG filter can process. Very large refracted
  containers (several thousand px) may degrade; keep the glass on reasonably sized regions.
  The engine logs a one-time console warning on Safari when an element is big enough to risk it.
- **iOS** misplaces filter subregions expressed in `objectBoundingBox` units, so the engine
  automatically switches to `userSpaceOnUse` units there. No configuration needed; `strength`
  means the same thing on every platform.
- **`<video>` in Safari** never reaches the SVG filter pipeline (a WebKit limitation). Refracting
  live video there requires a WebGL renderer — `computeDisplacementMap` is exported so you can
  feed the same map to your own shader.
- A lens that needs to look right over *moving* content benefits from more `edgeHighlight` and
  `glow` to stay legible.

## Development

```sh
npm install
npm run dev    # playground at localhost:5173
npm test       # unit tests for the map math
npm run build  # esm + cjs + d.ts to dist/
```

## License

[MIT](./LICENSE)
