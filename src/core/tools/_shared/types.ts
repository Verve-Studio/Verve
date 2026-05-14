import type React from "react";
import type {
  WebGPURenderer,
  GpuLayer,
} from "@/graphics/webgpu/rendering/WebGPURenderer";
import type {
  RGBAColor,
  TextLayerState,
  ShapeLayerState,
  PathLayerState,
  FrameLayerState,
  LayerState,
  PixelFormat,
  Guide,
  Tool,
} from "@/types";

// ─── Runtime context passed to tool handlers on each pointer event ────────────

export interface ToolContext {
  /**
   * Per-document store bundle (selection, history, crop, transform, …).
   * Tool handlers should read store state through `ctx.scope.X` rather than
   * importing the legacy module-level singletons; this guarantees the right
   * tab's instance even if the active scope changes mid-stroke.
   */
  scope: import("@/core/store/scope").DocumentScope;
  renderer: WebGPURenderer;
  layer: GpuLayer;
  layers: GpuLayer[];
  primaryColor: RGBAColor;
  secondaryColor: RGBAColor;
  render: (layers?: GpuLayer[]) => void;
  /**
   * Grow the active layer's buffer if the given canvas-space point (with
   * optional extra radius) would fall outside it. Call before writing pixels
   * at canvas coords near the edge.
   */
  growLayerToFit: (
    canvasX: number,
    canvasY: number,
    extraRadius?: number,
  ) => void;
  /**
   * Active selection mask in canvas-space (1 byte per pixel, 0 = not selected,
   * non-zero = selected). null means the whole canvas is selected.
   */
  selectionMask: Uint8Array | null;
  /** Set the primary color in app state (used by the eyedropper tool). */
  setColor: (color: RGBAColor) => void;
  /**
   * For async tools (e.g. fill): call this after the operation completes to
   * push a history entry. Tools that use this must also set `skipAutoHistory`
   * on their ToolDefinition to prevent a duplicate capture on pointer up.
   */
  commitStroke: (label: string) => void;
  /**
   * The overlay 2D canvas drawn on top of the WebGL canvas (used for
   * live drag previews — e.g. gradient guide line, selection marquee).
   * May be null if the canvas is not yet mounted.
   */
  overlayCanvas: HTMLCanvasElement | null;
  /** Create a new text layer at a canvas position (used by the text tool on pointerDown). */
  addTextLayer: (layer: TextLayerState) => void;
  /** Update an existing text layer's content / style (dispatches state update + re-rasterizes). */
  updateTextLayer: (layer: TextLayerState) => void;
  /** Open the inline text editor for an already-existing text layer (e.g. clicking on it with the text tool). */
  openTextLayerEditor: (id: string) => void;
  /** Current text layers in state — used by the text tool to detect clicks on existing text. */
  textLayers: TextLayerState[];
  /**
   * Re-rasterize a text layer at an arbitrary canvas position WITHOUT updating
   * app state. Used by the move tool for smooth live drag previews of text layers.
   */
  previewTextAt: (ls: TextLayerState, x: number, y: number) => void;
  /** Create a new shape layer, rasterize it, add to state and set as active. */
  addShapeLayer: (layer: ShapeLayerState) => void;
  /** Dispatch UPDATE_SHAPE_LAYER — sync effect re-rasterizes from new state. */
  updateShapeLayer: (layer: ShapeLayerState) => void;
  /**
   * Rasterize a shape layer directly into its GL buffer and render WITHOUT
   * dispatching to state. Used for live editing previews during drag.
   */
  previewShapeLayer: (layer: ShapeLayerState) => void;
  /** All current shape layers — shape tool uses this to find the active shape. */
  shapeLayers: ShapeLayerState[];
  /** The active shape layer, if the currently active layer is a shape type. */
  activeShapeLayer: ShapeLayerState | null;
  /** Create a new path (Pen-tool) layer, rasterize it, add to state and set as active. */
  addPathLayer: (layer: PathLayerState) => void;
  /** Dispatch UPDATE_PATH_LAYER — sync effect re-rasterizes from the new state. */
  updatePathLayer: (layer: PathLayerState) => void;
  /**
   * Rasterize a path layer directly into its GL buffer and render WITHOUT
   * dispatching to state. Used for live edit previews during pointer drag.
   */
  previewPathLayer: (layer: PathLayerState) => void;
  /** All current path layers. */
  pathLayers: PathLayerState[];
  /** The active path layer, if the currently active layer is a path type. */
  activePathLayer: PathLayerState | null;
  /** Create a new frame layer, rasterize it (placeholder), add to state and set as active. */
  addFrameLayer: (layer: FrameLayerState) => void;
  /** Dispatch UPDATE_FRAME_LAYER — sync effect re-rasterizes from the new state. */
  updateFrameLayer: (layer: FrameLayerState) => void;
  /**
   * Re-rasterize a frame layer at arbitrary parameters WITHOUT dispatching to
   * state. Used for live edit previews during drag.
   */
  previewFrameLayer: (layer: FrameLayerState) => void;
  /** All current frame layers — frame tool uses this to find the active frame. */
  frameLayers: FrameLayerState[];
  /** The active frame layer, if the currently active layer is a frame type. */
  activeFrameLayer: FrameLayerState | null;
  /** Current canvas zoom level — used to compute screen-space handle sizes in overlay drawings. */
  zoom: number;
  /** Whether tiled mode is active — used by wrap-capable tools to enable coordinate wrapping. */
  tiledMode: boolean;
  /** Document pixel format — tools branch on this to select rgba8 vs indexed8 behavior. */
  pixelFormat: PixelFormat;
  /** Current swatch palette — required by indexed8 drawing tools for nearest-index resolution. */
  swatches: readonly RGBAColor[];
  /** Current swatch groups — required by indexed8 tools that operate on a
   *  group's index range (e.g. the gradient tool). */
  swatchGroups: readonly import("@/types").SwatchGroup[];
  /** Set the active palette swatch index (used by the eyedropper in indexed8 mode). */
  setSwatch: (index: number) => void;
  /** Current guide list — used by tools that snap to guides. */
  guides: Guide[];
  /**
   * Map from parent pixel-layer ID → its mask GpuLayer (visible masks only —
   * built for the rendering pipeline). Tools that need to track *all* mask
   * GpuLayers regardless of visibility should resolve through `getGpuLayer`
   * after walking parent→child relations in `layerStates`.
   */
  maskMap: Map<string, GpuLayer>;
  /**
   * Full layer-state list for the document (every kind: pixel, text, shape,
   * frame, mask, adjustment, group, composite). Used by tools that need to
   * traverse parent/child relationships — e.g. the move tool dragging a
   * group also drags every descendant.
   */
  layerStates: readonly LayerState[];
  /**
   * Resolve any layer id to its GpuLayer instance, regardless of whether the
   * layer is currently in the visible render set. Returns `undefined` if no
   * GpuLayer has been allocated (e.g. for container layers without pixel
   * data, or adjustment layers).
   */
  getGpuLayer: (id: string) => GpuLayer | undefined; /**
   * IDs of all layers currently selected in the Layers panel (excluding the
   * active layer, which is always implicitly included). Used by the move tool
   * to move all selected layers together.
   */
  selectedLayerIds: readonly string[];
  /** Set the active layer in app state (used by the pick tool to select what was clicked). */
  setActiveLayer: (id: string) => void;
  /** Switch the active tool (used by the pick tool to enter the appropriate edit mode for the picked layer). */
  setActiveTool: (tool: Tool) => void;
  /**
   * Set the canvas cursor (CSS cursor string, e.g. `"ns-resize"`, `"grab"`,
   * or `""` to revert to the tool's default). The tool overlay element has
   * `pointer-events: none`, so cursors must be applied to the underlying
   * canvas — this helper does that without exposing the canvas ref to tools.
   */
  setCursor: (cursor: string) => void;
  /**
   * Pan the viewport by `dxCss`/`dyCss` CSS pixels (scrolls the viewport
   * inner). Used by the hand tool to drag the canvas around.
   */
  panViewport: (dxCss: number, dyCss: number) => void;
  /**
   * Set the document zoom level. If `focus` is given, the supplied
   * canvas-space point stays at the same viewport position before/after the
   * zoom (matching Photoshop's "zoom into where you click" behaviour). Used
   * by the zoom tool.
   */
  setZoom: (
    zoom: number,
    focus?: { canvasX: number; canvasY: number },
  ) => void;
}

