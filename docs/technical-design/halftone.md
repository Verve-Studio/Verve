# Technical Design: Halftone

## Overview

Halftone is a non-destructive real-time effect adjustment layer that simulates the dot-screen printing process used in offset and newspaper reproduction. It appears in the **Effects** menu alongside Bloom, Chromatic Aberration, Halation, Color Key, Drop Shadow, Glow, and Outline. It operates in two modes: **Color (CMYK)** renders four independent halftone screens (Cyan, Magenta, Yellow, Black) at the traditional printing angles (C=105°, M=75°, Y=90°, K=45°), and **B&W** renders a single grayscale screen at 45°. In both modes, non-dot pixels are transparent (alpha=0), enabling the effect to composite naturally over layers beneath it.

Structurally, Halftone is a **single-pass** GPU compute effect — no intermediate textures or multi-pass blur chain are required. It reads the pre-composited input texture, computes screen-rotated cell grids analytically per pixel, and writes the dot pattern directly to the output texture. This makes it cheaper to implement than bloom or drop-shadow but more shader-complex than a simple LUT-style adjustment.

---

## Affected Areas

| File | Change |
|---|---|
| `src/types/index.ts` | Add `'halftone'` to `AdjustmentType`; add `HalftoneParams` to `AdjustmentParamsMap`; add `HalftoneAdjustmentLayer` interface; extend `AdjustmentLayerState` union |
| `src/core/operations/adjustments/registry.ts` | Register `'halftone'` entry with `group: 'real-time-effects'` |
| `src/graphicspipeline/webgpu/types.ts` | Add `'halftone'` variant to `AdjustmentRenderOp` union |
| `src/graphicspipeline/webgpu/shaders/compute/adjustments/halftone.ts` | **New file** — WGSL compute shader |
| `src/graphicspipeline/webgpu/shaders/shaders.ts` | Re-export `HALFTONE_COMPUTE` |
| `src/graphicspipeline/webgpu/AdjustmentEncoder.ts` | Import shader; declare `halftonePipeline` field; register pipeline in constructor; add dispatch branch in `encode()` |
| `src/ux/main/Canvas/canvasPlan.ts` | Add `'halftone'` branch in `buildAdjustmentEntry()` |
| `src/ux/windows/effects/HalftoneOptions/HalftoneOptions.tsx` | **New file** — panel component |
| `src/ux/windows/effects/HalftoneOptions/HalftoneOptions.module.scss` | **New file** — panel styles |
| `src/ux/index.ts` | Export `HalftoneOptions` |

The unified rasterization pipeline, `useAdjustments`, and the Effects menu wiring require **no changes** beyond what the registry entry and the types/encoder changes already provide.

---

## State Changes

### `src/types/index.ts`

**1. Extend `AdjustmentType`** — add `'halftone'` after `'outline'`:

```ts
export type AdjustmentType =
  | /* ...existing members... */
  | 'outline'
  | 'halftone'
```

**2. Add `HalftoneParams` to `AdjustmentParamsMap`:**

```ts
'halftone': {
  /** Rendering mode. 'color' renders 4 CMYK screens; 'bw' renders a single grayscale screen. Default: 'color' */
  mode:     'color' | 'bw'
  /** Grid density in cells per 100 canvas pixels. Range 2–50. Default: 10 */
  frequency: number
  /** Cyan channel dot-size offset, −50 to +50 (%). Default: 0 */
  offsetC:   number
  /** Magenta channel dot-size offset, −50 to +50 (%). Default: 0 */
  offsetM:   number
  /** Yellow channel dot-size offset, −50 to +50 (%). Default: 0 */
  offsetY:   number
  /** Black channel dot-size offset, −50 to +50 (%). Default: 0 */
  offsetK:   number
}
```

**3. Add `HalftoneAdjustmentLayer` interface** (identical pattern to other effect layers):

```ts
export interface HalftoneAdjustmentLayer extends AdjustmentLayerBase {
  adjustmentType: 'halftone'
  params: AdjustmentParamsMap['halftone']
  hasMask: boolean
}
```

**4. Extend `AdjustmentLayerState` union** — add `HalftoneAdjustmentLayer` after `OutlineAdjustmentLayer`:

```ts
export type AdjustmentLayerState =
  | /* ...existing members... */
  | OutlineAdjustmentLayer
  | HalftoneAdjustmentLayer
```

