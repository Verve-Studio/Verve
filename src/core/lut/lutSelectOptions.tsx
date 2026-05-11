// ─── Shared <select> options for LUT pickers ─────────────────────────────────
//
// Builds the optgroups for any `<select>` that lists every LUT in the
// store. Splits builtins into "View Transforms" + "Camera IDTs", then
// surfaces user-loaded `.cube` files and OCIO-imported colour spaces as
// separate groups so they're easy to scan.

import React from "react";
import {
  lutCategory,
  LUT_CATEGORY_LABEL,
  type LutCategory,
  type LutTransform,
} from "@/core/lut";

const ORDER: LutCategory[] = ["view-transform", "camera-idt", "creative", "ocio"];

export function LutSelectOptions({
  luts,
}: {
  luts: LutTransform[];
}): React.JSX.Element {
  const grouped = new Map<LutCategory, LutTransform[]>();
  for (const lut of luts) {
    const cat = lutCategory(lut);
    const list = grouped.get(cat) ?? [];
    list.push(lut);
    grouped.set(cat, list);
  }
  return (
    <>
      {ORDER.flatMap((cat) => {
        const list = grouped.get(cat);
        if (!list || list.length === 0) return [];
        return [
          <optgroup key={cat} label={LUT_CATEGORY_LABEL[cat]}>
            {list.map((l) => (
              <option key={l.id} value={l.id}>
                {l.name}
              </option>
            ))}
          </optgroup>,
        ];
      })}
    </>
  );
}