// ─── Pointer position passed to tool handlers ─────────────────────────────────

export interface ToolPointerPos {
  x: number;
  y: number;
  pressure: number;
  shiftKey: boolean;
  altKey: boolean;
  /** Hardware event timestamp (ms, same epoch as performance.now). Used for accurate velocity when coalesced events are replayed. */
  timeStamp: number;
  /** Pen tilt in degrees, -90..90. 0 for mouse / unsupported devices. */
  tiltX: number;
  tiltY: number;
  /** Pen barrel rotation in degrees, 0..359. 0 for mouse / unsupported devices. */
  twist: number;
}

// ─── Stateful handler created fresh for each tool activation ──────────────────

export interface ToolHandler {
  onPointerDown(pos: ToolPointerPos, ctx: ToolContext): void;
  onPointerMove(pos: ToolPointerPos, ctx: ToolContext): void;
  onPointerUp(pos: ToolPointerPos, ctx: ToolContext): void;
  /** Called on every pointer-move regardless of button state — for hover UI effects. */
  onHover?(pos: ToolPointerPos, ctx: ToolContext): void;
  /** Called when the pointer leaves the canvas — clean up any hover UI. */
  onLeave?(ctx: ToolContext): void;
  /**
   * Called when this tool becomes active OR when the active layer changes
   * while this tool is already active. Used by tools like shape/frame to draw
   * their edit overlay (handles, dashed bounds) for the active layer the
   * moment they become available — e.g. so double-clicking a shape from the
   * pick tool drops the user straight into edit mode without an extra click.
   */
  onActivate?(ctx: ToolContext): void;
}

