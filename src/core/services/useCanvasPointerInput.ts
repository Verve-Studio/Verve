/**
 * Wires the two `useCanvas` invocations the Canvas component needs:
 *   1. The main GPU canvas (normal coordinate space: [0, W) × [0, H)).
 *   2. The tiled-mode 3×3 canvas (coordinate space: [-W, 2W) × [-H, 2H),
 *      so the centre tile is at the origin).
 *
 * Both share identical handlers except:
 *   - The tiled path takes a `coordinateOffset` to shift hits into
 *     canvas-space.
 *   - The tiled `onHover` uses `tiled=true` when positioning the brush
 *     cursor so coords are translated into wrapper-space (wrapper sits
 *     at +W, +H in tiled mode).
 *
 * Encapsulated here:
 *   - The coalesced pointer-move batch optimisation (`deferFlush`).
 *   - Brush-cursor + pencil-cursor + pixel-info side effects on hover.
 *   - `onActivate` propagation when the tool or active layer changes.
 *   - Auto stroke commit on pointer-up for pixel-modifying tools.
 *
 * Returned handlers are wired to the two canvases in Canvas.tsx's JSX.
 */
import { useEffect, useMemo } from "react";
import { useCanvas } from "@/core/services/useCanvas";
import { TOOL_REGISTRY } from "@/core/tools";
import type { ToolContext, ToolHandler, ToolPointerPos } from "@/core/tools";
import { cursorStore } from "@/ux/main/Canvas/cursorStore";
import type {
  GpuLayer,
  WebGPURenderer,
} from "@/graphics/webgpu/rendering/WebGPURenderer";
import type { Tool } from "@/types";
import type { BrushCursorApi } from "./useBrushCursor";
import type { CursorPixelInfoUpdate } from "./useCursorPixelInfo";

export interface CanvasPointerInputParams {
  isActive: boolean;
  width: number;
  height: number;
  activeTool: Tool;
  /** Used by `onActivate` effect — re-fires when this changes so tools
   *  like shape/frame can draw their edit overlay immediately. */
  activeLayerId: string | null;
  toolHandlerRef: React.RefObject<ToolHandler>;
  rendererRef: React.RefObject<WebGPURenderer | null>;
  /** Build a fresh `ToolContext` for the current pointer event. */
  buildCtx: () => ToolContext | null;
  /** Cleared on pointer-up so the next stroke targets the React layer. */
  newPixelLayerRef: React.RefObject<GpuLayer | null>;
  /** Stroke-end notification. */
  onStrokeEndRef: React.RefObject<((label: string) => void) | undefined>;
  /** Cursor side-effect APIs. */
  brushCursorApi: BrushCursorApi;
  updatePixelInfo: CursorPixelInfoUpdate;
}

export interface CanvasPointerInputHandlers {
  /** Wire onto the main GPU canvas. */
  main: ReturnType<typeof useCanvas>;
  /** Wire onto the tiled-mode overlay canvas. */
  tiled: ReturnType<typeof useCanvas>;
}

export function useCanvasPointerInput(
  params: CanvasPointerInputParams,
): CanvasPointerInputHandlers {
  const {
    isActive,
    width,
    height,
    activeTool,
    activeLayerId,
    toolHandlerRef,
    rendererRef,
    buildCtx,
    newPixelLayerRef,
    onStrokeEndRef,
    brushCursorApi,
    updatePixelInfo,
  } = params;

  // ── onActivate ────────────────────────────────────────────────────────────
  // Fire onActivate on the current tool whenever the active tool or active
  // layer changes — gives tools like shape/frame a chance to draw their
  // edit overlay immediately (e.g. double-clicking a shape via the pick
  // tool drops straight into edit mode without an extra click).
  useEffect(() => {
    if (!isActive) return;
    const ctx = buildCtx();
    if (ctx) toolHandlerRef.current.onActivate?.(ctx);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeTool, activeLayerId, isActive]);

  // ── Shared event handlers (factored so we can wire them to both canvases) ─
  const handleDown = (pos: ToolPointerPos): void => {
    const ctx = buildCtx();
    if (ctx) toolHandlerRef.current.onPointerDown(pos, ctx);
  };

  const handleMove = (pos: ToolPointerPos): void => {
    const ctx = buildCtx();
    if (ctx) toolHandlerRef.current.onPointerMove(pos, ctx);
    updatePixelInfo(pos);
  };

  const handleMoveBatch = (positions: ToolPointerPos[]): void => {
    // Pen coalesced-event batch: accumulate all CPU drawing first, then do
    // a single GPU texture upload + composite render at the end. Reduces
    // GPU work from N×(flushLayer + render) to 1×(flushLayer + render)
    // per display frame — critical for Wacom pens on large (4K) canvases.
    const renderer = rendererRef.current;
    const ctx = buildCtx();
    if (!ctx || !renderer) return;
    renderer.deferFlush = true;
    const noopRender = (): void => {
      /* deferred */
    };
    for (const pos of positions) {
      toolHandlerRef.current.onPointerMove(pos, {
        ...ctx,
        render: noopRender,
      });
    }
    renderer.deferFlush = false;
    renderer.flushLayer(ctx.layer);
    ctx.render();
  };

  const handleUp = (pos: ToolPointerPos): void => {
    const ctx = buildCtx();
    if (ctx) toolHandlerRef.current.onPointerUp(pos, ctx);
    newPixelLayerRef.current = null;
    const def = TOOL_REGISTRY[activeTool];
    if (def.modifiesPixels && !def.skipAutoHistory && ctx) {
      const label = activeTool.charAt(0).toUpperCase() + activeTool.slice(1);
      onStrokeEndRef.current?.(label);
    }
  };

  const handleHover = (tiled: boolean) => (pos: ToolPointerPos): void => {
    if (isActive) cursorStore.setPosition(pos.x, pos.y);
    brushCursorApi.updateCircleCursor(pos, tiled);
    // Pencil cursor uses raw (non-tiled) coords because it operates in
    // canvas-space too — the wrapper offset matches.
    brushCursorApi.updatePencilCursor(pos);
    const ctx = buildCtx();
    if (ctx) toolHandlerRef.current.onHover?.(pos, ctx);
  };

  const handleLeave = (): void => {
    const ctx = buildCtx();
    if (ctx) toolHandlerRef.current.onLeave?.(ctx);
  };

  // Stable offset object for the tiled canvas second useCanvas call —
  // useCanvas captures this via the deps; if we re-create it every render
  // the listener re-binds.
  const tiledOffset = useMemo(() => ({ x: width, y: height }), [width, height]);

  const main = useCanvas({
    onPointerDown: handleDown,
    onPointerMove: handleMove,
    onPointerMoveBatch: handleMoveBatch,
    onPointerUp: handleUp,
    onHover: handleHover(false),
    onLeave: handleLeave,
    documentWidth: width,
    documentHeight: height,
  });

  const tiled = useCanvas({
    onPointerDown: handleDown,
    onPointerMove: (pos) => {
      const ctx = buildCtx();
      if (ctx) toolHandlerRef.current.onPointerMove(pos, ctx);
    },
    onPointerMoveBatch: handleMoveBatch,
    onPointerUp: handleUp,
    onHover: handleHover(true),
    onLeave: handleLeave,
    coordinateOffset: tiledOffset,
  });

  return { main, tiled };
}
