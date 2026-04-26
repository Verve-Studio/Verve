import React, { useEffect } from 'react'
import { useAppContext } from '@/core/store/AppContext'
import type { AdjustmentLayerState, BrightnessContrastAdjustmentLayer, HueSaturationAdjustmentLayer, ColorVibranceAdjustmentLayer, ColorBalanceAdjustmentLayer, BlackAndWhiteAdjustmentLayer, ColorTemperatureAdjustmentLayer, ColorInvertAdjustmentLayer, SelectiveColorAdjustmentLayer, CurvesAdjustmentLayer, ColorGradingAdjustmentLayer, ReduceColorsAdjustmentLayer, ColorDitheringAdjustmentLayer, BloomAdjustmentLayer, ChromaticAberrationAdjustmentLayer, HalationAdjustmentLayer, ColorKeyAdjustmentLayer, DropShadowAdjustmentLayer, GlowAdjustmentLayer, OutlineAdjustmentLayer, HalftoneAdjustmentLayer, GaussianBlurAdjustmentLayer, BoxBlurAdjustmentLayer, RadialBlurAdjustmentLayer, MotionBlurAdjustmentLayer, RemoveMotionBlurAdjustmentLayer, LensBlurAdjustmentLayer, SharpenAdjustmentLayer, SharpenMoreAdjustmentLayer, UnsharpMaskAdjustmentLayer, SmartSharpenAdjustmentLayer, AddNoiseAdjustmentLayer, FilmGrainAdjustmentLayer, MedianFilterAdjustmentLayer, BilateralFilterAdjustmentLayer, ReduceNoiseAdjustmentLayer, CloudsAdjustmentLayer, PixelateAdjustmentLayer } from '@/types'
import type { CanvasHandle } from '@/ux/main/Canvas/Canvas'
import { BrightnessContrastPanel } from './adjustments/BrightnessContrastPanel/BrightnessContrastPanel'
import { HueSaturationPanel } from './adjustments/HueSaturationPanel/HueSaturationPanel'
import { ColorVibrancePanel } from './adjustments/ColorVibrancePanel/ColorVibrancePanel'
import { ColorBalancePanel } from './adjustments/ColorBalancePanel/ColorBalancePanel'
import { BlackAndWhitePanel } from './adjustments/BlackAndWhitePanel/BlackAndWhitePanel'
import { ColorTemperaturePanel } from './adjustments/ColorTemperaturePanel/ColorTemperaturePanel'
import { InvertPanel } from './adjustments/InvertPanel/InvertPanel'
import { SelectiveColorPanel } from './adjustments/SelectiveColorPanel/SelectiveColorPanel'
import { CurvesPanel } from './adjustments/CurvesPanel/CurvesPanel'
import { ColorGradingPanel } from './adjustments/ColorGradingPanel/ColorGradingPanel'
import { ReduceColorsPanel } from './adjustments/ReduceColorsPanel/ReduceColorsPanel'
import { ColorDitheringPanel } from './adjustments/ColorDitheringPanel/ColorDitheringPanel'
import { BloomOptions } from './effects/BloomOptions/BloomOptions'
import { ChromaticAberrationOptions } from './effects/ChromaticAberrationOptions/ChromaticAberrationOptions'
import { HalationOptions } from './effects/HalationOptions/HalationOptions'
import { ColorKeyPanel } from './effects/ColorKeyPanel/ColorKeyPanel'
import { DropShadowOptions } from './effects/DropShadowOptions/DropShadowOptions'
import { GlowOptions } from './effects/GlowOptions/GlowOptions'
import { OutlineOptions } from './effects/OutlineOptions/OutlineOptions'
import { HalftoneOptions } from './effects/HalftoneOptions/HalftoneOptions'
import { GaussianBlurPanel } from './filters/GaussianBlurPanel/GaussianBlurPanel'
import { SharpenPanel } from './filters/SharpenPanel/SharpenPanel'
import { BoxBlurPanel } from './filters/BoxBlurPanel/BoxBlurPanel'
import { RadialBlurPanel } from './filters/RadialBlurPanel/RadialBlurPanel'
import { MotionBlurPanel } from './filters/MotionBlurPanel/MotionBlurPanel'
import { RemoveMotionBlurPanel } from './filters/RemoveMotionBlurPanel/RemoveMotionBlurPanel'
import { LensBlurPanel } from './filters/LensBlurPanel/LensBlurPanel'
import { UnsharpMaskPanel } from './filters/UnsharpMaskPanel/UnsharpMaskPanel'
import { SmartSharpenPanel } from './filters/SmartSharpenPanel/SmartSharpenPanel'
import { AddNoisePanel } from './filters/AddNoisePanel/AddNoisePanel'
import { FilmGrainPanel } from './filters/FilmGrainPanel/FilmGrainPanel'
import { MedianFilterPanel } from './filters/MedianFilterPanel/MedianFilterPanel'
import { BilateralFilterPanel } from './filters/BilateralFilterPanel/BilateralFilterPanel'
import { ReduceNoisePanel } from './filters/ReduceNoisePanel/ReduceNoisePanel'
import { CloudsPanel } from './filters/CloudsPanel/CloudsPanel'
import { PixelatePanel } from './filters/PixelatePanel/PixelatePanel'
import { ToolWindow } from '@/ux'
import styles from './ToolWindow.module.scss'

