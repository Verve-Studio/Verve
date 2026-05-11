import React, { useEffect, useRef, useState } from "react";
import { useAppContext } from "@/core/store/AppContext";
import type { AutoMatchSourceStats, AutoMatchStats, LayerState } from "@/types";
import type { AutoMatchEffectLayer } from "@/core/effects/AutoMatch/AutoMatchEffect";
import type { CanvasHandle } from "@/ux/main/Canvas/Canvas";
import { effectRegistry } from "@/core/effects";
import { ParentConnectorIcon } from "@/ux/windows/ToolWindowIcons";
import styles from "./AutoMatchPanel.module.scss";

// ─── Props ────────────────────────────────────────────────────────────────────

interface AutoMatchPanelProps {
  layer: AutoMatchEffectLayer;
  parentLayerName: string;
  canvasHandleRef?: { readonly current: CanvasHandle | null };
}

const getDefaultParams = (): AutoMatchEffectLayer["params"] =>
  effectRegistry.get("auto-match")!.defaultParams as AutoMatchEffectLayer["params"];

// ─── Stats helpers ────────────────────────────────────────────────────────────

const EMPTY_STATS: AutoMatchSourceStats = {
  count: 0,
  meanL: 0,
  stdL: 0,
  minL: 0,
  maxL: 1,
  meanR: 0,
  meanG: 0,
  meanB: 0,
  chromaMag: 0,
};

interface BBox {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

/**
 * Chebyshev (chessboard) distance transform: for each pixel returns the
 * shortest 8-connected step count to the nearest opaque pixel in `pixels`.
 * Two-pass O(N), good enough as a Euclidean approximation for falloff
 * weighting (max √2 error vs. true Euclidean).
 */
function computeChebyshevDistance(
  pixels: Uint8Array | Float32Array,
  width: number,
  height: number,
): Float32Array {
  const isF32 = pixels instanceof Float32Array;
  const alphaThresh = isF32 ? 0.004 : 1;
  const INF = width + height + 1;
  const d = new Float32Array(width * height);

  // Forward pass — propagate from top-left
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = y * width + x;
      if (pixels[i * 4 + 3] >= alphaThresh) {
        d[i] = 0;
        continue;
      }
      let best = INF;
      if (x > 0) {
        const v = d[i - 1] + 1;
        if (v < best) best = v;
      }
      if (y > 0) {
        const v = d[i - width] + 1;
        if (v < best) best = v;
        if (x > 0) {
          const v2 = d[i - width - 1] + 1;
          if (v2 < best) best = v2;
        }
        if (x < width - 1) {
          const v2 = d[i - width + 1] + 1;
          if (v2 < best) best = v2;
        }
      }
      d[i] = best;
    }
  }
  // Backward pass — propagate from bottom-right
  for (let y = height - 1; y >= 0; y--) {
    for (let x = width - 1; x >= 0; x--) {
      const i = y * width + x;
      let best = d[i];
      if (x < width - 1) {
        const v = d[i + 1] + 1;
        if (v < best) best = v;
      }
      if (y < height - 1) {
        const v = d[i + width] + 1;
        if (v < best) best = v;
        if (x < width - 1) {
          const v2 = d[i + width + 1] + 1;
          if (v2 < best) best = v2;
        }
        if (x > 0) {
          const v2 = d[i + width - 1] + 1;
          if (v2 < best) best = v2;
        }
      }
      d[i] = best;
    }
  }
  return d;
}

/**
 * Iterate `pixels` (canvas-size, RGBA) over the given rectangle, accumulating
 * stats for opaque pixels (alpha >= threshold). Pixels can be Uint8Array
 * (0..255 per channel) or Float32Array (0..1, may exceed 1 for HDR).
 */
