// Registry-wide invariants for every registered pipeline effect (CLAUDE.md
// "Effects, adjustments, filters"): identity and menu placement, the
// declarative `paramFields` schema against `defaultParams`, and the
// purity / identity-stability of `buildPlanEntry` that the render cache
// keys (`rendering/cacheKeys.ts`) rely on.

import { readFileSync } from "fs";
import { resolve } from "path";
import { describe, expect, it, vi } from "vitest";
import { effectRegistry } from "@/core/effects";
import type { IPipelineEffect, PlanContext } from "@/core/effects/IPipelineEffect";
import type { EffectParamField } from "@/core/effects/_shared/effectParams";
import { serializeAdjOpStatic } from "@/graphics/webgpu/rendering/cacheKeys";
import type { GpuLayer } from "@/graphics/webgpu/rendering/WebGPURenderer";
import type { ParamValue } from "@/core/params/paramTypes";
import type { RGBAColor } from "@/types";
import { SRC_DIR } from "@tests/paths";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyEffect = IPipelineEffect<any, any>;
type Params = Record<string, unknown>;

const effects = effectRegistry.all() as AnyEffect[];
const byId = effects.map((e) => [e.id, e] as const);

function deepFreeze<T>(o: T): T {
  if (o && typeof o === "object" && !Object.isFrozen(o)) {
    Object.freeze(o);
    for (const v of Object.values(o as object)) deepFreeze(v);
  }
  return o;
}

function makeLayer(effect: AnyEffect, params: unknown = effect.defaultParams, extra: Params = {}) {
  return {
    id: `adj-${effect.id}`,
    name: effect.label,
    visible: true,
    type: "adjustment" as const,
    parentId: "parent",
    effectType: effect.id,
    // Same construction as useAdjustments.addEffect.
    params: params === effect.defaultParams ? { ...(effect.defaultParams as Params) } : params,
    hasMask: false,
    ...extra,
  };
}

const SWATCHES: RGBAColor[] = [
  { r: 255, g: 0, b: 0, a: 255 },
  { r: 0, g: 0, b: 255, a: 255 },
  { r: 30, g: 200, b: 40, a: 255 },
];

function ctx(over: Partial<PlanContext> = {}): PlanContext {
  return { swatches: SWATCHES, mask: undefined, resolveLayer: () => undefined, ...over };
}

const fakeMask = { id: "mask", contentVersion: 3 } as unknown as GpuLayer;

/** A value for `field` different from `current`, valid for its spec. */
function otherValue(field: EffectParamField<unknown>, current: ParamValue): ParamValue | undefined {
  const s = field.spec;
  switch (s.kind) {
    case "float":
    case "int": {
      const cur = current as number;
      const lo = s.min ?? cur - 10;
      const hi = s.max ?? cur + 10;
      if (lo === hi) return undefined;
      // Midpoint-ish value that differs from the current one.
      let v = s.kind === "int" ? Math.round((lo + hi) / 2) : lo + (hi - lo) * 0.37;
      if (v === cur) v = cur === hi ? lo : hi;
      return v;
    }
    case "bool":
      return !current;
    case "enum": {
      const o = s.options.find((x) => x.value !== current);
      return o?.value;
    }
    case "color": {
      const c = current as readonly number[];
      return c[0] > 0.5 ? [0, 0.2, 0.4, 1] : [1, 0.6, 0.2, 1];
    }
    case "vec2": {
      const [x, y] = current as readonly [number, number];
      return [x + 0.25, y - 0.25];
    }
    case "string":
      // Free text is effect-specific (e.g. curve points); the placeholder
      // shows a valid example.
      return s.placeholder !== undefined && s.placeholder !== current ? s.placeholder : undefined;
    default:
      return undefined;
  }
}

