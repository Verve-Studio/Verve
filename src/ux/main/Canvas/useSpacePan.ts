import { useEffect, useRef } from "react";

/**
 * Spacebar + drag pans the canvas viewport.
 * Cursor and panning state are managed entirely imperatively — no React state
 * updates are triggered, so panning never causes a component re-render.
 */
export function useSpacePan(
  isActive: boolean,
  viewportRef: React.RefObject<HTMLDivElement | null>,
): void {
  const spaceDownRef = useRef(false);
  const panningRef = useRef(false);
  const startXRef = useRef(0);
  const startYRef = useRef(0);
  const startScrollXRef = useRef(0);
  const startScrollYRef = useRef(0);

  useEffect(() => {
    if (!isActive) return;

    const onKeyDown = (e: KeyboardEvent): void => {
      if (e.code !== "Space") return;
      if (
        e.target instanceof HTMLInputElement ||
        e.target instanceof HTMLTextAreaElement
      )
        return;
      e.preventDefault(); // always suppress — repeated keydowns scroll the viewport if not prevented
      if (spaceDownRef.current) return;
      spaceDownRef.current = true;
      const vp = viewportRef.current;
      if (vp) vp.style.cursor = "grab";
    };
    const onKeyUp = (e: KeyboardEvent): void => {
      if (e.code !== "Space") return;
      spaceDownRef.current = false;
      if (panningRef.current) {
        panningRef.current = false;
        const vp = viewportRef.current;
        if (vp) vp.style.cursor = "";
      } else {
        const vp = viewportRef.current;
        if (vp) vp.style.cursor = "";
      }
    };

    const onPointerDown = (e: PointerEvent): void => {
      if (!spaceDownRef.current) return;
      if (e.button !== 0) return;
      const vp = viewportRef.current;
      if (!vp) return;
      e.preventDefault();
      e.stopPropagation();
      panningRef.current = true;
      startXRef.current = e.clientX;
      startYRef.current = e.clientY;
      startScrollXRef.current = vp.scrollLeft;
      startScrollYRef.current = vp.scrollTop;
      vp.style.cursor = "grabbing";
      vp.setPointerCapture(e.pointerId);
    };

    const onPointerMove = (e: PointerEvent): void => {
      if (!panningRef.current) return;
      const vp = viewportRef.current;
      if (!vp) return;
      e.preventDefault();
      e.stopPropagation();
      vp.scrollLeft = startScrollXRef.current - (e.clientX - startXRef.current);
      vp.scrollTop = startScrollYRef.current - (e.clientY - startYRef.current);
    };

    const onPointerUp = (e: PointerEvent): void => {
      if (!panningRef.current) return;
      e.preventDefault();
      e.stopPropagation();
      panningRef.current = false;
      const vp = viewportRef.current;
      if (vp) vp.style.cursor = spaceDownRef.current ? "grab" : "";
    };

    const vp = viewportRef.current;
    if (!vp) return;

    document.addEventListener("keydown", onKeyDown);
    document.addEventListener("keyup", onKeyUp);
    // Use capture so we intercept before the canvas tool handlers
    vp.addEventListener("pointerdown", onPointerDown, { capture: true });
    vp.addEventListener("pointermove", onPointerMove, { capture: true });
    vp.addEventListener("pointerup", onPointerUp, { capture: true });

    return () => {
      document.removeEventListener("keydown", onKeyDown);
      document.removeEventListener("keyup", onKeyUp);
      vp.removeEventListener("pointerdown", onPointerDown, { capture: true });
      vp.removeEventListener("pointermove", onPointerMove, { capture: true });
      vp.removeEventListener("pointerup", onPointerUp, { capture: true });
    };
  }, [isActive, viewportRef]);
}
