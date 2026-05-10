// ─── LUT loading & management actions ────────────────────────────────────────
//
// Handles user-initiated load/import flows for the LUT subsystem:
//   - Pick a `.cube` from disk and register it with `lutStore`.
//   - Set the active view-transform LUT.
//   - Remove a user LUT (built-ins refuse via the store).

import { useCallback } from "react";
import { lutStore, parseCubeLut, type LutTransform } from "@/core/lut";
import { displayStore } from "@/ux/main/Canvas/displayStore";

type Notify = (msg: string, kind?: "info" | "error") => void;

export function useLutOps(notify?: Notify): {
  loadCubeLut: () => Promise<void>;
  setViewTransform: (id: string | null) => void;
  removeLut: (id: string) => void;
} {
  const note = useCallback(
    (msg: string, kind: "info" | "error" = "info") => {
      notify?.(msg, kind);
      if (!notify) {
        if (kind === "error") console.error(msg);
        else console.info(msg);
      }
    },
    [notify],
  );

  const loadCubeLut = useCallback(async (): Promise<void> => {
    // Drive picker from the main process — Chromium's
    // `<input type=file>.click()` requires a continuous user-activation
    // chain that menu animations sometimes break, leading to the
    // "File chooser dialog can only be shown with a user activation"
    // error. The Electron dialog has no such constraint.
    const picked = await window.api.pickCubeLutFiles();
    if (!picked || picked.length === 0) return;
    let added = 0;
    for (const f of picked) {
      try {
        const parsed = parseCubeLut(f.text);
        if (!parsed.cube) {
          note(`${f.name}: 1D LUTs are not supported standalone`, "error");
          continue;
        }
        const stem = f.name.replace(/\.cube$/i, "");
        const id = `cube:${stem}:${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        const lut: LutTransform = {
          id,
          name: parsed.title ?? stem,
          inputSpace: "srgb",
          outputSpace: "srgb",
          shaper: parsed.shaper,
          cube: parsed.cube,
          source: { kind: "cube-file", path: f.name },
        };
        lutStore.register(lut);
        added++;
      } catch (err) {
        note(
          `${f.name}: failed to parse — ${(err as Error).message}`,
          "error",
        );
      }
    }
    if (added > 0) note(`Loaded ${added} LUT${added > 1 ? "s" : ""}`);
  }, [note]);

  const setViewTransform = useCallback((id: string | null): void => {
    displayStore.setViewTransformLut(id);
  }, []);

  const removeLut = useCallback((id: string): void => {
    if (displayStore.viewTransformLutId === id) {
      displayStore.setViewTransformLut(null);
    }
    lutStore.unregister(id);
  }, []);

  return { loadCubeLut, setViewTransform, removeLut };
}
