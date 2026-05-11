
import { useEffect } from "react";
import { activeScope } from "@/core/store/scope";

export function usePolygonalSelection(): void {
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (!activeScope().polygonalSelection.isActive) return;
      if (e.key === "Escape") {
        e.stopPropagation();
        activeScope().polygonalSelection.cancel();
      } else if (e.key === "Backspace" || e.key === "Delete") {
        e.stopPropagation();
        e.preventDefault();
        activeScope().polygonalSelection.removeLastVertex();
      }
    };
    document.addEventListener("keydown", onKey, true);
    return () => document.removeEventListener("keydown", onKey, true);
  }, []);
}
