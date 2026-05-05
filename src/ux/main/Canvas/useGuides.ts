import { useState, useEffect, useCallback, useRef } from "react";
import type { Dispatch } from "react";
import type { AppAction } from "@/core/store/AppContext";

export interface GuideDragPreview {
  axis: "h" | "v";
  position: number;
}

interface UseGuidesParams {
  dispatch: Dispatch<AppAction>;
  showRulers: boolean;
  showGuides: boolean;
  zoom: number;
  hRulerRef: React.RefObject<HTMLCanvasElement | null>;
  vRulerRef: React.RefObject<HTMLCanvasElement | null>;
  canvasWrapperRef: React.RefObject<HTMLDivElement | null>;
}

export function useGuides({
  dispatch,
  showRulers,
  showGuides,
  zoom,
  hRulerRef,
  vRulerRef,
  canvasWrapperRef,
}: UseGuidesParams): {
  dragPreview: GuideDragPreview | null;
  startGuideDrag: (
    e: React.PointerEvent,
    guideId: string,
    axis: "h" | "v",
  ) => void;
} {
  const [dragPreview, setDragPreview] = useState<GuideDragPreview | null>(null);

  // Keep latest values accessible from stable callbacks without recreating them
  const zoomRef = useRef(zoom);
  zoomRef.current = zoom;
  const dispatchRef = useRef(dispatch);
  dispatchRef.current = dispatch;
  const dragRef = useRef<{ axis: "h" | "v"; guideId: string | null } | null>(
    null,
  );

  /** Convert clientX/Y to canvas-document coordinates, and check if inside canvas. */
  const hitTest = useCallback(
    (clientX: number, clientY: number) => {
      const wrapper = canvasWrapperRef.current;
      if (!wrapper) return null;
      const rect = wrapper.getBoundingClientRect();
      const dpr = window.devicePixelRatio || 1;
      const cssPxPerDocPx = zoomRef.current / dpr;
      const docX = (clientX - rect.left) / cssPxPerDocPx;
      const docY = (clientY - rect.top) / cssPxPerDocPx;
      const inside =
        clientX >= rect.left &&
        clientX <= rect.right &&
        clientY >= rect.top &&
        clientY <= rect.bottom;
      return { docX, docY, inside };
    },
    [canvasWrapperRef],
  );

  /** Start a drag — called for both ruler-drag (new guide) and guide-element drag (move/delete). */
  const startDrag = useCallback(
    (axis: "h" | "v", guideId: string | null) => {
      dragRef.current = { axis, guideId };

      const onMove = (e: PointerEvent) => {
        const hit = hitTest(e.clientX, e.clientY);
        if (!hit || !dragRef.current) return;
        const position = dragRef.current.axis === "h" ? hit.docY : hit.docX;
        setDragPreview({ axis: dragRef.current.axis, position });
      };

      const onUp = (e: PointerEvent) => {
        document.removeEventListener("pointermove", onMove);
        document.removeEventListener("pointerup", onUp);

        const drag = dragRef.current;
        dragRef.current = null;
        setDragPreview(null);

        if (!drag) return;
        const hit = hitTest(e.clientX, e.clientY);
        const position = Math.round(
          drag.axis === "h" ? (hit?.docY ?? 0) : (hit?.docX ?? 0),
        );

        if (drag.guideId === null) {
          // New guide — only commit if dropped inside canvas
          if (hit?.inside) {
            dispatchRef.current({
              type: "ADD_GUIDE",
              payload: { id: `g${Date.now()}`, axis: drag.axis, position },
            });
          }
        } else {
          // Existing guide — delete if dragged off canvas, else move
          if (!hit?.inside) {
            dispatchRef.current({
              type: "DELETE_GUIDE",
              payload: drag.guideId,
            });
          } else {
            dispatchRef.current({
              type: "MOVE_GUIDE",
              payload: { id: drag.guideId, position },
            });
          }
        }
      };

      document.addEventListener("pointermove", onMove);
      document.addEventListener("pointerup", onUp);
    },
    [hitTest],
  );

  // Attach pointerdown handlers to ruler canvases when both rulers and guides are enabled
  useEffect(() => {
    if (!showRulers || !showGuides) return;
    const h = hRulerRef.current;
    const v = vRulerRef.current;
    if (!h || !v) return;

    const onHDown = (e: PointerEvent) => {
      if (e.button !== 0) return;
      h.setPointerCapture(e.pointerId);
      startDrag("h", null);
    };
    const onVDown = (e: PointerEvent) => {
      if (e.button !== 0) return;
      v.setPointerCapture(e.pointerId);
      startDrag("v", null);
    };

    h.addEventListener("pointerdown", onHDown);
    v.addEventListener("pointerdown", onVDown);
    return () => {
      h.removeEventListener("pointerdown", onHDown);
      v.removeEventListener("pointerdown", onVDown);
    };
  }, [showRulers, showGuides, hRulerRef, vRulerRef, startDrag]);

  /** Called from guide element onPointerDown to start moving an existing guide. */
  const startGuideDrag = useCallback(
    (e: React.PointerEvent, guideId: string, axis: "h" | "v") => {
      if (e.button !== 0) return;
      e.stopPropagation();
      (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
      startDrag(axis, guideId);
    },
    [startDrag],
  );

  return { dragPreview, startGuideDrag };
}
