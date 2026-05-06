import React from "react";
import { useAppContext } from "@/core/store/AppContext";
import type { PolarCoordinatesAdjustmentLayer } from "@/types";
import { ADJUSTMENT_REGISTRY } from "@/core/operations/adjustments/registry";
import type { AdjustmentRegistrationEntry } from "@/core/operations/adjustments/registry";
import { ParentConnectorIcon } from "@/ux/windows/ToolWindowIcons";
import {
  DistortionSlider,
  DistortionSegmented,
  EDGE_MODES,
} from "../distortionShared";
import styles from "../distortionPanel.module.scss";

interface Props {
  layer: PolarCoordinatesAdjustmentLayer;
  parentLayerName: string;
}

const DEFAULT_PARAMS = (
  ADJUSTMENT_REGISTRY as readonly AdjustmentRegistrationEntry[]
).find((e) => e.adjustmentType === "polar-coordinates")!
  .defaultParams as PolarCoordinatesAdjustmentLayer["params"];

const MODES: PolarCoordinatesAdjustmentLayer["params"]["mode"][] = [
  "rect-to-polar",
  "polar-to-rect",
];

const MODE_LABEL: Record<
  PolarCoordinatesAdjustmentLayer["params"]["mode"],
  string
> = {
  "rect-to-polar": "Rect → Polar",
  "polar-to-rect": "Polar → Rect",
};

export function PolarCoordinatesOptions({
  layer,
  parentLayerName,
}: Props): React.JSX.Element {
  const { dispatch } = useAppContext();
  const p = layer.params;
  const update = (
    patch: Partial<PolarCoordinatesAdjustmentLayer["params"]>,
  ): void => {
    dispatch({
      type: "UPDATE_ADJUSTMENT_LAYER",
      payload: { ...layer, params: { ...layer.params, ...patch } },
    });
  };

  return (
    <div className={styles.content}>
      <DistortionSegmented
        label="Mode"
        options={MODES}
        value={p.mode}
        onChange={(v) => update({ mode: v })}
        formatLabel={(v) => MODE_LABEL[v]}
      />
      <DistortionSlider
        label="Center X"
        value={Math.round(p.centerX * 100)}
        min={0}
        max={100}
        onChange={(v) => update({ centerX: v / 100 })}
        suffix="%"
      />
      <DistortionSlider
        label="Center Y"
        value={Math.round(p.centerY * 100)}
        min={0}
        max={100}
        onChange={(v) => update({ centerY: v / 100 })}
        suffix="%"
      />
      <DistortionSegmented
        label="Edges"
        options={EDGE_MODES}
        value={p.edgeMode}
        onChange={(v) => update({ edgeMode: v })}
      />
      <div className={styles.footer}>
        <span className={styles.footerInfo}>
          <ParentConnectorIcon />
          Distorting <strong>{parentLayerName}</strong>
        </span>
        <button
          className={styles.resetBtn}
          onClick={() =>
            dispatch({
              type: "UPDATE_ADJUSTMENT_LAYER",
              payload: { ...layer, params: { ...DEFAULT_PARAMS } },
            })
          }
        >
          Reset
        </button>
      </div>
    </div>
  );
}
