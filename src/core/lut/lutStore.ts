// ─── LUT registry (cross-document module singleton) ──────────────────────────
//
// Holds every LUT loaded into the running app: built-in baked transforms
// (HLG/Filmic/Rec2020/AgX→sRGB), user `.cube` files, OCIO-imported colour-
// space transforms. Effects and the display blit reference LUTs by id.

import type { LutCategory, LutPersisted, LutTransform } from "./LUT";

/** Resolve the UI grouping for a LUT, falling back to a sensible default
 *  based on its source when `category` isn't set explicitly. */
export function lutCategory(lut: LutTransform): LutCategory {
  if (lut.category) return lut.category;
  if (lut.source.kind === "cube-file") return "creative";
  if (lut.source.kind === "ocio") return "ocio";
  return "view-transform";
}

/** Display label for each category — used by the manager modal and the
 *  optgroup labels in dropdowns. */
export const LUT_CATEGORY_LABEL: Record<LutCategory, string> = {
  "view-transform": "View Transforms",
  "camera-idt": "Camera IDTs",
  creative: "Loaded LUTs",
  ocio: "OCIO",
};

type Listener = () => void;

const luts = new Map<string, LutTransform>();
const listeners = new Set<Listener>();

function emit(): void {
  for (const fn of listeners) fn();
}

export const lutStore = {
  /** Get a LUT by id (returns undefined if missing). */
  get(id: string): LutTransform | undefined {
    return luts.get(id);
  },

  /** All LUTs in registration order. */
  all(): LutTransform[] {
    return Array.from(luts.values());
  },

  /** Filter view — useful for the manager UI ("only OCIO", "only builtins"). */
  filter(pred: (lut: LutTransform) => boolean): LutTransform[] {
    return this.all().filter(pred);
  },

  /** Add or replace a LUT. */
  register(lut: LutTransform): void {
    luts.set(lut.id, lut);
    emit();
  },

  /** Remove by id. Built-ins refuse to delete (the manager UI should hide
   *  the delete affordance for them anyway). */
  unregister(id: string): boolean {
    const lut = luts.get(id);
    if (!lut) return false;
    if (lut.source.kind === "builtin") return false;
    luts.delete(id);
    emit();
    return true;
  },

  /** Subscribe to registry changes (manager modal, menu rebuild). */
  subscribe(listener: Listener): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },

  /** Snapshot for persistence — only metadata, since GPU tables are heavy
   *  and most sources can re-materialize on demand. */
  serialize(): LutPersisted[] {
    return this.all().map((l) => ({
      id: l.id,
      name: l.name,
      inputSpace: l.inputSpace,
      outputSpace: l.outputSpace,
      source: l.source,
    }));
  },
};