---

## Registry Entry

### `src/core/operations/adjustments/registry.ts`

Add after the `'outline'` entry (at the bottom of the `ADJUSTMENT_REGISTRY` array, before the closing bracket):

```ts
{
  adjustmentType: 'halftone' as const,
  label: 'Halftone…',
  group: 'real-time-effects',
  defaultParams: {
    mode:      'color' as const,
    frequency: 10,
    offsetC:   0,
    offsetM:   0,
    offsetY:   0,
    offsetK:   0,
  },
},
```

---

## WGSL Shader Design

### File: `src/graphicspipeline/webgpu/shaders/compute/adjustments/halftone.ts`

The shader is a single `@compute @workgroup_size(8, 8)` pass. It uses the same five-binding layout as all other single-pass adjustments (src, dst, params uniform, selMask, maskFlags).

#### Uniform Struct — byte layout (32 bytes total)

| Offset | Field | Type | Description |
|--------|-------|------|-------------|
| 0 | `frequency` | `f32` | Cells per 100 canvas pixels (2–50) |
| 4 | `offsetC` | `f32` | Cyan dot-size offset, −50..+50 (%) |
| 8 | `offsetM` | `f32` | Magenta dot-size offset, −50..+50 (%) |
| 12 | `offsetY` | `f32` | Yellow dot-size offset, −50..+50 (%) |
| 16 | `offsetK` | `f32` | Black dot-size offset, −50..+50 (%) |
| 20 | `mode` | `u32` | 0 = color (CMYK), 1 = B&W |
| 24 | `_pad0` | `u32` | padding |
| 28 | `_pad1` | `u32` | padding |

The struct size (32 bytes) is already a multiple of 16, satisfying the WGSL uniform alignment requirement. The `encodeComputePassRaw` helper's `Math.max(16, Math.ceil(n / 16) * 16)` alignment is a no-op here.

#### Algorithm (per pixel)

`cell_pitch = 100.0 / frequency`

**Color mode (mode == 0):**

For each of the 4 ink channels [C at 105°, M at 75°, Y at 90°, K at 45°]:
1. Rotate the pixel coordinate into the screen's local axis: `sx = x·cos(θ) + y·sin(θ)`, `sy = −x·sin(θ) + y·cos(θ)`.
2. Find the enclosing cell: `cell_x = floor(sx / cell_pitch)`, `cell_y = floor(sy / cell_pitch)`.
3. Compute cell center in screen space: `ccsx = (cell_x + 0.5) · cell_pitch`, `ccsy = (cell_y + 0.5) · cell_pitch`.
4. Rotate cell center back to canvas space and sample `srcTex` at `round(ccx), round(ccy)` (clamped to texture bounds).
5. Derive CMYK from the cell-center sample (see below). If `sample.a < 0.001`, channel value = 0.
6. `dot_radius = clamp(channel_value · (cell_pitch / 2.0) · (1.0 + offset / 100.0),  0.0,  cell_pitch / 2.0)`
7. Distance from pixel to cell center in screen space: `dist = length(sx − ccsx, sy − ccsy)`.
8. `dot[ch] = (dist <= dot_radius) ? 1.0 : 0.0`

CMYK compositing (subtractive, CMYK-to-RGB):
```
R_out = (1 − dotC) · (1 − dotK)
G_out = (1 − dotM) · (1 − dotK)
B_out = (1 − dotY) · (1 − dotK)
A_out = (dotC + dotM + dotY + dotK > 0.0) ? 1.0 : 0.0
```

**B&W mode (mode == 1):**

Single 45° screen:
1. Rotate pixel into 45° screen space.
2. Find enclosing cell; find and rotate back cell center; sample srcTex at cell center.
3. Compute luminance at cell center, **premultiplied by alpha**: `L = (0.2126·r + 0.7152·g + 0.0722·b) · sample.a`. This prevents transparent regions from generating full-sized black dots.
4. `dot_radius = (1.0 − L) · (cell_pitch / 2.0)` — large dots in shadows, no dot in pure white/transparent.
5. Output: dot present → `(0, 0, 0, 1)`, else → `(0, 0, 0, 0)`.

