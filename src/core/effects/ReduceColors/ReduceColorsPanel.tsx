import React, { useEffect, useRef, useState } from "react";
import {
  shallowEqual2,
  useAppDispatch,
  useAppSelector,
} from "@/core/store/AppContext";
import type { RGBAColor } from "@/types";
import type { ReduceColorsEffectLayer } from "@/core/effects/ReduceColors/ReduceColorsEffect";
import type { CanvasHandle } from "@/ux/main/Canvas/Canvas";
import { linearToSrgbChannel } from "@/utils/pixelFormatConvert";
import { ParentConnectorIcon } from "@/ux/windows/ToolWindowIcons";
import styles from "./ReduceColorsPanel.module.scss";
import { quantizeOffThread } from "@/wasm/pixelopsWorkerClient";

const QUANTIZE_SAMPLE_PIXELS = 1_000_000;

/** Even subsample of `native` (RGBA) as sRGB bytes for the quantizer. */
function samplePixelsForQuantize(
  native: Uint8Array | Float32Array,
): Uint8Array {
  const count = native.length / 4;
  const stride = Math.max(1, Math.ceil(count / QUANTIZE_SAMPLE_PIXELS));
  const out = new Uint8Array(Math.ceil(count / stride) * 4);
  const isFloat = native instanceof Float32Array;
  let o = 0;
  for (let p = 0; p < count; p += stride, o += 4) {
    const i = p * 4;
    if (isFloat) {
      for (let c = 0; c < 3; c++) {
        const e = linearToSrgbChannel(native[i + c]);
        out[o + c] = e <= 0 ? 0 : e >= 1 ? 255 : Math.round(e * 255);
      }
      const a = native[i + 3];
      out[o + 3] = a <= 0 ? 0 : a >= 1 ? 255 : Math.round(a * 255);
    } else {
      out[o] = native[i];
      out[o + 1] = native[i + 1];
      out[o + 2] = native[i + 2];
      out[o + 3] = native[i + 3];
    }
  }
  return out;
}

// ─── Props ────────────────────────────────────────────────────────────────────

interface ReduceColorsPanelProps {
  layer: ReduceColorsEffectLayer;
  parentLayerName: string;
  canvasHandleRef?: { readonly current: CanvasHandle | null };
}

// ─── Component ────────────────────────────────────────────────────────────────

