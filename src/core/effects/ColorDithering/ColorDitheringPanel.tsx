import React from "react";
import { useAppContext } from "@/core/store/AppContext";
import type { ColorDitheringEffectLayer } from "@/types";
import { ParentConnectorIcon } from "@/ux/windows/ToolWindowIcons";
import styles from "./ColorDitheringPanel.module.scss";

interface ColorDitheringPanelProps {
  layer: ColorDitheringEffectLayer;
  parentLayerName: string;
}

const STYLE_OPTIONS = [
  { value: "bayer4", label: "Bayer 4×4" },
  { value: "bayer8", label: "Bayer 8×8" },
] as const;

export function ColorDitheringPanel({
  layer,
  parentLayerName,
}: ColorDitheringPanelProps): React.JSX.Element {
  const {
    state: { swatches },
    dispatch,
  } = useAppContext();
  const { style, opacity } = layer.params;

  const paletteEmpty = swatches.length === 0;

  const setStyle = (newStyle: typeof style): void => {
    dispatch({
      type: "UPDATE_ADJUSTMENT_LAYER",
      payload: { ...layer, params: { ...layer.params, style: newStyle } },
    });
  };

  const setOpacity = (val: number): void => {
    dispatch({
      type: "UPDATE_ADJUSTMENT_LAYER",
      payload: {
        ...layer,
        params: {
          ...layer.params,
          opacity: Math.min(100, Math.max(0, Math.round(val))),
        },
      },
    });
  };

  return (
    <div className={styles.content}>
      <div className={paletteEmpty ? styles.controlsDisabled : undefined}>
        <div className={styles.row}>
          <span className={styles.label}>Style</span>
          <div className={styles.segmented}>
            {STYLE_OPTIONS.map((opt) => (
              <button
                key={opt.value}
                className={
                  style === opt.value ? styles.segBtnActive : styles.segBtn
                }
                onClick={() => setStyle(opt.value)}
              >
                {opt.label}
              </button>
            ))}
          </div>
        </div>

        <div className={styles.row}>
          <span className={styles.label}>Opacity</span>
          <div className={styles.trackWrap}>
            <input
              type="range"
              className={styles.track}
              min={0}
              max={100}
              step={1}
              value={opacity ?? 100}
              style={
                {
                  "--pct": String((opacity ?? 100) / 100),
                } as React.CSSProperties
              }
              onChange={(e) => setOpacity(Number(e.target.value))}
            />
          </div>
          <input
            type="number"
            className={styles.numInput}
            min={0}
            max={100}
            step={1}
            value={opacity ?? 100}
            onChange={(e) => {
              const v = e.target.valueAsNumber;
              if (!isNaN(v)) setOpacity(v);
            }}
          />
        </div>
      </div>

      {paletteEmpty ? (
        <p className={styles.warning}>
          Palette is empty — add swatches to enable dithering.
        </p>
      ) : (
        <p className={styles.note}>
          This effect dithers to the document palette. Update the palette in the
          Swatches panel to change the target colors.
        </p>
      )}

      <div className={styles.footer}>
        <span className={styles.footerInfo}>
          <ParentConnectorIcon />
          Adjusting <strong>{parentLayerName}</strong>
        </span>
      </div>
    </div>
  );
}