**RGB → CMYK conversion for color mode:**
```
K = 1 − max(R, G, B)
if sample.a < 0.001:  C = M = Y = K = 0
else if K ≥ 1.0:      C = M = Y = 0,  K = 1 · sample.a
else:
  inv = 1 / (1 − K)
  C = (1 − R − K) · inv · sample.a
  M = (1 − G − K) · inv · sample.a
  Y = (1 − B − K) · inv · sample.a
  K = K · sample.a
```

Note: the alpha weighting ensures transparent cell-center samples produce zero ink and therefore zero-radius dots (per spec requirement for both modes).

**Selection mask application** (identical to all other single-pass adjustments): when `maskFlags.hasMask != 0`, lerp between `srcTex[coord]` and `out_color` by `selMask[coord].r`.

#### Full WGSL Source

```ts
export const HALFTONE_COMPUTE = /* wgsl */ `

struct MaskFlags {
  hasMask : u32,
  _pad    : vec3u,
}

struct HalftoneParams {
  frequency : f32,
  offsetC   : f32,
  offsetM   : f32,
  offsetY   : f32,
  offsetK   : f32,
  mode      : u32,
  _pad0     : u32,
  _pad1     : u32,
}

@group(0) @binding(0) var srcTex     : texture_2d<f32>;
@group(0) @binding(1) var dstTex     : texture_storage_2d<rgba8unorm, write>;
@group(0) @binding(2) var<uniform>   params    : HalftoneParams;
@group(0) @binding(3) var selMask    : texture_2d<f32>;
@group(0) @binding(4) var<uniform>   maskFlags : MaskFlags;

const PI : f32 = 3.14159265358979323846;

// Fixed screen angles (degrees): Cyan=105, Magenta=75, Yellow=90, Black=45
const ANG_C : f32 = 105.0;
const ANG_M : f32 = 75.0;
const ANG_Y : f32 = 90.0;
const ANG_K : f32 = 45.0;

// Derive one CMYK channel value (0..1) from an RGBA sample, weighted by alpha.
// ch: 0=C, 1=M, 2=Y, 3=K
fn cmykChannel(sc: vec4f, ch: u32) -> f32 {
  if sc.a < 0.001 { return 0.0; }
  let K = 1.0 - max(sc.r, max(sc.g, sc.b));
  if ch == 3u { return K * sc.a; }
  if K >= 1.0 { return 0.0; }
  let inv = 1.0 / (1.0 - K);
  if ch == 0u { return (1.0 - sc.r - K) * inv * sc.a; }
  if ch == 1u { return (1.0 - sc.g - K) * inv * sc.a; }
  return             (1.0 - sc.b - K) * inv * sc.a;
}

// Compute the dot presence (0.0 or 1.0) for one screen channel at the
// given canvas-space pixel coordinate.
fn screenDot(
  coordf     : vec2f,
  cos_a      : f32,
  sin_a      : f32,
  cell_pitch : f32,
  ch_offset  : f32,
  dims       : vec2u,
  ch         : u32,
) -> f32 {
  // Rotate pixel into screen space
  let sx = coordf.x * cos_a + coordf.y * sin_a;
  let sy = -coordf.x * sin_a + coordf.y * cos_a;

  // Enclosing cell in screen space
  let cell_x = floor(sx / cell_pitch);
  let cell_y = floor(sy / cell_pitch);

  // Cell centre in screen space
  let ccsx = (cell_x + 0.5) * cell_pitch;
  let ccsy = (cell_y + 0.5) * cell_pitch;

  // Rotate cell centre back to canvas space and sample
  let ccx = ccsx * cos_a - ccsy * sin_a;
  let ccy = ccsx * sin_a + ccsy * cos_a;
  let sc = textureLoad(
    srcTex,
    clamp(vec2i(i32(round(ccx)), i32(round(ccy))), vec2i(0), vec2i(dims) - vec2i(1)),
    0,
  );

  // Channel value (alpha-weighted)
  let ch_val = cmykChannel(sc, ch);

  // Effective dot radius
  let max_r = cell_pitch * 0.5;
  let dot_r = clamp(ch_val * max_r * (1.0 + ch_offset / 100.0), 0.0, max_r);

  // Distance from pixel to cell centre in screen space
  let dist = length(vec2f(sx - ccsx, sy - ccsy));

  return select(0.0, 1.0, dist <= dot_r);
}

