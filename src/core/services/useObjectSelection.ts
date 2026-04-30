import { useCallback, useEffect, useRef } from 'react'
import type { MutableRefObject } from 'react'
import type { AppState } from '@/types'
import type { CanvasHandle } from '@/ux/main/Canvas/Canvas'
import { objectSelectionStore } from '@/core/store/objectSelectionStore'
import { objectSelectionCallbacks, objectSelectionOptions } from '../../tools/objectSelection'
import { selectionStore } from '@/core/store/selectionStore'
import type { SelectionMode } from '@/core/store/selectionStore'
import { grabCutHybrid } from '@/wasm/grabcutHybrid'

// ─── Types ────────────────────────────────────────────────────────────────────

interface UseObjectSelectionParams {
  canvasHandleRef: { readonly current: CanvasHandle | null }
  stateRef: MutableRefObject<AppState>
  captureHistory: (label: string) => void
  activeTabId: string
  layers: AppState['layers']
}

// ─── Canvas pixel helpers ─────────────────────────────────────────────────────

async function downsampleTo1024(
  rgba: Uint8Array,
  srcWidth: number,
  srcHeight: number,
): Promise<Uint8Array> {
  // Standard SAM preprocessing: resize longest side to 1024, preserve aspect ratio,
  // zero-pad the shorter dimension. Coordinates in sam.ts are scaled the same way.
  const scale = 1024 / Math.max(srcWidth, srcHeight)
  const dstW = Math.round(srcWidth * scale)
  const dstH = Math.round(srcHeight * scale)
  const imgData = new ImageData(new Uint8ClampedArray(rgba.buffer as ArrayBuffer, rgba.byteOffset, rgba.byteLength), srcWidth, srcHeight)
  const bmp = await createImageBitmap(imgData, {
    resizeWidth: dstW,
    resizeHeight: dstH,
    resizeQuality: 'medium',
  })
  // OffscreenCanvas is zero-initialized (black), so the padded area stays 0
  const oc = new OffscreenCanvas(1024, 1024)
  oc.getContext('2d')!.drawImage(bmp, 0, 0)
  bmp.close()
  const out = oc.getContext('2d')!.getImageData(0, 0, 1024, 1024)
  return new Uint8Array(out.data.buffer)
}

async function upsampleMask(
  mask1024: Uint8Array,
  canvasWidth: number,
  canvasHeight: number,
): Promise<Uint8Array> {
  // EfficientSAM decoder returns a 1024×1024 mask in the *padded* encoder-input space.
  // Only the top-left region corresponding to the actual (non-padded) image
  // contains real content. Crop to that region before resizing to canvas dimensions.
  const scale = 1024 / Math.max(canvasWidth, canvasHeight)
  const dstW = Math.max(1, Math.round(canvasWidth * scale))
  const dstH = Math.max(1, Math.round(canvasHeight * scale))

  const rgba1024 = new Uint8ClampedArray(1024 * 1024 * 4)
  for (let i = 0; i < 1024 * 1024; i++) {
    rgba1024[i * 4 + 0] = mask1024[i]
    rgba1024[i * 4 + 1] = mask1024[i]
    rgba1024[i * 4 + 2] = mask1024[i]
    rgba1024[i * 4 + 3] = 255
  }
  // Crop to the non-padded content region, then resize to canvas dimensions
  const bmp = await createImageBitmap(
    new ImageData(rgba1024, 1024, 1024),
    0, 0, dstW, dstH,
    { resizeWidth: canvasWidth, resizeHeight: canvasHeight, resizeQuality: 'medium' },
  )
  const oc = new OffscreenCanvas(canvasWidth, canvasHeight)
  oc.getContext('2d')!.drawImage(bmp, 0, 0)
  bmp.close()
  const px = oc.getContext('2d')!.getImageData(0, 0, canvasWidth, canvasHeight)
  const out = new Uint8Array(canvasWidth * canvasHeight)
  for (let i = 0; i < out.length; i++) out[i] = px.data[i * 4]
  return out
}

