import type { CurvesEffectLayer } from "@/core/effects/Curves/CurvesEffect";
import { useCurvesHistogram } from "@/core/services/useCurvesHistogram";
import {
  getAdjustmentClipboardData,
  setAdjustmentClipboardData,
} from "@/core/store/adjustmentClipboardStore";
import { adjustmentPreviewStore } from "@/core/store/adjustmentPreviewStore";
import { useAppContext } from "@/core/store/AppContext";
import type { CurvesChannel, CurvesControlPoint } from "@/types";
import type { CanvasHandle } from "@/ux/main/Canvas/Canvas";
import { CurvesGraph } from "@/ux/widgets/CurvesGraph/CurvesGraph";
import { ParentConnectorIcon } from "@/ux/windows/ToolWindowIcons";
import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  cloneCurvesParams,
  makeIdentityCurve,
  nextPointId,
  validateCurvesParams,
  withDirtyPresetRef,
} from "./curves";
import styles from "./CurvesPanel.module.scss";
import {
  BUILTIN_CURVES_PRESETS,
  clonePresetChannels,
} from "./curvesPresets";

// ─── Props ────────────────────────────────────────────────────────────────────

interface CurvesPanelProps {
  layer: CurvesEffectLayer;
  parentLayerName: string;
  canvasHandleRef?: { readonly current: CanvasHandle | null };
}

// ─── Channel config ───────────────────────────────────────────────────────────

const CHANNELS: { value: CurvesChannel; label: string; cls: string }[] = [
  { value: "rgb", label: "RGB", cls: "" },
  { value: "red", label: "Red", cls: "red" },
  { value: "green", label: "Green", cls: "green" },
  { value: "blue", label: "Blue", cls: "blue" },
];

const CHANNEL_LABEL: Record<CurvesChannel, string> = {
  rgb: "RGB",
  red: "Red",
  green: "Green",
  blue: "Blue",
};

// ─── Component ────────────────────────────────────────────────────────────────

