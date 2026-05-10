// ─── LUT subsystem barrel ────────────────────────────────────────────────────
//
// Importing this module registers every built-in LUT in `lutStore`. The
// adjustment effect, view-transform UI, and manager modal all consume from
// the store.

import { getBuiltInLuts } from "./bakedLuts";
import { lutStore } from "./lutStore";

let bootstrapped = false;
function bootstrap(): void {
  if (bootstrapped) return;
  bootstrapped = true;
  for (const lut of getBuiltInLuts()) lutStore.register(lut);
}

bootstrap();

export { lutStore, lutCategory, LUT_CATEGORY_LABEL } from "./lutStore";
export { ensureLutOnGpu, evictLut } from "./lutGpu";
export { parseCubeLut } from "./parseCubeLut";
export type {
  LutTransform,
  LutColorSpace,
  LutCategory,
  CubeLut,
  ShaperLut,
  LutPersisted,
} from "./LUT";
