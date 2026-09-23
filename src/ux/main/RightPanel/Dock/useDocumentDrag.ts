import { useCallback, useEffect, useRef } from "react";

/**
 * Document-level mouse drag tracking with guaranteed cleanup. The listeners
 * are removed on mouseup, when a move arrives with the primary button
 * already released (mouseup lost outside the window), on window blur, and
 * when the owning component unmounts mid-drag — so no stale listener keeps
 * writing to the dock store for an id that no longer exists.
 *
 * `onEnd` receives the last known mouse event, or null when the drag was
 * cut short by unmount / blur (callers typically commit or discard then).
 */
export function useDocumentDrag(): (
  onMove: (e: MouseEvent) => void,
  onEnd: (e: MouseEvent | null) => void,
) => void {
  const cleanupRef = useRef<(() => void) | null>(null);

  useEffect(
    () => () => {
      cleanupRef.current?.();
    },
    [],
  );

  return useCallback((onMove, onEnd) => {
    cleanupRef.current?.();
    let ended = false;
    const finish = (e: MouseEvent | null): void => {
      if (ended) return;
      ended = true;
      document.removeEventListener("mousemove", handleMove);
      document.removeEventListener("mouseup", handleUp);
      window.removeEventListener("blur", handleBlur);
      cleanupRef.current = null;
      onEnd(e);
    };
    const handleMove = (e: MouseEvent): void => {
      if (!(e.buttons & 1)) {
        finish(e);
        return;
      }
      onMove(e);
    };
    const handleUp = (e: MouseEvent): void => finish(e);
    const handleBlur = (): void => finish(null);
    document.addEventListener("mousemove", handleMove);
    document.addEventListener("mouseup", handleUp);
    window.addEventListener("blur", handleBlur);
    cleanupRef.current = () => {
      // Unmount: drop the listeners without committing into the store.
      ended = true;
      document.removeEventListener("mousemove", handleMove);
      document.removeEventListener("mouseup", handleUp);
      window.removeEventListener("blur", handleBlur);
      cleanupRef.current = null;
    };
  }, []);
}
