import React from "react";
import { useAppContext } from "@/core/store/AppContext";
import type { ShearAdjustmentLayer } from "@/types";
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
  layer: ShearAdjustmentLayer;
  parentLayerName: string;
}

const DEFAULT_PARAMS = (
  ADJUSTMENT_REGISTRY as readonly AdjustmentRegistrationEntry[]
).find((e) => e.adjustmentType === "shear")!
  .defaultParams as ShearAdjustmentLayer["params"];

const DIRECTIONS: ShearAdjustmentLayer["params"]["direction"][] = [
  "horizontal",
  "vertical",
];

export function ShearOptions({
  layer,
  parentLayerName,
}: Props): React.JSX.Element {
  const { dispatch } = useAppContext();
  const p = layer.params;
  const update = (patch: Partial<ShearAdjustmentLayer["params"]>): void => {
    dispatch({
      type: "UPDATE_ADJUSTMENT_LAYER",
      payload: { ...layer, params: { ...layer.params, ...patch } },
    });
  };

  return (
    <div className={styles.content}>
      <DistortionSlider
        label="Amplitude"
        value={p.amplitude}
        min={-500}
        max={500}
        onChange={(v) => update({ amplitude: v })}
        suffix="px"
      />
      <DistortionSegmented
        label="Direction"
        options={DIRECTIONS}
        value={p.direction}
        onChange={(v) => update({ direction: v })}
      />
      <DistortionSlider
        label="Wave Freq"
        value={p.waveFrequency}
        min={0}
        max={10}
        step={1}
        onChange={(v) => update({ waveFrequency: v })}
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
          Shearing <strong>{parentLayerName}</strong>
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