/**
 * Keep only mask connected components that contain at least one of the given
 * "seed" pixel coordinates (the user's prompt points / box interior). Drops
 * floating speckles SAM occasionally produces in unrelated background regions.
 *
 * Operates on a binary view of the mask (>= 128 = foreground). Preserves the
 * original soft mask values for kept components (so feather/AA still works).
 */
function keepComponentsContainingSeeds(
  mask: Uint8Array,
  width: number,
  height: number,
  seeds: Array<{ x: number; y: number }>,
): Uint8Array {
  if (seeds.length === 0) return mask
  // labels[i] = 0 unset, 1+ = component id
  const labels = new Int32Array(width * height)
  const stack: number[] = []
  let nextLabel = 1
  const keep = new Set<number>()
  // Mark which seed pixels fall inside foreground
  const seedPixels = new Set<number>()
  for (const s of seeds) {
    const sx = Math.max(0, Math.min(width - 1, Math.round(s.x)))
    const sy = Math.max(0, Math.min(height - 1, Math.round(s.y)))
    seedPixels.add(sy * width + sx)
  }

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = y * width + x
      if (labels[i] !== 0 || mask[i] < 128) continue
      // Flood-fill this component (4-connected, iterative)
      const id = nextLabel++
      stack.length = 0
      stack.push(i)
      labels[i] = id
      let containsSeed = false
      while (stack.length > 0) {
        const p = stack.pop()!
        if (seedPixels.has(p)) containsSeed = true
        const py = (p / width) | 0
        const px = p - py * width
        if (px > 0) {
          const n = p - 1
          if (labels[n] === 0 && mask[n] >= 128) { labels[n] = id; stack.push(n) }
        }
        if (px < width - 1) {
          const n = p + 1
          if (labels[n] === 0 && mask[n] >= 128) { labels[n] = id; stack.push(n) }
        }
        if (py > 0) {
          const n = p - width
          if (labels[n] === 0 && mask[n] >= 128) { labels[n] = id; stack.push(n) }
        }
        if (py < height - 1) {
          const n = p + width
          if (labels[n] === 0 && mask[n] >= 128) { labels[n] = id; stack.push(n) }
        }
      }
      if (containsSeed) keep.add(id)
    }
  }

  if (keep.size === 0) return mask // no seed inside any component → don't filter
  const out = new Uint8Array(mask.length)
  for (let i = 0; i < mask.length; i++) {
    if (keep.has(labels[i])) out[i] = mask[i]
  }
  return out
}

// ─── Hook ─────────────────────────────────────────────────────────────────────