@compute @workgroup_size(8, 8)
fn cs_halftone(@builtin(global_invocation_id) id: vec3u) {
  let dims = textureDimensions(srcTex);
  if id.x >= dims.x || id.y >= dims.y { return; }
  let coord  = vec2i(id.xy);
  let coordf = vec2f(f32(id.x), f32(id.y));

  let cell_pitch = 100.0 / params.frequency;

  var out_color = vec4f(0.0);

  if params.mode == 0u {
    // ── Color (CMYK) mode ────────────────────────────────────────────────────
    // Precompute sin/cos for the four fixed angles
    let rad_C = ANG_C * PI / 180.0;
    let rad_M = ANG_M * PI / 180.0;
    let rad_Y = ANG_Y * PI / 180.0;
    let rad_K = ANG_K * PI / 180.0;

    let dotC = screenDot(coordf, cos(rad_C), sin(rad_C), cell_pitch, params.offsetC, dims, 0u);
    let dotM = screenDot(coordf, cos(rad_M), sin(rad_M), cell_pitch, params.offsetM, dims, 1u);
    let dotY = screenDot(coordf, cos(rad_Y), sin(rad_Y), cell_pitch, params.offsetY, dims, 2u);
    let dotK = screenDot(coordf, cos(rad_K), sin(rad_K), cell_pitch, params.offsetK, dims, 3u);

    // Subtractive CMYK → RGB (per spec: R affected by C+K, G by M+K, B by Y+K)
    let R = (1.0 - dotC) * (1.0 - dotK);
    let G = (1.0 - dotM) * (1.0 - dotK);
    let B = (1.0 - dotY) * (1.0 - dotK);
    let A = select(0.0, 1.0, (dotC + dotM + dotY + dotK) > 0.0);

    out_color = vec4f(R, G, B, A);
  } else {
    // ── B&W mode ─────────────────────────────────────────────────────────────
    let rad_K = ANG_K * PI / 180.0;
    let cos_a = cos(rad_K);
    let sin_a = sin(rad_K);

    let sx = coordf.x * cos_a + coordf.y * sin_a;
    let sy = -coordf.x * sin_a + coordf.y * cos_a;

    let cell_x = floor(sx / cell_pitch);
    let cell_y = floor(sy / cell_pitch);

    let ccsx = (cell_x + 0.5) * cell_pitch;
    let ccsy = (cell_y + 0.5) * cell_pitch;

    let ccx = ccsx * cos_a - ccsy * sin_a;
    let ccy = ccsx * sin_a + ccsy * cos_a;

    let sc = textureLoad(
      srcTex,
      clamp(vec2i(i32(round(ccx)), i32(round(ccy))), vec2i(0), vec2i(dims) - vec2i(1)),
      0,
    );

    // Luminance premultiplied by alpha (prevents transparent areas from generating dots)
    let lum = (0.2126 * sc.r + 0.7152 * sc.g + 0.0722 * sc.b) * sc.a;

    let max_r = cell_pitch * 0.5;
    let dot_r = (1.0 - lum) * max_r;

    let dist = length(vec2f(sx - ccsx, sy - ccsy));
    let has_dot = dist <= dot_r;
    out_color = select(vec4f(0.0), vec4f(0.0, 0.0, 0.0, 1.0), has_dot);
  }

  // Selection mask
  if maskFlags.hasMask != 0u {
    let mask_val = textureLoad(selMask, coord, 0).r;
    let src_color = textureLoad(srcTex, coord, 0);
    out_color = mix(src_color, out_color, mask_val);
  }

  textureStore(dstTex, coord, out_color);
}
`
```

---

## `AdjustmentRenderOp` Changes

### `src/graphicspipeline/webgpu/types.ts`

Add the following variant to the `AdjustmentRenderOp` union, after the `'outline'` variant and before the closing semicolon:

```ts
| {
    kind:      'halftone'
    layerId:   string
    frequency: number         // 2–50 cells per 100 px
    offsetC:   number         // −50..+50 (%)
    offsetM:   number
    offsetY:   number
    offsetK:   number
    mode:      'color' | 'bw'
    visible:   boolean
    selMaskLayer?: GpuLayer
  }
```

---

## `AdjustmentEncoder.ts` Changes

### `src/graphicspipeline/webgpu/AdjustmentEncoder.ts`

**1. Import** — add `HALFTONE_COMPUTE` to the shader import block:

