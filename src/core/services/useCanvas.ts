import { useRef, useCallback } from "react";

export interface CanvasPointerPosition {
  x: number;
  y: number;
  pressure: number;
  shiftKey: boolean;
  altKey: boolean;
  timeStamp: number;
}

interface UseCanvasOptions {
  onPointerDown?: (pos: CanvasPointerPosition) => void;
  onPointerMove?: (pos: CanvasPointerPosition) => void;
  /**
   * Called instead of onPointerMove when pen/touch coalesced events are
   * available. Receives ALL positions for the batch so the handler can
   * accumulate CPU drawing and flush the GPU only once at the end.
   * Falls back to calling onPointerMove per-event when not provided.
   */
  onPointerMoveBatch?: (positions: CanvasPointerPosition[]) => void;
  onPointerUp?: (pos: CanvasPointerPosition) => void;
  /** Fires on every pointermove regardless of button state — for hover effects. */
  onHover?: (pos: CanvasPointerPosition) => void;
  /** Fires when the pointer leaves the canvas. */
  onLeave?: () => void;
  /**
   * When provided, subtract offset.x/y from the computed canvas coordinates.
   * Bounds checking is also skipped so tools receive out-of-bounds coords
   * (needed for tiled-mode wrap-around).
   */
  coordinateOffset?: { x: number; y: number };
  /**
   * Document pixel size. When the canvas backing buffer is smaller than the
   * document (e.g. zoom < 1, where we shrink the swapchain to viewport size),
   * pointer coordinates must still be reported in document space. If omitted,
   * the canvas backing buffer is assumed to equal the document.
   */
  documentWidth?: number;
  documentHeight?: number;
}

interface UseCanvasReturn {
  isDrawing: React.RefObject<boolean>;
  handlePointerDown: (e: React.PointerEvent<HTMLCanvasElement>) => void;
  handlePointerMove: (e: React.PointerEvent<HTMLCanvasElement>) => void;
  handlePointerUp: (e: React.PointerEvent<HTMLCanvasElement>) => void;
  handlePointerLeave: (e: React.PointerEvent<HTMLCanvasElement>) => void;
}

