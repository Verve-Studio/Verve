import React from "react";
import { useAppContext } from "@/core/store/AppContext";
import type { PinchAdjustmentLayer } from "@/types";
import { effectRegistry } from "@/core/effects";
import { ParentConnectorIcon } from "@/ux/windows/ToolWindowIcons";
import {
  DistortionSlider,
  DistortionSegmented,
  EDGE_MODES,
} from "../distortionShared";
import styles from "../distortionPanel.module.scss";

interface Props {
  layer: PinchAdjustmentLayer;
  parentLayerName: string;
}

const getDefaultParams = (): PinchAdjustmentLayer["params"] =>
  effectRegistry.get("pinch")!.defaultParams as PinchAdjustmentLayer["params"];

export function PinchOptions({
  layer,
  parentLayerName,
}: Props): React.JSX.Element {
  const { dispatch } = useAppContext();
  const p = layer.params;
  const update = (patch: Partial<PinchAdjustmentLayer["params"]>): void => {
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
        min={-100}
        max={100}
        onChange={(v) => update({ amount: v })}
        suffix="%"
      />
      <DistortionSlider
        label="Radius"
        value={Math.round(p.radius * 100)}
        min={5}
        max={100}
        onChange={(v) => update({ radius: v / 100 })}
        suffix="%"
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
          Pinching <strong>{parentLayerName}</strong>
        </span>
        <button
          className={styles.resetBtn}
          onClick={() =>
            dispatch({
              type: "UPDATE_ADJUSTMENT_LAYER",
              payload: { ...layer, params: { ...getDefaultParams() } },
            })
          }
        >
          Reset
        </button>
      </div>
    </div>
  );
}
