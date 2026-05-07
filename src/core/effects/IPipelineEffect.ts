import type { ComponentType } from "react";
import type { AdjustmentLayerState, RGBAColor } from "@/types";
import type {
  AdjustmentRenderOp,
  GpuLayer,
} from "@/graphicspipeline/webgpu/rendering/WebGPURenderer";
import type { EffectEncoder } from "@/graphicspipeline/webgpu/EffectEncoder";
import type { CanvasHandle } from "@/ux/main/Canvas/Canvas";

export type MenuRoot = "adjustments" | "effects" | "filters";

export interface MenuPlacement {
  root: MenuRoot;
  /** Submenu group inside the root menu, e.g. "blur" / "color" / "stylize". */
  submenu?: string;
  /** Instant filters apply on click without opening a panel. */
  instant?: boolean;
  /** Optional accelerator, e.g. "Ctrl+Shift+U". */
  shortcut?: string;
}

export interface PlanContext {
  /** Active document swatches (palette mode). */
  swatches: RGBAColor[];
  /** Selection mask for this adjustment layer, if any. */
  mask: GpuLayer | undefined;
}

export interface EncodeContext {
  encoder: GPUCommandEncoder;
  srcTex: GPUTexture;
  dstTex: GPUTexture;
  format: GPUTextureFormat;
  /**
   * The owning encoder, exposed so effects can reuse its pre-built pipelines
   * and shared primitives (`encodeStdAdjRenderPass`, `encodeBloomRenderPass`,
   * etc.) instead of duplicating the GPU plumbing.
   *
   * INTERNAL ONLY — this surface is for first-party effects that ship with
   * the app. Future plugin-facing effects must NOT depend on `engine` directly;
   * a stable, narrower `EncodeServices` interface will be introduced for that
   * use case. Treat any `engine.*` access as private API subject to change.
   */
  engine: EffectEncoder;
}

export interface PanelProps<L extends AdjustmentLayerState> {
  layer: L;
  parentLayerName: string;
  /**
   * Read-only reference to the active canvas handle. Optional because most
   * panels don't need it; effects that do (curves, auto-match, reduce-colors)
   * can read it for stats sampling or palette derivation.
   */
  canvasHandleRef?: { readonly current: CanvasHandle | null };
}

/**
 * One effect — adjustment, real-time effect, or filter — registered in
 * `effectRegistry`. Implementations wire together every responsibility for a
 * single effect so adding a new one is one registration step instead of edits
 * across the codebase.
 *
 * The interface intentionally reuses the existing `AdjustmentLayerState` /
 * `AdjustmentRenderOp` unions rather than introducing new ones; the registry
 * routes specific union members to the right effect by id.
 */
export interface IPipelineEffect<
  L extends AdjustmentLayerState = AdjustmentLayerState,
  Op extends AdjustmentRenderOp = AdjustmentRenderOp,
> {
  /** Stable id; matches `adjustmentType` on the layer and `kind` on the render op. */
  readonly id: L["adjustmentType"] & Op["kind"];

  /** Display label, e.g. "Pixelate…". */
  readonly label: string;

  /** Where this effect appears in the menu structure. */
  readonly menu: MenuPlacement;

  /** Default params used when a fresh layer is created. */
  readonly defaultParams: L["params"];

  /** Build a render-plan entry from a layer; called every frame. */
  buildPlanEntry(layer: L, ctx: PlanContext): Op;

  /** Record GPU work for this effect into the given command encoder. */
  encode(ctx: EncodeContext, entry: Op): void;

  /** Right-side panel component shown when this layer is active. */
  readonly Panel: ComponentType<PanelProps<L>>;

  /**
   * Optional. Called once per frame after encode + submit. Effects with
   * cross-frame texture caches use this to release entries that weren't
   * touched during the just-submitted frame (analogous to the previous
   * `*UsedThisFrame` flags on AdjustmentEncoder).
   */
  onFrameEnd?(): void;

  /**
   * Optional. Called when the owning AdjustmentEncoder is destroyed (canvas
   * tear-down). Effects with persistent GPU resources (texture caches, LUT
   * textures) release them here.
   */
  onDestroy?(): void;
}