describe("effect registry", () => {
  it("registers every effect in effectTypes' EffectParamsMap and nothing else", () => {
    const src = readFileSync(resolve(SRC_DIR, "core/effects/effectTypes.ts"), "utf8");
    const block = /interface EffectParamsMap\s*\{([\s\S]*?)\n\}/.exec(src)![1];
    const declared = [...block.matchAll(/^\s*"?([\w-]+)"?\s*:/gm)].map((m) => m[1]);
    expect(declared.length).toBeGreaterThan(50);
    expect(effects.map((e) => e.id).sort()).toEqual([...declared].sort());
  });

  it("index.ts registers each effect exactly once (no duplicate-registration warning)", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.resetModules();
    const fresh = await import("@/core/effects");
    expect(warn).not.toHaveBeenCalled();
    expect(fresh.effectRegistry.all().length).toBe(effects.length);
  });

  it("has unique ids and labels", () => {
    const ids = effects.map((e) => e.id);
    expect(new Set(ids).size).toBe(ids.length);
    const labels = effects.map((e) => e.label);
    expect(new Set(labels).size).toBe(labels.length);
  });

  it("byMenuRoot partitions the registry", () => {
    const roots = ["adjustments", "effects", "filters"] as const;
    const total = roots.reduce((n, r) => n + effectRegistry.byMenuRoot(r).length, 0);
    expect(total).toBe(effects.length);
    expect(effectRegistry.get("no-such-effect")).toBeUndefined();
    expect(effectRegistry.has("curves")).toBe(true);
  });

  describe.each(byId)("%s", (_id, effect) => {
    it("declares a valid identity, menu placement and UI", () => {
      expect(effect.id).toMatch(/^[a-z][a-z0-9-]*$/);
      expect(effect.label.trim()).not.toBe("");
      expect(["adjustments", "effects", "filters"]).toContain(effect.menu.root);
      if (effect.menu.submenu !== undefined) expect(effect.menu.submenu).toMatch(/\S/);
      // Opening the layer needs a panel unless a dedicated editor handles it.
      expect(effect.Panel !== undefined || effect.openEditor !== undefined).toBe(true);
      expect(typeof effect.buildPlanEntry).toBe("function");
      expect(typeof effect.encode).toBe("function");
      expect(effect.defaultParams).toBeTypeOf("object");
    });

    it("builds a well-formed plan entry from a layer created without its panel", () => {
      const layer = deepFreeze(makeLayer(effect));
      const entry = effect.buildPlanEntry(layer, ctx({ swatches: [] }));
      expect(entry.kind).toBe(effect.id);
      expect(entry.layerId).toBe(layer.id);
      expect(entry.visible).toBe(true);
      expect(entry.selMaskLayer).toBeUndefined();
      expect(entry.params).toEqual(layer.params);
      expect(() => serializeAdjOpStatic(entry)).not.toThrow();

      const hidden = effect.buildPlanEntry(deepFreeze(makeLayer(effect, layer.params, { visible: false })), ctx());
      expect(hidden.visible).toBe(false);
      const masked = effect.buildPlanEntry(layer, ctx({ mask: fakeMask }));
      expect(masked.selMaskLayer).toBe(fakeMask);
    });

    it("buildPlanEntry is pure and identity-stable (WeakMap rule)", () => {
      const layer = deepFreeze(makeLayer(effect));
      const c = ctx();
      const a = effect.buildPlanEntry(layer, c);
      // The reducer recreates the layer object on unrelated edits; params
      // keep their identity. Derived fields must too.
      const b = effect.buildPlanEntry(deepFreeze({ ...layer }), c);
      expect(b).toEqual(a);
      for (const [k, v] of Object.entries(a as Params)) {
        if (v !== null && typeof v === "object") {
          expect((b as Params)[k], `field '${k}' must be identity-stable across frames`).toBe(v);
        }
      }
      expect(serializeAdjOpStatic(b)).toBe(serializeAdjOpStatic(a));
    });

    const fields = (effect.paramFields ?? []) as readonly EffectParamField<unknown>[];
    if (fields.length === 0) return;

    it("paramFields have unique ids and specs consistent with defaultParams", () => {
      const ids = fields.map((f) => f.id);
      expect(new Set(ids).size).toBe(ids.length);
      const defaults = deepFreeze(effect.defaultParams);
      for (const f of fields) {
        const where = `${effect.id}.${f.id}`;
        expect(f.label.trim(), where).not.toBe("");
        const v = f.get(defaults);
        const s = f.spec;
        switch (s.kind) {
          case "float":
          case "int":
            expect(typeof v, where).toBe("number");
            expect(Number.isFinite(v), where).toBe(true);
            if (s.min !== undefined && s.max !== undefined) expect(s.min, where).toBeLessThanOrEqual(s.max);
            if (s.min !== undefined) expect(v as number, `${where} default below min`).toBeGreaterThanOrEqual(s.min);
            if (s.max !== undefined) expect(v as number, `${where} default above max`).toBeLessThanOrEqual(s.max);
            if (s.kind === "int") expect(Number.isInteger(v), `${where} int default`).toBe(true);
            break;
          case "enum": {
            const values = s.options.map((o) => o.value);
            expect(values.length, where).toBeGreaterThan(0);
            expect(new Set(values).size, `${where} duplicate options`).toBe(values.length);
            expect(values, `${where} default not an option`).toContain(v);
            break;
          }
          case "bool":
            expect(typeof v, where).toBe("boolean");
            break;
          case "color":
            expect((v as readonly number[]).length, where).toBe(4);
            for (const c of v as readonly number[]) {
              expect(c, where).toBeGreaterThanOrEqual(0);
              expect(c, where).toBeLessThanOrEqual(1);
            }
            break;
          case "vec2":
            expect((v as readonly number[]).every(Number.isFinite), where).toBe(true);
            break;
          default:
            break;
        }
      }
    });

    it("paramFields round-trip without mutating params", () => {
      const defaults = deepFreeze(effect.defaultParams);
      for (const f of fields) {
        const v = f.get(defaults);
        const same = f.set(defaults, v);
        expect(f.get(same), `${effect.id}.${f.id}`).toEqual(v);
        const next = otherValue(f, v);
        if (next === undefined) continue;
        const changed = f.set(defaults, next);
        expect(changed, `${effect.id}.${f.id} set must return a new object`).not.toBe(defaults);
        const got = f.get(changed);
        if (f.spec.kind === "color") {
          (got as readonly number[]).forEach((c, i) => expect(c).toBeCloseTo((next as readonly number[])[i], 2));
        } else {
          expect(got, `${effect.id}.${f.id}`).toEqual(next);
        }
      }
    });

    it("numeric paramFields keep out-of-range writes inside their declared range", () => {
      // Some fields narrow the range further per mode (Time of Day's
      // darkness), so only containment is required.
      const defaults = deepFreeze(effect.defaultParams);
      for (const f of fields) {
        const s = f.spec;
        if (s.kind !== "float" && s.kind !== "int") continue;
        const where = `${effect.id}.${f.id}`;
        for (const probe of [-1e6, 1e6, NaN]) {
          const v = f.get(f.set(defaults, probe)) as number;
          expect(Number.isFinite(v), where).toBe(true);
          if (s.min !== undefined) expect(v, where).toBeGreaterThanOrEqual(s.min);
          if (s.max !== undefined) expect(v, where).toBeLessThanOrEqual(s.max);
          if (s.kind === "int") expect(Number.isInteger(v), where).toBe(true);
        }
      }
    });

    it("every user-facing param reaches the render-cache key", () => {
      // A param edit that doesn't change the op's cache key would never
      // re-render the cached adjustment-group output.
      const defaults = deepFreeze(effect.defaultParams);
      const base = serializeAdjOpStatic(effect.buildPlanEntry(makeLayer(effect, defaults), ctx()));
      for (const f of fields) {
        const next = otherValue(f, f.get(defaults));
        if (next === undefined) continue;
        const params = deepFreeze(f.set(defaults, next));
        const key = serializeAdjOpStatic(effect.buildPlanEntry(makeLayer(effect, params), ctx()));
        expect(key, `${effect.id}.${f.id}`).not.toBe(base);
      }
    });
  });
});

