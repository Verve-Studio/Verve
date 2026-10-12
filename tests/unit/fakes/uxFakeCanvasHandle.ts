// Minimal fake CanvasHandle for the service-hook tests (src/core/services).
// Only the methods the layer / group commands touch are implemented, as
// vi.fn spies; touching any other member throws so a test never passes by
// silently reading `undefined` off the fake.

import { vi, type Mock } from "vitest";
import type { CanvasHandle } from "@/ux/main/Canvas/Canvas";

type Raster = Awaited<ReturnType<CanvasHandle["rasterizeLayers"]>>;

export interface FakeCanvasHandle {
  handle: CanvasHandle;
  rasterizeLayers: Mock<CanvasHandle["rasterizeLayers"]>;
  rasterizeComposite: Mock<CanvasHandle["rasterizeComposite"]>;
  rasterizeGroupChildren: Mock<CanvasHandle["rasterizeGroupChildren"]>;
  prepareNewLayer: Mock<CanvasHandle["prepareNewLayer"]>;
  prepareNewLayerIndexed: Mock<CanvasHandle["prepareNewLayerIndexed"]>;
  cloneLayerData: Mock<CanvasHandle["cloneLayerData"]>;
  getAdjustmentMaskPixels: Mock<CanvasHandle["getAdjustmentMaskPixels"]>;
  registerAdjustmentSelectionMask: Mock<CanvasHandle["registerAdjustmentSelectionMask"]>;
  getGpuLayer: Mock<CanvasHandle["getGpuLayer"]>;
}

/** Canvas-sized raster result (rgba8 unless `data` is given). */
export function raster(width = 4, height = 4, data?: Uint8Array | Float32Array): Raster {
  return { data: data ?? new Uint8Array(width * height * 4), width, height, backendUsed: "gpu" };
}

/** `extra` adds (or overrides) handle members for a particular test. */
export function makeFakeCanvasHandle(extra: Partial<CanvasHandle> = {}): FakeCanvasHandle {
  const impl = {
    rasterizeLayers: vi.fn<CanvasHandle["rasterizeLayers"]>(async () => raster()),
    rasterizeComposite: vi.fn<CanvasHandle["rasterizeComposite"]>(async () => raster()),
    rasterizeGroupChildren: vi.fn<CanvasHandle["rasterizeGroupChildren"]>(async () => raster()),
    prepareNewLayer: vi.fn<CanvasHandle["prepareNewLayer"]>(),
    prepareNewLayerIndexed: vi.fn<CanvasHandle["prepareNewLayerIndexed"]>(),
    cloneLayerData: vi.fn<CanvasHandle["cloneLayerData"]>(() => true),
    getAdjustmentMaskPixels: vi.fn<CanvasHandle["getAdjustmentMaskPixels"]>(() => null),
    registerAdjustmentSelectionMask: vi.fn<CanvasHandle["registerAdjustmentSelectionMask"]>(),
    getGpuLayer: vi.fn<CanvasHandle["getGpuLayer"]>(() => null),
  };
  const handle = new Proxy({ ...impl, ...extra } as Record<string, unknown>, {
    get(target, prop) {
      if (prop in target) return target[prop as string];
      if (prop === "then") return undefined; // not a thenable
      throw new Error(`FakeCanvasHandle: ${String(prop)} is not implemented`);
    },
  }) as unknown as CanvasHandle;
  return { handle, ...impl };
}

/** A GpuLayer stand-in with the geometry / pixel fields the transform hooks
 *  read (no texture). */
export function fakeGpuLayer(
  id: string,
  format: "rgba8" | "rgba32f" | "indexed8",
  width: number,
  height: number,
  offsetX = 0,
  offsetY = 0,
  data?: Uint8Array | Float32Array,
): NonNullable<ReturnType<CanvasHandle["getGpuLayer"]>> {
  const ch = format === "indexed8" ? 1 : 4;
  return {
    id,
    name: id,
    format,
    layerWidth: width,
    layerHeight: height,
    offsetX,
    offsetY,
    data: data ?? (format === "rgba32f" ? new Float32Array(width * height * ch) : new Uint8Array(width * height * ch)),
  } as unknown as NonNullable<ReturnType<CanvasHandle["getGpuLayer"]>>;
}

/** `canvasHandleRef` as the hooks take it. */
export function handleRef(handle: CanvasHandle | null): { readonly current: CanvasHandle | null } {
  return { current: handle };
}
