import {
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

  const data = await renderer.readFlattenedPlan(request.plan);

  return {
    data,
    width: renderer.pixelWidth,
    height: renderer.pixelHeight,
    backendUsed: "gpu",
  };
}