describe("effects with panel-derived params work headless", () => {
  // Their plan entries read params the panel computes (a palette, image
  // statistics); automation creates them without a panel.
  it.each(["reduce-colors", "auto-match"])("%s implements prepareHeadless", (id) => {
    expect(effectRegistry.get(id)!.prepareHeadless).toBeTypeOf("function");
  });

  it("reduce-colors: palette mode needs nothing, reduce mode without pixels keeps params", async () => {
    const effect = effectRegistry.get("reduce-colors")! as AnyEffect;
    const read = vi.fn().mockResolvedValue(null);
    const canvasHandle = { readAdjustmentInputPixels: read } as never;
    const palette = makeLayer(effect, { ...(effect.defaultParams as Params), mode: "palette" });
    expect(await effect.prepareHeadless!(palette, { canvasHandle, layers: [] })).toBeNull();
    expect(read).not.toHaveBeenCalled();
    const reduce = makeLayer(effect, { ...(effect.defaultParams as Params), mode: "reduce" });
    expect(await effect.prepareHeadless!(reduce, { canvasHandle, layers: [] })).toBeNull();
    expect(read).toHaveBeenCalledWith(reduce.id);
    // Without a derived palette the entry is a no-op palette, not a crash.
    const entry = effect.buildPlanEntry(reduce, ctx()) as { paletteCount: number };
    expect(entry.paletteCount).toBe(0);
  });

  it("reduce-colors: changing the colour count drops the stale derived palette", () => {
    const effect = effectRegistry.get("reduce-colors")! as AnyEffect;
    const field = effect.paramFields!.find((f) => f.id === "colorCount")!;
    const withPalette = { ...(effect.defaultParams as Params), derivedPalette: SWATCHES };
    const n = (field.get(withPalette) as number) === 8 ? 9 : 8;
    expect((field.set(withPalette, n) as Params).derivedPalette).toBeNull();
    expect(field.set(withPalette, field.get(withPalette))).toBe(withPalette);
  });
});

describe("effectRegistry API", () => {
  it("warns on a duplicate id and keeps the latest registration", async () => {
    vi.resetModules();
    const { effectRegistry: reg } = await import("@/core/effects/effectRegistry");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const a = { id: "x", menu: { root: "filters" } } as unknown as AnyEffect;
    const b = { id: "x", menu: { root: "effects" } } as unknown as AnyEffect;
    reg.register(a);
    expect(warn).not.toHaveBeenCalled();
    reg.register(b);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("duplicate registration: x"));
    expect(reg.get("x")).toBe(b);
    expect(reg.all()).toEqual([b]);
    expect(reg.byMenuRoot("effects")).toEqual([b]);
    expect(reg.byMenuRoot("filters")).toEqual([]);
  });
});