```ts
import {
  // ...existing imports...
  OUTLINE_COMPOSITE_COMPUTE,
  HALFTONE_COMPUTE,
} from './shaders/shaders'
```

**2. Private field** — add alongside the outline pipeline declarations:

```ts
// Halftone
private readonly halftonePipeline: GPUComputePipeline
```

**3. Constructor registration** — add after the last `this.outline...` line:

```ts
this.halftonePipeline = createComputePipeline(device, HALFTONE_COMPUTE, 'cs_halftone')
```

**4. `encode()` dispatch** — add before the `const _exhaustive: never = entry` exhaustive check:

```ts
if (entry.kind === 'halftone') {
  const buf = new ArrayBuffer(32)
  const f   = new Float32Array(buf)
  const u   = new Uint32Array(buf)
  f[0] = entry.frequency
  f[1] = entry.offsetC
  f[2] = entry.offsetM
  f[3] = entry.offsetY
  f[4] = entry.offsetK
  u[5] = entry.mode === 'color' ? 0 : 1
  // u[6] and u[7] remain 0 (padding; ArrayBuffer is zero-initialized)
  this.encodeComputePassRaw(encoder, this.halftonePipeline, srcTex, dstTex, buf, entry.selMaskLayer)
  return
}
```

No texture cache, no intermediate buffers, no multi-pass setup. The `destroy()` method requires no changes.

---

## `shaders.ts` Re-export

### `src/graphicspipeline/webgpu/shaders/shaders.ts`

Add after the `OUTLINE_COMPOSITE_COMPUTE` export line:

```ts
export { HALFTONE_COMPUTE } from './compute/adjustments/halftone'
```

---

## `canvasPlan.ts` Changes

### `src/ux/main/Canvas/canvasPlan.ts`

In `buildAdjustmentEntry()`, add the following branch immediately before the `const _exhaustive: never = ls` line:

```ts
if (ls.adjustmentType === 'halftone') {
  return {
    kind:      'halftone',
    layerId:   ls.id,
    frequency: ls.params.frequency,
    offsetC:   ls.params.offsetC,
    offsetM:   ls.params.offsetM,
    offsetY:   ls.params.offsetY,
    offsetK:   ls.params.offsetK,
    mode:      ls.params.mode,
    visible:   ls.visible,
    selMaskLayer: mask,
  }
}
```

---

## Panel Component

### `src/ux/windows/effects/HalftoneOptions/HalftoneOptions.tsx`

**Props:**

```ts
interface HalftoneOptionsProps {
  layer:           HalftoneAdjustmentLayer
  parentLayerName: string
}
```

**Component structure:**

```tsx
export function HalftoneOptions({ layer, parentLayerName }: HalftoneOptionsProps): React.JSX.Element {
  const { dispatch } = useAppContext()
  const p = layer.params

  const update = (patch: Partial<typeof p>): void => {
    dispatch({ type: 'UPDATE_ADJUSTMENT_LAYER', payload: { ...layer, params: { ...p, ...patch } } })
  }

  const pct = (v: number, lo: number, hi: number): string => String((v - lo) / (hi - lo))

  return (
    <div className={styles.content}>

      {/* Mode segmented control */}
      <div className={styles.modeRow}>
        <button
          className={`${styles.modeButton} ${p.mode === 'color' ? styles.modeButtonActive : ''}`}
          onClick={() => update({ mode: 'color' })}
        >Color (CMYK)</button>
        <button
          className={`${styles.modeButton} ${p.mode === 'bw' ? styles.modeButtonActive : ''}`}
          onClick={() => update({ mode: 'bw' })}
        >B&amp;W</button>
      </div>

      {/* Frequency */}
      <div className={styles.row}>
        <span className={styles.label}>Frequency</span>
        <div className={styles.trackWrap}>
          <input type="range" className={styles.track}
            min={2} max={50} step={1} value={p.frequency}
            style={{ '--pct': pct(p.frequency, 2, 50) } as React.CSSProperties}
            onChange={(e) => update({ frequency: Number(e.target.value) })}
          />
        </div>
        <input type="number" className={styles.numInput}
          min={2} max={50} step={1} value={p.frequency}
          onChange={(e) => {
            const v = e.target.valueAsNumber
            if (!isNaN(v)) update({ frequency: Math.min(50, Math.max(2, Math.round(v))) })
          }}
        />
        <span className={styles.unitLabel}>cells/100px</span>
      </div>

      {/* Per-channel offsets — only in Color (CMYK) mode */}
      {p.mode === 'color' && (
        <>
          <div className={styles.sectionHeader}>Channel Offsets</div>
          {(['C', 'M', 'Y', 'K'] as const).map((ch) => {
            const key = `offset${ch}` as 'offsetC' | 'offsetM' | 'offsetY' | 'offsetK'
            return (
              <div key={ch} className={styles.row}>
                <span className={styles.label}>{ch}</span>
                <div className={styles.trackWrap}>
                  <input type="range" className={styles.track}
                    min={-50} max={50} step={1} value={p[key]}
                    style={{ '--pct': pct(p[key], -50, 50) } as React.CSSProperties}
                    onChange={(e) => update({ [key]: Number(e.target.value) })}
                  />
                </div>
                <input type="number" className={styles.numInput}
                  min={-50} max={50} step={1} value={p[key]}
                  onChange={(e) => {
                    const v = e.target.valueAsNumber
                    if (!isNaN(v)) update({ [key]: Math.min(50, Math.max(-50, Math.round(v))) })
                  }}
                />
                <span className={styles.unitLabel}>%</span>
              </div>
            )
          })}
        </>
      )}
    </div>
  )
}
```

