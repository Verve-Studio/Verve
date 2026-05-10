import type { LayerColorSpace, PixelFormat } from "@/types";
import type { EffectParamsMap } from "@/core/effects/effectTypes";
import type { CurvesLuts } from "@/core/effects/Curves/curves";

// ─── GpuLayer ─────────────────────────────────────────────────────────────────

export interface GpuLayer {
  id: string;
  name: string;
  texture: GPUTexture;
  data: Uint8Array | Float32Array;
  format: PixelFormat;
  layerWidth: number;
  layerHeight: number;
  offsetX: number;
  offsetY: number;
  opacity: number;
  visible: boolean;
  blendMode: string;
  /** Accumulated dirty region in layer-local texel coords. Expanded by tools; consumed + reset by flushLayer. */
  dirtyRect: { lx: number; ly: number; rx: number; ry: number } | null;
  /** Incremented by flushLayer() every time pixel content is uploaded to the GPU.
   *  Used by the render cache to detect content changes without full pixel comparison. */
  contentVersion: number;
  /** Tagged colour space for this layer's stored pixels. When this differs
   *  from the document working space, the renderer interposes an IDT
   *  decode pre-pass that produces a working-space scratch texture used
   *  for adjustments + composite. Default `'auto'` → no pre-pass. */
  colorSpace: LayerColorSpace;
}

export const BLEND_MODE_INDEX: Record<string, number> = {
  normal: 0,
  multiply: 1,
  screen: 2,
  overlay: 3,
  "soft-light": 4,
  "hard-light": 5,
  darken: 6,
  lighten: 7,
  difference: 8,
  exclusion: 9,
  "color-dodge": 10,
  "color-burn": 11,
};

// ─── EffectRenderOp ────────────────────────────────────────────────────────
//
// Generic shape: every render op carries the layer's params plus standard
// metadata (kind, layerId, visibility, optional selection mask). A handful of
// effects need precomputed plan-time data (Curves' LUTs, ReduceColors' palette,
// AutoMatch's pixel statistics) — those declare entries in PlanExtrasMap and
// the corresponding op variant is augmented with the extra fields.
//
// Adding a new effect requires NO edits here as long as its render op only
// needs the layer's params. Effects that need extras add a key to
// PlanExtrasMap.

export interface PlanExtrasMap {
  curves: { luts: CurvesLuts };
  "reduce-colors": { palette: Float32Array; paletteCount: number };
  "color-dithering": { palette: Float32Array; paletteCount: number };
  "auto-match": {
    layerMeanL: number;
    layerStdL: number;
    layerMinL: number;
    layerMaxL: number;
    layerMeanR: number;
    layerMeanG: number;
    layerMeanB: number;
    layerChromaMag: number;
    layerCount: number;
    contextMeanL: number;
    contextStdL: number;
    contextMinL: number;
    contextMaxL: number;
    contextMeanR: number;
    contextMeanG: number;
    contextMeanB: number;
    contextChromaMag: number;
    contextCount: number;
    statsVersion: number;
  };
}

export type EffectRenderOp = {
  [K in keyof EffectParamsMap]: {
    kind: K;
    layerId: string;
    visible: boolean;
    selMaskLayer?: GpuLayer;
    params: EffectParamsMap[K];
  } & (K extends keyof PlanExtrasMap ? PlanExtrasMap[K] : object);
}[keyof EffectParamsMap];

// ─── RenderPlanEntry ──────────────────────────────────────────────────────────

export type RenderPlanEntry =
  | { kind: "layer"; layer: GpuLayer; mask?: GpuLayer }
  | {
      kind: "adjustment-group";
      parentLayerId: string;
      baseLayer: GpuLayer;
      baseMask?: GpuLayer;
      adjustments: EffectRenderOp[];
      /** When true the parent pixel layer is locked — the renderer will bake
       *  the composited output once and reuse it on every subsequent frame,
       *  and `planIsFlatLayersOnly` treats it as equivalent to a plain layer. */
      locked?: boolean;
    }
  | {
      kind: "layer-group";
      groupId: string;
      opacity: number;
      blendMode: string;
      visible: boolean;
      children: RenderPlanEntry[];
    }
  | {
      /** Non-destructive merged layer: children are flattened at render time,
       *  then `adjustments` are applied to the merged result before compositing. */
      kind: "composite-layer";
      layerId: string;
      opacity: number;
      blendMode: string;
      visible: boolean;
      children: RenderPlanEntry[];
      adjustments: EffectRenderOp[];
      /** When true the composite is locked — the renderer bakes its flattened
       *  output once and reuses it on every subsequent frame, and
       *  `planIsFlatLayersOnly` treats it as equivalent to a plain layer. */
      locked?: boolean;
    }
  | EffectRenderOp;

// ─── Error ────────────────────────────────────────────────────────────────────

export class WebGPUUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WebGPUUnavailableError";
  }
}
