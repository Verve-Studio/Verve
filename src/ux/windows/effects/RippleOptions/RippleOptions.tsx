import React from "react";
import { useAppContext } from "@/core/store/AppContext";
import type { RippleAdjustmentLayer } from "@/types";
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
  layer: RippleAdjustmentLayer;
  parentLayerName: string;
}

const DEFAULT_PARAMS = (
  ADJUSTMENT_REGISTRY as readonly AdjustmentRegistrationEntry[]
).find((e) => e.adjustmentType === "ripple")!
  .defaultParams as RippleAdjustmentLayer["params"];

const DIRECTIONS: RippleAdjustmentLayer["params"]["direction"][] = [
  "horizontal",
  "vertical",
  "both",
];

export function RippleOptions({
  layer,
  parentLayerName,
}: Props): React.JSX.Element {
  const { dispatch } = useAppContext();
  const p = layer.params;
  const update = (patch: Partial<RippleAdjustmentLayer["params"]>): void => {
    dispatch({
      type: "UPDATE_ADJUSTMENT_LAYER",
      payload: { ...layer, params: { ...layer.params, ...patch } },
    });
  };

  return (
    <div className={styles.content}>
      <DistortionSlider
        label="Amount"
        value={p.amount}
        min={-500}
        max={500}
        onChange={(v) => update({ amount: v })}
      />
      <DistortionSlider
        label="Size"
        value={p.size}
        min={1}
        max={100}
        onChange={(v) => update({ size: v })}
      />
      <DistortionSegmented
        label="Direction"
        options={DIRECTIONS}
        value={p.direction}
        onChange={(v) => update({ direction: v })}
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
          Rippling <strong>{parentLayerName}</strong>
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