Key design decisions:
- The mode switch dispatches immediately via `UPDATE_ADJUSTMENT_LAYER`, matching the spec ("updates the canvas preview immediately"). No local React state is needed for mode — it lives in `layer.params.mode`.
- The per-channel offset rows are conditionally rendered (`{p.mode === 'color' && ...}`). The offset *values* remain in `layer.params` when B&W mode is active; they are simply not shown and not modified — exactly matching the spec's "preserved (but hidden)" requirement.
- The `update()` helper does a shallow merge with spread, exactly as in `BloomOptions` and `GlowOptions`.
- The channel offset loop uses `('C' | 'M' | 'Y' | 'K')` mapped to the param key names. If the TypeScript narrowing on `p[key]` causes issues, destructure the four values individually instead.

### `src/ux/windows/effects/HalftoneOptions/HalftoneOptions.module.scss`

Follow the same pattern as `GlowOptions.module.scss` with two additions:

```scss
@use '@/styles/variables' as vars;

.content {
  display: flex;
  flex-direction: column;
}

/* Mode segmented control */
.modeRow {
  display: flex;
  align-items: center;
  gap: 4px;
  height: 28px;
  margin-bottom: 4px;
}

.modeButton {
  flex: 1;
  height: 22px;
  background: #2a2a2a;
  border: 1px solid #3a3a3a;
  border-radius: 3px;
  color: #aaaaaa;
  font-size: 11px;
  cursor: pointer;

  &:hover { background: #333333; }
}

.modeButtonActive {
  background: #0699fb;
  border-color: #0699fb;
  color: #ffffff;

  &:hover { background: #0699fb; }
}

.sectionHeader {
  font-size: 10px;
  color: #666666;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  margin: 4px 0 2px;
}

/* Shared slider row layout — identical to GlowOptions */
.row {
  display: flex;
  align-items: center;
  gap: 6px;
  height: 28px;
}

.label {
  width: 68px;
  flex-shrink: 0;
  font-size: 11px;
  color: #aaaaaa;
  white-space: nowrap;
}

.trackWrap {
  flex: 1;
  min-width: 0;
  display: flex;
  align-items: center;
}

.track {
  width: 100%;
  height: 3px;
  appearance: none;
  -webkit-appearance: none;
  background: linear-gradient(
    to right,
    #0699fb calc(var(--pct) * 100%),
    #3a3a3a calc(var(--pct) * 100%)
  );
  border-radius: 2px;
  outline: none;
  cursor: pointer;

  &::-webkit-slider-thumb {
    appearance: none;
    -webkit-appearance: none;
    width: 10px;
    height: 10px;
    border-radius: 50%;
    background: #d4d4d4;
    border: 1px solid #555555;
    cursor: pointer;
    transition: background 80ms;
  }

  &:hover::-webkit-slider-thumb { background: #ffffff; }

  &:focus::-webkit-slider-thumb {
    background: #0699fb;
    border-color: #0699fb;
    box-shadow: 0 0 0 2px rgba(6, 153, 251, 0.18);
  }

  &::-moz-range-thumb {
    width: 10px;
    height: 10px;
    border-radius: 50%;
    background: #d4d4d4;
    border: 1px solid #555555;
    cursor: pointer;
  }
}

.numInput {
  width: 40px;
  height: 18px;
  padding: 0 4px;
  background: #1e1e1e;
  border: 1px solid #3a3a3a;
  border-radius: 2px;
  font-size: 11px;
  color: #d4d4d4;
  text-align: right;
  -moz-appearance: textfield;

  &::-webkit-inner-spin-button,
  &::-webkit-outer-spin-button { -webkit-appearance: none; }
}

.unitLabel {
  width: 68px;
  flex-shrink: 0;
  font-size: 10px;
  color: #666666;
  white-space: nowrap;
}
```