export function CurvesPanel({
  layer,
  parentLayerName,
  canvasHandleRef,
}: CurvesPanelProps): React.JSX.Element {
  const { state, dispatch } = useAppContext();

  const params = layer.params;
  const ch = params.ui.selectedChannel;
  const currentPoints = params.channels[ch].points;

  // Ephemeral panel state
  const [selectedPointId, setSelectedPointId] = useState<string | null>(
    currentPoints.length > 2 ? currentPoints[1].id : currentPoints[0].id,
  );
  const [hoverTone, setHoverTone] = useState<{
    input: number;
    output: number;
  } | null>(null);
  const [pasteError, setPasteErrorState] = useState<string | null>(null);
  const [previewEnabled, setPreviewEnabled] = useState(true);
  const [showHistogram, setShowHistogram] = useState(true);
  const pasteErrorTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const histogramSourceRevisionHint = useMemo(() => {
    return state.layers
      .map((ls) => {
        if ("type" in ls && ls.type === "adjustment") {
          if (ls.id === layer.id) {
            return `${ls.id}:self:${ls.visible ? 1 : 0}:${ls.parentId}`;
          }
          return `${ls.id}:${ls.effectType}:${ls.visible ? 1 : 0}:${ls.parentId}:${JSON.stringify(ls.params)}`;
        }
        if ("type" in ls && ls.type === "mask") {
          return `${ls.id}:mask:${ls.visible ? 1 : 0}:${ls.parentId}`;
        }
        return `${ls.id}:pixel:${ls.visible ? 1 : 0}:${"opacity" in ls ? ls.opacity : 1}:${"blendMode" in ls ? ls.blendMode : "normal"}`;
      })
      .join("|");
  }, [state.layers, layer.id]);

  const {
    histogram,
    status: histogramStatus,
    message: histogramMessage,
  } = useCurvesHistogram({
    canvasHandleRef: canvasHandleRef ?? { current: null },
    adjustmentLayerId: layer.id,
    selectedChannel: ch,
    showHistogram,
    width: state.canvas.width,
    height: state.canvas.height,
    sourceRevisionHint: histogramSourceRevisionHint,
  });

  const histogramStatusText = showHistogram
    ? histogramStatus === "loading"
      ? "Histogram loading..."
      : histogramStatus === "unavailable" || histogramStatus === "error"
        ? (histogramMessage ?? "Histogram unavailable.")
        : ""
    : "";

  // Preview store integration
  useEffect(() => {
    return () => {
      adjustmentPreviewStore.clear(layer.id);
    };
  }, [layer.id]);

  // Error banner helper
  const showPasteError = (msg: string): void => {
    setPasteErrorState(msg);
    if (pasteErrorTimerRef.current) clearTimeout(pasteErrorTimerRef.current);
    pasteErrorTimerRef.current = setTimeout(
      () => setPasteErrorState(null),
      4000,
    );
  };

  useEffect(() => {
    return () => {
      if (pasteErrorTimerRef.current) clearTimeout(pasteErrorTimerRef.current);
    };
  }, []);

  // ─── Dispatch helper ────────────────────────────────────────────────────────

  const dispatchParams = useCallback(
    (newParams: typeof params): void => {
      dispatch({
        type: "UPDATE_ADJUSTMENT_LAYER",
        payload: { ...layer, params: newParams },
      });
    },
    [dispatch, layer],
  );

  // ─── Channel ────────────────────────────────────────────────────────────────

  const handleChannelChange = useCallback(
    (newCh: CurvesChannel): void => {
      const pts = params.channels[newCh].points;
      const targetIdx = Math.min(2, pts.length - 1);
      setSelectedPointId(pts[targetIdx]?.id ?? pts[0]?.id ?? null);
      setHoverTone(null);
      dispatchParams({
        ...params,
        ui: { ...params.ui, selectedChannel: newCh },
      });
    },
    [params, dispatchParams],
  );

  // ─── Point operations ───────────────────────────────────────────────────────

  const handleAddPoint = useCallback(
    (input: number, output: number): void => {
      const pts = currentPoints;
      if (pts.some((p) => Math.abs(p.x - input) < 3)) return;

      const newPoint: CurvesControlPoint = {
        id: nextPointId(ch, pts),
        x: input,
        y: output,
      };

      const insertIdx = pts.findIndex((p) => p.x > input);
      const newPoints =
        insertIdx < 0
          ? [...pts, newPoint]
          : [...pts.slice(0, insertIdx), newPoint, ...pts.slice(insertIdx)];

      dispatchParams({
        ...params,
        channels: { ...params.channels, [ch]: { points: newPoints } },
        ui: {
          ...params.ui,
          presetRef: withDirtyPresetRef(params.ui.presetRef, true),
        },
      });
      setSelectedPointId(newPoint.id);
    },
    [ch, currentPoints, params, dispatchParams],
  );

  const handleMovePoint = useCallback(
    (pointId: string, input: number, output: number): void => {
      const pts = currentPoints;
      const idx = pts.findIndex((p) => p.id === pointId);
      if (idx < 0) return;

      const isEndpoint = idx === 0 || idx === pts.length - 1;
      const prevX = idx > 0 ? pts[idx - 1].x + 1 : 0;
      const nextX = idx < pts.length - 1 ? pts[idx + 1].x - 1 : 255;

      const newX = isEndpoint
        ? pts[idx].x
        : Math.max(prevX, Math.min(nextX, Math.max(0, Math.min(255, input))));
      const newY = Math.max(0, Math.min(255, output));

      if (newX === pts[idx].x && newY === pts[idx].y) return;

      const newPoints = pts.map((p, i) =>
        i === idx ? { ...p, x: newX, y: newY } : p,
      );
      dispatchParams({
        ...params,
        channels: { ...params.channels, [ch]: { points: newPoints } },
        ui: {
          ...params.ui,
          presetRef: withDirtyPresetRef(params.ui.presetRef, true),
        },
      });
    },
    [ch, currentPoints, params, dispatchParams],
  );

  const handleDeletePoint = useCallback(
    (pointId: string): void => {
      const pts = currentPoints;
      const idx = pts.findIndex((p) => p.id === pointId);
      if (idx <= 0 || idx >= pts.length - 1) return;

      const newPoints = pts.filter((_, i) => i !== idx);
      const newSelectedId =
        newPoints[Math.min(idx, newPoints.length - 1)]?.id ?? null;

      dispatchParams({
        ...params,
        channels: { ...params.channels, [ch]: { points: newPoints } },
        ui: {
          ...params.ui,
          presetRef: withDirtyPresetRef(params.ui.presetRef, true),
        },
      });
      setSelectedPointId(newSelectedId);
    },
    [ch, currentPoints, params, dispatchParams],
  );

  const handleNudgePoint = useCallback(
    (pointId: string, dx: number, dy: number): void => {
      const pts = currentPoints;
      const idx = pts.findIndex((p) => p.id === pointId);
      if (idx < 0) return;

      const isEndpoint = idx === 0 || idx === pts.length - 1;
      const p = pts[idx];

      const rawX = isEndpoint ? p.x : Math.max(0, Math.min(255, p.x + dx));
      const rawY = Math.max(0, Math.min(255, p.y + dy));

      const prevX = idx > 0 ? pts[idx - 1].x + 1 : 0;
      const nextX = idx < pts.length - 1 ? pts[idx + 1].x - 1 : 255;
      const finalX = isEndpoint ? p.x : Math.max(prevX, Math.min(nextX, rawX));

      if (finalX === p.x && rawY === p.y) return;

      const newPoints = pts.map((pt, i) =>
        i === idx ? { ...pt, x: finalX, y: rawY } : pt,
      );
      dispatchParams({
        ...params,
        channels: { ...params.channels, [ch]: { points: newPoints } },
        ui: {
          ...params.ui,
          presetRef: withDirtyPresetRef(params.ui.presetRef, true),
        },
      });
    },
    [ch, currentPoints, params, dispatchParams],
  );

  // ─── Presets ────────────────────────────────────────────────────────────────

  const handlePresetChange = (id: string): void => {
    const preset = BUILTIN_CURVES_PRESETS.find((p) => p.id === id);
    if (!preset) return;

    dispatchParams({
      ...params,
      channels: clonePresetChannels(preset.channels),
      ui: {
        ...params.ui,
        presetRef: {
          source: "builtin",
          id: preset.id,
          name: preset.label,
          dirty: false,
        },
      },
    });
    // Reset selection to a representative point of the new preset
    const newPts = preset.channels[ch].points;
    const targetIdx = Math.min(2, newPts.length - 1);
    setSelectedPointId(newPts[targetIdx]?.id ?? newPts[0]?.id ?? null);
  };

  // ─── Actions ────────────────────────────────────────────────────────────────

  const handleCopySettings = (): void => {
    setAdjustmentClipboardData({
      kind: "curves-settings",
      version: 1,
      payload: cloneCurvesParams(params),
    });
  };

  const handlePasteSettings = (): void => {
    const data = getAdjustmentClipboardData();
    if (!data || data.kind !== "curves-settings") {
      showPasteError("Paste failed: no Curves settings in clipboard.");
      return;
    }
    if (!validateCurvesParams(data.payload)) {
      showPasteError(
        "Paste failed. Curves settings payload is incompatible with this version.",
      );
      return;
    }
    const pasted = cloneCurvesParams(data.payload);
    dispatchParams(pasted);
    const newPts = pasted.channels[pasted.ui.selectedChannel].points;
    const targetIdx = Math.min(2, newPts.length - 1);
    setSelectedPointId(newPts[targetIdx]?.id ?? newPts[0]?.id ?? null);
  };

  const handleResetChannel = (): void => {
    const identity = makeIdentityCurve(ch);
    dispatchParams({
      ...params,
      channels: { ...params.channels, [ch]: identity },
      ui: {
        ...params.ui,
        presetRef: withDirtyPresetRef(params.ui.presetRef, true),
      },
    });
    const pts = identity.points;
    setSelectedPointId(pts[pts.length - 1]?.id ?? null);
  };

  const handleResetAll = (): void => {
    dispatchParams({
      ...params,
      channels: {
        rgb: makeIdentityCurve("rgb"),
        red: makeIdentityCurve("red"),
        green: makeIdentityCurve("green"),
        blue: makeIdentityCurve("blue"),
      },
      ui: {
        ...params.ui,
        presetRef: {
          source: "builtin",
          id: "linear",
          name: "Linear",
          dirty: false,
        },
      },
    });
    setSelectedPointId(null);
  };

  // ─── Preview toggle ─────────────────────────────────────────────────────────

  const handlePreviewToggle = (enabled: boolean): void => {
    setPreviewEnabled(enabled);
    adjustmentPreviewStore.setBypassed(layer.id, !enabled);
  };

  // ─── Visual aids ────────────────────────────────────────────────────────────

  const handleVisualAid = <K extends keyof typeof params.ui.visualAids>(
    key: K,
    value: (typeof params.ui.visualAids)[K],
  ): void => {
    dispatchParams({
      ...params,
      ui: {
        ...params.ui,
        visualAids: { ...params.ui.visualAids, [key]: value },
      },
    });
  };

  // ─── Telemetry row helpers ──────────────────────────────────────────────────

  const selectedPointIdx = currentPoints.findIndex(
    (p) => p.id === selectedPointId,
  );
  const selectedPoint =
    selectedPointIdx >= 0 ? currentPoints[selectedPointIdx] : null;
  const isSelectedEndpoint =
    selectedPointIdx === 0 || selectedPointIdx === currentPoints.length - 1;

  const pointLabel = (): string => {
    if (selectedPointIdx < 0) return "—";
    if (selectedPointIdx === 0) return "Start";
    if (selectedPointIdx === currentPoints.length - 1) return "End";
    return `P${selectedPointIdx}`;
  };

  // ─── Preset select value ────────────────────────────────────────────────────

  const presetSelectValue = params.ui.presetRef?.id ?? "__custom__";
  const isBuiltin = params.ui.presetRef?.source === "builtin";

  // ─── Footer hint text ───────────────────────────────────────────────────────

  const footerHintText = (): string => {
    if (!layer.visible) return "Layer visibility bypasses Curves globally";
    return "Shift-drag constrains axis";
  };

  // ─── Readout text ───────────────────────────────────────────────────────────

  const readoutText = (): string => {
    if (selectedPoint) {
      return `Selected: ${selectedPoint.x} in → ${selectedPoint.y} out`;
    }
    if (hoverTone) {
      return `Hover: ${hoverTone.input} → ${hoverTone.output}`;
    }
    return "";
  };

  // ─── Render ────────────────────────────────────────────────────────────────

  return (
    <div className={styles.content}>
      {/* Scope row */}
      <div className={styles.scopeRow}>
        <span className={styles.scopeChip}>
          <strong>Scope:</strong>{" "}
          {layer.hasMask ? "Selection mask" : "Full layer"}
        </span>
        <span className={styles.denseNote}>1 undo entry when panel closes</span>
      </div>

      {/* Channel selector */}
      <div className={styles.row}>
        <span className={styles.fieldLabel}>Channel</span>
        <div className={styles.segmented}>
          {CHANNELS.map((c) => (
            <button
              key={c.value}
              className={[
                styles.segBtn,
                c.cls ? styles[c.cls as "red" | "green" | "blue"] : "",
                ch === c.value ? styles.active : "",
              ].join(" ")}
              onClick={() => handleChannelChange(c.value)}
            >
              {c.label}
            </button>
          ))}
        </div>
      </div>

      {/* Preset row */}
      <div className={styles.row}>
        <span className={styles.fieldLabel}>Preset</span>
        <select
          className={styles.presetSelect}
          value={presetSelectValue}
          onChange={(e) => handlePresetChange(e.target.value)}
        >
          {!params.ui.presetRef && (
            <option value="__custom__" disabled>
              — (edited) —
            </option>
          )}
          {params.ui.presetRef && params.ui.presetRef.dirty && (
            <option value={params.ui.presetRef.id} disabled>
              {params.ui.presetRef.name} *
            </option>
          )}
          {BUILTIN_CURVES_PRESETS.filter(
            (p) =>
              !(params.ui.presetRef?.id === p.id && params.ui.presetRef?.dirty),
          ).map((p) => (
            <option key={p.id} value={p.id}>
              {p.label}
            </option>
          ))}
        </select>
        <button
          className={styles.miniBtn}
          disabled
          title="Save custom preset (not yet available)"
        >
          Save
        </button>
        <button
          className={styles.miniBtn}
          disabled={isBuiltin || !params.ui.presetRef}
          title="Rename custom preset"
        >
          Rename
        </button>
        <button
          className={styles.miniBtn}
          disabled={isBuiltin || !params.ui.presetRef}
          title="Delete custom preset"
        >
          Delete
        </button>
      </div>

      {/* Curve region */}
      <div className={styles.curveRegion}>
        <div className={styles.curveHeader}>
          <div className={styles.curveTitle}>
            Curve Editor <strong>{CHANNEL_LABEL[ch]}</strong>
          </div>
          <div className={styles.curveReadout}>
            {histogramStatusText || readoutText()}
          </div>
        </div>
        <CurvesGraph
          channel={ch}
          points={currentPoints}
          histogram={showHistogram ? histogram : null}
          visualAids={params.ui.visualAids}
          selectedPointId={selectedPointId}
          onAddPoint={handleAddPoint}
          onMovePoint={handleMovePoint}
          onSelectPoint={setSelectedPointId}
          onDeletePoint={handleDeletePoint}
          onNudgePoint={handleNudgePoint}
          onHoverChange={(input, output) => setHoverTone({ input, output })}
        />
      </div>

      {/* Telemetry row */}
      <div className={styles.telemetryRow}>
        <span className={styles.telemetryMeta}>{pointLabel()}</span>
        <div className={styles.telemetryGroup}>
          <span className={styles.telemetryTag}>In</span>
          <input
            type="number"
            className={styles.telemetryInput}
            min={0}
            max={255}
            value={selectedPoint?.x ?? ""}
            disabled={!selectedPoint}
            onChange={(e) => {
              if (!selectedPointId || !selectedPoint) return;
              const v = parseInt(e.target.value, 10);
              if (!isNaN(v))
                handleMovePoint(selectedPointId, v, selectedPoint.y);
            }}
          />
        </div>
        <div className={styles.telemetryGroup}>
          <span className={styles.telemetryTag}>Out</span>
          <input
            type="number"
            className={styles.telemetryInput}
            min={0}
            max={255}
            value={selectedPoint?.y ?? ""}
            disabled={!selectedPoint}
            onChange={(e) => {
              if (!selectedPointId || !selectedPoint) return;
              const v = parseInt(e.target.value, 10);
              if (!isNaN(v))
                handleMovePoint(selectedPointId, selectedPoint.x, v);
            }}
          />
        </div>
        <div className={styles.telemetrySpacer} />
        {hoverTone && (
          <span className={styles.hoverPill}>
            Hover {hoverTone.input} → {hoverTone.output}
          </span>
        )}
        <button
          className={styles.ghostBtn}
          disabled={!selectedPointId || isSelectedEndpoint}
          onClick={() => selectedPointId && handleDeletePoint(selectedPointId)}
        >
          Delete Point
        </button>
      </div>

      {/* Visual aids row */}
      <div className={styles.aidRow}>
        <span className={styles.fieldLabel}>Aids</span>
        <div className={styles.aidGroup}>
          <label className={styles.checkOpt}>
            <input
              type="checkbox"
              checked={showHistogram}
              onChange={(e) => setShowHistogram(e.target.checked)}
            />
            Histogram
          </label>
          <label className={styles.checkOpt}>
            <input
              type="checkbox"
              checked={params.ui.visualAids.showClippingIndicators}
              onChange={(e) =>
                handleVisualAid("showClippingIndicators", e.target.checked)
              }
            />
            Clipping
          </label>
          <label className={styles.checkOpt}>
            <input
              type="checkbox"
              checked={params.ui.visualAids.showReadout}
              onChange={(e) => handleVisualAid("showReadout", e.target.checked)}
            />
            Readout
          </label>
          <span className={styles.telemetryTag}>Grid</span>
          <select
            className={styles.gridSelect}
            value={params.ui.visualAids.gridDensity}
            onChange={(e) =>
              handleVisualAid("gridDensity", e.target.value as "4x4" | "8x8")
            }
          >
            <option value="4x4">4×4</option>
            <option value="8x8">8×8</option>
          </select>
        </div>
      </div>

      {/* Action row */}
      <div className={styles.actionRow}>
        <div className={styles.actionLeft}>
          <button className={styles.actionBtn} onClick={handleCopySettings}>
            Copy Settings
          </button>
          <button className={styles.actionBtn} onClick={handlePasteSettings}>
            Paste Settings
          </button>
        </div>
        <div className={styles.actionRight}>
          <button className={styles.actionBtn} onClick={handleResetChannel}>
            Reset {CHANNEL_LABEL[ch]}
          </button>
          <button
            className={`${styles.actionBtn} ${styles.primary}`}
            onClick={handleResetAll}
          >
            Reset All
          </button>
        </div>
      </div>

      {/* Paste error banner */}
      {pasteError && <div className={styles.errorBanner}>{pasteError}</div>}

      {/* Preview row */}
      <div className={styles.previewRow}>
        <label className={styles.previewToggle}>
          <input
            type="checkbox"
            checked={previewEnabled}
            onChange={(e) => handlePreviewToggle(e.target.checked)}
          />
          Preview
        </label>
        <span className={styles.previewNote}>
          {previewEnabled
            ? "Panel preview bypass only. Layer eye still wins."
            : "Preview disabled; stored points remain unchanged."}
        </span>
      </div>

      {/* Footer */}
      <div className={styles.footer}>
        <div className={styles.layerIndicator}>
          <span className={styles.layerIndicatorIcon}>
            <ParentConnectorIcon />
          </span>
          <span className={styles.layerIndicatorText}>
            Adjusting <strong>{parentLayerName}</strong>
          </span>
        </div>
        <span
          className={[
            styles.footerHint,
            !layer.visible ? styles.layerHidden : "",
          ].join(" ")}
        >
          {footerHintText()}
        </span>
      </div>
    </div>
  );
}
