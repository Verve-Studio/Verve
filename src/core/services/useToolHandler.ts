/**
 * Tool-handler lifecycle: keeps a single `ToolHandler` instance alive for
 * the active tool and runs the cleanup that should happen whenever the
 * tool changes.
 *
 * The cleanup is more involved than it looks:
 *   - Selection tools that paint a "pending" rect (marquee, lasso, magic
 *     wand, healing brush, patch) need their pending preview cleared when
 *     switching away.
 *   - In-progress polygonal selection is committed/cancelled.
 *   - Object-selection store is reset.
 *   - The CSS-circle brush cursor is hidden when leaving any "thick" tool.
 *   - The pencil's pixel preview cursor is hidden in all cases (re-shown
 *     by `onHover` when pencil becomes active again).
 *
 * The hook also returns the ref so callers (pointer-input hooks) can pass
 * the handler to `useCanvas`'s callbacks.
 */
import { useEffect, useRef } from "react";
import { TOOL_REGISTRY } from "@/core/tools";
import type { ToolHandler } from "@/core/tools";
import { activeScope } from "@/core/store/scope";
import type { Tool } from "@/types";

export interface ToolHandlerParams {
  isActive: boolean;
  activeTool: Tool;
  brushCursorRef: React.RefObject<HTMLDivElement | null>;
  pixelBrushCursorRef: React.RefObject<HTMLDivElement | null>;
  /** Base class name applied to the brush cursor — passed through so the
   *  hook doesn't depend on Canvas-specific CSS modules. */
  brushCursorBaseClass: string;
}

export interface ToolHandlerApi {
  toolHandlerRef: React.RefObject<ToolHandler>;
}

const CIRCLE_CURSOR_TOOLS: ReadonlySet<Tool> = new Set<Tool>([
  "brush",
  "eraser",
  "clone-stamp",
  "dodge",
  "burn",
  "liquify",
  "blur",
  "sharpen",
  "smudge",
  "healing-brush",
  "object-removal",
  "quick-select",
]);

const PENDING_SELECTION_TOOLS: ReadonlySet<Tool> = new Set<Tool>([
  "select",
  "lasso",
  "magic-wand",
  "patch",
  "healing-brush",
]);

export function useToolHandler(params: ToolHandlerParams): ToolHandlerApi {
  const {
    isActive,
    activeTool,
    brushCursorRef,
    pixelBrushCursorRef,
    brushCursorBaseClass,
  } = params;

  const toolHandlerRef = useRef<ToolHandler>(
    TOOL_REGISTRY[activeTool].createHandler(),
  );

  useEffect(() => {
    if (!isActive) return;
    const sel = activeTool;
    if (!PENDING_SELECTION_TOOLS.has(sel)) {
      activeScope().selection.setPending(null);
    }
    toolHandlerRef.current = TOOL_REGISTRY[sel].createHandler();
    // Cancel any in-progress polygonal selection when switching tools.
    activeScope().polygonalSelection.cancel();
    // Drop any leftover inpaint mask when switching away from object-removal
    // so the red overlay doesn't linger on top of unrelated tools.
    if (sel !== "object-removal") activeScope().inpaintMask.clear();
    // Hide the circle cursor when switching away from a circle-cursor tool.
    if (brushCursorRef.current) {
      if (!CIRCLE_CURSOR_TOOLS.has(sel)) {
        brushCursorRef.current.style.display = "none";
      }
      // Always reset the class so the clone-stamp crosshair class doesn't
      // linger when switching between circle-cursor tools.
      brushCursorRef.current.className = brushCursorBaseClass;
    }
    if (pixelBrushCursorRef.current) {
      pixelBrushCursorRef.current.style.display = "none";
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeTool, isActive]);

  return { toolHandlerRef };
}
