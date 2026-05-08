import React, { useEffect } from "react";
import { useAppContext } from "@/core/store/AppContext";
import { effectRegistry } from "@/core/effects";
import { EffectFallbackIcon } from "@/core/effects/_shared/icons";
import type { EffectLayerState } from "@/core/effects/effectTypes";
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
      icon={effectRegistry.get(adjLayer.effectType)?.icon ?? EffectFallbackIcon}
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
