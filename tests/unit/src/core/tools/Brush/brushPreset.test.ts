import { describe, expect, it } from "vitest";
import type { Brush, DynamicCurve } from "@/types";
import {
  deserializeBrush,
  identityCurve,
  makeDefaultBrush,
  serializeBrush,
  serializedTipPayloads,
} from "@/core/tools/Brush/brushPreset";
import { makeStarterBrushes } from "@/core/tools/Brush/brushPresets";
import { BRUSH_BLEND_MODES } from "@/core/tools/Brush/brushBlend";
import { makeTipSampler } from "@/core/tools/Brush/tipSampler";

function withBitmaps(): Brush {
  const b = makeDefaultBrush("b1", "Bitmap");
  b.shape = { kind: "bitmap", bitmapRgba: new Uint8Array([1, 2, 3, 4, 250, 251, 252, 253]), bitmapWidth: 2, bitmapHeight: 1 };
  b.dualTip = { ...b.dualTip!, enabled: true, shape: { kind: "bitmap", bitmapRgba: new Uint8Array([9, 8, 7, 6]), bitmapWidth: 1, bitmapHeight: 1 } };
  return b;
}

describe("brush serialization", () => {
  it("round-trips through JSON with base64 tips", () => {
    const b = withBitmaps();
    const json = JSON.stringify(serializeBrush(b));
    const back = deserializeBrush(JSON.parse(json));
    expect(back).toEqual(b);
    expect(back.shape.bitmapRgba).toBeInstanceOf(Uint8Array);
  });

  it("encodes tip bytes as strings and leaves the source brush untouched", () => {
    const b = withBitmaps();
    const raw = serializeBrush(b) as Record<string, unknown>;
    expect(typeof (raw.shape as Record<string, unknown>).bitmapRgba).toBe("string");
    expect(b.shape.bitmapRgba).toBeInstanceOf(Uint8Array);
    expect(serializedTipPayloads(raw)).toHaveLength(2);
  });

  it("supports custom encoders (container blob references)", () => {
    const blobs: Uint8Array[] = [];
    const raw = serializeBrush(withBitmaps(), (bytes) => {
      blobs.push(bytes);
      return `blob:${blobs.length - 1}`;
    }) as Record<string, unknown>;
    expect(serializedTipPayloads(raw)).toEqual(["blob:0", "blob:1"]);
    const back = deserializeBrush(raw, (ref) => blobs[Number(ref.slice(5))]);
    expect(Array.from(back.dualTip!.shape.bitmapRgba!)).toEqual([9, 8, 7, 6]);
  });

  it("procedural tips serialize unchanged", () => {
    const b = makeDefaultBrush("p");
    expect(deserializeBrush(JSON.parse(JSON.stringify(serializeBrush(b))))).toEqual(b);
    expect(serializedTipPayloads(serializeBrush(b) as Record<string, unknown>)).toEqual([]);
  });

  it("drops legacy SDF fields and survives corrupt tip payloads", () => {
    const raw = serializeBrush(withBitmaps()) as Record<string, Record<string, unknown>>;
    raw.shape.sdfBase64 = "AAAA";
    raw.shape.sdfWidth = 1;
    raw.shape.bitmapRgba = "%%%not base64%%%";
    const back = deserializeBrush(raw as Record<string, unknown>);
    expect(back.shape).not.toHaveProperty("sdfBase64");
    expect(back.shape.bitmapRgba).toBeUndefined();
    // A tip whose bytes were lost falls back to a round sampler, not a crash.
    expect(makeTipSampler(back.shape).tipKind).toBe(0);
  });

  it("tolerates a missing shape and a brush without a dual tip", () => {
    const raw = serializeBrush(makeDefaultBrush("x")) as Record<string, unknown>;
    delete raw.dualTip;
    raw.shape = null;
    const back = deserializeBrush(raw);
    expect(back.shape).toEqual({ kind: "round" });
    expect(back.dualTip).toBeUndefined();
  });
});