The `unitLabel` for the Frequency row reads "cells/100px" which is wider than "px" or "%". The `width: 68px` accommodates this — if the design review reveals it clips, increase to `80px`.

---

## Export from `src/ux/index.ts`

Add after the `OutlineOptions` export line:

```ts
export { HalftoneOptions } from './windows/effects/HalftoneOptions/HalftoneOptions'
```

---

## Unified Rasterization

No changes required. The unified rasterization pipeline (`src/graphicspipeline/rasterization/`) dispatches adjustment ops through `AdjustmentEncoder.encode()` for all flatten, merge, and export operations. Because `encode()` will handle `entry.kind === 'halftone'` — using the same single-pass `encodeComputePassRaw` helper used in the interactive preview — the halftone effect is automatically included and identical in all rendering paths.

The TypeScript exhaustive-type checks (`const _exhaustive: never = entry` in `encode()` and `const _exhaustive: never = ls` in `buildAdjustmentEntry()`) will produce compiler errors if either branch is missing, making it impossible to silently omit the effect.

---

## Implementation Steps

Follow these steps in order. Each step is independently compilable and verifiable.

1. **`src/types/index.ts`** — Add `'halftone'` to `AdjustmentType`; add `HalftoneParams` to `AdjustmentParamsMap`; add `HalftoneAdjustmentLayer` interface; add `HalftoneAdjustmentLayer` to `AdjustmentLayerState`. Run `npm run typecheck` — the compiler will report `AdjustmentRenderOp` and `buildAdjustmentEntry` as non-exhaustive.

2. **`src/graphicspipeline/webgpu/types.ts`** — Add the `'halftone'` variant to `AdjustmentRenderOp`. Typecheck again — `AdjustmentEncoder.encode()` becomes non-exhaustive.

3. **`src/graphicspipeline/webgpu/shaders/compute/adjustments/halftone.ts`** — Create the new file with the `HALFTONE_COMPUTE` shader string (full source above). No external dependencies.

4. **`src/graphicspipeline/webgpu/shaders/shaders.ts`** — Add `export { HALFTONE_COMPUTE } from './compute/adjustments/halftone'`.

5. **`src/graphicspipeline/webgpu/AdjustmentEncoder.ts`** — Import `HALFTONE_COMPUTE`; declare `halftonePipeline` field; register in constructor; add the `'halftone'` dispatch branch in `encode()`. Typecheck — `encode()` exhaustive check is satisfied.

6. **`src/core/operations/adjustments/registry.ts`** — Add the registry entry.

7. **`src/ux/main/Canvas/canvasPlan.ts`** — Add the `'halftone'` branch in `buildAdjustmentEntry()`. Typecheck — `buildAdjustmentEntry` exhaustive check is satisfied.

8. **`src/ux/windows/effects/HalftoneOptions/HalftoneOptions.tsx`** and **`HalftoneOptions.module.scss`** — Create both new files.

9. **`src/ux/index.ts`** — Export `HalftoneOptions`.

10. **Smoke test** — `npm run dev`, create a gradient pixel layer, apply Effects → Halftone…, verify Color mode rosette pattern and B&W mode dot screen. Toggle mode, adjust frequency and offsets, hide/show the layer, press Ctrl+Z to undo.

---

## Architectural Constraints

