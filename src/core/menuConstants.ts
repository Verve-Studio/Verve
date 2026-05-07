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
 * Stable bucket-by-group: items with the same `group` key become contiguous,
 * preserving group order by first appearance and within-group registration
 * order. Without this the consumers' "insert separator when group changes"
 * logic produces duplicate sections for any group whose effects are scattered
 * across the registration order (e.g. Bloom + Halation both `fx-lenseffects`
 * but registered with other groups between them).
 */
function groupContiguous<T extends { group?: string }>(items: readonly T[]): T[] {
  const groupOrder: Array<string | undefined> = [];
  const buckets = new Map<string | undefined, T[]>();
  for (const item of items) {
    let bucket = buckets.get(item.group);
    if (!bucket) {
      bucket = [];
      buckets.set(item.group, bucket);
      groupOrder.push(item.group);
    }
    bucket.push(item);
  }
  return groupOrder.flatMap((g) => buckets.get(g) ?? []);
}

export const ADJUSTMENT_MENU_ITEMS = groupContiguous(adjustmentItems);
export const EFFECTS_MENU_ITEMS = groupContiguous(effectsItems);
export const FILTER_MENU_ITEMS = groupContiguous(filterItems);