describe("brush data validity", () => {
  const curveOk = (c: DynamicCurve, where: string): void => {
    expect(c.jitter, where).toBeGreaterThanOrEqual(0);
    expect(c.jitter, where).toBeLessThanOrEqual(1);
    expect(c.minimum, where).toBeGreaterThanOrEqual(0);
    expect(c.minimum, where).toBeLessThanOrEqual(1);
    expect(c.curve.length, where).toBeGreaterThanOrEqual(2);
    for (let i = 0; i < c.curve.length; i++) {
      const p = c.curve[i];
      expect(p.x >= 0 && p.x <= 1 && p.y >= 0 && p.y <= 1, where).toBe(true);
      if (i > 0) expect(p.x, where).toBeGreaterThanOrEqual(c.curve[i - 1].x);
    }
  };

  const brushes = [makeDefaultBrush("default"), ...makeStarterBrushes()];

  it("identityCurve is off and maps 0→0, 1→1", () => {
    expect(identityCurve()).toEqual({ jitter: 0, source: "off", minimum: 0, curve: [{ x: 0, y: 0 }, { x: 1, y: 1 }] });
  });

  it("starter brushes have unique ids and names", () => {
    const starters = makeStarterBrushes();
    expect(starters.length).toBeGreaterThan(0);
    expect(new Set(starters.map((b) => b.id)).size).toBe(starters.length);
    expect(new Set(starters.map((b) => b.name)).size).toBe(starters.length);
  });

  it("starter brushes are deterministic (fixed-seed sampled tips)", () => {
    const a = makeStarterBrushes();
    const b = makeStarterBrushes();
    for (let i = 0; i < a.length; i++) {
      expect(a[i].shape).toEqual(b[i].shape);
      expect(a[i].dualTip?.shape).toEqual(b[i].dualTip?.shape);
    }
  });

  it.each(brushes.map((b) => [b.name, b] as const))("%s has in-range settings", (_n, b) => {
    expect(b.tip.size).toBeGreaterThan(0);
    expect(b.tip.spacing).toBeGreaterThan(0);
    expect(b.tip.spacing).toBeLessThanOrEqual(100 * 10);
    expect(b.tip.hardness).toBeGreaterThanOrEqual(0);
    expect(b.tip.hardness).toBeLessThanOrEqual(100);
    expect(b.tip.roundness).toBeGreaterThan(0);
    expect(b.tip.roundness).toBeLessThanOrEqual(1);
    expect(b.tip.flow).toBeGreaterThan(0);
    expect(b.tip.flow).toBeLessThanOrEqual(100);
    expect(b.opacity).toBeGreaterThan(0);
    expect(b.opacity).toBeLessThanOrEqual(100);
    expect(b.scatter.count).toBeGreaterThanOrEqual(1);
    if (b.blendMode) expect(BRUSH_BLEND_MODES.map((m) => m.id)).toContain(b.blendMode);
    for (const [k, c] of Object.entries(b.shapeDyn)) curveOk(c, `${b.name}.shapeDyn.${k}`);
    for (const [k, c] of Object.entries(b.transfer ?? {})) curveOk(c, `${b.name}.transfer.${k}`);
    for (const [k, c] of Object.entries(b.colorDyn)) if (typeof c === "object") curveOk(c as DynamicCurve, `${b.name}.colorDyn.${k}`);
    curveOk(b.scatter.jitter, `${b.name}.scatter.jitter`);
    curveOk(b.scatter.countJitter, `${b.name}.scatter.countJitter`);
    if (b.texture.depthJitter) curveOk(b.texture.depthJitter, `${b.name}.texture.depthJitter`);
    for (const shape of [b.shape, b.dualTip?.shape]) {
      if (shape?.kind === "bitmap") {
        expect(shape.bitmapRgba!.length).toBe(shape.bitmapWidth! * shape.bitmapHeight! * 4);
        expect(makeTipSampler(shape).tipKind).toBe(3);
      }
    }
  });

  it("starter brushes round-trip through serialization", () => {
    for (const b of makeStarterBrushes()) expect(deserializeBrush(JSON.parse(JSON.stringify(serializeBrush(b))))).toEqual(b);
  });
});
