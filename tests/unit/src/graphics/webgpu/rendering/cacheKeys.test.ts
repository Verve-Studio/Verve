import { describe, expect, it } from "vitest";
import {
  computeAdjGroupParamsKey,
  computeAdjGroupStaticKey,
  serializeAdjOp,
  serializeAdjOpStatic,
} from "@/graphics/webgpu/rendering/cacheKeys";
import type { EffectRenderOp, GpuLayer, SourceLayer } from "@/graphics/webgpu/rendering/WebGPURenderer";

const layer = (over: Partial<GpuLayer> = {}): GpuLayer =>
  ({
    id: "L",
    contentVersion: 1,
    offsetX: 0,
    offsetY: 0,
    layerWidth: 10,
    layerHeight: 10,
    ...over,
  }) as GpuLayer;

const op = (over: Record<string, unknown> = {}): EffectRenderOp =>
  ({
    kind: "brightness-contrast",
    layerId: "adj1",
    visible: true,
    params: { brightness: 10, contrast: 0 },
    ...over,
  }) as unknown as EffectRenderOp;

describe("serializeAdjOpStatic", () => {
  it("includes kind, layer id, visibility and params", () => {
    const k = serializeAdjOpStatic(op());
    expect(k).toContain("brightness-contrast|adj1|1");
    expect(k).toContain('params:{"brightness":10,"contrast":0}');
    expect(serializeAdjOpStatic(op({ visible: false }))).toContain("|0");
  });

  it("differs when params differ and matches for equal fresh ops", () => {
    expect(serializeAdjOpStatic(op())).toBe(serializeAdjOpStatic(op()));
    expect(serializeAdjOpStatic(op({ params: { brightness: 11, contrast: 0 } }))).not.toBe(serializeAdjOpStatic(op()));
    expect(serializeAdjOpStatic(op({ layerId: "adj2" }))).not.toBe(serializeAdjOpStatic(op()));
  });

  it("serialises Float32Array extras by value (palettes)", () => {
    const a = op({ palette: new Float32Array([0.5, 1]), paletteCount: 2 });
    const b = op({ palette: new Float32Array([0.5, 1]), paletteCount: 2 });
    const c = op({ palette: new Float32Array([0.5, 0.25]), paletteCount: 2 });
    expect(serializeAdjOpStatic(a)).toBe(serializeAdjOpStatic(b));
    expect(serializeAdjOpStatic(a)).not.toBe(serializeAdjOpStatic(c));
    expect(serializeAdjOpStatic(a)).toContain("palette:0.5,1");
  });

  it("excludes GPU objects (mask texture, LUTs) but marks that a mask exists", () => {
    const masked = op({ selMaskLayer: layer({ id: "m", contentVersion: 5 }) });
    const k = serializeAdjOpStatic(masked);
    expect(k).toContain("selM");
    expect(k).not.toContain("contentVersion");
    const withLuts = op({ luts: { rgb: new Float32Array([1, 2, 3]) } });
    expect(serializeAdjOpStatic(withLuts)).toBe(serializeAdjOpStatic(op()));
  });

  it("keys source layers by id, content version and geometry", () => {
    const src = (l: GpuLayer) => ({ layer: l, adjustments: [] });
    const base = serializeAdjOpStatic(op({ sourceLayers: [src(layer())] }));
    expect(serializeAdjOpStatic(op({ sourceLayers: [src(layer({ contentVersion: 2 }))] }))).not.toBe(base);
    expect(serializeAdjOpStatic(op({ sourceLayers: [src(layer({ offsetX: 3 }))] }))).not.toBe(base);
    expect(serializeAdjOpStatic(op({ sourceLayers: [src(layer({ layerWidth: 11 }))] }))).not.toBe(base);
    expect(serializeAdjOpStatic(op({ sourceLayers: [null] }))).toContain("src:-");
  });

  it("keys a source's layer mask and effects (it is read as it renders)", () => {
    const key = (s: Partial<SourceLayer>) =>
      serializeAdjOpStatic(op({ sourceLayers: [{ layer: layer(), adjustments: [], ...s }] }));
    const base = key({});
    const mask = layer({ id: "m", contentVersion: 1 });
    expect(key({ mask })).not.toBe(base);
    expect(key({ mask })).not.toBe(key({ mask: layer({ id: "m", contentVersion: 2 }) }));
    const fx = op({ layerId: "fx" });
    expect(key({ adjustments: [fx] })).not.toBe(base);
    expect(key({ adjustments: [fx] })).not.toBe(
      key({ adjustments: [op({ layerId: "fx", params: { brightness: 50, contrast: 0 } })] }),
    );
  });

  it("memoises by op identity (immutable plan entries)", () => {
    // Documented contract: plan entries are immutable, so a key computed
    // once is reused even if the object were mutated afterwards.
    const params = { brightness: 1, contrast: 0 };
    const o = op({ params });
    const k1 = serializeAdjOpStatic(o);
    params.brightness = 99;
    expect(serializeAdjOpStatic(o)).toBe(k1);
    // A new op sharing the same params object reuses the cached params
    // serialisation too.
    expect(serializeAdjOpStatic(op({ params }))).toBe(k1);
  });

  it("tolerates values JSON can't serialise", () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(serializeAdjOpStatic(op({ params: cyclic }))).toContain("params:[object]");
  });
});

describe("serializeAdjOp", () => {
  it("adds the selection mask's current content version, read live", () => {
    const mask = layer({ id: "m", contentVersion: 5 });
    const o = op({ selMaskLayer: mask });
    expect(serializeAdjOp(o)).toBe(`${serializeAdjOpStatic(o)}~selV:5`);
    mask.contentVersion = 6;
    expect(serializeAdjOp(o)).toBe(`${serializeAdjOpStatic(o)}~selV:6`);
  });

  it("equals the static key without a mask", () => {
    const o = op();
    expect(serializeAdjOp(o)).toBe(serializeAdjOpStatic(o));
  });
});

describe("group keys", () => {
  it("join per-op keys in order", () => {
    const a = op();
    const b = op({ layerId: "adj2", kind: "color-invert", params: {} });
    expect(computeAdjGroupParamsKey([a, b])).toBe(`${serializeAdjOp(a)}§${serializeAdjOp(b)}`);
    expect(computeAdjGroupParamsKey([b, a])).not.toBe(computeAdjGroupParamsKey([a, b]));
    expect(computeAdjGroupParamsKey([])).toBe("");
  });

  it("the static group key ignores mask content changes, the params key doesn't", () => {
    const mask = layer({ id: "m", contentVersion: 1 });
    const ops = [op({ selMaskLayer: mask })];
    const s1 = computeAdjGroupStaticKey(ops);
    const p1 = computeAdjGroupParamsKey(ops);
    mask.contentVersion = 2;
    expect(computeAdjGroupStaticKey(ops)).toBe(s1);
    expect(computeAdjGroupParamsKey(ops)).not.toBe(p1);
  });
});
