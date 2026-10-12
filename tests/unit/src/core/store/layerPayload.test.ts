import { describe, expect, it } from "vitest";
import { createLayerDataBundle } from "@/core/store/layerPayload";

describe("createLayerDataBundle", () => {
  it("returns an empty bundle with fresh maps each call", () => {
    const a = createLayerDataBundle();
    const b = createLayerDataBundle();
    expect(a.layers.size).toBe(0);
    expect(a.adjustmentMasks.size).toBe(0);
    expect(a.layers).not.toBe(b.layers);
    expect(a.adjustmentMasks).not.toBe(b.adjustmentMasks);
  });

  it("holds typed arrays directly in each layer's native format", () => {
    const bundle = createLayerDataBundle();
    const f32 = new Float32Array(16);
    const idx = new Uint8Array(4);
    bundle.layers.set("hdr", { format: "rgba32f", data: f32 });
    bundle.layers.set("pal", {
      format: "indexed8",
      data: idx,
      geo: { layerWidth: 2, layerHeight: 2, offsetX: -1, offsetY: 3 },
    });
    expect(bundle.layers.get("hdr")!.data).toBe(f32);
    expect(bundle.layers.get("pal")!.data).toBe(idx);
    // Layer init consumes entries by deleting them once uploaded.
    bundle.layers.delete("hdr");
    expect([...bundle.layers.keys()]).toEqual(["pal"]);
  });
});