export function ReduceColorsPanel({
  layer,
  parentLayerName,
  canvasHandleRef,
}: ReduceColorsPanelProps): React.JSX.Element {
  const state = useAppSelector(
    (s) => ({ swatches: s.swatches }),
    shallowEqual2,
  );
  const dispatch = useAppDispatch();
  const { mode, colorCount } = layer.params;
  const [isQuantizing, setIsQuantizing] = useState(false);
  const genRef = useRef(0);

  const pct = (v: number, min: number, max: number): string =>
    String((v - min) / (max - min));

  useEffect(() => {
    if (mode !== "reduce") return;
    const gen = ++genRef.current;

    const run = async (): Promise<void> => {
      const native = await canvasHandleRef?.current?.readAdjustmentInputPixels(
        layer.id,
      );
      if (!native || gen !== genRef.current) return;
      // Palette statistics don't need every pixel: quantize an even
      // subsample of at most QUANTIZE_SAMPLE_PIXELS. rgba32f input is
      // scene-linear, so it's gamma-encoded to sRGB bytes (the quantizer
      // and the palette are sRGB), not scaled by 255.
      const pixels = samplePixelsForQuantize(native);

      setIsQuantizing(true);
      try {
        const result = await quantizeOffThread(pixels, colorCount);
        if (gen !== genRef.current) return;
        const newPalette: RGBAColor[] = [];
        for (let i = 0; i < result.count; i++) {
          newPalette.push({
            r: result.palette[i * 4 + 0],
            g: result.palette[i * 4 + 1],
            b: result.palette[i * 4 + 2],
            a: result.palette[i * 4 + 3],
          });
        }
        dispatch({
          type: "UPDATE_ADJUSTMENT_LAYER",
          payload: {
            ...layer,
            params: { ...layer.params, colorCount, derivedPalette: newPalette },
          },
        });
      } finally {
        if (gen === genRef.current) setIsQuantizing(false);
      }
    };

    // Debounced: every slider tick used to trigger a full-resolution GPU
    // readback + conversion + quantize; only the settled value matters.
    const timer = setTimeout(() => void run(), 200);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [layer.id, mode, colorCount]);

  const swatchCount = state.swatches.length;
  const paletteValid = swatchCount >= 2;

  return (
    <div className={styles.content}>
      <div className={styles.modeRow}>
        <div className={styles.segmented}>
          <button
            className={`${styles.segBtn} ${mode === "reduce" ? styles.segBtnActive : ""}`}
            onClick={() =>
              dispatch({
                type: "UPDATE_ADJUSTMENT_LAYER",
                payload: {
                  ...layer,
                  params: { ...layer.params, mode: "reduce" },
                },
              })
            }
          >
            Reduce to N
          </button>
          <button
            className={`${styles.segBtn} ${mode === "palette" ? styles.segBtnActive : ""}`}
            onClick={() =>
              dispatch({
                type: "UPDATE_ADJUSTMENT_LAYER",
                payload: {
                  ...layer,
                  params: { ...layer.params, mode: "palette" },
                },
              })
            }
          >
            Map to Palette
          </button>
        </div>
      </div>

      {mode === "reduce" && (
        <div className={styles.row}>
          <span className={styles.label}>Colors</span>
          <div className={styles.trackWrap}>
            <input
              type="range"
              className={styles.track}
              min={2}
              max={256}
              step={1}
              value={colorCount}
              style={
                { "--pct": pct(colorCount, 2, 256) } as React.CSSProperties
              }
              onChange={(e) =>
                dispatch({
                  type: "UPDATE_ADJUSTMENT_LAYER",
                  payload: {
                    ...layer,
                    params: {
                      ...layer.params,
                      colorCount: Number(e.target.value),
                      derivedPalette: null,
                    },
                  },
                })
              }
            />
          </div>
          <input
            type="number"
            className={styles.numInput}
            min={2}
            max={256}
            step={1}
            value={colorCount}
            onChange={(e) => {
              const v = e.target.valueAsNumber;
              if (!isNaN(v))
                dispatch({
                  type: "UPDATE_ADJUSTMENT_LAYER",
                  payload: {
                    ...layer,
                    params: {
                      ...layer.params,
                      colorCount: Math.min(256, Math.max(2, Math.round(v))),
                      derivedPalette: null,
                    },
                  },
                });
            }}
          />
        </div>
      )}

      {mode === "reduce" && isQuantizing && (
        <p className={styles.computing}>Computing…</p>
      )}

      {mode === "palette" && (
        <div className={styles.paletteInfo}>
          {paletteValid ? (
            <p className={styles.paletteCount}>
              {swatchCount} color{swatchCount !== 1 ? "s" : ""} in palette
            </p>
          ) : (
            <div className={styles.warning}>
              <svg
                width="12"
                height="12"
                viewBox="0 0 12 12"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.2"
                aria-hidden="true"
              >
                <path d="M6 1.5L10.5 9.5H1.5L6 1.5Z" />
                <line x1="6" y1="5" x2="6" y2="7.2" />
                <circle
                  cx="6"
                  cy="8.5"
                  r="0.6"
                  fill="currentColor"
                  stroke="none"
                />
              </svg>
              <span>Palette must have at least 2 colors</span>
            </div>
          )}
        </div>
      )}

      <div className={styles.footer}>
        <span className={styles.footerInfo}>
          <ParentConnectorIcon />
          Adjusting <strong>{parentLayerName}</strong>
        </span>
        <button
          className={styles.resetBtn}
          onClick={() =>
            dispatch({
              type: "UPDATE_ADJUSTMENT_LAYER",
              payload: {
                ...layer,
                params: {
                  mode: "reduce",
                  colorCount: 16,
                  derivedPalette: null,
                },
              },
            })
          }
          title="Reset to defaults"
        >
          Reset
        </button>
      </div>
    </div>
  );
}
