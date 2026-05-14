/**
 * Factory for `ToolContext` — the bag of refs + dispatchers + state slices
 * every `ToolHandler` callback receives on every pointer event.
 *
 * Important: returns a STABLE callback that internally reads from an
 * inputs-ref refreshed on every render. The callback identity never
 * changes, so wrapping it in `useEffect` deps doesn't cause churn — but
 * each invocation builds a fresh `ToolContext` that closes over the LATEST
 * state. Tool handlers can rely on getting current values for
 * `state.primaryColor`, `state.activeLayerId`, etc., on every pointer move.
 *
 * The factory returns `null` when the tool/layer combination doesn't make
 * sense:
 *   - no active pixel layer AND the tool needs one (most pixel-modifying
 *     tools do; the whitelist below lists the exceptions)
 *   - active layer is locked and the tool modifies pixels
 *   - active layer is a parametric layer (text/shape/frame/adjustment) and
 *     the tool doesn't have `worksOnAllLayers`
 *
 * Returning null causes the caller to drop the event silently.
 */
import { useCallback, useRef } from "react";
import { TOOL_REGISTRY } from "@/core/tools";
import type { ToolContext } from "@/core/tools";
import { activeScope } from "@/core/store/scope";
import type {
  AppState,
  Tool,
  PixelFormat,
  RGBAColor,
  TextLayerState,
  ShapeLayerState,
  PathLayerState,
  FrameLayerState,
} from "@/types";
import type { AppAction } from "@/core/store/AppContext";
import type {
  GpuLayer,
  WebGPURenderer,
} from "@/graphics/webgpu/rendering/WebGPURenderer";
import { rasterizeTextToLayer } from "@/ux/main/Canvas/textRasterizer";
import { rasterizeShapeToLayer } from "@/ux/main/Canvas/shapeRasterizer";
import { rasterizePathToLayer } from "@/ux/main/Canvas/pathRasterizer";
import { rasterizeFrameToLayer } from "@/ux/main/Canvas/frameRasterizer";

/** Whitelist of tools that may run with no active pixel layer. Pick / hand /
 *  zoom don't touch pixels; text / shape / frame create their own; the
 *  selection tools only mutate the selection mask; crop only writes to the
 *  crop store. */
const NO_LAYER_TOOLS: ReadonlySet<Tool> = new Set<Tool>([
  "text",
  "shape",
  "pen",
  "frame",
  "pick",
  "hand",
  "zoom",
  "measure",
  "select",
  "lasso",
  "polygonal-selection",
  "auto-mask",
  "crop",
]);

export interface ToolContextDeps {
  state: AppState;
  dispatch: React.Dispatch<AppAction>;
  rendererRef: React.RefObject<WebGPURenderer | null>;
  glLayersRef: React.RefObject<Map<string, GpuLayer>>;
  /** Pending new pixel layer — when a paint tool first stamps on a
   *  parametric layer (text/shape) it auto-creates a pixel layer and
   *  parks it here so buildCtx can target it before React re-renders
   *  with the new layer in state. */
  newPixelLayerRef: React.RefObject<GpuLayer | null>;
  toolOverlayRef: React.RefObject<HTMLCanvasElement | null>;
  canvasRef: React.RefObject<HTMLCanvasElement | null>;
  viewportRef: React.RefObject<HTMLDivElement | null>;
  pendingScrollRef: React.RefObject<{ scrollLeft: number; scrollTop: number } | null>;
  swatchesRef: React.RefObject<readonly RGBAColor[]>;
  /** Document size. */
  width: number;
  height: number;
  /** Mask map builder + ordered-layer builder. Owned by Canvas (used both
   *  here and by the render-plan builder). */
  buildMaskMap: () => Map<string, GpuLayer>;
  buildOrderedGLLayers: () => GpuLayer[];
  /** Render trigger. */
  doRender: () => void;
  /** Stroke commit callback. */
  onStrokeEndRef: React.RefObject<((label: string) => void) | undefined>;
  /** UI state setter for opening the inline text editor on a new text
   *  layer. */
  setEditingLayerId: (id: string | null) => void;
}