export function useCanvas({
  onPointerDown,
  onPointerMove,
  onPointerMoveBatch,
  onPointerUp,
  onHover,
  onLeave,
  coordinateOffset,
  documentWidth,
  documentHeight,
}: UseCanvasOptions): UseCanvasReturn {
  const isDrawing = useRef(false);

  const toCanvasPos = useCallback(
    (
      e: React.PointerEvent<HTMLCanvasElement>,
    ): CanvasPointerPosition | null => {
      const rect = e.currentTarget.getBoundingClientRect();
      // Always map pointer position to document-pixel space. The backing buffer
      // may be smaller than the document (zoom-out swapchain shrink), so we
      // cannot use canvas.width for the conversion.
      const docW = documentWidth ?? e.currentTarget.width;
      const docH = documentHeight ?? e.currentTarget.height;
      const scaleX = docW / rect.width;
      const scaleY = docH / rect.height;
      let x = Math.floor((e.clientX - rect.left) * scaleX);
      let y = Math.floor((e.clientY - rect.top) * scaleY);
      if (coordinateOffset) {
        x -= coordinateOffset.x;
        y -= coordinateOffset.y;
        // Skip bounds check in tiled mode — tools need out-of-bounds coords for wrap-around
      } else {
        if (x < 0 || y < 0 || x >= docW || y >= docH) return null;
      }
      return {
        x,
        y,
        pressure: e.pressure,
        shiftKey: e.shiftKey,
        altKey: e.altKey,
        timeStamp: e.timeStamp,
      };
    },
    [coordinateOffset, documentWidth, documentHeight],
  );

  /** Converts pointer position to canvas coords without bounds checking — used during active strokes. */
  const toRawPos = useCallback(
    (e: React.PointerEvent<HTMLCanvasElement>): CanvasPointerPosition => {
      const rect = e.currentTarget.getBoundingClientRect();
      const docW = documentWidth ?? e.currentTarget.width;
      const docH = documentHeight ?? e.currentTarget.height;
      const scaleX = docW / rect.width;
      const scaleY = docH / rect.height;
      const ox = coordinateOffset?.x ?? 0;
      const oy = coordinateOffset?.y ?? 0;
      return {
        x: Math.floor((e.clientX - rect.left) * scaleX) - ox,
        y: Math.floor((e.clientY - rect.top) * scaleY) - oy,
        pressure: e.pressure,
        shiftKey: e.shiftKey,
        altKey: e.altKey,
        timeStamp: e.timeStamp,
      };
    },
    [coordinateOffset, documentWidth, documentHeight],
  );

  const handlePointerDown = useCallback(
    (e: React.PointerEvent<HTMLCanvasElement>): void => {
      // Only respond to primary button / pen tip (button 0).
      // Wacom barrel buttons and eraser end fire button 2/5 — ignore them here.
      if (e.button !== 0) return;
      const pos = toCanvasPos(e);
      if (!pos) return;
      e.currentTarget.setPointerCapture(e.pointerId);
      isDrawing.current = true;
      onPointerDown?.(pos);
    },
    [toCanvasPos, onPointerDown],
  );

  const handlePointerMove = useCallback(
    (e: React.PointerEvent<HTMLCanvasElement>): void => {
      // Detect pen tip lifted without firing pointerup (known Wacom/tablet quirk).
      // e.buttons bit 0 = primary button / pen tip is currently pressed.
      if (isDrawing.current && !(e.buttons & 1)) {
        isDrawing.current = false;
        onPointerUp?.(toRawPos(e));
        return;
      }

      // Use coalesced events for pen/touch only. High-polling-rate mice (1000Hz+)
      // produce 16+ coalesced events per frame — each triggers a full WebGL flush/render
      // and tanks performance. Mouse events are already delivered once-per-frame by the
      // browser, so the primary event is sufficient for mouse input.
      const coalesced =
        e.nativeEvent.pointerType !== "mouse"
          ? e.nativeEvent.getCoalescedEvents?.()
          : null;
      if (coalesced && coalesced.length > 0) {
        const rect = e.currentTarget.getBoundingClientRect();
        const docW = documentWidth ?? e.currentTarget.width;
        const docH = documentHeight ?? e.currentTarget.height;
        const sx = docW / rect.width;
        const sy = docH / rect.height;
        const ox = coordinateOffset?.x ?? 0;
        const oy = coordinateOffset?.y ?? 0;
        const positions: CanvasPointerPosition[] = [];
        for (const ce of coalesced) {
          const pos: CanvasPointerPosition = {
            x: Math.floor((ce.clientX - rect.left) * sx) - ox,
            y: Math.floor((ce.clientY - rect.top) * sy) - oy,
            // Use primary event pressure for all coalesced samples — per-coalesced pressure
            // fluctuates at the hardware polling rate and causes visible size/opacity jitter.
            pressure: e.pressure,
            shiftKey: ce.shiftKey,
            altKey: ce.altKey,
            // Use the coalesced sample's own timestamp for correct velocity calculation;
            // coalesced events all fire in the same JS tick but have real hardware timestamps.
            timeStamp: ce.timeStamp,
          };
          onHover?.(pos);
          if (isDrawing.current) positions.push(pos);
        }
        if (positions.length > 0) {
          if (onPointerMoveBatch) {
            // Batch path: caller accumulates CPU drawing for all positions, then
            // does a single GPU flush+render at the end — critical for pen on 4K.
            onPointerMoveBatch(positions);
          } else {
            for (const pos of positions) onPointerMove?.(pos);
          }
        }
      } else {
        onHover?.(toRawPos(e));
        if (isDrawing.current) onPointerMove?.(toRawPos(e));
      }
    },
    [
      toCanvasPos,
      onPointerMove,
      onPointerMoveBatch,
      onPointerUp,
      onHover,
      coordinateOffset,
      documentWidth,
      documentHeight,
    ],
  );

  const handlePointerUp = useCallback(
    (e: React.PointerEvent<HTMLCanvasElement>): void => {
      // Only end the stroke on primary button / pen tip release.
      if (e.button !== 0) return;
      if (!isDrawing.current) return;
      isDrawing.current = false;
      onPointerUp?.(toRawPos(e));
    },
    [toRawPos, onPointerUp],
  );

  const handlePointerLeave = useCallback(
    (e: React.PointerEvent<HTMLCanvasElement>): void => {
      onLeave?.();
      if (!isDrawing.current) return;
      isDrawing.current = false;
      onPointerUp?.(toRawPos(e));
    },
    [toRawPos, onPointerUp, onLeave],
  );

  return {
    isDrawing,
    handlePointerDown,
    handlePointerMove,
    handlePointerUp,
    handlePointerLeave,
  };
}
