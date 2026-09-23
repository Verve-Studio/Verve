import {
  RasterizationExecutionError,
  RasterizationUnavailableError,
  type RasterizeDocumentRequest,
  type RasterizeDocumentResult,
} from "./types";

export async function rasterizeWithGpu(
  request: RasterizeDocumentRequest,
): Promise<RasterizeDocumentResult> {
  const renderer = request.renderer;
  if (!renderer) {
    throw new RasterizationUnavailableError(
      "GPU rasterization is unavailable because no renderer is bound.",
    );
  }

  let data: Uint8Array | Float32Array;
  try {
    data = await renderer.readFlattenedPlan(request.plan);
  } catch (err) {
    throw new RasterizationExecutionError(
      `GPU rasterization failed (${request.reason}): ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }

  return {
    data,
    width: renderer.pixelWidth,
    height: renderer.pixelHeight,
    backendUsed: "gpu",
  };
}
