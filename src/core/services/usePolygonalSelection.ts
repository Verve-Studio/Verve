import { polygonalSelectionStore } from "@/core/store/polygonalSelectionStore";
import { useEffect } from "react";

export function usePolygonalSelection(): void {
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (!polygonalSelectionStore.isActive) return;
      if (e.key === "Escape") {
        e.stopPropagation();
        polygonalSelectionStore.cancel();
      } else if (e.key === "Backspace" || e.key === "Delete") {
        e.stopPropagation();
        e.preventDefault();
        polygonalSelectionStore.removeLastVertex();
      }
    };
    document.addEventListener("keydown", onKey, true);
    return () => document.removeEventListener("keydown", onKey, true);
  }, []);
}
