/**
 * Types for the Emscripten-generated pixelops WASM module.
 *
 * The module is compiled with:
 *   -sMODULARIZE=1 -sEXPORT_ES6=1 -sEXPORT_NAME=createPixelOps
 *   -sEXPORTED_RUNTIME_METHODS=HEAPU8,HEAPF32
 *   -sEXPORTED_FUNCTIONS=_malloc,_free,...
 */

export interface PixelOpsModule {
  // Memory management
  _malloc(size: number): number
  _free(ptr: number): void

  // Live view of WASM linear memory (re-read after any call that may grow memory)
  HEAPU8: Uint8Array
  HEAPF32: Float32Array

  // ── Operations ────────────────────────────────────────────────────────────
  _pixelops_flood_fill(
    pixelsPtr: number, width: number, height: number,
    startX: number, startY: number,
    fillR: number, fillG: number, fillB: number, fillA: number,
    tolerance: number
  ): void

  _pixelops_convolve(
    srcPtr: number, dstPtr: number,
    width: number, height: number,
    kernelPtr: number, kernelSize: number
  ): void

  _pixelops_resize_bilinear(
    srcPtr: number, srcWidth: number, srcHeight: number,
    dstPtr: number, dstWidth: number, dstHeight: number
  ): void

  _pixelops_resize_nearest(
    srcPtr: number, srcWidth: number, srcHeight: number,
    dstPtr: number, dstWidth: number, dstHeight: number
  ): void

  _pixelops_dither_bayer(
    pixelsPtr: number, width: number, height: number, matrixSize: number
  ): void

  /**
   * Returns the actual number of palette entries produced (≤ maxColors).
   * palettePtr must point to a buffer of at least maxColors * 4 bytes.
   */
  _pixelops_quantize(
    pixelsPtr: number, pixelCount: number,
    paletteOutPtr: number, maxColors: number
  ): number

  /**
   * Computes histogram for curves adjustment.
    * Returns pointer to 4*256 float32 array (rgb, red, green, blue channels).
   * maskPtr may be null for no selection mask.
   */
  _pixelops_curves_histogram(
    inputPtr: number, width: number, height: number,
    maskPtr: number
  ): number


  _pixelops_affine_transform(
    srcPtr: number, srcW: number, srcH: number,
    dstPtr: number, dstW: number, dstH: number,
    invMatrixPtr: number,
    interp: number
  ): void

  _pixelops_perspective_transform(
    srcPtr: number, srcW: number, srcH: number,
    dstPtr: number, dstW: number, dstH: number,
    invHPtr: number,
    interp: number
  ): void

  /**
   * Content-aware inpainting via PatchMatch.
   * pixels: RGBA source, width×height×4 bytes.
   * mask:   single-channel fill mask, width×height bytes (255 = fill, 0 = source).
   * patchSize: patch half-radius (recommended: 4 → 9×9 patches).
   * sourceMaskPtr: pointer to source-eligibility mask (1=eligible, 0=excluded), or 0 for unconstrained.
   * out:    pre-allocated RGBA output buffer, same size as pixels.
   */
  _pixelops_inpaint(
    pixelsPtr: number,
    width: number,
    height: number,
    maskPtr: number,
    patchSize: number,
    sourceMaskPtr: number,
    outPtr: number
  ): void

  /**
   * GrabCut segmentation (Rother et al. 2004).
   * @param rgbaPtr   RGBA image, width×height×4 bytes.
   * @param width     Image width.
   * @param height    Image height.
   * @param trimapPtr Per-pixel trimap: 0=BG, 128=unknown, 255=FG. width×height bytes.
   * @param alphaPtr  Output alpha mask (0 or 255). width×height bytes. Pre-allocated.
   * @param iterations EM iterations (3 is typically sufficient).
   * @param k         GMM components per class (5 recommended).
   */
  _pixelops_grabcut(
    rgbaPtr: number,
    width: number,
    height: number,
    trimapPtr: number,
    alphaPtr: number,
    iterations: number,
    k: number
  ): void

  _pixelops_grabcut_compute_beta(
    rgbaPtr: number, width: number, height: number
  ): number

  _pixelops_grabcut_kmeans_init(
    rgbaPtr: number, width: number, height: number,
    trimapPtr: number, k: number, paramsOutPtr: number
  ): void

  _pixelops_grabcut_update_gmms(
    rgbaPtr: number, width: number, height: number,
    labelPtr: number, k: number, paramsInOutPtr: number
  ): void

  _pixelops_grabcut_mincut(
    capSPtr: number, capTPtr: number,
    hWPtr: number, vWPtr: number,
    trimapPtr: number, width: number, height: number, labelOutPtr: number
  ): void

  _matchPaletteIndices(
    rgbaPtr: number,
    pixelCount: number,
    palettePtr: number,
    paletteSize: number,
    outPtr: number,
    transparentIdx: number
  ): void
}

/** Factory function exported by the Emscripten-generated ES module */
export type PixelOpsFactory = (options: {
  locateFile: (filename: string) => string
}) => Promise<PixelOpsModule>

/** Result of histogram computation for curves adjustment */
export interface CurvesHistogramResult {
  rgb: Float32Array
  red: Float32Array
  green: Float32Array
  blue: Float32Array
}
