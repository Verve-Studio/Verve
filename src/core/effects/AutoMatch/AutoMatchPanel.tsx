import React, { useEffect, useRef, useState } from "react";
import {
  shallowEqual2,
  useAppDispatch,
  useAppSelector,
} from "@/core/store/AppContext";
import type { AutoMatchEffectLayer } from "@/core/effects/AutoMatch/AutoMatchEffect";
import type { CanvasHandle } from "@/ux/main/Canvas/Canvas";
import { effectRegistry } from "@/core/effects";
import { ParentConnectorIcon } from "@/ux/windows/ToolWindowIcons";
import styles from "./AutoMatchPanel.module.scss";
import { analyzeAutoMatch } from "./autoMatchAnalysis";

// ─── Props ────────────────────────────────────────────────────────────────────

interface AutoMatchPanelProps {
  layer: AutoMatchEffectLayer;
  parentLayerName: string;
  canvasHandleRef?: { readonly current: CanvasHandle | null };
}

const getDefaultParams = (): AutoMatchEffectLayer["params"] =>
  effectRegistry.get("auto-match")!
    .defaultParams as AutoMatchEffectLayer["params"];

export function AutoMatchPanel({
  layer,
  parentLayerName,
  canvasHandleRef,
}: AutoMatchPanelProps): React.JSX.Element {
  const state = useAppSelector((s) => ({ layers: s.layers }), shallowEqual2);
  const dispatch = useAppDispatch();
  const p = layer.params;

  const [isRunning, setIsRunning] = useState(false);
  const genRef = useRef(0);

  const updateParams = (
    next: Partial<AutoMatchEffectLayer["params"]>,
  ): void => {
    dispatch({
      type: "UPDATE_ADJUSTMENT_LAYER",
      payload: { ...layer, params: { ...layer.params, ...next } },
    });
  };

  const recompute = async (): Promise<void> => {
    const handle = canvasHandleRef?.current;
    if (!handle) return;
    const gen = ++genRef.current;
    setIsRunning(true);
    try {
      await runAnalysis(gen);
    } finally {
      if (gen === genRef.current) setIsRunning(false);
    }
  };

  const runAnalysis = async (gen: number): Promise<void> => {
    const handle = canvasHandleRef?.current;
    if (!handle) return;
    const stats = await analyzeAutoMatch(handle, layer, state.layers);
    if (!stats || gen !== genRef.current) return;
    dispatch({
      type: "UPDATE_ADJUSTMENT_LAYER",
      payload: {
        ...layer,
        params: {
          ...layer.params,
          cachedStats: stats,
          statsVersion: layer.params.statsVersion + 1,
        },
      },
    });
  };

  // Auto-analyze when the panel opens with no cached stats yet.
  useEffect(() => {
    if (!p.cachedStats) {
      void recompute();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [layer.id]);

  const pct = (v: number, min: number, max: number): string =>
    String((v - min) / (max - min));

  const slider = (
    label: string,
    value: number,
    min: number,
    max: number,
    onChange: (v: number) => void,
  ): React.JSX.Element => (
    <div className={styles.row}>
      <span className={styles.label}>{label}</span>
      <div className={styles.trackWrap}>
        <input
          type="range"
          className={styles.track}
          min={min}
          max={max}
          step={1}
          value={value}
          style={{ "--pct": pct(value, min, max) } as React.CSSProperties}
          onChange={(e) => onChange(Number(e.target.value))}
        />
      </div>
      <input
        type="number"
        className={styles.numInput}
        min={min}
        max={max}
        step={1}
        value={value}
        onChange={(e) => {
          const v = e.target.valueAsNumber;
          if (!isNaN(v)) onChange(Math.min(max, Math.max(min, Math.round(v))));
        }}
      />
    </div>
  );

  return (
    <div className={styles.content}>
      {slider("Sample Radius", p.samplingDistance, 0, 1000, (v) =>
        updateParams({ samplingDistance: v }),
      )}
      {slider("Strength", p.strength, 0, 100, (v) =>
        updateParams({ strength: v }),
      )}

      <div className={styles.divider} />
      <div className={styles.sectionLabel}>Per-Component</div>

      {slider("Brightness", p.brightness, 0, 200, (v) =>
        updateParams({ brightness: v }),
      )}
      {slider("Contrast", p.contrast, 0, 200, (v) =>
        updateParams({ contrast: v }),
      )}
      {slider("Gamma", p.gamma, 0, 200, (v) => updateParams({ gamma: v }))}
      {slider("Color", p.color, 0, 200, (v) => updateParams({ color: v }))}
      {slider("Saturation", p.saturation, 0, 200, (v) =>
        updateParams({ saturation: v }),
      )}

      <div className={styles.checkRow}>
        <input
          id={`am-clamp-hi-${layer.id}`}
          type="checkbox"
          checked={p.clampHighlights}
          onChange={(e) => updateParams({ clampHighlights: e.target.checked })}
        />
        <label htmlFor={`am-clamp-hi-${layer.id}`}>Clamp highlights</label>
      </div>
      <div className={styles.checkRow}>
        <input
          id={`am-clamp-lo-${layer.id}`}
          type="checkbox"
          checked={p.clampShadows}
          onChange={(e) => updateParams({ clampShadows: e.target.checked })}
        />
        <label htmlFor={`am-clamp-lo-${layer.id}`}>Clamp shadows</label>
      </div>

      <div className={styles.footer}>
        <span className={styles.footerInfo}>
          <ParentConnectorIcon />
          Adjusting <strong>{parentLayerName}</strong>
        </span>
        <button
          className={styles.resetBtn}
          onClick={() => void recompute()}
          disabled={isRunning}
          title="Re-sample the rest of the image"
        >
          {isRunning ? "Analyzing…" : "Recompute"}
        </button>
        <button
          className={styles.resetBtn}
          onClick={() =>
            dispatch({
              type: "UPDATE_ADJUSTMENT_LAYER",
              payload: {
                ...layer,
                params: {
                  ...getDefaultParams(),
                  // Preserve the cached analysis so the user doesn't lose work.
                  cachedStats: layer.params.cachedStats,
                  statsVersion: layer.params.statsVersion,
                },
              },
            })
          }
          title="Reset sliders to defaults"
        >
          Reset
        </button>
      </div>
    </div>
  );
}