function gatherStats(
  pixels: Uint8Array | Float32Array,
  width: number,
  height: number,
  rect: BBox,
  /** Per-pixel weight (canvas-size). When omitted, every opaque pixel weighs 1. */
  weights?: Float32Array | null,
): AutoMatchSourceStats & { sumL2: number; sumL: number } {
  const isF32 = pixels instanceof Float32Array;
  const norm = isF32 ? 1 : 1 / 255;
  const alphaThresh = isF32 ? 0.004 : 1; // ~1/255

  const x0 = Math.max(0, rect.x0 | 0);
  const y0 = Math.max(0, rect.y0 | 0);
  const x1 = Math.min(width, rect.x1 | 0);
  const y1 = Math.min(height, rect.y1 | 0);

  let count = 0;
  let sumW = 0;
  let sumR = 0;
  let sumG = 0;
  let sumB = 0;
  let sumL = 0;
  let sumL2 = 0;
  let sumChroma = 0;
  let minL = Infinity;
  let maxL = -Infinity;

  for (let y = y0; y < y1; y++) {
    const rowPx = y * width + x0;
    let i = rowPx * 4;
    let pIdx = rowPx;
    for (let x = x0; x < x1; x++, i += 4, pIdx++) {
      const a = pixels[i + 3];
      if (a < alphaThresh) continue;
      const w = weights ? weights[pIdx] : 1;
      if (w <= 0) continue;
      const r = pixels[i] * norm;
      const g = pixels[i + 1] * norm;
      const b = pixels[i + 2] * norm;
      const l = 0.2126 * r + 0.7152 * g + 0.0722 * b;
      const cr = r - l;
      const cg = g - l;
      const cb = b - l;
      const chromaLen = Math.sqrt(cr * cr + cg * cg + cb * cb);
      count++;
      sumW += w;
      sumR += r * w;
      sumG += g * w;
      sumB += b * w;
      sumL += l * w;
      sumL2 += l * l * w;
      sumChroma += chromaLen * w;
      if (l < minL) minL = l;
      if (l > maxL) maxL = l;
    }
  }

  if (count === 0 || sumW <= 0) {
    return { ...EMPTY_STATS, sumL: 0, sumL2: 0 };
  }
  const meanL = sumL / sumW;
  const variance = Math.max(0, sumL2 / sumW - meanL * meanL);
  return {
    count,
    meanL,
    stdL: Math.sqrt(variance),
    minL: minL,
    maxL: maxL,
    meanR: sumR / sumW,
    meanG: sumG / sumW,
    meanB: sumB / sumW,
    chromaMag: sumChroma / sumW,
    sumL,
    sumL2,
  };
}

/**
 * Compute the layer's opaque bounding box from a canvas-size RGBA buffer.
 * Returns null if the layer is fully transparent.
 */
function findOpaqueBBox(
  pixels: Uint8Array | Float32Array,
  width: number,
  height: number,
): BBox | null {
  const isF32 = pixels instanceof Float32Array;
  const alphaThresh = isF32 ? 0.004 : 1;
  let x0 = width;
  let y0 = height;
  let x1 = 0;
  let y1 = 0;
  let any = false;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const a = pixels[(y * width + x) * 4 + 3];
      if (a < alphaThresh) continue;
      any = true;
      if (x < x0) x0 = x;
      if (y < y0) y0 = y;
      if (x > x1) x1 = x;
      if (y > y1) y1 = y;
    }
  }
  if (!any) return null;
  return { x0, y0, x1: x1 + 1, y1: y1 + 1 };
}

// ─── Component ────────────────────────────────────────────────────────────────

