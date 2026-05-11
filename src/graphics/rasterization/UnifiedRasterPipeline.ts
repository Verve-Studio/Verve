import { rasterizeWithGpu } from "./GpuRasterPipeline";
import {
  type RasterizeDocumentRequest,
  type RasterizeDocumentResult,
} from "./types";

export async function rasterizeDocument(
  request: RasterizeDocumentRequest,
): Promise<RasterizeDocumentResult> {
  return rasterizeWithGpu(request);
}
