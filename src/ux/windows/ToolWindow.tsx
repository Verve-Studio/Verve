import React, { useEffect } from "react";
import { useAppContext } from "@/core/store/AppContext";
import { effectRegistry } from "@/core/effects";
import type { EffectLayerState } from "@/types";
import type { CanvasHandle } from "@/ux/main/Canvas/Canvas";
import { ToolWindow } from "@/ux";
import styles from "./ToolWindow.module.scss";

// ─── Props ────────────────────────────────────────────────────────────────────

interface ToolWindowProps {
  onClose: () => void;
  canvasHandleRef?: { readonly current: CanvasHandle | null };
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function toolTitle(layer: EffectLayerState): string {
  const effect = effectRegistry.get(layer.effectType);
  return effect ? effect.label.replace(/…$/, "") : layer.effectType;
}

const LockClosedIconSvg = (): React.JSX.Element => (
  <svg
    viewBox="0 0 12 14"
    fill="currentColor"
    width="10"
    height="11"
    aria-hidden="true"
  >
    <rect x="2" y="6" width="8" height="7" rx="1" />
    <path
      d="M4 6V4.5a2 2 0 114 0V6"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.3"
    />
  </svg>
);

const BrightnessContrastHeaderIcon = (): React.JSX.Element => (
  <svg
    width="12"
    height="12"
    viewBox="0 0 12 12"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.2"
    strokeLinecap="round"
    aria-hidden="true"
  >
    <circle cx="6" cy="6" r="2" />
    <path d="M6 1v1M6 10v1M1 6h1M10 6h1M2.5 2.5l.7.7M8.8 8.8l.7.7M9.5 2.5l-.7.7M3.2 8.8l-.7.7" />
  </svg>
);

const HueSaturationHeaderIcon = (): React.JSX.Element => (
  <svg
    width="12"
    height="12"
    viewBox="0 0 12 12"
    fill="currentColor"
    aria-hidden="true"
  >
    <circle cx="6" cy="6" r="4.5" />
  </svg>
);

const ColorVibranceHeaderIcon = (): React.JSX.Element => (
  <svg
    width="12"
    height="12"
    viewBox="0 0 12 12"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.2"
    aria-hidden="true"
  >
    <circle cx="6" cy="6" r="1.8" />
    <circle cx="6" cy="6" r="4" />
  </svg>
);

const ColorBalanceHeaderIcon = (): React.JSX.Element => (
  <svg
    width="12"
    height="12"
    viewBox="0 0 12 12"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.1"
    strokeLinecap="round"
    aria-hidden="true"
  >
    <line x1="6" y1="1.5" x2="6" y2="10.5" />
    <line x1="2" y1="4" x2="10" y2="4" />
    <polygon points="2,4 1.1,6.2 2.9,6.2" fill="currentColor" stroke="none" />
    <polygon points="10,4 9.1,6.2 10.9,6.2" fill="currentColor" stroke="none" />
    <line x1="4.5" y1="10.5" x2="7.5" y2="10.5" />
  </svg>
);

const BlackAndWhiteHeaderIcon = (): React.JSX.Element => (
  <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true">
    <path d="M6 1.5 A4.5 4.5 0 0 0 6 10.5 Z" fill="currentColor" />
    <circle
      cx="6"
      cy="6"
      r="4.5"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.2"
    />
  </svg>
);

const ColorTemperatureHeaderIcon = (): React.JSX.Element => (
  <svg
    width="12"
    height="12"
    viewBox="0 0 12 12"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.2"
    strokeLinecap="round"
    aria-hidden="true"
  >
    <line x1="6" y1="1" x2="6" y2="7" />
    <circle cx="6" cy="9" r="2" />
    <line x1="8.5" y1="2" x2="10" y2="2" />
    <line x1="8.5" y1="4" x2="9.5" y2="4" />
    <line x1="8.5" y1="6" x2="10" y2="6" />
  </svg>
);

const ColorInvertHeaderIcon = (): React.JSX.Element => (
  <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true">
    <path d="M6 1.5 A4.5 4.5 0 0 1 6 10.5 Z" fill="currentColor" />
    <path
      d="M6 1.5 A4.5 4.5 0 0 0 6 10.5 Z"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.2"
    />
    <circle
      cx="6"
      cy="6"
      r="4.5"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.2"
    />
  </svg>
);

const SelectiveColorHeaderIcon = (): React.JSX.Element => (
  <svg
    width="12"
    height="12"
    viewBox="0 0 12 12"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.1"
    aria-hidden="true"
  >
    <circle cx="4.5" cy="4.5" r="2.8" stroke="#ff6060" />
    <circle cx="7.5" cy="4.5" r="2.8" stroke="#60d060" />
    <circle cx="6" cy="7" r="2.8" stroke="#6060ff" />
  </svg>
);

const AutoMatchHeaderIcon = (): React.JSX.Element => (
  <svg
    width="12"
    height="12"
    viewBox="0 0 12 12"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.1"
    strokeLinecap="round"
    aria-hidden="true"
  >
    <rect x="1.5" y="1.5" width="9" height="9" rx="1" />
    <path d="M3 8 L5 5 L7 7 L9 3" />
    <circle cx="5" cy="5" r="0.9" fill="currentColor" stroke="none" />
  </svg>
);

const ChannelMixerHeaderIcon = (): React.JSX.Element => (
  <svg
    width="12"
    height="12"
    viewBox="0 0 12 12"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.1"
    strokeLinecap="round"
    aria-hidden="true"
  >
    <line x1="3" y1="2" x2="3" y2="10" stroke="#ff6060" />
    <line x1="6" y1="2" x2="6" y2="10" stroke="#60d060" />
    <line x1="9" y1="2" x2="9" y2="10" stroke="#6060ff" />
    <circle cx="3" cy="4" r="1" fill="#ff6060" stroke="none" />
    <circle cx="6" cy="7" r="1" fill="#60d060" stroke="none" />
    <circle cx="9" cy="5" r="1" fill="#6060ff" stroke="none" />
  </svg>
);

const CurvesHeaderIcon = (): React.JSX.Element => (
  <svg
    viewBox="0 0 12 12"
    fill="none"
    width="12"
    height="12"
    stroke="currentColor"
    strokeWidth="1.1"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
  >
    <path d="M1.5 9.5 C3.2 9.5 3.9 5.8 5.7 5.8 C7 5.8 7.2 7.4 8.7 7.4 C10 7.4 10.5 3.2 10.5 2.2" />
    <circle cx="1.5" cy="9.5" r="0.8" fill="currentColor" stroke="none" />
    <circle cx="10.5" cy="2.2" r="0.8" fill="currentColor" stroke="none" />
  </svg>
);

const ColorGradingHeaderIcon = (): React.JSX.Element => (
  <svg
    width="12"
    height="12"
    viewBox="0 0 12 12"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.2"
    aria-hidden="true"
  >
    <circle cx="3" cy="6" r="1.8" />
    <circle cx="9" cy="6" r="1.8" />
    <circle cx="6" cy="3" r="1.8" />
    <circle cx="6" cy="9" r="1.8" />
  </svg>
);

const ReduceColorsHeaderIcon = (): React.JSX.Element => (
  <svg
    width="12"
    height="12"
    viewBox="0 0 12 12"
    fill="currentColor"
    aria-hidden="true"
  >
    <rect x="1.5" y="1.5" width="4" height="4" rx="0.5" />
    <rect x="6.5" y="1.5" width="4" height="4" rx="0.5" />
    <rect x="1.5" y="6.5" width="4" height="4" rx="0.5" />
    <rect x="6.5" y="6.5" width="4" height="4" rx="0.5" />
  </svg>
);

const ColorDitheringHeaderIcon = (): React.JSX.Element => (
  <svg
    width="12"
    height="12"
    viewBox="0 0 12 12"
    fill="currentColor"
    aria-hidden="true"
  >
    <rect x="0" y="0" width="3" height="3" />
    <rect x="6" y="0" width="3" height="3" />
    <rect x="3" y="3" width="3" height="3" />
    <rect x="9" y="3" width="3" height="3" />
    <rect x="0" y="6" width="3" height="3" />
    <rect x="6" y="6" width="3" height="3" />
    <rect x="3" y="9" width="3" height="3" />
    <rect x="9" y="9" width="3" height="3" />
  </svg>
);

const BloomHeaderIcon = (): React.JSX.Element => (
  <svg
    width="12"
    height="12"
    viewBox="0 0 12 12"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.1"
    aria-hidden="true"
  >
    <circle cx="6" cy="6" r="1.5" fill="currentColor" stroke="none" />
    <circle cx="6" cy="6" r="3" opacity="0.6" />
    <circle cx="6" cy="6" r="4.5" opacity="0.3" />
  </svg>
);

const LensDistortionHeaderIcon = (): React.JSX.Element => (
  <svg
    width="12"
    height="12"
    viewBox="0 0 12 12"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.1"
    strokeLinecap="round"
    aria-hidden="true"
  >
    <rect x="1.5" y="1.5" width="9" height="9" rx="1" />
    <path d="M2.5 4 Q6 2.6 9.5 4" />
    <path d="M2.5 8 Q6 9.4 9.5 8" />
    <path d="M4 2.5 Q2.6 6 4 9.5" />
    <path d="M8 2.5 Q9.4 6 8 9.5" />
  </svg>
);

const VignetteHeaderIcon = (): React.JSX.Element => (
  <svg
    width="12"
    height="12"
    viewBox="0 0 12 12"
    fill="none"
    aria-hidden="true"
  >
    <defs>
      <radialGradient id="vignette-grad" cx="0.5" cy="0.5" r="0.55">
        <stop offset="0.45" stopColor="#d4d4d4" stopOpacity="0" />
        <stop offset="1" stopColor="#000000" stopOpacity="0.95" />
      </radialGradient>
    </defs>
    <rect
      x="1"
      y="1"
      width="10"
      height="10"
      rx="1.5"
      stroke="currentColor"
      strokeWidth="1"
      fill="#d4d4d4"
    />
    <rect
      x="1"
      y="1"
      width="10"
      height="10"
      rx="1.5"
      fill="url(#vignette-grad)"
    />
  </svg>
);

const ChromaticAberrationHeaderIcon = (): React.JSX.Element => (
  <svg
    width="12"
    height="12"
    viewBox="0 0 12 12"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.2"
    aria-hidden="true"
  >
    <circle
      cx="4.5"
      cy="6"
      r="2.5"
      stroke="#ff5555"
      strokeWidth="1"
      opacity="0.85"
    />
    <circle
      cx="7.5"
      cy="6"
      r="2.5"
      stroke="#55aaff"
      strokeWidth="1"
      opacity="0.85"
    />
  </svg>
);

const HalationHeaderIcon = (): React.JSX.Element => (
  <svg
    width="12"
    height="12"
    viewBox="0 0 12 12"
    fill="none"
    aria-hidden="true"
  >
    <circle cx="6" cy="6" r="1.8" fill="#e05a20" />
    <circle
      cx="6"
      cy="6"
      r="3.4"
      stroke="#e05a20"
      strokeWidth="0.9"
      opacity="0.55"
    />
    <circle
      cx="6"
      cy="6"
      r="5"
      stroke="#e05a20"
      strokeWidth="0.7"
      opacity="0.25"
    />
  </svg>
);

const DropShadowHeaderIcon = (): React.JSX.Element => (
  <svg
    width="12"
    height="12"
    viewBox="0 0 12 12"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.2"
    aria-hidden="true"
  >
    <rect x="1.5" y="1.5" width="7" height="7" rx="0.5" />
    <rect
      x="3.5"
      y="3.5"
      width="7"
      height="7"
      rx="0.5"
      fill="currentColor"
      fillOpacity="0.25"
      strokeOpacity="0.4"
    />
  </svg>
);

const GlowHeaderIcon = (): React.JSX.Element => (
  <svg
    width="12"
    height="12"
    viewBox="0 0 12 12"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.1"
    aria-hidden="true"
  >
    <circle
      cx="6"
      cy="6"
      r="1.5"
      fill="currentColor"
      stroke="none"
      opacity="0.9"
    />
    <circle cx="6" cy="6" r="3" opacity="0.55" />
    <circle cx="6" cy="6" r="4.8" opacity="0.25" />
  </svg>
);

const OutlineHeaderIcon = (): React.JSX.Element => (
  <svg
    width="12"
    height="12"
    viewBox="0 0 12 12"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.2"
    aria-hidden="true"
  >
    <rect x="3" y="3" width="6" height="6" />
    <rect x="1" y="1" width="10" height="10" />
  </svg>
);

const HalftoneHeaderIcon = (): React.JSX.Element => (
  <svg
    width="12"
    height="12"
    viewBox="0 0 12 12"
    fill="currentColor"
    aria-hidden="true"
  >
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
);

const ColorKeyHeaderIcon = (): React.JSX.Element => (
  <svg
    width="12"
    height="12"
    viewBox="0 0 12 12"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.2"
    aria-hidden="true"
  >
    <rect x="1.5" y="2.5" width="9" height="7" rx="0.5" />
    <circle cx="6" cy="6" r="2" />
    <line x1="1.5" y1="6" x2="4" y2="6" strokeOpacity="0.5" />
    <line x1="8" y1="6" x2="10.5" y2="6" strokeOpacity="0.5" />
  </svg>
);

function AdjPanelIcon({
  type,
}: {
  type: EffectLayerState["effectType"];
}): React.JSX.Element {
  if (type === "brightness-contrast") return <BrightnessContrastHeaderIcon />;
  if (type === "hue-saturation") return <HueSaturationHeaderIcon />;
  if (type === "color-balance") return <ColorBalanceHeaderIcon />;
  if (type === "black-and-white") return <BlackAndWhiteHeaderIcon />;
  if (type === "color-temperature") return <ColorTemperatureHeaderIcon />;
  if (type === "color-invert") return <ColorInvertHeaderIcon />;
  if (type === "selective-color") return <SelectiveColorHeaderIcon />;
  if (type === "channel-mixer") return <ChannelMixerHeaderIcon />;
  if (type === "auto-match") return <AutoMatchHeaderIcon />;
  if (type === "curves") return <CurvesHeaderIcon />;
  if (type === "color-grading") return <ColorGradingHeaderIcon />;
  if (type === "reduce-colors") return <ReduceColorsHeaderIcon />;
  if (type === "color-dithering") return <ColorDitheringHeaderIcon />;
  if (type === "bloom") return <BloomHeaderIcon />;
  if (type === "chromatic-aberration") return <ChromaticAberrationHeaderIcon />;
  if (type === "vignette") return <VignetteHeaderIcon />;
  if (type === "lens-distortion") return <LensDistortionHeaderIcon />;
  if (
    type === "pinch" ||
    type === "polar-coordinates" ||
    type === "ripple" ||
    type === "shear" ||
    type === "twirl" ||
    type === "displace"
  )
    return <LensDistortionHeaderIcon />;
  if (type === "halation") return <HalationHeaderIcon />;
  if (type === "color-key") return <ColorKeyHeaderIcon />;
  if (type === "drop-shadow") return <DropShadowHeaderIcon />;
  if (type === "glow") return <GlowHeaderIcon />;
  if (type === "outline") return <OutlineHeaderIcon />;
  if (type === "halftone") return <HalftoneHeaderIcon />;
  return <ColorVibranceHeaderIcon />;
}

// ─── Component ────────────────────────────────────────────────────────────────

export function AdjustmentPanel({
  onClose,
  canvasHandleRef,
}: ToolWindowProps): React.JSX.Element | null {
  const { state } = useAppContext();
  const { openAdjustmentLayerId, layers } = state;

  const layer =
    openAdjustmentLayerId !== null
      ? layers.find((l) => l.id === openAdjustmentLayerId)
      : undefined;

  useEffect(() => {
    if (!openAdjustmentLayerId) return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [openAdjustmentLayerId, onClose]);

  if (!layer || !("type" in layer) || layer.type !== "adjustment") return null;

  const adjLayer = layer as EffectLayerState;
  const parentLayer = layers.find((l) => l.id === adjLayer.parentId);
  const parentLayerName = parentLayer?.name ?? "Layer";
  const parentLocked =
    (parentLayer as { locked?: boolean } | undefined)?.locked === true;

  var panelWidth = 0;

  switch(adjLayer.effectType) {
    case "curves":
      panelWidth = 306;
      break;
    case "color-grading":
      panelWidth = 504;
      break;
    case "lens-distortion":
      panelWidth = 360;
      break;
    default:
      panelWidth = 236;
  }

  return (
    <ToolWindow
      title={toolTitle(adjLayer)}
      icon={<AdjPanelIcon type={adjLayer.effectType} />}
      onClose={onClose}
      width={panelWidth}
    >
      {parentLocked && (
        <div className={styles.lockedBanner}>
          <LockClosedIconSvg />
          Layer is locked — editing disabled
        </div>
      )}
      <div
        className={`${styles.body}${parentLocked ? ` ${styles.bodyLocked}` : ""}`}
      >
        {(() => {
          const effect = effectRegistry.get(adjLayer.effectType);
          if (!effect) return null;
          const Panel = effect.Panel as React.ComponentType<{
            layer: typeof adjLayer;
            parentLayerName: string;
            canvasHandleRef?: { readonly current: CanvasHandle | null };
          }>;
          return (
            <Panel
              layer={adjLayer}
              parentLayerName={parentLayerName}
              canvasHandleRef={canvasHandleRef}
            />
          );
        })()}
      </div>
    </ToolWindow>
  );
}