/** Convert primary/secondary colour into a grayscale value for mask-layer
 *  brushes (matches Photoshop's behaviour when painting onto a mask). */
function toGrayColor(c: RGBAColor): RGBAColor {
  const g = 0.299 * c.r + 0.587 * c.g + 0.114 * c.b;
  return { r: g, g: g, b: g, a: 1 };
}

export function useToolContext(deps: ToolContextDeps): () => ToolContext | null {
  // Mirror every input into a ref read on every call. This keeps the
  // returned callback identity stable while ensuring tools always observe
  // the latest state on every pointer event.
  const depsRef = useRef(deps);
  depsRef.current = deps;

  return useCallback((): ToolContext | null => {
    const d = depsRef.current;
    const { state, dispatch } = d;
    const renderer = d.rendererRef.current;
    if (!renderer) return null;

    const activeId = state.activeLayerId;
    const activeLayer = activeId
      ? d.glLayersRef.current.get(activeId)
      : undefined;

    // Tools that don't need an active pixel layer get to run anyway.
    if (!activeLayer && !NO_LAYER_TOOLS.has(state.activeTool)) {
      return null;
    }

    // Pixel-modifying tools are blocked on locked layers and on
    // parametric layers (text / shape / group / adjustment). Mask layers
    // are allowed — tools paint grayscale onto the mask buffer.
    if (TOOL_REGISTRY[state.activeTool].modifiesPixels) {
      const stateMeta = state.layers.find((l) => l.id === activeId);
      if (stateMeta && "locked" in stateMeta && stateMeta.locked) return null;
      const isParametric =
        stateMeta && "type" in stateMeta && stateMeta.type !== "mask";
      if (isParametric && !TOOL_REGISTRY[state.activeTool].worksOnAllLayers)
        return null;
    }

    const activeMeta = state.layers.find((l) => l.id === activeId);
    const isMaskLayer =
      activeMeta && "type" in activeMeta && activeMeta.type === "mask";

    return {
      scope: activeScope(),
      renderer,
      layer: activeLayer!,
      layers: d.buildOrderedGLLayers(),
      primaryColor: isMaskLayer
        ? toGrayColor(state.primaryColor)
        : state.primaryColor,
      secondaryColor: isMaskLayer
        ? toGrayColor(state.secondaryColor)
        : state.secondaryColor,
      selectionMask: activeScope().selection.mask,
      render: () => {
        d.doRender();
      },
      growLayerToFit: (
        canvasX: number,
        canvasY: number,
        extraRadius = 0,
      ): void => {
        // Mask layers are always full-canvas sized — never grow them.
        // Growing a mask shifts its existing pixel data to a non-zero
        // offset inside the new larger buffer, while new regions are
        // zero-initialized (R=0 = hide). The shader samples the mask at
        // canvas UV [0,1]², so a shifted/grown mask makes the parent layer
        // appear invisible ("squished mask" artifact).
        if (isMaskLayer) return;
        const W = renderer.pixelWidth;
        const H = renderer.pixelHeight;
        if (state.canvas.tiledMode) {
          // blendPixelOver applies the same wrap before bounds-checking
          // against the layer rect; the layer must cover the wrapped
          // destination, not the raw out-of-canvas input.
          canvasX = ((canvasX % W) + W) % W;
          canvasY = ((canvasY % H) + H) % H;
        } else {
          // Clamp to canvas bounds — painting outside the canvas should
          // not grow the layer beyond canvas dimensions.
          canvasX = Math.max(0, Math.min(W - 1, canvasX));
          canvasY = Math.max(0, Math.min(H - 1, canvasY));
        }
        renderer.growLayerToFit(activeLayer!, canvasX, canvasY, extraRadius);
      },
      setColor: (color: RGBAColor) => {
        dispatch({
          type: "SET_PRIMARY_COLOR",
          payload: isMaskLayer ? toGrayColor(color) : color,
        });
      },
      commitStroke: (label: string) => {
        d.onStrokeEndRef.current?.(label);
      },
      overlayCanvas: d.toolOverlayRef.current,
      addTextLayer: (ls) => {
        const cw = renderer.pixelWidth;
        const ch = renderer.pixelHeight;
        const gl = renderer.createLayer(ls.id, ls.name, cw, ch, 0, 0);
        rasterizeTextToLayer(ls, gl);
        renderer.flushLayer(gl);
        d.glLayersRef.current.set(ls.id, gl);
        d.doRender();
        dispatch({ type: "ADD_TEXT_LAYER", payload: ls });
        d.setEditingLayerId(ls.id);
      },
      updateTextLayer: (ls) => {
        dispatch({ type: "UPDATE_TEXT_LAYER", payload: ls });
      },
      openTextLayerEditor: (id) => {
        dispatch({ type: "SET_ACTIVE_LAYER", payload: id });
        d.setEditingLayerId(id);
      },
      textLayers: state.layers.filter(
        (l): l is TextLayerState => "type" in l && l.type === "text",
      ),
      previewTextAt: (ls, x, y) => {
        const gl = d.glLayersRef.current.get(ls.id);
        if (!gl) return;
        rasterizeTextToLayer({ ...ls, x, y }, gl);
        renderer.flushLayer(gl);
        d.doRender();
      },
      addShapeLayer: (ls) => {
        const cw = renderer.pixelWidth;
        const ch = renderer.pixelHeight;
        const gl = renderer.createLayer(ls.id, ls.name, cw, ch, 0, 0);
        rasterizeShapeToLayer(ls, gl, cw, ch, state.pixelFormat, state.swatches);
        renderer.flushLayer(gl);
        d.glLayersRef.current.set(ls.id, gl);
        d.doRender();
        dispatch({ type: "ADD_SHAPE_LAYER", payload: ls });
      },
      updateShapeLayer: (ls) => {
        dispatch({ type: "UPDATE_SHAPE_LAYER", payload: ls });
      },
      previewShapeLayer: (ls) => {
        const gl = d.glLayersRef.current.get(ls.id);
        if (!gl) return;
        const cw = renderer.pixelWidth;
        const ch = renderer.pixelHeight;
        rasterizeShapeToLayer(ls, gl, cw, ch, state.pixelFormat, state.swatches);
        renderer.flushLayer(gl);
        d.doRender();
      },
      shapeLayers: state.layers.filter(
        (l): l is ShapeLayerState => "type" in l && l.type === "shape",
      ),
      activeShapeLayer: (() => {
        const l = state.layers.find((l) => l.id === activeId);
        return l && "type" in l && l.type === "shape" ? l : null;
      })(),
      addPathLayer: (ls) => {
        const cw = renderer.pixelWidth;
        const ch = renderer.pixelHeight;
        const gl = renderer.createLayer(ls.id, ls.name, cw, ch, 0, 0);
        rasterizePathToLayer(ls, gl, cw, ch, state.pixelFormat);
        renderer.flushLayer(gl);
        d.glLayersRef.current.set(ls.id, gl);
        d.doRender();
        dispatch({ type: "ADD_PATH_LAYER", payload: ls });
      },
      updatePathLayer: (ls) => {
        dispatch({ type: "UPDATE_PATH_LAYER", payload: ls });
      },
      previewPathLayer: (ls) => {
        const gl = d.glLayersRef.current.get(ls.id);
        if (!gl) return;
        const cw = renderer.pixelWidth;
        const ch = renderer.pixelHeight;
        rasterizePathToLayer(ls, gl, cw, ch, state.pixelFormat);
        renderer.flushLayer(gl);
        d.doRender();
      },
      pathLayers: state.layers.filter(
        (l): l is PathLayerState => "type" in l && l.type === "path",
      ),
      activePathLayer: (() => {
        const l = state.layers.find((l) => l.id === activeId);
        return l && "type" in l && l.type === "path" ? l : null;
      })(),
      addFrameLayer: (ls) => {
        const cw = renderer.pixelWidth;
        const ch = renderer.pixelHeight;
        const gl = renderer.createLayer(ls.id, ls.name, cw, ch, 0, 0);
        rasterizeFrameToLayer(ls, gl, cw, ch);
        renderer.flushLayer(gl);
        d.glLayersRef.current.set(ls.id, gl);
        d.doRender();
        dispatch({ type: "ADD_FRAME_LAYER", payload: ls });
      },
      updateFrameLayer: (ls) => {
        dispatch({ type: "UPDATE_FRAME_LAYER", payload: ls });
      },
      previewFrameLayer: (ls) => {
        const gl = d.glLayersRef.current.get(ls.id);
        if (!gl) return;
        const cw = renderer.pixelWidth;
        const ch = renderer.pixelHeight;
        rasterizeFrameToLayer(ls, gl, cw, ch);
        renderer.flushLayer(gl);
        d.doRender();
      },
      frameLayers: state.layers.filter(
        (l): l is FrameLayerState => "type" in l && l.type === "frame",
      ),
      activeFrameLayer: (() => {
        const l = state.layers.find((l) => l.id === activeId);
        return l && "type" in l && l.type === "frame" ? l : null;
      })(),
      updateLinkedLayer: (ls) => {
        dispatch({ type: "UPDATE_LINKED_LAYER", payload: ls });
      },
      zoom: state.canvas.zoom,
      tiledMode: state.canvas.tiledMode,
      pixelFormat: state.pixelFormat as PixelFormat,
      swatches: d.swatchesRef.current as RGBAColor[],
      swatchGroups: state.swatchGroups,
      setSwatch: (index) => {
        dispatch({ type: "SET_ACTIVE_SWATCH", payload: index });
      },
      guides: state.canvas.guides,
      maskMap: d.buildMaskMap(),
      layerStates: state.layers,
      getGpuLayer: (id: string): GpuLayer | undefined =>
        d.glLayersRef.current.get(id),
      selectedLayerIds: state.selectedLayerIds,
      setActiveLayer: (id: string) => {
        dispatch({ type: "SET_ACTIVE_LAYER", payload: id });
      },
      setActiveTool: (t) => {
        dispatch({ type: "SET_TOOL", payload: t });
      },
      setCursor: (cursor: string) => {
        const c = d.canvasRef.current;
        if (c) c.style.cursor = cursor;
      },
      panViewport: (dxCss: number, dyCss: number) => {
        const vp = d.viewportRef.current;
        if (!vp) return;
        vp.scrollLeft += dxCss;
        vp.scrollTop += dyCss;
      },
      setZoom: (
        nextZoom: number,
        focus?: { canvasX: number; canvasY: number },
      ) => {
        const clamped = parseFloat(
          Math.max(0.05, Math.min(32, nextZoom)).toFixed(4),
        );
        const vp = d.viewportRef.current;
        const oldZoom = state.canvas.zoom;
        if (vp && focus && oldZoom > 0 && clamped !== oldZoom) {
          // Anchor the supplied canvas-space point so it stays at the same
          // viewport CSS-px location. Mirrors useScrollZoom's wheel formula.
          const dpr = window.devicePixelRatio;
          const anchorX =
            (d.width * oldZoom) / dpr +
            (focus.canvasX * oldZoom) / dpr -
            vp.scrollLeft;
          const anchorY =
            (d.height * oldZoom) / dpr +
            (focus.canvasY * oldZoom) / dpr -
            vp.scrollTop;
          const r = clamped / oldZoom;
          d.pendingScrollRef.current = {
            scrollLeft: (vp.scrollLeft + anchorX) * r - anchorX,
            scrollTop: (vp.scrollTop + anchorY) * r - anchorY,
          };
        }
        dispatch({ type: "SET_ZOOM", payload: clamped });
      },
    };
  }, []);
}
