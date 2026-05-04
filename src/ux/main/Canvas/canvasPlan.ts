import type { AdjustmentLayerState, LayerState, RGBAColor, OutlineParams, PixelFormat } from '@/types'
import { isGroupLayer, isCompositeLayer, isContainerLayer } from '@/types'
import { buildCurvesLuts } from '@/core/operations/adjustments/curves'
import type { GpuLayer, AdjustmentRenderOp, RenderPlanEntry } from '@/graphicspipeline/webgpu/rendering/WebGPURenderer'
import { buildRootLayerIds } from '@/utils/layerTree'

function srgbByteToLinear(r: number, g: number, b: number): { r: number; g: number; b: number } {
  const toLinear = (c: number): number => {
    const s = c / 255
    return s <= 0.04045 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4)
  }
  return { r: toLinear(r), g: toLinear(g), b: toLinear(b) }
}

function linearSrgbToOklab(r: number, g: number, b: number): { L: number; a: number; b: number } {
  const l = 0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b
  const m = 0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b
  const s = 0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b
  const l_ = Math.cbrt(Math.max(l, 0))
  const m_ = Math.cbrt(Math.max(m, 0))
  const s_ = Math.cbrt(Math.max(s, 0))
  return {
    L: 0.2104542553 * l_ + 0.7936177850 * m_ - 0.0040720468 * s_,
    a: 1.9779984951 * l_ - 2.4285922050 * m_ + 0.4505937099 * s_,
    b: 0.0259040371 * l_ + 0.7827717662 * m_ - 0.8086757660 * s_,
  }
}

