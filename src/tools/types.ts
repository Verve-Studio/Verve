import type React from 'react'
import type { WebGPURenderer, GpuLayer } from '@/graphicspipeline/webgpu/rendering/WebGPURenderer'
import type { RGBAColor, TextLayerState, ShapeLayerState } from '@/types'

// ─── Runtime context passed to tool handlers on each pointer event ────────────

export interface ToolContext {
  renderer: WebGPURenderer
  layer: GpuLayer
  layers: GpuLayer[]
  primaryColor: RGBAColor
  secondaryColor: RGBAColor
  render: (layers?: GpuLayer[]) => void
  /**
   * Grow the active layer's buffer if the given canvas-space point (with
   * optional extra radius) would fall outside it. Call before writing pixels
   * at canvas coords near the edge.
   */
  growLayerToFit: (canvasX: number, canvasY: number, extraRadius?: number) => void
  /**
   * Active selection mask in canvas-space (1 byte per pixel, 0 = not selected,
   * non-zero = selected). null means the whole canvas is selected.
   */
  selectionMask: Uint8Array | null
  /** Set the primary color in app state (used by the eyedropper tool). */
  setColor: (color: RGBAColor) => void
  /**
   * For async tools (e.g. fill): call this after the operation completes to
   * push a history entry. Tools that use this must also set `skipAutoHistory`
   * on their ToolDefinition to prevent a duplicate capture on pointer up.
   */
  commitStroke: (label: string) => void
  /**
   * The overlay 2D canvas drawn on top of the WebGL canvas (used for
   * live drag previews — e.g. gradient guide line, selection marquee).
   * May be null if the canvas is not yet mounted.
   */
  overlayCanvas: HTMLCanvasElement | null
  /** Create a new text layer at a canvas position (used by the text tool on pointerDown). */
  addTextLayer: (layer: TextLayerState) => void
  /** Update an existing text layer's content / style (dispatches state update + re-rasterizes). */
  updateTextLayer: (layer: TextLayerState) => void
  /** Open the inline text editor for an already-existing text layer (e.g. clicking on it with the text tool). */
  openTextLayerEditor: (id: string) => void
  /** Current text layers in state — used by the text tool to detect clicks on existing text. */
  textLayers: TextLayerState[]
  /**
   * Re-rasterize a text layer at an arbitrary canvas position WITHOUT updating
   * app state. Used by the move tool for smooth live drag previews of text layers.
   */
  previewTextAt: (ls: TextLayerState, x: number, y: number) => void
  /** Create a new shape layer, rasterize it, add to state and set as active. */
  addShapeLayer: (layer: ShapeLayerState) => void
  /** Dispatch UPDATE_SHAPE_LAYER — sync effect re-rasterizes from new state. */
  updateShapeLayer: (layer: ShapeLayerState) => void
  /**
   * Rasterize a shape layer directly into its GL buffer and render WITHOUT
   * dispatching to state. Used for live editing previews during drag.
   */
  previewShapeLayer: (layer: ShapeLayerState) => void
  /** All current shape layers — shape tool uses this to find the active shape. */
  shapeLayers: ShapeLayerState[]
  /** The active shape layer, if the currently active layer is a shape type. */
  activeShapeLayer: ShapeLayerState | null
  /** Current canvas zoom level — used to compute screen-space handle sizes in overlay drawings. */
  zoom: number
  /** Whether tiled mode is active — used by wrap-capable tools to enable coordinate wrapping. */
  tiledMode: boolean
}

// ─── Pointer position passed to tool handlers ─────────────────────────────────

export interface ToolPointerPos {
  x: number
  y: number
  pressure: number
  shiftKey: boolean
  altKey: boolean
  /** Hardware event timestamp (ms, same epoch as performance.now). Used for accurate velocity when coalesced events are replayed. */
  timeStamp: number
}

// ─── Stateful handler created fresh for each tool activation ──────────────────

export interface ToolHandler {
  onPointerDown(pos: ToolPointerPos, ctx: ToolContext): void
  onPointerMove(pos: ToolPointerPos, ctx: ToolContext): void
  onPointerUp(pos: ToolPointerPos, ctx: ToolContext): void
  /** Called on every pointer-move regardless of button state — for hover UI effects. */
  onHover?(pos: ToolPointerPos, ctx: ToolContext): void
  /** Called when the pointer leaves the canvas — clean up any hover UI. */
  onLeave?(ctx: ToolContext): void
}

// ─── CSS module classes passed to each Options component ──────────────────────

export interface ToolOptionsStyles {
  optLabel: string
  optText: string
  optInput: string
  optSelect: string
  optCheckLabel: string
  optSep: string
  optBtn: string
  optModeBtn: string
  optModeBtnActive: string
}

// ─── Full tool definition registered in the tool registry ─────────────────────

export interface ToolDefinition {
  createHandler(): ToolHandler
  Options(props: { styles: ToolOptionsStyles }): React.JSX.Element
  /** True for tools that write pixels; Canvas uses this to block locked layers and trigger history capture on pointer up. */
  modifiesPixels?: boolean
  /** Set true for async tools that call ctx.commitStroke() themselves; suppresses the automatic pointer-up capture. */
  skipAutoHistory?: boolean
  /**
   * True for tools that paint/draw new pixels and therefore need a real pixel
   * layer to operate on. When the active layer is a text or shape layer, Canvas
   * will auto-create a new pixel layer above it before the first stroke.
   * Should be set only for brush, pencil, fill, gradient (not move, eraser, dodge, burn, etc.).
   */
  paintsOntoPixelLayer?: boolean
  /**
   * True for tools that have their own handling for text/shape/group layers
   * and must NOT be blocked by the parametric-layer guard in Canvas.tsx.
   * The move tool is the canonical example.
   */
  worksOnAllLayers?: boolean
}