// ─── Props ────────────────────────────────────────────────────────────────────

interface ToolWindowProps {
  onClose: () => void
  canvasHandleRef?: { readonly current: CanvasHandle | null }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function toolTitle(layer: AdjustmentLayerState): string {
  switch (layer.adjustmentType) {
    case 'brightness-contrast': return 'Brightness/Contrast'
    case 'hue-saturation':      return 'Hue/Saturation'
    case 'color-vibrance':      return 'Color Vibrance'
    case 'color-balance':       return 'Color Balance'
    case 'black-and-white':     return 'Black and White'
    case 'color-temperature':   return 'Color Temperature'
    case 'color-invert':        return 'Invert'
    case 'selective-color':     return 'Selective Color'
    case 'curves':              return 'Curves'
    case 'color-grading':       return 'Color Grading'
    case 'reduce-colors':       return 'Reduce Colors'
    case 'color-dithering':     return 'Color Dithering'
    case 'bloom':               return 'Bloom'
    case 'chromatic-aberration': return 'Chromatic Aberration'
    case 'halation':             return 'Halation'
    case 'color-key':            return 'Color Key'
    case 'drop-shadow':          return 'Drop Shadow'
    case 'glow':                 return 'Glow'
    case 'outline':              return 'Outline'
    case 'halftone':             return 'Halftone'
    case 'gaussian-blur':        return 'Gaussian Blur'
    case 'box-blur':             return 'Box Blur'
    case 'radial-blur':          return 'Radial Blur'
    case 'motion-blur':          return 'Motion Blur'
    case 'remove-motion-blur':   return 'Remove Motion Blur'
    case 'lens-blur':            return 'Lens Blur'
    case 'sharpen':              return 'Sharpen'
    case 'sharpen-more':         return 'Sharpen More'
    case 'unsharp-mask':         return 'Unsharp Mask'
    case 'smart-sharpen':        return 'Smart Sharpen'
    case 'add-noise':            return 'Add Noise'
    case 'film-grain':           return 'Film Grain'
    case 'median-filter':        return 'Median'
    case 'bilateral-filter':     return 'Bilateral Filter'
    case 'reduce-noise':         return 'Reduce Noise'
    case 'clouds':               return 'Clouds'
    case 'pixelate':             return 'Pixelate'
  }
}

const BrightnessContrastHeaderIcon = (): React.JSX.Element => (
  <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" aria-hidden="true">
    <circle cx="6" cy="6" r="2" />
    <path d="M6 1v1M6 10v1M1 6h1M10 6h1M2.5 2.5l.7.7M8.8 8.8l.7.7M9.5 2.5l-.7.7M3.2 8.8l-.7.7" />
  </svg>
)

const HueSaturationHeaderIcon = (): React.JSX.Element => (
  <svg width="12" height="12" viewBox="0 0 12 12" fill="currentColor" aria-hidden="true">
    <circle cx="6" cy="6" r="4.5" />
  </svg>
)

const ColorVibranceHeaderIcon = (): React.JSX.Element => (
  <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.2" aria-hidden="true">
    <circle cx="6" cy="6" r="1.8" />
    <circle cx="6" cy="6" r="4" />
  </svg>
)

const ColorBalanceHeaderIcon = (): React.JSX.Element => (
  <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.1" strokeLinecap="round" aria-hidden="true">
    <line x1="6" y1="1.5" x2="6" y2="10.5" />
    <line x1="2" y1="4" x2="10" y2="4" />
    <polygon points="2,4 1.1,6.2 2.9,6.2" fill="currentColor" stroke="none" />
    <polygon points="10,4 9.1,6.2 10.9,6.2" fill="currentColor" stroke="none" />
    <line x1="4.5" y1="10.5" x2="7.5" y2="10.5" />
  </svg>
)

const BlackAndWhiteHeaderIcon = (): React.JSX.Element => (
  <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true">
    <path d="M6 1.5 A4.5 4.5 0 0 0 6 10.5 Z" fill="currentColor" />
    <circle cx="6" cy="6" r="4.5" fill="none" stroke="currentColor" strokeWidth="1.2" />
  </svg>
)

const ColorTemperatureHeaderIcon = (): React.JSX.Element => (
  <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" aria-hidden="true">
    <line x1="6" y1="1" x2="6" y2="7" />
    <circle cx="6" cy="9" r="2" />
    <line x1="8.5" y1="2" x2="10" y2="2" />
    <line x1="8.5" y1="4" x2="9.5" y2="4" />
    <line x1="8.5" y1="6" x2="10" y2="6" />
  </svg>
)

const ColorInvertHeaderIcon = (): React.JSX.Element => (
  <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true">
    <path d="M6 1.5 A4.5 4.5 0 0 1 6 10.5 Z" fill="currentColor" />
    <path d="M6 1.5 A4.5 4.5 0 0 0 6 10.5 Z" fill="none" stroke="currentColor" strokeWidth="1.2" />
    <circle cx="6" cy="6" r="4.5" fill="none" stroke="currentColor" strokeWidth="1.2" />
  </svg>
)

const SelectiveColorHeaderIcon = (): React.JSX.Element => (
  <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.1" aria-hidden="true">
    <circle cx="4.5" cy="4.5" r="2.8" stroke="#ff6060" />
    <circle cx="7.5" cy="4.5" r="2.8" stroke="#60d060" />
    <circle cx="6" cy="7" r="2.8" stroke="#6060ff" />
  </svg>
)

const CurvesHeaderIcon = (): React.JSX.Element => (
  <svg viewBox="0 0 12 12" fill="none" width="12" height="12" stroke="currentColor" strokeWidth="1.1" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M1.5 9.5 C3.2 9.5 3.9 5.8 5.7 5.8 C7 5.8 7.2 7.4 8.7 7.4 C10 7.4 10.5 3.2 10.5 2.2" />
    <circle cx="1.5" cy="9.5" r="0.8" fill="currentColor" stroke="none" />
    <circle cx="10.5" cy="2.2" r="0.8" fill="currentColor" stroke="none" />
  </svg>
)

const ColorGradingHeaderIcon = (): React.JSX.Element => (
  <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.2" aria-hidden="true">
    <circle cx="3" cy="6" r="1.8" />
    <circle cx="9" cy="6" r="1.8" />
    <circle cx="6" cy="3" r="1.8" />
    <circle cx="6" cy="9" r="1.8" />
  </svg>
)

const ReduceColorsHeaderIcon = (): React.JSX.Element => (
  <svg width="12" height="12" viewBox="0 0 12 12" fill="currentColor" aria-hidden="true">
    <rect x="1.5" y="1.5" width="4" height="4" rx="0.5" />
    <rect x="6.5" y="1.5" width="4" height="4" rx="0.5" />
    <rect x="1.5" y="6.5" width="4" height="4" rx="0.5" />
    <rect x="6.5" y="6.5" width="4" height="4" rx="0.5" />
  </svg>
)

const ColorDitheringHeaderIcon = (): React.JSX.Element => (
  <svg width="12" height="12" viewBox="0 0 12 12" fill="currentColor" aria-hidden="true">
    <rect x="0" y="0" width="3" height="3" />
    <rect x="6" y="0" width="3" height="3" />
    <rect x="3" y="3" width="3" height="3" />
    <rect x="9" y="3" width="3" height="3" />
    <rect x="0" y="6" width="3" height="3" />
    <rect x="6" y="6" width="3" height="3" />
    <rect x="3" y="9" width="3" height="3" />
    <rect x="9" y="9" width="3" height="3" />
  </svg>
)

const BloomHeaderIcon = (): React.JSX.Element => (
  <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.1" aria-hidden="true">
    <circle cx="6" cy="6" r="1.5" fill="currentColor" stroke="none" />
    <circle cx="6" cy="6" r="3" opacity="0.6" />
    <circle cx="6" cy="6" r="4.5" opacity="0.3" />
  </svg>
)

const ChromaticAberrationHeaderIcon = (): React.JSX.Element => (
  <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.2" aria-hidden="true">
    <circle cx="4.5" cy="6" r="2.5" stroke="#ff5555" strokeWidth="1" opacity="0.85" />
    <circle cx="7.5" cy="6" r="2.5" stroke="#55aaff" strokeWidth="1" opacity="0.85" />
  </svg>
)

const HalationHeaderIcon = (): React.JSX.Element => (
  <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true">
    <circle cx="6" cy="6" r="1.8" fill="#e05a20" />
    <circle cx="6" cy="6" r="3.4" stroke="#e05a20" strokeWidth="0.9" opacity="0.55" />
    <circle cx="6" cy="6" r="5" stroke="#e05a20" strokeWidth="0.7" opacity="0.25" />
  </svg>
)

const DropShadowHeaderIcon = (): React.JSX.Element => (
  <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.2" aria-hidden="true">
    <rect x="1.5" y="1.5" width="7" height="7" rx="0.5" />
    <rect x="3.5" y="3.5" width="7" height="7" rx="0.5" fill="currentColor" fillOpacity="0.25" strokeOpacity="0.4" />
  </svg>
)

const GlowHeaderIcon = (): React.JSX.Element => (
  <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.1" aria-hidden="true">
    <circle cx="6" cy="6" r="1.5" fill="currentColor" stroke="none" opacity="0.9" />
    <circle cx="6" cy="6" r="3" opacity="0.55" />
    <circle cx="6" cy="6" r="4.8" opacity="0.25" />
  </svg>
)

const OutlineHeaderIcon = (): React.JSX.Element => (
  <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.2" aria-hidden="true">
    <rect x="3" y="3" width="6" height="6" />
    <rect x="1" y="1" width="10" height="10" />
  </svg>
)

const HalftoneHeaderIcon = (): React.JSX.Element => (
  <svg width="12" height="12" viewBox="0 0 12 12" fill="currentColor" aria-hidden="true">
    <circle cx="2.5" cy="2.5" r="1.5" />
    <circle cx="6" cy="2" r="1" />
    <circle cx="9.5" cy="2.5" r="1.5" />
    <circle cx="2" cy="6" r="1" />
    <circle cx="6" cy="6" r="2" />
    <circle cx="10" cy="6" r="1" />
    <circle cx="2.5" cy="9.5" r="1.5" />
    <circle cx="6" cy="10" r="1" />
    <circle cx="9.5" cy="9.5" r="1.5" />
  </svg>
)

const ColorKeyHeaderIcon = (): React.JSX.Element => (
  <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.2" aria-hidden="true">
    <rect x="1.5" y="2.5" width="9" height="7" rx="0.5" />
    <circle cx="6" cy="6" r="2" />
    <line x1="1.5" y1="6" x2="4" y2="6" strokeOpacity="0.5" />
    <line x1="8" y1="6" x2="10.5" y2="6" strokeOpacity="0.5" />
  </svg>
)

function AdjPanelIcon({ type }: { type: AdjustmentLayerState['adjustmentType'] }): React.JSX.Element {
  if (type === 'brightness-contrast') return <BrightnessContrastHeaderIcon />
  if (type === 'hue-saturation') return <HueSaturationHeaderIcon />
  if (type === 'color-balance') return <ColorBalanceHeaderIcon />
  if (type === 'black-and-white') return <BlackAndWhiteHeaderIcon />
  if (type === 'color-temperature') return <ColorTemperatureHeaderIcon />
  if (type === 'color-invert') return <ColorInvertHeaderIcon />
  if (type === 'selective-color') return <SelectiveColorHeaderIcon />
  if (type === 'curves') return <CurvesHeaderIcon />
  if (type === 'color-grading') return <ColorGradingHeaderIcon />
  if (type === 'reduce-colors') return <ReduceColorsHeaderIcon />
  if (type === 'color-dithering') return <ColorDitheringHeaderIcon />
  if (type === 'bloom') return <BloomHeaderIcon />
  if (type === 'chromatic-aberration') return <ChromaticAberrationHeaderIcon />
  if (type === 'halation') return <HalationHeaderIcon />
  if (type === 'color-key') return <ColorKeyHeaderIcon />
  if (type === 'drop-shadow') return <DropShadowHeaderIcon />
  if (type === 'glow') return <GlowHeaderIcon />
  if (type === 'outline') return <OutlineHeaderIcon />
  if (type === 'halftone') return <HalftoneHeaderIcon />
  return <ColorVibranceHeaderIcon />
}

// ─── Component ────────────────────────────────────────────────────────────────

export function AdjustmentPanel({ onClose, canvasHandleRef }: ToolWindowProps): React.JSX.Element | null {
  const { state } = useAppContext()
  const { openAdjustmentLayerId, layers } = state

  const layer = openAdjustmentLayerId !== null
    ? layers.find(l => l.id === openAdjustmentLayerId)
    : undefined

  useEffect(() => {
    if (!openAdjustmentLayerId) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [openAdjustmentLayerId, onClose])

  if (!layer || !('type' in layer) || layer.type !== 'adjustment') return null

  const adjLayer = layer as AdjustmentLayerState
  const parentLayer = layers.find(l => l.id === adjLayer.parentId)
  const parentLayerName = parentLayer?.name ?? 'Layer'

  const panelWidth = adjLayer.adjustmentType === 'curves' ? 306
    : adjLayer.adjustmentType === 'color-grading' ? 504
    : 236

  return (
    <ToolWindow
      title={toolTitle(adjLayer)}
      icon={<AdjPanelIcon type={adjLayer.adjustmentType} />}
      onClose={onClose}
      width={panelWidth}
    >
      <div className={styles.body}>
        {adjLayer.adjustmentType === 'brightness-contrast' && (
          <BrightnessContrastPanel layer={adjLayer as BrightnessContrastAdjustmentLayer} parentLayerName={parentLayerName} />
        )}
        {adjLayer.adjustmentType === 'hue-saturation' && (
          <HueSaturationPanel layer={adjLayer as HueSaturationAdjustmentLayer} parentLayerName={parentLayerName} />
        )}
        {adjLayer.adjustmentType === 'color-vibrance' && (
          <ColorVibrancePanel layer={adjLayer as ColorVibranceAdjustmentLayer} parentLayerName={parentLayerName} />
        )}
        {adjLayer.adjustmentType === 'color-balance' && (
          <ColorBalancePanel layer={adjLayer as ColorBalanceAdjustmentLayer} parentLayerName={parentLayerName} />
        )}
        {adjLayer.adjustmentType === 'black-and-white' && (
          <BlackAndWhitePanel layer={adjLayer as BlackAndWhiteAdjustmentLayer} parentLayerName={parentLayerName} />
        )}
        {adjLayer.adjustmentType === 'color-temperature' && (
          <ColorTemperaturePanel layer={adjLayer as ColorTemperatureAdjustmentLayer} parentLayerName={parentLayerName} />
        )}
        {adjLayer.adjustmentType === 'color-invert' && (
          <InvertPanel layer={adjLayer as ColorInvertAdjustmentLayer} parentLayerName={parentLayerName} />
        )}
        {adjLayer.adjustmentType === 'selective-color' && (
          <SelectiveColorPanel layer={adjLayer as SelectiveColorAdjustmentLayer} parentLayerName={parentLayerName} />
        )}
        {adjLayer.adjustmentType === 'curves' && (
          <CurvesPanel
            layer={adjLayer as CurvesAdjustmentLayer}
            parentLayerName={parentLayerName}
            canvasHandleRef={canvasHandleRef}
          />
        )}
        {adjLayer.adjustmentType === 'color-grading' && (
          <ColorGradingPanel
            layer={adjLayer as ColorGradingAdjustmentLayer}
            parentLayerName={parentLayerName}
          />
        )}
        {adjLayer.adjustmentType === 'reduce-colors' && (
          <ReduceColorsPanel
            layer={adjLayer as ReduceColorsAdjustmentLayer}
            parentLayerName={parentLayerName}
            canvasHandleRef={canvasHandleRef}
          />
        )}
        {adjLayer.adjustmentType === 'color-dithering' && (
          <ColorDitheringPanel
            layer={adjLayer as ColorDitheringAdjustmentLayer}
            parentLayerName={parentLayerName}
          />
        )}
        {adjLayer.adjustmentType === 'bloom' && (
          <BloomOptions layer={adjLayer as BloomAdjustmentLayer} parentLayerName={parentLayerName} />
        )}
        {adjLayer.adjustmentType === 'chromatic-aberration' && (
          <ChromaticAberrationOptions layer={adjLayer as ChromaticAberrationAdjustmentLayer} parentLayerName={parentLayerName} />
        )}
        {adjLayer.adjustmentType === 'halation' && (
          <HalationOptions layer={adjLayer as HalationAdjustmentLayer} parentLayerName={parentLayerName} />
        )}
        {adjLayer.adjustmentType === 'color-key' && (
          <ColorKeyPanel
            layer={adjLayer as ColorKeyAdjustmentLayer}
            parentLayerName={parentLayerName}
          />
        )}
        {adjLayer.adjustmentType === 'drop-shadow' && (
          <DropShadowOptions
            layer={adjLayer as DropShadowAdjustmentLayer}
            parentLayerName={parentLayerName}
          />
        )}
        {adjLayer.adjustmentType === 'glow' && (
          <GlowOptions
            layer={adjLayer as GlowAdjustmentLayer}
            parentLayerName={parentLayerName}
          />
        )}
        {adjLayer.adjustmentType === 'outline' && (
          <OutlineOptions
            layer={adjLayer as OutlineAdjustmentLayer}
            parentLayerName={parentLayerName}
          />
        )}
        {adjLayer.adjustmentType === 'halftone' && (
          <HalftoneOptions
            layer={adjLayer as HalftoneAdjustmentLayer}
            parentLayerName={parentLayerName}
          />
        )}
        {adjLayer.adjustmentType === 'gaussian-blur' && (
          <GaussianBlurPanel layer={adjLayer as GaussianBlurAdjustmentLayer} parentLayerName={parentLayerName} />
        )}
        {adjLayer.adjustmentType === 'box-blur' && (
          <BoxBlurPanel layer={adjLayer as BoxBlurAdjustmentLayer} parentLayerName={parentLayerName} />
        )}
        {adjLayer.adjustmentType === 'radial-blur' && (
          <RadialBlurPanel layer={adjLayer as RadialBlurAdjustmentLayer} parentLayerName={parentLayerName} />
        )}
        {adjLayer.adjustmentType === 'motion-blur' && (
          <MotionBlurPanel layer={adjLayer as MotionBlurAdjustmentLayer} parentLayerName={parentLayerName} />
        )}
        {adjLayer.adjustmentType === 'remove-motion-blur' && (
          <RemoveMotionBlurPanel layer={adjLayer as RemoveMotionBlurAdjustmentLayer} parentLayerName={parentLayerName} />
        )}
        {adjLayer.adjustmentType === 'lens-blur' && (
          <LensBlurPanel layer={adjLayer as LensBlurAdjustmentLayer} parentLayerName={parentLayerName} />
        )}
        {adjLayer.adjustmentType === 'sharpen' && (
          <SharpenPanel layer={adjLayer as SharpenAdjustmentLayer} parentLayerName={parentLayerName} />
        )}
        {adjLayer.adjustmentType === 'sharpen-more' && (
          <SharpenPanel layer={adjLayer as SharpenMoreAdjustmentLayer} parentLayerName={parentLayerName} />
        )}
        {adjLayer.adjustmentType === 'unsharp-mask' && (
          <UnsharpMaskPanel layer={adjLayer as UnsharpMaskAdjustmentLayer} parentLayerName={parentLayerName} />
        )}
        {adjLayer.adjustmentType === 'smart-sharpen' && (
          <SmartSharpenPanel layer={adjLayer as SmartSharpenAdjustmentLayer} parentLayerName={parentLayerName} />
        )}
        {adjLayer.adjustmentType === 'add-noise' && (
          <AddNoisePanel layer={adjLayer as AddNoiseAdjustmentLayer} parentLayerName={parentLayerName} />
        )}
        {adjLayer.adjustmentType === 'film-grain' && (
          <FilmGrainPanel layer={adjLayer as FilmGrainAdjustmentLayer} parentLayerName={parentLayerName} />
        )}
        {adjLayer.adjustmentType === 'median-filter' && (
          <MedianFilterPanel layer={adjLayer as MedianFilterAdjustmentLayer} parentLayerName={parentLayerName} />
        )}
        {adjLayer.adjustmentType === 'bilateral-filter' && (
          <BilateralFilterPanel layer={adjLayer as BilateralFilterAdjustmentLayer} parentLayerName={parentLayerName} />
        )}
        {adjLayer.adjustmentType === 'reduce-noise' && (
          <ReduceNoisePanel layer={adjLayer as ReduceNoiseAdjustmentLayer} parentLayerName={parentLayerName} />
        )}
        {adjLayer.adjustmentType === 'clouds' && (
          <CloudsPanel layer={adjLayer as CloudsAdjustmentLayer} parentLayerName={parentLayerName} />
        )}
        {adjLayer.adjustmentType === 'pixelate' && (
          <PixelatePanel layer={adjLayer as PixelateAdjustmentLayer} parentLayerName={parentLayerName} />
        )}
      </div>
    </ToolWindow>
  )
}