// ─── CSS module classes passed to each Options component ──────────────────────

export interface ToolOptionsStyles {
  optLabel: string;
  optText: string;
  optInput: string;
  optCheckbox: string;
  optSelect: string;
  optCheckLabel: string;
  optSep: string;
  optBtn: string;
  optModeBtn: string;
  optModeBtnActive: string;
}

// ─── Full tool definition registered in the tool registry ─────────────────────

export interface ToolDefinition {
  createHandler(): ToolHandler;
  Options(props: { styles: ToolOptionsStyles }): React.JSX.Element;
  /** True for tools that write pixels; Canvas uses this to block locked layers and trigger history capture on pointer up. */
  modifiesPixels?: boolean;
  /** Set true for async tools that call ctx.commitStroke() themselves; suppresses the automatic pointer-up capture. */
  skipAutoHistory?: boolean;
  /**
   * True for tools that paint/draw new pixels and therefore need a real pixel
   * layer to operate on. When the active layer is a text or shape layer, Canvas
   * will auto-create a new pixel layer above it before the first stroke.
   * Should be set only for brush, pencil, fill, gradient (not move, eraser, dodge, burn, etc.).
   */
  paintsOntoPixelLayer?: boolean;
  /**
   * True for tools that have their own handling for text/shape/group layers
   * and must NOT be blocked by the parametric-layer guard in Canvas.tsx.
   * The move tool is the canonical example.
   */
  worksOnAllLayers?: boolean;
}