- **Single compute pass** — this effect fits naturally into `encodeComputePassRaw` without requiring a texture cache or multi-pass infrastructure. Do not introduce intermediate textures unless a future enhancement (e.g., anti-aliased dot edges via SDF) genuinely requires it.
- **No CPU fallback** — per `AGENTS.md`, the rasterization pipeline is GPU-only. The shader's `round()`/`floor()` analytically computes dot membership without any CPU pixel-walking.
- **Mode stored in params, not React state** — mode is part of `layer.params.mode` dispatched through `UPDATE_ADJUSTMENT_LAYER`. No local `useState` for mode in the panel component. This ensures that re-opening the panel always reflects the committed value and that the reducer/undo system captures mode changes correctly.
- **Fixed angles** — screen angles (C=105°, M=75°, Y=90°, K=45°) are hard-coded WGSL constants, not uniforms. This simplifies the uniform struct and removes any risk of the user accidentally setting angles that cause moiré with each other.
- **Transparent background** — non-dot pixels always have alpha=0. The implementation must not write a white background. This is enforced in the shader: `A_out = (any dot > 0) ? 1.0 : 0.0`.
- **Exhaustive type checks** — the two `const _exhaustive: never` guards in `AdjustmentEncoder.ts` and `canvasPlan.ts` serve as compile-time enforcement that every `AdjustmentType` has a complete implementation path. Both must remain in place.
- **`.module.scss` only** — per `AGENTS.md`, no plain `.scss` default imports. The panel component imports `styles from './HalftoneOptions.module.scss'`.

---

## Open Questions / Implementation Risks

1. **`--pct` CSS custom property for negative-range sliders** — the offset sliders have range −50 to +50. The `pct` helper `(v - lo) / (hi - lo)` produces the correct 0–1 fill fraction for negative values (e.g., −25 → 0.25, 0 → 0.5, +25 → 0.75). The CSS gradient `linear-gradient(to right, #0699fb calc(var(--pct) * 100%), #3a3a3a ...)` will display the filled segment from the left. This is technically correct but may look unintuitive (center = neutral point). If the UX review requests a center-anchored fill for bidirectional sliders, the SCSS would need to be extended with a separate styling variant. For now, left-anchored fill matching all other sliders is acceptable.

2. **WGSL loop vs. four explicit calls** — the four `screenDot()` calls in color mode are intentionally written as four separate explicit calls rather than a loop, because WGSL arrays of `f32` constants with per-element reads in a loop require special care on some GPU drivers. The explicit-call approach guarantees that the four angle sin/cos values are computed independently and avoids any potential loop-unrolling inefficiency. This adds verbosity but is the safest pattern.

3. **Performance at frequency=50 on large canvases** — at frequency=50, `cell_pitch=2px`. Each pixel invokes four `screenDot()` calls, each of which calls `cos()`/`sin()` on fixed constants and performs a `textureLoad`. On a 4000×4000 canvas this is 64M shader invocations × 4 texture fetches each. The sin/cos values are constant per shader module compile (the angles are WGSL constants), so the compiler may pre-fold them to literal values; however, this is not guaranteed. Consider hoisting sin/cos outside the `screenDot` function and passing them as parameters (as the design already does) to ensure the compiler sees them as constants per-invocation rather than per-channel. Profile on the target machine at frequency=50; if the frame time exceeds the budget, the workgroup size can be increased from `(8,8)` to `(16,16)` as a first optimization lever.

4. **Cell boundary floating-point artifacts** — pixels exactly on a cell boundary may flip between adjacent cells due to `floor()` rounding. This produces a maximum of 1-pixel-wide seams between dot regions. In practice at typical frequencies (5–20) the seam is sub-pixel and invisible. At very fine frequencies (50), seams would be visible but are acceptable as a known WGSL limitation. An SDF-based approach (signed distance to the nearest cell boundary) could eliminate this at higher shader complexity — out of scope for the initial implementation.

5. **TypeScript union index on `p[key]`** — the channel offset loop maps `'C' | 'M' | 'Y' | 'K'` to `'offsetC' | 'offsetM' | 'offsetY' | 'offsetK'`. TypeScript's indexed access may not narrow the type of `p[key]` to `number` without an explicit cast. If the compiler flags this, replace the loop with four explicitly written rows (C, M, Y, K) to eliminate the narrowing issue entirely. Correctness and maintainability are the same either way; the loop is just shorter.

6. **`cells/100px` unit label width** — the unit label column (`width: 68px` in the SCSS) may clip "cells/100px" at the 11px font size. Measure at runtime; if clipping occurs, increase to `90px` or use `width: auto` with `white-space: nowrap` and a minimum panel width guarantee.
