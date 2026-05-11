import type { IPipelineEffect, MenuRoot } from "./IPipelineEffect";

// Stored as `any` because the registry erases the specific layer/op generics
// at the boundary — the runtime guarantee that `effect.id === entry.kind ===
// layer.effectType` is what makes the dispatch sound. Each effect's own
// type signature is preserved at its definition site.
type AnyEffect = IPipelineEffect<any, any>;

const effects = new Map<string, AnyEffect>();

export const effectRegistry = {
  register(effect: AnyEffect): void {
    if (effects.has(effect.id)) {
      console.warn(`[effectRegistry] duplicate registration: ${effect.id}`);
    }
    effects.set(effect.id, effect);
  },

  get(id: string): AnyEffect | undefined {
    return effects.get(id);
  },

  has(id: string): boolean {
    return effects.has(id);
  },

  all(): readonly AnyEffect[] {
    return Array.from(effects.values());
  },

  byMenuRoot(root: MenuRoot): readonly AnyEffect[] {
    return Array.from(effects.values()).filter((e) => e.menu.root === root);
  },
};
