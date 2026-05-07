import React, { useCallback, useEffect, useRef } from "react";
import { useAppContext } from "@/core/store/AppContext";
import { useCanvasContext } from "@/core/store/CanvasContext";
import type { RadialBlurEffectLayer } from "@/types";
import { ParentConnectorIcon } from "@/ux/windows/ToolWindowIcons";
import sharedStyles from "@/core/effects/_shared/filterPanel.module.scss";
import styles from "./RadialBlurPanel.module.scss";

const PREVIEW_MAX_W = 220;
const PREVIEW_MAX_H = 140;

interface Props {
  layer: RadialBlurEffectLayer;
  parentLayerName: string;
}

export function RadialBlurPanel({
  layer,
  parentLayerName,
}: Props): React.JSX.Element {
  const { state, dispatch } = useAppContext();
  const { thumbnailCanvasRef } = useCanvasContext();
  const { mode, amount, centerX, centerY, quality } = layer.params;
  const pctAmount = String((amount - 1) / 99);

  const up = (partial: Partial<typeof layer.params>): void =>
    dispatch({
      type: "UPDATE_ADJUSTMENT_LAYER",
      payload: { ...layer, params: { ...layer.params, ...partial } },
    });

  // ── Preview canvas ────────────────────────────────────────────────
  const docW = state.canvas.width;
  const docH = state.canvas.height;
  const scale = Math.min(1, Math.min(PREVIEW_MAX_W / docW, PREVIEW_MAX_H / docH));
  const previewW = Math.max(1, Math.round(docW * scale));
  const previewH = Math.max(1, Math.round(docH * scale));

  const previewCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const isDraggingRef = useRef(false);
  const rafRef = useRef<number>(0);

  const drawPreview = useCallback((): void => {
    const dst = previewCanvasRef.current;
    const src = thumbnailCanvasRef.current;
    if (!dst) return;
    const ctx = dst.getContext("2d");
    if (!ctx) return;
    ctx.clearRect(0, 0, previewW, previewH);
    if (src) {
      try {
        ctx.drawImage(src, 0, 0, previewW, previewH);
      } catch {
        // mirror not yet updated
      }
    }
  }, [thumbnailCanvasRef, previewW, previewH]);

  // Keep the preview in sync with the live thumbnail mirror.
  useEffect(() => {
    let active = true;
    const loop = (): void => {
      if (!active) return;
      drawPreview();
      rafRef.current = requestAnimationFrame(loop);
    };
    rafRef.current = requestAnimationFrame(loop);
    return () => {
      active = false;
      cancelAnimationFrame(rafRef.current);
    };
  }, [drawPreview]);

  const updateCenterFromEvent = useCallback(
    (e: React.PointerEvent<HTMLCanvasElement>): void => {
      const canvas = previewCanvasRef.current;
      if (!canvas) return;
      const rect = canvas.getBoundingClientRect();
      const nx = (e.clientX - rect.left) / rect.width;
      const ny = (e.clientY - rect.top) / rect.height;
      up({
        centerX: Math.min(1, Math.max(0, nx)),
        centerY: Math.min(1, Math.max(0, ny)),
      });
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [layer.id, layer.params],
  );

  const onPointerDown = (e: React.PointerEvent<HTMLCanvasElement>): void => {
    isDraggingRef.current = true;
    e.currentTarget.setPointerCapture(e.pointerId);
    updateCenterFromEvent(e);
  };
  const onPointerMove = (e: React.PointerEvent<HTMLCanvasElement>): void => {
    if (!isDraggingRef.current) return;
    updateCenterFromEvent(e);
  };
  const onPointerUp = (e: React.PointerEvent<HTMLCanvasElement>): void => {
    isDraggingRef.current = false;
    if (e.currentTarget.hasPointerCapture(e.pointerId)) {
      e.currentTarget.releasePointerCapture(e.pointerId);
    }
  };

  const crosshairLeft = Math.round(centerX * previewW);
  const crosshairTop = Math.round(centerY * previewH);

  return (
    <div className={sharedStyles.content}>
      {/* ── Centre picker ──────────────────────────────────────────── */}
      <div className={styles.previewWrap} style={{ width: previewW }}>
        <canvas
          ref={previewCanvasRef}
          className={styles.previewCanvas}
          width={previewW}
          height={previewH}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerUp}
          aria-label="Click to set radial blur centre"
        />
        <div
          className={styles.crosshair}
          style={{ left: crosshairLeft, top: crosshairTop }}
          aria-hidden="true"
        >
          <div className={styles.crosshairDot} />
        </div>
      </div>
      <p className={styles.previewHint}>Click or drag to set centre</p>

      <div className={sharedStyles.row}>
        <span className={sharedStyles.label}>Centre</span>
        <input
          type="number"
          className={sharedStyles.numInput}
          min={0}
          max={100}
          step={1}
          value={Math.round(centerX * 100)}
          onChange={(e) => {
            const v = e.target.valueAsNumber;
            if (!isNaN(v))
              up({ centerX: Math.min(1, Math.max(0, v / 100)) });
          }}
          aria-label="Centre X (%)"
        />
        <span className={styles.axisLabel}>X</span>
        <input
          type="number"
          className={sharedStyles.numInput}
          min={0}
          max={100}
          step={1}
          value={Math.round(centerY * 100)}
          onChange={(e) => {
            const v = e.target.valueAsNumber;
            if (!isNaN(v))
              up({ centerY: Math.min(1, Math.max(0, v / 100)) });
          }}
          aria-label="Centre Y (%)"
        />
        <span className={styles.axisLabel}>Y</span>
      </div>

      <div className={sharedStyles.sep} />

      <div className={sharedStyles.row}>
        <span className={sharedStyles.label}>Mode</span>
        <div className={sharedStyles.segmented}>
          {([0, 1] as const).map((m) => (
            <button
              key={m}
              className={`${sharedStyles.segBtn} ${mode === m ? sharedStyles.segBtnActive : ""}`}
              onClick={() => up({ mode: m })}
            >
              {m === 0 ? "Spin" : "Zoom"}
            </button>
          ))}
        </div>
        <span className={sharedStyles.unitSpacer} />
      </div>

      <div className={sharedStyles.row}>
        <span className={sharedStyles.label}>Amount</span>
        <div className={sharedStyles.trackWrap}>
          <input
            type="range"
            className={sharedStyles.track}
            min={1}
            max={100}
            step={1}
            value={amount}
            style={{ "--pct": pctAmount } as React.CSSProperties}
            onChange={(e) => up({ amount: Number(e.target.value) })}
          />
        </div>
        <input
          type="number"
          className={sharedStyles.numInput}
          min={1}
          max={100}
          step={1}
          value={amount}
          onChange={(e) => {
            const v = e.target.valueAsNumber;
            if (!isNaN(v))
              up({ amount: Math.min(100, Math.max(1, Math.round(v))) });
          }}
        />
        <span className={sharedStyles.unitSpacer} />
      </div>

      <div className={sharedStyles.sep} />

      <div className={sharedStyles.row}>
        <span className={sharedStyles.label}>Quality</span>
        <div className={sharedStyles.segmented}>
          {([0, 1, 2] as const).map((q) => (
            <button
              key={q}
              className={`${sharedStyles.segBtn} ${quality === q ? sharedStyles.segBtnActive : ""}`}
              onClick={() => up({ quality: q })}
            >
              {q === 0 ? "Draft" : q === 1 ? "Good" : "Best"}
            </button>
          ))}
        </div>
        <span className={sharedStyles.unitSpacer} />
      </div>

      <div className={sharedStyles.footer}>
        <span className={sharedStyles.footerInfo}>
          <ParentConnectorIcon />
          Adjusting <strong>{parentLayerName}</strong>
        </span>
        <button
          className={sharedStyles.resetBtn}
          onClick={() =>
            up({ mode: 0, amount: 10, centerX: 0.5, centerY: 0.5, quality: 1 })
          }
          title="Reset"
        >
          Reset
        </button>
      </div>
    </div>
  );
}
