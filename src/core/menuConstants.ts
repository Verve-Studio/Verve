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

export const ADJUSTMENT_MENU_ITEMS = adjustmentItems;
export const EFFECTS_MENU_ITEMS = effectsItems;
export const FILTER_MENU_ITEMS = filterItems;