export function buildAdjustmentEntry(
  ls: AdjustmentLayerState,
  mask: GpuLayer | undefined,
  swatches: RGBAColor[],
): AdjustmentRenderOp | null {
  if (ls.adjustmentType === 'brightness-contrast') {
    return {
      kind: 'brightness-contrast',
      layerId: ls.id,
      brightness: ls.params.brightness,
      contrast: ls.params.contrast,
      visible: ls.visible,
      selMaskLayer: mask,
    }
  }
  if (ls.adjustmentType === 'hue-saturation') {
    return {
      kind: 'hue-saturation',
      layerId: ls.id,
      hue: ls.params.hue,
      saturation: ls.params.saturation,
      lightness: ls.params.lightness,
      visible: ls.visible,
      selMaskLayer: mask,
    }
  }
  if (ls.adjustmentType === 'color-vibrance') {
    return {
      kind: 'color-vibrance',
      layerId: ls.id,
      vibrance: ls.params.vibrance,
      saturation: ls.params.saturation,
      visible: ls.visible,
      selMaskLayer: mask,
    }
  }
  if (ls.adjustmentType === 'color-balance') {
    return {
      kind: 'color-balance',
      layerId: ls.id,
      params: ls.params,
      visible: ls.visible,
      selMaskLayer: mask,
    }
  }
  if (ls.adjustmentType === 'black-and-white') {
    return {
      kind: 'black-and-white',
      layerId: ls.id,
      params: ls.params,
      visible: ls.visible,
      selMaskLayer: mask,
    }
  }
  if (ls.adjustmentType === 'color-temperature') {
    return {
      kind: 'color-temperature',
      layerId: ls.id,
      temperature: ls.params.temperature,
      tint: ls.params.tint,
      visible: ls.visible,
      selMaskLayer: mask,
    }
  }
  if (ls.adjustmentType === 'color-invert') {
    return {
      kind: 'color-invert',
      layerId: ls.id,
      visible: ls.visible,
      selMaskLayer: mask,
    }
  }
  if (ls.adjustmentType === 'selective-color') {
    return {
      kind: 'selective-color',
      layerId: ls.id,
      params: ls.params,
      visible: ls.visible,
      selMaskLayer: mask,
    }
  }
  if (ls.adjustmentType === 'curves') {
    return {
      kind: 'curves',
      layerId: ls.id,
      params: ls.params,
      luts: buildCurvesLuts(ls.params),
      visible: ls.visible,
      selMaskLayer: mask,
    }
  }
  if (ls.adjustmentType === 'color-grading') {
    return {
      kind: 'color-grading',
      layerId: ls.id,
      params: ls.params,
      visible: ls.visible,
      selMaskLayer: mask,
    }
  }
  if (ls.adjustmentType === 'reduce-colors') {
    const { mode, derivedPalette } = ls.params
    const sourceColors: RGBAColor[] = mode === 'reduce'
      ? (derivedPalette ?? [])
      : (swatches.length >= 2 ? swatches : [])

    const paletteCount = Math.min(sourceColors.length, 256)
    const palette = new Float32Array(256 * 4)
    for (let i = 0; i < paletteCount; i++) {
      const { r, g, b } = sourceColors[i]
      const lin = srgbByteToLinear(r, g, b)
      const lab = linearSrgbToOklab(lin.r, lin.g, lin.b)
      palette[i * 4 + 0] = lab.L
      palette[i * 4 + 1] = lab.a
      palette[i * 4 + 2] = lab.b
      palette[i * 4 + 3] = 0
    }
    return {
      kind: 'reduce-colors',
      layerId: ls.id,
      visible: ls.visible,
      selMaskLayer: mask,
      palette,
      paletteCount,
    }
  }
  if (ls.adjustmentType === 'color-dithering') {
    const STYLE_MAP: Record<string, number> = {
      'bayer4': 0, 'bayer8': 1,
    }
    const style = STYLE_MAP[ls.params.style] ?? 0
    const paletteCount = Math.min(swatches.length, 256)
    const palette = new Float32Array(256 * 4)
    for (let i = 0; i < paletteCount; i++) {
      const { r, g, b } = swatches[i]
      const lin = srgbByteToLinear(r, g, b)
      palette[i * 4 + 0] = lin.r
      palette[i * 4 + 1] = lin.g
      palette[i * 4 + 2] = lin.b
      palette[i * 4 + 3] = 0
    }
    return {
      kind: 'color-dithering',
      layerId: ls.id,
      visible: ls.visible,
      selMaskLayer: mask,
      palette,
      paletteCount,
      style,
      opacity: ls.params.opacity ?? 100,
    }
  }
  if (ls.adjustmentType === 'bloom') {
    return {
      kind: 'bloom',
      layerId: ls.id,
      threshold: ls.params.threshold,
      strength:  ls.params.strength,
      spread:    ls.params.spread,
      quality:   ls.params.quality,
      visible:   ls.visible,
      selMaskLayer: mask,
    }
  }
  if (ls.adjustmentType === 'chromatic-aberration') {
    return {
      kind:     'chromatic-aberration',
      layerId:  ls.id,
      caType:   ls.params.type,
      distance: ls.params.distance,
      angle:    ls.params.angle,
      visible:  ls.visible,
      selMaskLayer: mask,
    }
  }
  if (ls.adjustmentType === 'halation') {
    return {
      kind:      'halation',
      layerId:   ls.id,
      threshold: ls.params.threshold,
      spread:    ls.params.spread,
      blur:      ls.params.blur,
      strength:  ls.params.strength,
      visible:   ls.visible,
      selMaskLayer: mask,
    }
  }
  if (ls.adjustmentType === 'color-key') {
    const { r, g, b } = ls.params.keyColor
    return {
      kind:         'color-key',
      layerId:      ls.id,
      keyR:         r / 255,
      keyG:         g / 255,
      keyB:         b / 255,
      tolerance:    ls.params.tolerance,
      softness:     ls.params.softness,
      dilation:     ls.params.dilation,
      visible:      ls.visible,
      selMaskLayer: mask,
    }
  }
  if (ls.adjustmentType === 'drop-shadow') {
    const { color, opacity, offsetX, offsetY, spread, softness, blendMode, knockout } = ls.params
    return {
      kind:      'drop-shadow',
      layerId:   ls.id,
      colorR:    color.r / 255,
      colorG:    color.g / 255,
      colorB:    color.b / 255,
      colorA:    color.a / 255,
      opacity:   opacity / 100,
      offsetX,
      offsetY,
      spread,
      softness,
      blendMode,
      knockout,
      visible:      ls.visible,
      selMaskLayer: mask,
    }
  }
  if (ls.adjustmentType === 'glow') {
    const { color, opacity, spread, softness, blendMode, knockout } = ls.params
    return {
      kind:      'glow',
      layerId:   ls.id,
      colorR:    color.r / 255,
      colorG:    color.g / 255,
      colorB:    color.b / 255,
      colorA:    color.a / 255,
      opacity:   opacity / 100,
      spread,
      softness,
      blendMode,
      knockout,
      visible:      ls.visible,
      selMaskLayer: mask,
    }
  }
  if (ls.adjustmentType === 'outline') {
    const { color, opacity, thickness, position, softness } = ls.params as OutlineParams
    return {
      kind:      'outline',
      layerId:   ls.id,
      colorR:    color.r / 255,
      colorG:    color.g / 255,
      colorB:    color.b / 255,
      colorA:    color.a / 255,
      opacity:   opacity / 100,
      thickness: Math.round(thickness),
      position,
      softness,
      visible:      ls.visible,
      selMaskLayer: mask,
    }
  }
  if (ls.adjustmentType === 'halftone') {
    return {
      kind:      'halftone',
      layerId:   ls.id,
      frequency: ls.params.frequency,
      offsetC:   ls.params.offsetC,
      offsetM:   ls.params.offsetM,
      offsetY:   ls.params.offsetY,
      offsetK:   ls.params.offsetK,
      mode:      ls.params.mode,
      visible:   ls.visible,
      selMaskLayer: mask,
    }
  }
  if (ls.adjustmentType === 'gaussian-blur') {
    return { kind: 'gaussian-blur', layerId: ls.id, radius: ls.params.radius, visible: ls.visible, selMaskLayer: mask }
  }
  if (ls.adjustmentType === 'box-blur') {
    return { kind: 'box-blur', layerId: ls.id, radius: ls.params.radius, visible: ls.visible, selMaskLayer: mask }
  }
  if (ls.adjustmentType === 'radial-blur') {
    const { mode, amount, centerX, centerY, quality } = ls.params
    return { kind: 'radial-blur', layerId: ls.id, mode, amount, centerX, centerY, quality, visible: ls.visible, selMaskLayer: mask }
  }
  if (ls.adjustmentType === 'motion-blur') {
    return { kind: 'motion-blur', layerId: ls.id, angle: ls.params.angle, distance: ls.params.distance, visible: ls.visible, selMaskLayer: mask }
  }
  if (ls.adjustmentType === 'remove-motion-blur') {
    const { angle, distance, noiseReduction } = ls.params
    return { kind: 'remove-motion-blur', layerId: ls.id, angle, distance, noiseReduction, visible: ls.visible, selMaskLayer: mask }
  }
  if (ls.adjustmentType === 'lens-blur') {
    const { radius, bladeCount, bladeCurvature, rotation } = ls.params
    return { kind: 'lens-blur', layerId: ls.id, radius, bladeCount, bladeCurvature, rotation, visible: ls.visible, selMaskLayer: mask }
  }
  if (ls.adjustmentType === 'sharpen') {
    return { kind: 'sharpen', layerId: ls.id, visible: ls.visible, selMaskLayer: mask }
  }
  if (ls.adjustmentType === 'sharpen-more') {
    return { kind: 'sharpen-more', layerId: ls.id, visible: ls.visible, selMaskLayer: mask }
  }
  if (ls.adjustmentType === 'unsharp-mask') {
    const { amount, radius, threshold } = ls.params
    return { kind: 'unsharp-mask', layerId: ls.id, amount, radius, threshold, visible: ls.visible, selMaskLayer: mask }
  }
  if (ls.adjustmentType === 'smart-sharpen') {
    const { amount, radius, reduceNoise, remove } = ls.params
    return { kind: 'smart-sharpen', layerId: ls.id, amount, radius, reduceNoise, remove: remove === 'gaussian' ? 0 : 1, visible: ls.visible, selMaskLayer: mask }
  }
  if (ls.adjustmentType === 'add-noise') {
    const { amount, distribution, monochromatic, seed } = ls.params
    return { kind: 'add-noise', layerId: ls.id, amount, distribution: distribution === 'gaussian' ? 1 : 0, monochromatic: monochromatic ? 1 : 0, seed, visible: ls.visible, selMaskLayer: mask }
  }
  if (ls.adjustmentType === 'film-grain') {
    const { grainSize, intensity, roughness, seed } = ls.params
    return { kind: 'film-grain', layerId: ls.id, grainSize, intensity, roughness, seed, visible: ls.visible, selMaskLayer: mask }
  }
  if (ls.adjustmentType === 'median-filter') {
    return { kind: 'median-filter', layerId: ls.id, radius: ls.params.radius, visible: ls.visible, selMaskLayer: mask }
  }
  if (ls.adjustmentType === 'bilateral-filter') {
    const { radius, sigmaSpatial, sigmaColor } = ls.params
    return { kind: 'bilateral-filter', layerId: ls.id, radius, sigmaSpatial, sigmaColor, visible: ls.visible, selMaskLayer: mask }
  }
  if (ls.adjustmentType === 'reduce-noise') {
    const { strength, preserveDetails, reduceColorNoise, sharpenDetails } = ls.params
    return { kind: 'reduce-noise', layerId: ls.id, strength, preserveDetails, reduceColorNoise, sharpenDetails, visible: ls.visible, selMaskLayer: mask }
  }
  if (ls.adjustmentType === 'clouds') {
    const { scale, opacity, colorMode, fgR, fgG, fgB, bgR, bgG, bgB, seed } = ls.params
    const fgColor = (fgR | (fgG << 8) | (fgB << 16)) >>> 0
    const bgColor = (bgR | (bgG << 8) | (bgB << 16)) >>> 0
    return { kind: 'clouds', layerId: ls.id, scale, opacity, colorMode: colorMode === 'color' ? 1 : 0, fgColor, bgColor, seed, visible: ls.visible, selMaskLayer: mask }
  }
  if (ls.adjustmentType === 'pixelate') {
    return { kind: 'pixelate', layerId: ls.id, blockSize: ls.params.blockSize, visible: ls.visible, selMaskLayer: mask }
  }
  if (ls.adjustmentType === 'bevel') {
    const { width, softness, angle, strength } = ls.params
    return {
      kind:     'bevel',
      layerId:  ls.id,
      width,
      softness,
      angle,
      strength,
      visible:      ls.visible,
      selMaskLayer: mask,
    }
  }
  if (ls.adjustmentType === 'inner-shadow') {
    const { color, opacity, offsetX, offsetY, spread, softness } = ls.params
    return {
      kind:     'inner-shadow',
      layerId:  ls.id,
      colorR:   color.r / 255,
      colorG:   color.g / 255,
      colorB:   color.b / 255,
      colorA:   color.a / 255,
      opacity:  opacity / 100,
      offsetX,
      offsetY,
      spread,
      softness,
      visible:      ls.visible,
      selMaskLayer: mask,
    }
  }
  if (ls.adjustmentType === 'inner-glow') {
    const { color, opacity, spread, softness } = ls.params
    return {
      kind:     'inner-glow',
      layerId:  ls.id,
      colorR:   color.r / 255,
      colorG:   color.g / 255,
      colorB:   color.b / 255,
      colorA:   color.a / 255,
      opacity:  opacity / 100,
      spread,
      softness,
      visible:      ls.visible,
      selMaskLayer: mask,
    }
  }
  if (ls.adjustmentType === 'seamless-texture') {
    const { breakRepetition, cellSize, blendRadius, seamlessBorders, borderRadius, seed } = ls.params
    return {
      kind:            'seamless-texture',
      layerId:         ls.id,
      breakRepetition,
      cellSize,
      blendRadius,
      seamlessBorders,
      borderRadius,
      seed,
      visible:      ls.visible,
      selMaskLayer: mask,
    }
  }
  const _exhaustive: never = ls
  return _exhaustive
}