export function AutoMatchPanel({
  layer,
  parentLayerName,
  canvasHandleRef,
}: AutoMatchPanelProps): React.JSX.Element {
  const { state, dispatch } = useAppContext();
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

    const parentId = layer.parentId;
    const parent = state.layers.find((l) => l.id === parentId);
    if (!parent) return;

    // Read the pixels that feed INTO this adjustment — i.e. the parent layer
    // with every upstream adjustment in the same chain already applied. Using
    // the raw layer pixels here would make the cached stats describe a
    // different image than the one the shader actually operates on, which
    // produces over- or under-correction.
    const parentPixels = await handle.readAdjustmentInputPixels(layer.id);
    if (gen !== genRef.current) return;
    if (!parentPixels) return;

    // Build the rest-of-image layer list: everything except the parent itself
    // and any adjustments attached to the parent (those would have no effect
    // without their parent).
    const restLayers: LayerState[] = state.layers.filter((l) => {
      if (l.id === parentId) return false;
      if (
        "type" in l &&
        l.type === "adjustment" &&
        (l as { parentId: string }).parentId === parentId
      ) {
        return false;
      }
      return true;
    });

    let restPixels: Uint8Array | Float32Array;
    let width: number;
    let height: number;
    try {
      const result = await handle.rasterizeLayers(restLayers, "sample");
      if (gen !== genRef.current) return;
      restPixels = result.data;
      width = result.width;
      height = result.height;
    } catch {
      return;
    }

    // Layer stats across its bounding box (saves work vs. full canvas scan).
    const layerBBox = findOpaqueBBox(parentPixels, width, height);
    let layerStats: AutoMatchSourceStats;
    let contextStats: AutoMatchSourceStats;

    if (!layerBBox) {
      layerStats = { ...EMPTY_STATS };
      contextStats = { ...EMPTY_STATS };
    } else {
      const ls = gatherStats(parentPixels, width, height, layerBBox);
      layerStats = {
        count: ls.count,
        meanL: ls.meanL,
        stdL: ls.stdL,
        minL: ls.minL,
        maxL: ls.maxL,
        meanR: ls.meanR,
        meanG: ls.meanG,
        meanB: ls.meanB,
        chromaMag: ls.chromaMag,
      };

      // Sampling region = layer bbox dilated by samplingDistance, intersected
      // with image bounds. This is the bounding rectangle of pixels in the
      // rest-of-image that can possibly contribute to the surroundings stats.
      const r = Math.max(1, p.samplingDistance);
      const sampleRect: BBox = {
        x0: layerBBox.x0 - r,
        y0: layerBBox.y0 - r,
        x1: layerBBox.x1 + r,
        y1: layerBBox.y1 + r,
      };

      // Per-pixel falloff weights so context near the layer's silhouette
      // dominates the stats over context that's `samplingDistance` pixels
      // away. Without this, a tall narrow subject (like a person standing on
      // a road) ends up weighting the bright sky above their head as much as
      // the dim road at their feet, and the brightness shift collapses.
      const dist = computeChebyshevDistance(parentPixels, width, height);
      const weights = new Float32Array(width * height);
      // Smoothstep falloff: weight = 1 inside the silhouette, → 0 at distance r
      for (let i = 0; i < dist.length; i++) {
        const t = dist[i] / r;
        if (t >= 1) {
          weights[i] = 0;
        } else {
          // smoothstep(1, 0, t) = 1 - (3t² - 2t³) for t in [0,1]
          const s = 1 - (3 * t * t - 2 * t * t * t);
          weights[i] = s;
        }
      }
      const cs = gatherStats(restPixels, width, height, sampleRect, weights);
      contextStats = {
        count: cs.count,
        meanL: cs.meanL,
        stdL: cs.stdL,
        minL: cs.minL,
        maxL: cs.maxL,
        meanR: cs.meanR,
        meanG: cs.meanG,
        meanB: cs.meanB,
        chromaMag: cs.chromaMag,
      };
    }

    if (gen !== genRef.current) return;

    const stats: AutoMatchStats = { layer: layerStats, context: contextStats };
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
      {slider(
        "Sample Radius",
        p.samplingDistance,
        0,
        1000,
        (v) => updateParams({ samplingDistance: v }),
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
        <label htmlFor={`am-clamp-hi-${layer.id}`}>
          Clamp highlights
        </label>
      </div>
      <div className={styles.checkRow}>
        <input
          id={`am-clamp-lo-${layer.id}`}
          type="checkbox"
          checked={p.clampShadows}
          onChange={(e) => updateParams({ clampShadows: e.target.checked })}
        />
        <label htmlFor={`am-clamp-lo-${layer.id}`}>
          Clamp shadows
        </label>
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
