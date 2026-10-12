import { describe, expect, it, vi } from "vitest";
import {
  RasterizationExecutionError,
  RasterizationUnavailableError,
  rasterizeDocument,
  type RasterizeDocumentRequest,
} from "@/graphics/rasterization/index";
import type { RenderPlanEntry, WebGPURenderer } from "@/graphics/webgpu/rendering/WebGPURenderer";

function fakeRenderer(read: (plan: RenderPlanEntry[]) => Promise<Uint8Array | Float32Array>) {
  return {
    pixelWidth: 4,
    pixelHeight: 2,
    readFlattenedPlan: vi.fn(read),
  } as unknown as WebGPURenderer & { readFlattenedPlan: ReturnType<typeof vi.fn> };
}

const req = (over: Partial<RasterizeDocumentRequest>): RasterizeDocumentRequest => ({
  plan: [],
  width: 4,
  height: 2,
  reason: "flatten",
  ...over,
});

describe("rasterizeDocument", () => {
  it("renders the exact plan on the GPU and reports the renderer's size", async () => {
    const data = new Float32Array(4 * 2 * 4).fill(0.5);
    const renderer = fakeRenderer(() => Promise.resolve(data));
    const plan: RenderPlanEntry[] = [];
    const out = await rasterizeDocument(req({ plan, renderer, reason: "export" }));
    expect(renderer.readFlattenedPlan).toHaveBeenCalledWith(plan);
    expect(out).toEqual({ data, width: 4, height: 2, backendUsed: "gpu" });
    // Float documents keep float output (no 8-bit quantisation on export).
    expect(out.data).toBeInstanceOf(Float32Array);
  });

  it.each([null, undefined])("throws RasterizationUnavailableError with renderer=%s (never a silent no-op)", async (renderer) => {
    await expect(rasterizeDocument(req({ renderer }))).rejects.toBeInstanceOf(RasterizationUnavailableError);
  });

  it("wraps GPU failures in RasterizationExecutionError naming the reason", async () => {
    const renderer = fakeRenderer(() => Promise.reject(new Error("device lost")));
    const err = await rasterizeDocument(req({ renderer, reason: "merge" })).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RasterizationExecutionError);
    expect((err as Error).message).toMatch(/merge/);
    expect((err as Error).message).toMatch(/device lost/);
    expect((err as Error).name).toBe("RasterizationExecutionError");
  });

  it("wraps non-Error rejections too", async () => {
    const renderer = fakeRenderer(() => Promise.reject("boom"));
    await expect(rasterizeDocument(req({ renderer, reason: "sample" }))).rejects.toThrow(/sample.*boom/);
  });
});