export function useObjectSelection({
  canvasHandleRef,
  stateRef,
  captureHistory,
  activeTabId,
  layers,
}: UseObjectSelectionParams): { invalidateSamCache: () => void } {
  // ── Stable refs ────────────────────────────────────────────────────────────
  const captureHistoryRef = useRef(captureHistory)
  captureHistoryRef.current = captureHistory

  /** Saved selection mask before this session started (for non-'set' commit modes). */
  const savedMaskRef = useRef<Uint8Array | null>(null)
  const hasSavedMaskRef = useRef(false)

  /** Cache version we last encoded for. */
  const encodedCacheVersionRef = useRef(-1)

  /** Prevent concurrent inference runs. */
  const isRunningRef = useRef(false)

  const debounceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  // ── Cache invalidation ─────────────────────────────────────────────────────

  const invalidateSamCache = useCallback((): void => {
    objectSelectionStore.invalidateCache()
    void window.api.sam.invalidateCache()
  }, [])

  // Reset session when tab changes
  const prevTabIdRef = useRef(activeTabId)
  useEffect(() => {
    if (activeTabId !== prevTabIdRef.current) {
      prevTabIdRef.current = activeTabId
      hasSavedMaskRef.current = false
      savedMaskRef.current = null
      objectSelectionStore.reset()
      invalidateSamCache()
    }
  }, [activeTabId, invalidateSamCache])

  // Invalidate when layer content changes
  const prevLayersRef = useRef(layers)
  useEffect(() => {
    if (layers !== prevLayersRef.current) {
      prevLayersRef.current = layers
      invalidateSamCache()
    }
  }, [layers, invalidateSamCache])

  // ── Model check on mount ───────────────────────────────────────────────────

  useEffect(() => {
    objectSelectionStore.modelStatus = 'checking'
    objectSelectionStore.notify()
    window.api.sam
      .checkModel()
      .then((status) => {
        objectSelectionStore.modelStatus =
          status.encoderReady && status.decoderReady ? 'ready' : 'error'
        objectSelectionStore.notify()
      })
      .catch(() => {
        objectSelectionStore.modelStatus = 'error'
        objectSelectionStore.notify()
      })
  }, [])
  // ── Matting model check on mount ─────────────────────────────────────

  useEffect(() => {
    objectSelectionStore.mattingModelStatus = 'checking'
    objectSelectionStore.notify()
    window.api.matting
      .checkModel()
      .then((status) => {
        objectSelectionStore.mattingModelStatus = status.ready ? 'ready' : 'error'
        objectSelectionStore.notify()
      })
      .catch(() => {
        objectSelectionStore.mattingModelStatus = 'error'
        objectSelectionStore.notify()
      })
  }, [])
  // ── Core inference pipeline ────────────────────────────────────────────────

  const runInference = useCallback(async (): Promise<void> => {
    if (isRunningRef.current) return
    const handle = canvasHandleRef.current
    if (!handle) return

    const { canvas: { width, height } } = stateRef.current

    // Save original selection before first inference in this session
    if (!hasSavedMaskRef.current) {
      savedMaskRef.current = selectionStore.mask ? new Uint8Array(selectionStore.mask) : null
      hasSavedMaskRef.current = true
    }

    isRunningRef.current = true
    objectSelectionStore.inferenceStatus = 'running'
    objectSelectionStore.notify()

    try {
      // Encode image if cache is stale
      if (encodedCacheVersionRef.current !== objectSelectionStore.cacheVersion) {
        const { data: rgba, width: rw, height: rh } = await handle.rasterizeComposite('sample')
        const data1024 = await downsampleTo1024(rgba as Uint8Array, rw, rh)
        await window.api.sam.encodeImage(data1024, width, height)
        encodedCacheVersionRef.current = objectSelectionStore.cacheVersion
      }

      const store = objectSelectionStore
      const boxPrompt = store.promptMode === 'rect' ? store.dragRect : null
      const decodeResult = await window.api.sam.decodeMask({
        embeddings: null,
        points: store.points,
        box: boxPrompt,
        origWidth: width,
        origHeight: height,
      })

      let upsampled = await upsampleMask(new Uint8Array(decodeResult.mask), width, height)

      // Drop floating speckles: keep only components that contain a prompt seed.
      // For positive points use them directly; for a box, sample its interior on
      // a 5×5 grid (covers most of the prompted region).
      const seeds: Array<{ x: number; y: number }> = store.points
        .filter(p => p.positive)
        .map(p => ({ x: p.x, y: p.y }))
      if (boxPrompt) {
        const x1 = Math.min(boxPrompt.x1, boxPrompt.x2)
        const y1 = Math.min(boxPrompt.y1, boxPrompt.y2)
        const x2 = Math.max(boxPrompt.x1, boxPrompt.x2)
        const y2 = Math.max(boxPrompt.y1, boxPrompt.y2)
        for (let gy = 1; gy <= 5; gy++) {
          for (let gx = 1; gx <= 5; gx++) {
            seeds.push({
              x: x1 + ((x2 - x1) * gx) / 6,
              y: y1 + ((y2 - y1) * gy) / 6,
            })
          }
        }
      }
      upsampled = keepComponentsContainingSeeds(upsampled, width, height, seeds)

      objectSelectionStore.pendingMask = upsampled
      objectSelectionStore.pendingMaskRefined = false

      // Live preview: show the combined result for the current mode so the user
      // sees exactly what will be committed. For 'set' just apply directly;
      // for add/subtract/intersect restore a copy of the saved mask first so
      // applyMask operates on the correct base (and cannot corrupt savedMaskRef).
      const { feather, antiAlias } = objectSelectionOptions
      const previewMode = objectSelectionOptions.mode
      if (previewMode !== 'set' && savedMaskRef.current !== null) {
        selectionStore.restoreMask(new Uint8Array(savedMaskRef.current))
      } else if (previewMode !== 'set') {
        selectionStore.clear()
      }
      selectionStore.setFromSAMMask(upsampled, previewMode, feather, antiAlias)

      objectSelectionStore.inferenceStatus = 'idle'
      objectSelectionStore.notify()
    } catch (err) {
      console.error('[ObjectSelection] Inference failed:', err)
      objectSelectionStore.inferenceStatus = 'error'
      objectSelectionStore.notify()
    } finally {
      isRunningRef.current = false
    }
  }, [canvasHandleRef, stateRef])

  // ── Select Subject ─────────────────────────────────────────────────────────

  const runSelectSubject = useCallback(async (): Promise<void> => {
    if (isRunningRef.current) return
    const handle = canvasHandleRef.current
    if (!handle) return

    const { canvas: { width, height } } = stateRef.current

    if (!hasSavedMaskRef.current) {
      savedMaskRef.current = selectionStore.mask ? new Uint8Array(selectionStore.mask) : null
      hasSavedMaskRef.current = true
    }

    isRunningRef.current = true
    objectSelectionStore.inferenceStatus = 'running'
    objectSelectionStore.notify()

    try {
      if (encodedCacheVersionRef.current !== objectSelectionStore.cacheVersion) {
        const { data: rgba, width: rw, height: rh } = await handle.rasterizeComposite('sample')
        const data1024 = await downsampleTo1024(rgba as Uint8Array, rw, rh)
        await window.api.sam.encodeImage(data1024, width, height)
        encodedCacheVersionRef.current = objectSelectionStore.cacheVersion
      }

      // Use canvas center as implicit positive point for subject detection
      const centerPoint = { x: width / 2, y: height / 2, positive: true }

      const decodeResult = await window.api.sam.decodeMask({
        embeddings: null,
        points: [centerPoint],
        box: null,
        origWidth: width,
        origHeight: height,
      })

      let upsampled = await upsampleMask(new Uint8Array(decodeResult.mask), width, height)
      // Subject mode: keep only the component containing the canvas center.
      upsampled = keepComponentsContainingSeeds(upsampled, width, height, [centerPoint])
      objectSelectionStore.pendingMask = upsampled
      objectSelectionStore.pendingMaskRefined = false

      const { feather, antiAlias } = objectSelectionOptions
      const previewMode = objectSelectionOptions.mode
      if (previewMode !== 'set' && savedMaskRef.current !== null) {
        selectionStore.restoreMask(new Uint8Array(savedMaskRef.current))
      } else if (previewMode !== 'set') {
        selectionStore.clear()
      }
      selectionStore.setFromSAMMask(upsampled, previewMode, feather, antiAlias)

      objectSelectionStore.inferenceStatus = 'idle'
      objectSelectionStore.notify()
    } catch (err) {
      console.error('[ObjectSelection] Select Subject failed:', err)
      objectSelectionStore.inferenceStatus = 'error'
      objectSelectionStore.notify()
    } finally {
      isRunningRef.current = false
    }
  }, [canvasHandleRef, stateRef])

  // ── Commit and Cancel ──────────────────────────────────────────────────────

  const commitSelection = useCallback((mode: SelectionMode): void => {
    const pending = objectSelectionStore.pendingMask
    if (!pending) return

    const { feather, antiAlias } = objectSelectionOptions
    // If the mask was already processed by Refine Edge its alpha values are
    // final — skip the extra feather/antiAlias pass to avoid softening them.
    const applyFeather = objectSelectionStore.pendingMaskRefined ? 0 : feather
    const applyAA = objectSelectionStore.pendingMaskRefined ? false : antiAlias

    // Restore the original selection, then apply new mask with the chosen mode
    if (savedMaskRef.current !== null) {
      selectionStore.restoreMask(savedMaskRef.current)
    } else {
      selectionStore.clear()
    }
    selectionStore.setFromSAMMask(pending, mode, applyFeather, applyAA)

    captureHistoryRef.current('Object Selection')

    hasSavedMaskRef.current = false
    savedMaskRef.current = null
    objectSelectionStore.reset()
  }, [])

  const cancelSelection = useCallback((): void => {
    if (savedMaskRef.current !== null) {
      selectionStore.restoreMask(savedMaskRef.current)
    } else {
      selectionStore.clear()
    }
    hasSavedMaskRef.current = false
    savedMaskRef.current = null
    objectSelectionStore.reset()
  }, [])

  // ── Refine Edge (alpha matting via RVM) ────────────────────────────────────

  const downloadMattingModel = useCallback(async (): Promise<void> => {
    objectSelectionStore.mattingModelStatus = 'downloading'
    objectSelectionStore.mattingDownloadProgress = null
    objectSelectionStore.mattingModelError = null
    objectSelectionStore.notify()

    const unsubscribe = window.api.matting.onDownloadProgress((p) => {
      objectSelectionStore.mattingDownloadProgress = p
      objectSelectionStore.notify()
    })

    try {
      const result = await window.api.matting.downloadModel()
      if ('error' in result) {
        objectSelectionStore.mattingModelStatus = 'error'
        objectSelectionStore.mattingModelError = result.error
      } else {
        objectSelectionStore.mattingModelStatus = 'ready'
        objectSelectionStore.mattingDownloadProgress = null
      }
    } catch (err) {
      objectSelectionStore.mattingModelStatus = 'error'
      objectSelectionStore.mattingModelError = err instanceof Error ? err.message : String(err)
    } finally {
      unsubscribe()
      objectSelectionStore.notify()
    }
  }, [])

  const refineEdge = useCallback(async (): Promise<void> => {
    if (objectSelectionStore.refineStatus === 'running') return
    // Hair mode requires the RVM model; object (GrabCut) mode works without it.
    if (
      objectSelectionOptions.refineMode === 'hair' &&
      objectSelectionStore.mattingModelStatus !== 'ready'
    ) return
    const handle = canvasHandleRef.current
    if (!handle) return

    const mask = selectionStore.mask
    const cw = selectionStore.width
    const ch = selectionStore.height
    if (!mask || cw === 0 || ch === 0) return

    objectSelectionStore.refineStatus = 'running'
    objectSelectionStore.notify()

    try {
      // 1. Tight bbox of selected pixels (>= 128) with padding for context.
      let minX = cw, minY = ch, maxX = -1, maxY = -1
      for (let y = 0; y < ch; y++) {
        const row = y * cw
        for (let x = 0; x < cw; x++) {
          if (mask[row + x] >= 128) {
            if (x < minX) minX = x
            if (x > maxX) maxX = x
            if (y < minY) minY = y
            if (y > maxY) maxY = y
          }
        }
      }
      if (maxX < 0) {
        objectSelectionStore.refineStatus = 'idle'
        objectSelectionStore.notify()
        return
      }

      // Pad the bbox: hair (RVM) needs context for wispy edges; object mode
      // needs room for GrabCut's outer dilation to extend beyond SAM's mask
      // and capture pixels SAM missed (e.g. bright rims of dark objects).
      const PAD = objectSelectionOptions.refineMode === 'object' ? 96 : 64
      const x0 = Math.max(0, minX - PAD)
      const y0 = Math.max(0, minY - PAD)
      const x1 = Math.min(cw - 1, maxX + PAD)
      const y1 = Math.min(ch - 1, maxY + PAD)
      const cropW = x1 - x0 + 1
      const cropH = y1 - y0 + 1

      // 2. Composite RGBA + crop.
      const { data: rgba, width: rw, height: rh } = await handle.rasterizeComposite('sample')
      if (rw !== cw || rh !== ch) {
        throw new Error(`Composite size ${rw}×${rh} ≠ canvas ${cw}×${ch}`)
      }

      const cropRgba = new Uint8Array(cropW * cropH * 4)
      for (let y = 0; y < cropH; y++) {
        const srcRow = ((y + y0) * cw + x0) * 4
        cropRgba.set(rgba.subarray(srcRow, srcRow + cropW * 4), y * cropW * 4)
      }

      // 3. Crop selection mask.
      const cropMask = new Uint8Array(cropW * cropH)
      for (let y = 0; y < cropH; y++) {
        const srcRow = (y + y0) * cw + x0
        cropMask.set(mask.subarray(srcRow, srcRow + cropW), y * cropW)
      }

      // 4. Refine edges based on selected mode.
      // Object mode (GrabCut) uses an asymmetric trimap: small inner erosion
      // gives a confident FG core to train colour models from; a wider outer
      // dilation gives GrabCut room to expand into pixels SAM missed (e.g.
      // bright rims of dark objects).
      const erodeR =
        objectSelectionOptions.refineMode === 'object'
          ? Math.max(2, Math.min(8, Math.round(Math.min(cropW, cropH) * 0.005)))
          : Math.max(8, Math.min(48, Math.round(Math.min(cropW, cropH) * 0.05)))
      const dilateR =
        objectSelectionOptions.refineMode === 'object'
          ? Math.max(20, Math.min(60, Math.round(Math.min(cropW, cropH) * 0.04)))
          : erodeR
      const bandRadius = erodeR  // legacy name, used by hair-mode IPC call below

      let refinedCrop: Uint8Array

      if (objectSelectionOptions.refineMode === 'object') {
        const tTri0 = performance.now()
        // Build trimap via O(N) integral image of the binary selection.
        // erosion(Re)  = all pixels in (2Re+1)² window are FG → window sum == area
        // dilation(Rd) = at least one pixel in (2Rd+1)² is FG → window sum > 0
        const N = cropW * cropH
        const trimap = new Uint8Array(N)

        // Integral image of binary {0,1}. Width/height +1 for the standard
        // sum-area-table convention (zero row/col at index 0).
        const iw = cropW + 1
        const ih = cropH + 1
        const ii = new Int32Array(iw * ih)
        for (let y = 0; y < cropH; y++) {
          let rowSum = 0
          const dstBase = (y + 1) * iw
          const upBase  = y * iw
          for (let x = 0; x < cropW; x++) {
            rowSum += cropMask[y * cropW + x] >= 128 ? 1 : 0
            ii[dstBase + (x + 1)] = ii[upBase + (x + 1)] + rowSum
          }
        }
        const windowSum = (x: number, y: number, R: number): { sum: number; area: number } => {
          const x0w = Math.max(0, x - R)
          const x1w = Math.min(cropW - 1, x + R)
          const y0w = Math.max(0, y - R)
          const y1w = Math.min(cropH - 1, y + R)
          const sum =
            ii[(y1w + 1) * iw + (x1w + 1)] -
            ii[y0w       * iw + (x1w + 1)] -
            ii[(y1w + 1) * iw + x0w]       +
            ii[y0w       * iw + x0w]
          const area = (x1w - x0w + 1) * (y1w - y0w + 1)
          return { sum, area }
        }
        for (let y = 0; y < cropH; y++) {
          for (let x = 0; x < cropW; x++) {
            const e = windowSum(x, y, erodeR)
            if (e.sum === e.area) {
              trimap[y * cropW + x] = 255 // definite FG (eroded interior)
              continue
            }
            const d = windowSum(x, y, dilateR)
            trimap[y * cropW + x] = d.sum === 0 ? 0 : 128 // BG outside dilation, else unknown
          }
        }
        const tTri = performance.now() - tTri0
        const tGC0 = performance.now()
        refinedCrop = await grabCutHybrid(cropRgba, cropW, cropH, trimap)
        const tGC = performance.now() - tGC0
        console.log(`[refineEdge] crop=${cropW}×${cropH} erode=${erodeR} dilate=${dilateR} trimap=${tTri.toFixed(0)}ms grabcut=${tGC.toFixed(0)}ms`)
      } else {
        // Hair / fur mode: RVM neural matting via IPC.
        const { alpha } = await window.api.matting.refine({
          imageRgba: cropRgba,
          width: cropW,
          height: cropH,
          selectionMask: cropMask,
          bandRadius,
          mode: objectSelectionOptions.refineMode,
        })
        refinedCrop = new Uint8Array(alpha.buffer, alpha.byteOffset, alpha.byteLength)
      }

      // 5. Place refined crop back into a canvas-sized mask. Outside the crop
      //    keep the original selection (padding ensures the refined region fully
      //    spans the original boundary, so nothing visible changes outside it).
      const out = new Uint8Array(mask)
      for (let y = 0; y < cropH; y++) {
        const dstRow = (y + y0) * cw + x0
        out.set(refinedCrop.subarray(y * cropW, (y + 1) * cropW), dstRow)
      }

      // Use setFromSAMMask so border segments are recomputed (restoreMask
      // would leave the marching-ants overlay empty even though the mask is
      // correct in memory). Pass feather=0, antiAlias=false to keep the
      // refined alpha exactly as RVM produced it.
      selectionStore.setFromSAMMask(out, 'set', 0, false)

      // Update pendingMask so a subsequent Commit uses the refined result,
      // not the original coarse SAM mask.
      objectSelectionStore.pendingMask = out
      objectSelectionStore.pendingMaskRefined = true

      captureHistoryRef.current('Refine Edge')

      objectSelectionStore.refineStatus = 'idle'
      objectSelectionStore.notify()
    } catch (err) {
      console.error('[ObjectSelection] Refine Edge failed:', err)
      objectSelectionStore.refineStatus = 'error'
      objectSelectionStore.notify()
    }
  }, [canvasHandleRef])

  // ── Wire module-level callbacks (called by the Options UI) ─────────────────

  useEffect(() => {
    objectSelectionCallbacks.commit = commitSelection
    objectSelectionCallbacks.cancel = cancelSelection
    objectSelectionCallbacks.runSubject = () => { void runSelectSubject() }
    objectSelectionCallbacks.refineEdge = () => { void refineEdge() }
    objectSelectionCallbacks.downloadMattingModel = () => { void downloadMattingModel() }
    return () => {
      objectSelectionCallbacks.commit = () => {}
      objectSelectionCallbacks.cancel = () => {}
      objectSelectionCallbacks.runSubject = () => {}
      objectSelectionCallbacks.refineEdge = () => {}
      objectSelectionCallbacks.downloadMattingModel = () => {}
    }
  }, [commitSelection, cancelSelection, runSelectSubject, refineEdge, downloadMattingModel])

  // ── Store subscription → trigger inference ─────────────────────────────────

  const runInferenceRef = useRef(runInference)
  runInferenceRef.current = runInference

  useEffect(() => {
    let prevPointCount = objectSelectionStore.points.length
    let prevIsDragging = objectSelectionStore.isDragging

    const onStoreChange = (): void => {
      const store = objectSelectionStore
      if (store.modelStatus !== 'ready') return

      if (store.promptMode === 'rect') {
        const dragEnded = prevIsDragging && !store.isDragging && store.dragRect !== null
        prevIsDragging = store.isDragging
        if (dragEnded) {
          void runInferenceRef.current()
        }
      } else {
        const pointAdded = store.points.length > prevPointCount
        prevPointCount = store.points.length
        if (pointAdded || store.points.length > 0) {
          if (debounceTimerRef.current !== null) clearTimeout(debounceTimerRef.current)
          if (store.points.length > 0) {
            debounceTimerRef.current = setTimeout(() => {
              void runInferenceRef.current()
            }, 300)
          }
        }
      }
    }

    objectSelectionStore.subscribe(onStoreChange)
    return () => {
      objectSelectionStore.unsubscribe(onStoreChange)
      if (debounceTimerRef.current !== null) {
        clearTimeout(debounceTimerRef.current)
        debounceTimerRef.current = null
      }
    }
  }, [])

  // ── Keyboard handling (capture phase so Escape/Enter/Backspace don't bubble) ─

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (stateRef.current.activeTool !== 'object-selection') return
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return

      if (e.key === 'Escape') {
        e.stopPropagation()
        cancelSelection()
        return
      }

      if (e.key === 'Enter') {
        e.stopPropagation()
        e.preventDefault()
        commitSelection(objectSelectionOptions.mode)
        return
      }

      if ((e.key === 'Backspace' || e.key === 'Delete') &&
          objectSelectionStore.promptMode === 'point') {
        e.stopPropagation()
        e.preventDefault()
        if (objectSelectionStore.points.length > 0) {
          objectSelectionStore.removeLastPoint()
          // Inference re-triggered via store subscription (debounced)
        }
        return
      }
    }

    document.addEventListener('keydown', onKey, true)
    return () => document.removeEventListener('keydown', onKey, true)
  }, [cancelSelection, commitSelection])

  return { invalidateSamCache }
}
