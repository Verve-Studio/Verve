import type { FilterKey } from "@/types";
import type { EffectType } from "@/core/effects/effectTypes";
// Side-effecting import: registers all IPipelineEffect implementations into
// `effectRegistry` so the menu lists below see them at module-evaluation time.
import { effectRegistry } from "@/core/effects";

const adjustmentItems: Array<{
  type: EffectType;
  label: string;
  group?: string;
}> = [];
const effectsItems: Array<{
  type: EffectType;
  label: string;
  group?: string;
}> = [];
const filterItems: Array<{
  key: FilterKey;
  label: string;
  instant?: boolean;
  group?: string;
}> = [];

// Build the three menu lists from the central effect registry. Each effect's
// `menu.root` decides which menu it joins; `menu.submenu` becomes the group
// (used only for inserting separators between sub-sections).
for (const effect of effectRegistry.all()) {
  if (effect.menu.root === "adjustments") {
    adjustmentItems.push({
      type: effect.id as EffectType,
      label: effect.label,
      group: effect.menu.submenu,
    });
  } else if (effect.menu.root === "effects") {
    effectsItems.push({
      type: effect.id as EffectType,
      label: effect.label,
      group: effect.menu.submenu,
    });
  } else if (effect.menu.root === "filters") {
    filterItems.push({
      key: effect.id as FilterKey,
      label: effect.label,
      instant: effect.menu.instant,
      group: effect.menu.submenu,
    });
  }
}

/**
 * Pinned group order — groups appear in this order in their respective menu;
 * any group not listed sorts after the pinned ones in alphabetical order.
 * Within each group, items are alphabetised by label.
 */
const ADJUSTMENT_GROUP_ORDER = [
  "adj-tone",     // Brightness/Contrast, Curves, Auto Match
  "adj-color",    // Hue/Saturation, Color Balance, Temperature, Vibrance, Selective Color
  "adj-style",    // Black & White, Channel Mixer, Color Bias, Color Grading, Invert
  "adj-indexed",  // Reduce Colors, Color Dithering
];
const EFFECTS_GROUP_ORDER = [
  "fx-color",
  "fx-lenseffects",
  "fx-shadow",
  "fx-distortion",
];
const FILTER_GROUP_ORDER = [
  "blur",
  "sharpen",
  "noise",
  "stylize",
  "render",
  "texture",
];

/**
 * Bucket items by group, then return them flattened so each group's items
 * are contiguous (the consumers insert a separator whenever `group` changes).
 * Groups are emitted in the pinned-order list first, then any unknown groups
 * in alphabetical order. Within each group, items are alphabetised by label.
 */
function organiseMenu<T extends { group?: string; label: string }>(
  items: readonly T[],
  pinnedOrder: readonly string[],
): T[] {
  const buckets = new Map<string | undefined, T[]>();
  for (const item of items) {
    const arr = buckets.get(item.group) ?? [];
    arr.push(item);
    buckets.set(item.group, arr);
  }
  // Sort each bucket alphabetically by label (case-insensitive).
  const labelKey = (v: T): string => v.label.toLocaleLowerCase();
  for (const arr of buckets.values()) {
    arr.sort((a, b) => labelKey(a).localeCompare(labelKey(b)));
  }
  // Emit pinned groups first (in declared order), then any unknown groups
  // alphabetically. Items missing a group sink to the end.
  const known = new Set(pinnedOrder);
  const unknown = Array.from(buckets.keys())
    .filter(
      (g): g is string => typeof g === "string" && !known.has(g),
    )
    .sort();
  const groupOrder: Array<string | undefined> = [
    ...pinnedOrder.filter((g) => buckets.has(g)),
    ...unknown,
  ];
  if (buckets.has(undefined)) groupOrder.push(undefined);
  return groupOrder.flatMap((g) => buckets.get(g) ?? []);
}

export const ADJUSTMENT_MENU_ITEMS = organiseMenu(
  adjustmentItems,
  ADJUSTMENT_GROUP_ORDER,
);
export const EFFECTS_MENU_ITEMS = organiseMenu(
  effectsItems,
  EFFECTS_GROUP_ORDER,
);
export const FILTER_MENU_ITEMS = organiseMenu(
  filterItems,
  FILTER_GROUP_ORDER,
);
