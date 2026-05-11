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
  _malloc(size: number): number;
  _free(ptr: number): void;

  // Live view of WASM linear memory (re-read after any call that may grow memory)
  HEAPU8: Uint8Array;
  HEAPF32: Float32Array;

  // ── Operations ────────────────────────────────────────────────────────────
  _pixelops_flood_fill(
    pixelsPtr: number,
    width: number,
    height: number,
    startX: number,
    startY: number,
    fillR: number,
    fillG: number,
    fillB: number,
    fillA: number,
    tolerance: number,
  ): void;

  _pixelops_flood_fill_f32(
    pixelsPtr: number,
    width: number,
    height: number,
    startX: number,
    startY: number,
    fillR: number,
    fillG: number,
    fillB: number,
    fillA: number,
    tolerance: number,
  ): void;

  _pixelops_convolve(
    srcPtr: number,
    dstPtr: number,
    width: number,
    height: number,
    kernelPtr: number,
    kernelSize: number,
  ): void;

  _pixelops_resize_bilinear(
    srcPtr: number,
    srcWidth: number,
    srcHeight: number,
    dstPtr: number,
    dstWidth: number,
    dstHeight: number,
  ): void;

  _pixelops_resize_nearest(
    srcPtr: number,
    srcWidth: number,
    srcHeight: number,
    dstPtr: number,
    dstWidth: number,
    dstHeight: number,
  ): void;

  _pixelops_dither_bayer(
    pixelsPtr: number,
    width: number,
    height: number,
    matrixSize: number,
  ): void;

  /**
   * Returns the actual number of palette entries produced (≤ maxColors).
   * palettePtr must point to a buffer of at least maxColors * 4 bytes.
   */
  _pixelops_quantize(
    pixelsPtr: number,
    pixelCount: number,
    paletteOutPtr: number,
    maxColors: number,
  ): number;

  /**
   * Computes histogram for curves adjustment.
   * Returns pointer to 4*256 float32 array (rgb, red, green, blue channels).
   * maskPtr may be null for no selection mask.
   */
  _pixelops_curves_histogram(
    inputPtr: number,
    width: number,
    height: number,
    maskPtr: number,
  ): number;

  _pixelops_affine_transform(
    srcPtr: number,
    srcW: number,
    srcH: number,
    dstPtr: number,
    dstW: number,
    dstH: number,
    invMatrixPtr: number,
    interp: number,
  ): void;

  _pixelops_perspective_transform(
    srcPtr: number,
    srcW: number,
    srcH: number,
    dstPtr: number,
    dstW: number,
    dstH: number,
    invHPtr: number,
    interp: number,
  ): void;

  /** Rotate RGBA image. amount: 0=90°CW, 1=180°, 2=270°CW. dst must be pre-allocated. */
  _pixelops_rotate_rgba(
    srcPtr: number,
    srcW: number,
    srcH: number,
    dstPtr: number,
    amount: number,
  ): void;

  /** Flip RGBA image. axis: 0=horizontal, 1=vertical. dst must be pre-allocated. */
  _pixelops_flip_rgba(
    srcPtr: number,
    w: number,
    h: number,
    dstPtr: number,
    axis: number,
  ): void;

  /** Rotate indexed (1 byte/pixel) image. amount: 0=90°CW, 1=180°, 2=270°CW. */
  _pixelops_rotate_indexed(
    srcPtr: number,
    srcW: number,
    srcH: number,
    dstPtr: number,
    amount: number,
  ): void;

  /** Flip indexed (1 byte/pixel) image. axis: 0=horizontal, 1=vertical. */
  _pixelops_flip_indexed(
    srcPtr: number,
    w: number,
    h: number,
    dstPtr: number,
    axis: number,
  ): void;

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
    outPtr: number,
  ): void;

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
    k: number,
  ): void;

  _pixelops_grabcut_compute_beta(
    rgbaPtr: number,
    width: number,
    height: number,
  ): number;

  _pixelops_grabcut_kmeans_init(
    rgbaPtr: number,
    width: number,
    height: number,
    trimapPtr: number,
    k: number,
    paramsOutPtr: number,
  ): void;

  _pixelops_grabcut_update_gmms(
    rgbaPtr: number,
    width: number,
    height: number,
    labelPtr: number,
    k: number,
    paramsInOutPtr: number,
  ): void;

  _pixelops_grabcut_mincut(
    capSPtr: number,
    capTPtr: number,
    hWPtr: number,
    vWPtr: number,
    trimapPtr: number,
    width: number,
    height: number,
    labelOutPtr: number,
  ): void;

  _matchPaletteIndices(
    rgbaPtr: number,
    pixelCount: number,
    palettePtr: number,
    paletteSize: number,
    outPtr: number,
    transparentIdx: number,
  ): void;

  /**
   * BFS 4-connected flood fill on a 1-byte-per-pixel indexed buffer.
   * Replaces all pixels connected to (startX, startY) that share the same
   * index value with fillIndex.  Operates in-place on the layer buffer.
   */
  _floodFillIndexed(
    indicesPtr: number,
    w: number,
    h: number,
    startX: number,
    startY: number,
    fillIndex: number,
  ): void;

  // ── EXR I/O (tinyexr) ─────────────────────────────────────────────────────
  /**
   * Decode an OpenEXR file.
   * Returns a pointer to an ExrResult struct { width, height, pixels }.
   * Caller must free with _freeExrResult.
   */
  _loadExr(srcPtr: number, srcLen: number): number;
  _freeExrResult(resultPtr: number): void;

  /**
   * Encode an RGBA float32 image to EXR.
   * Returns a pointer to an ExrBytes struct { data, size }.
   * Caller must free with _freeExrBytes.
   * compression: 0=none, 1=zip, 2=zips, 3=piz
   * halfFloat: 0=float32, 1=half16
   */
  _saveExr(
    pixelsPtr: number,
    width: number,
    height: number,
    compression: number,
    halfFloat: number,
  ): number;
  _freeExrBytes(resultPtr: number): void;

  /**
   * Decode an EXR file into one-or-more named layers (multi-part files OR
   * single-part files with channels named "<LayerName>.R/G/B/A").
   * Returns pointer to ExrMultiResult { canvasW, canvasH, numLayers,
   * layersPtr → ExrLayerOut[] }, or 0 on failure.
   */
  _loadExrLayers(srcPtr: number, srcLen: number): number;
  _freeExrLayersResult(resultPtr: number): void;

  /**
   * Encode multiple full-canvas RGBA float32 layers into a single-part EXR
   * with channel-named groups ("<LayerName>.R/G/B/A").
   * concatNames: numLayers null-terminated UTF-8 strings, concatenated.
   * concatPixels: numLayers × width*height*4 floats, layer-major.
   */
  _saveExrLayers(
    width: number,
    height: number,
    numLayers: number,
    concatNamesPtr: number,
    concatPixelsPtr: number,
    compression: number,
    halfFloat: number,
  ): number;

  // DDS I/O
  _pixelops_dds_get_info(dataPtr: number, size: number, outPtr: number): number;
  _pixelops_dds_decode(
    dataPtr: number,
    size: number,
    outPtr: number,
    outSize: number,
  ): number;
  _pixelops_dds_decode_f32(
    dataPtr: number,
    size: number,
    outPtr: number,
    outSize: number,
  ): number;
  _pixelops_dds_get_encoded_size(
    width: number,
    height: number,
    fmt: number,
    mipLevels: number,
    headerMode: number,
  ): number;
  _pixelops_dds_max_mip_levels(
    width: number,
    height: number,
    minDim: number,
  ): number;
  _pixelops_dds_encode(
    pixelsPtr: number,
    width: number,
    height: number,
    fmt: number,
    mipLevels: number,
    headerMode: number,
    outPtr: number,
    outSize: number,
  ): number;
  _pixelops_dds_encode_f32(
    pixelsPtr: number,
    width: number,
    height: number,
    fmt: number,
    mipLevels: number,
    headerMode: number,
    outPtr: number,
    outSize: number,
  ): number;

  /**
   * Apply one brush stamp's inner pixel loop. All scalar parameters travel
   * in `paramsPtr` — a 116-byte packed `BrushStampParams` struct laid out
   * by the JS wrapper. Other pointers reference WASM-heap-resident slices
   * the wrapper has copied in (layer + touched bbox slices, optional
   * selection-mask, optional bitmap-tip SDF). Mutates layer + touched in
   * place; the wrapper copies the results back to the JS-side buffers.
   */
  _pixelops_brush_stamp(
    paramsPtr: number,
    layerDataPtr: number,
    touchedDataPtr: number,
    selMaskPtr: number,        // 0 = no selection
    sdfPtr: number,            // 0 if primary tip is procedural
    sdfW: number,
    sdfH: number,
    dualSdfPtr: number,        // 0 if dual is off or procedural
    dualSdfW: number,
    dualSdfH: number,
  ): void;

  /**
   * Batched form of `_pixelops_brush_stamp`. `paramsArrayPtr` points to a
   * tightly packed array of `count` BrushStampParams structs (each
   * PARAM_BYTES bytes). All stamps in the array share the layer / touched
   * / selection / SDF context passed in the trailing args. Used by the
   * brush engine to amortise JS↔WASM crossings + param packing across an
   * entire segment of stamps, eliminating per-stamp BrushStampJob
   * allocation and the GC pressure that came with it. */
  _pixelops_brush_stamp_batch(
    paramsArrayPtr: number,
    count: number,
    layerDataPtr: number,
    touchedDataPtr: number,
    selMaskPtr: number,
    sdfPtr: number,
    sdfW: number,
    sdfH: number,
    dualSdfPtr: number,
    dualSdfW: number,
    dualSdfH: number,
  ): void;

  /**
   * Rasterize the brush coverage at the design shape into an 8-bit
   * bitmap. `paramsPtr` is a BrushStampParams struct (only the shape
   * fields — radius, angle, roundness, shear, flip, aaWidth, tipKind,
   * dual params, grain params — are read). `outBitmapPtr` must point
   * to a pre-allocated `bmW * bmH` byte buffer. Returns nothing.
   */
  _pixelops_brush_bake_coverage(
    paramsPtr: number,
    outBitmapPtr: number,
    bmW: number,
    bmH: number,
    sdfPtr: number,
    sdfW: number,
    sdfH: number,
    dualSdfPtr: number,
    dualSdfW: number,
    dualSdfH: number,
  ): void;

  /**
   * Per-stamp dispatch using a pre-rasterized coverage bitmap. Reads
   * per-stamp cx/cy (→ bmOffsetX/Y), color, opacity, cap, bbox, layer
   * extents from the BrushStampParams struct; the bitmap shape itself
   * is shared across all stamps in a stroke.
   */
  _pixelops_brush_stamp_bitmap(
    paramsPtr: number,
    layerDataPtr: number,
    touchedDataPtr: number,
    selMaskPtr: number,
    bitmapPtr: number,
    bmW: number,
    bmH: number,
  ): void;

  _pixelops_brush_stamp_bitmap_batch(
    paramsArrayPtr: number,
    count: number,
    layerDataPtr: number,
    touchedDataPtr: number,
    selMaskPtr: number,
    bitmapPtr: number,
    bmW: number,
    bmH: number,
  ): void;
}

/** Factory function exported by the Emscripten-generated ES module */
export type PixelOpsFactory = (options: {
  locateFile: (filename: string) => string;
}) => Promise<PixelOpsModule>;

/** Result of histogram computation for curves adjustment */
export interface CurvesHistogramResult {
  rgb: Float32Array;
  red: Float32Array;
  green: Float32Array;
  blue: Float32Array;
}
