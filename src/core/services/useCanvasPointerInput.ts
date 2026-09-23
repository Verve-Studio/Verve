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
import { useEffect, useMemo, useRef } from "react";
import { useCanvas } from "@/core/services/useCanvas";
import { TOOL_REGISTRY } from "@/core/tools";
import type { ToolContext, ToolHandler, ToolPointerPos } from "@/core/tools";
import { cursorStore } from "@/ux/main/Canvas/cursorStore";
import type {
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
    onStrokeEndRef,
    brushCursorApi,
    updatePixelInfo,
  } = params;

  // ── onActivate ────────────────────────────────────────────────────────────
  // Fire onActivate on the current tool whenever the active tool or active
  // layer changes — gives tools like shape/frame a chance to draw their
  // edit overlay immediately (e.g. double-clicking a shape via the pick
  // tool drops straight into edit mode without an extra click).
  //
  // Always clear the tool-overlay canvas first so leftover handles / dashed
  // bounds / rubber-bands from the previous tool don't linger after a tool
  // switch. Tools that want overlay UI redraw it inside onActivate.
  useEffect(() => {
    if (!isActive) return;
    const ctx = buildCtx();
    if (ctx) {
      const overlay = ctx.overlayCanvas;
      if (overlay) {
        const o2d = overlay.getContext("2d");
        o2d?.clearRect(0, 0, overlay.width, overlay.height);
      }
      toolHandlerRef.current.onActivate?.(ctx);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeTool, activeLayerId, isActive]);

  // ── Stroke pinning ──────────────────────────────────────────────────────
  // The handler (and tool) that received pointer-down keeps receiving the
  // moves and the pointer-up of that stroke, even if the active tool changes
  // mid-stroke (keyboard shortcut while the pen is down). Otherwise the new
  // handler gets a pointer-up for a stroke it never started, and the old
  // one never finishes: Brush's build-up timer keeps stamping forever,
  // `strokeStart` is never paired with `strokeEnd`, Move leaves its text
  // layer hidden, and the history entry is recorded (or dropped) under the
  // wrong tool.
  //
  // The context built at pointer-down is kept too: if a live context can't
  // be built at pointer-up (layer deleted / locked / turned parametric), the
  // stroke is finished with the pinned one instead of being abandoned.
  const strokeRef = useRef<{
    handler: ToolHandler;
    tool: Tool;
    downCtx: ToolContext;
  } | null>(null);

  // While a stroke is in progress, swallow keyboard shortcuts (capture phase
  // on window runs before every other key handler). Undo / Delete / New
  // Layer / Paste mid-stroke used to swap or destroy the layer being painted
  // — leaving the stroke writing into a stale (possibly freed) buffer.
  // Modifier keys and Space (hand-tool panning) pass through.
  useEffect(() => {
    const PASS = new Set(["Shift", "Control", "Alt", "Meta", " ", "CapsLock"]);
    const onKey = (e: KeyboardEvent): void => {
      if (!strokeRef.current || PASS.has(e.key)) return;
      e.preventDefault();
      e.stopImmediatePropagation();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, []);
  const strokeHandler = (): ToolHandler =>
    strokeRef.current?.handler ?? toolHandlerRef.current;

  // ── Shared event handlers (factored so we can wire them to both canvases) ─
  const handleDown = (pos: ToolPointerPos): void => {
    const ctx = buildCtx();
    if (!ctx) return;
    strokeRef.current = {
      handler: toolHandlerRef.current,
      tool: activeTool,
      downCtx: ctx,
    };
    toolHandlerRef.current.onPointerDown(pos, ctx);
  };

  const handleMove = (pos: ToolPointerPos): void => {
    const ctx = buildCtx();
    if (ctx) strokeHandler().onPointerMove(pos, ctx);
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
    try {
      // The real `render` is passed through: `doRender` already coalesces
      // to one rAF per frame, and tools that keep the context (e.g. Brush
      // build-up ticks) must be able to render after the batch. A no-op
      // render here used to leak into those timers.
      const handler = strokeHandler();
      const def = TOOL_REGISTRY[strokeRef.current?.tool ?? activeTool];
      if (def.modifiesPixels || def.wantsCoalescedSamples) {
        for (const pos of positions) handler.onPointerMove(pos, ctx);
      } else {
        // Non-painting tools only need where the pointer is now.
        handler.onPointerMove(positions[positions.length - 1], ctx);
      }
    } finally {
      // Always end the batch (a throwing tool must not leave flushing off).
      // Uploads only the layers tools actually flushed, once each; indexed8
      // layers flushed without a palette get the document's swatches.
      renderer.endDeferFlush(ctx.swatches);
      ctx.render();
    }
  };

  const handleUp = (pos: ToolPointerPos): void => {
    const stroke = strokeRef.current;
    strokeRef.current = null;
    const handler = stroke?.handler ?? toolHandlerRef.current;
    const tool = stroke?.tool ?? activeTool;
    const renderer = rendererRef.current;
    let ctx = buildCtx();
    // The live context can be missing mid-stroke (active layer deleted,
    // locked, turned into a parametric/adjustment layer). Finish with the
    // pinned pointer-down context as long as its layer is still alive.
    if (
      (!ctx || (stroke && ctx.layer !== stroke.downCtx.layer)) &&
      stroke &&
      renderer?.isLayerLive(stroke.downCtx.layer)
    ) {
      ctx = stroke.downCtx;
    }
    let result: ReturnType<ToolHandler["onPointerUp"]> = undefined;
    let finished = false;
    try {
      if (ctx) {
        result = handler.onPointerUp(pos, ctx);
        finished = true;
      }
    } finally {
      if (!finished) {
        // Couldn't finish (no usable context, or the tool threw): stop the
        // tool's timers / per-stroke state and close the renderer stroke so
        // effects aren't left bypassed with a full re-composite per frame.
        try {
          handler.onCancel?.();
        } finally {
          if (renderer?.isStrokeActive) renderer.strokeEnd();
        }
      }
    }
    const def = TOOL_REGISTRY[tool];
    if (
      finished &&
      def.modifiesPixels &&
      !def.skipAutoHistory &&
      !result?.skipHistory
    ) {
      const label = tool.charAt(0).toUpperCase() + tool.slice(1);
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
      if (ctx) strokeHandler().onPointerMove(pos, ctx);
    },
    onPointerMoveBatch: handleMoveBatch,
    onPointerUp: handleUp,
    onHover: handleHover(true),
    onLeave: handleLeave,
    coordinateOffset: tiledOffset,
  });

  return { main, tiled };
}