export function buildSubPlan(
  orderedIds: readonly string[],
  layers: readonly LayerState[],
  glLayers: Map<string, GpuLayer>,
  maskMap: Map<string, GpuLayer>,
  adjustmentMaskMap: Map<string, GpuLayer>,
  bypassedAdjustmentIds: ReadonlySet<string>,
  swatches: RGBAColor[],
  pixelFormat: PixelFormat = 'rgba8',
): RenderPlanEntry[] {
  const layersById = new Map(layers.map(l => [l.id, l]))
  const plan: RenderPlanEntry[] = []

  for (const id of orderedIds) {
    const ls = layersById.get(id)
    if (!ls) continue

    // Skip mask layers — handled via their pixel parent
    if ('type' in ls && ls.type === 'mask') continue

    // Adjustment layers
    if ('type' in ls && ls.type === 'adjustment') {
      if (pixelFormat === 'indexed8') continue
      const adjLs = ls as AdjustmentLayerState
      const parent = layersById.get(adjLs.parentId)
      // Per-layer attachment (parentId → non-container layer): skip, bundled with pixel parent
      if (parent && !isContainerLayer(parent)) continue
      // Composite-layer attachment: bundled into composite-layer entry, skip standalone emission
      if (parent && isCompositeLayer(parent)) continue
      // Group-scoped adjustment: treat as standalone
      if (bypassedAdjustmentIds.has(ls.id)) continue
      // Invisible adjustments are no-ops — omit from plan so planIsFlatLayersOnly
      // stays true and the incremental paint path remains available.
      if (!adjLs.visible) continue
      const entry = buildAdjustmentEntry(adjLs, adjustmentMaskMap.get(ls.id), swatches)
      if (entry) plan.push(entry)
      continue
    }

    // Group layer → recurse. Groups are purely organisational: always
    // pass-through with full opacity, no mask, no adjustments. For non-trivial
    // compositing semantics use a Composite Layer instead.
    if (isGroupLayer(ls)) {
      plan.push({
        kind: 'layer-group',
        groupId: ls.id,
        opacity: 1,
        blendMode: 'pass-through',
        visible: ls.visible,
        children: buildSubPlan(
          ls.childIds, layers, glLayers, maskMap, adjustmentMaskMap, bypassedAdjustmentIds, swatches, pixelFormat,
        ),
      })
      continue
    }

    // Composite layer → flatten children, apply attached adjustments
    if (isCompositeLayer(ls)) {
      const attachedAdj: AdjustmentRenderOp[] = []
      if (pixelFormat !== 'indexed8') {
        for (const adj of layers) {
          if (
            'type' in adj &&
            adj.type === 'adjustment' &&
            adj.visible !== false &&
            (adj as AdjustmentLayerState).parentId === ls.id &&
            !bypassedAdjustmentIds.has(adj.id)
          ) {
            const op = buildAdjustmentEntry(adj as AdjustmentLayerState, adjustmentMaskMap.get(adj.id), swatches)
            if (op) attachedAdj.push(op)
          }
        }
      }
      plan.push({
        kind: 'composite-layer',
        layerId: ls.id,
        opacity: ls.opacity,
        blendMode: ls.blendMode,
        visible: ls.visible,
        children: buildSubPlan(
          ls.childIds, layers, glLayers, maskMap, adjustmentMaskMap, bypassedAdjustmentIds, swatches, pixelFormat,
        ),
        adjustments: attachedAdj,
        locked: ls.locked === true,
      })
      continue
    }

    // Pixel, text, or shape layer — collect attached per-layer adjustments
    const baseLayer = glLayers.get(ls.id)
    if (!baseLayer) continue

    const adjustments: AdjustmentRenderOp[] = []
    if (pixelFormat !== 'indexed8') {
    for (const adj of layers) {
      if (
        'type' in adj &&
        adj.type === 'adjustment' &&
        adj.visible !== false &&
        (adj as AdjustmentLayerState).parentId === ls.id &&
        !bypassedAdjustmentIds.has(adj.id)
      ) {
        const op = buildAdjustmentEntry(adj as AdjustmentLayerState, adjustmentMaskMap.get(adj.id), swatches)
        if (op) adjustments.push(op)
      }
    }
    }

    if (adjustments.length > 0) {
      const isLocked = 'locked' in ls && (ls as { locked: boolean }).locked === true
      plan.push({
        kind: 'adjustment-group',
        parentLayerId: ls.id,
        baseLayer,
        baseMask: maskMap.get(ls.id),
        adjustments,
        locked: isLocked || undefined,
      })
    } else {
      plan.push({ kind: 'layer', layer: baseLayer, mask: maskMap.get(ls.id) })
    }
  }

  return plan
}

export function buildRenderPlan(
  layers: readonly LayerState[],
  glLayers: Map<string, GpuLayer>,
  maskMap: Map<string, GpuLayer>,
  adjustmentMaskMap: Map<string, GpuLayer>,
  bypassedAdjustmentIds: ReadonlySet<string>,
  swatches: RGBAColor[],
  pixelFormat: PixelFormat = 'rgba8',
): RenderPlanEntry[] {
  return buildSubPlan(
    buildRootLayerIds(layers),
    layers, glLayers, maskMap, adjustmentMaskMap, bypassedAdjustmentIds, swatches, pixelFormat,
  )
}
