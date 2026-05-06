import React from "react";
import { useAppContext } from "@/core/store/AppContext";
import type { TwirlAdjustmentLayer } from "@/types";
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
  layer: TwirlAdjustmentLayer;
  parentLayerName: string;
}

const DEFAULT_PARAMS = (
  ADJUSTMENT_REGISTRY as readonly AdjustmentRegistrationEntry[]
).find((e) => e.adjustmentType === "twirl")!
  .defaultParams as TwirlAdjustmentLayer["params"];

export function TwirlOptions({
  layer,
  parentLayerName,
}: Props): React.JSX.Element {
  const { dispatch } = useAppContext();
  const p = layer.params;
  const update = (patch: Partial<TwirlAdjustmentLayer["params"]>): void => {
    dispatch({
      type: "UPDATE_ADJUSTMENT_LAYER",
      payload: { ...layer, params: { ...layer.params, ...patch } },
    });
  };

  return (
    <div className={styles.content}>
      <DistortionSlider
        label="Angle"
        value={p.angle}
        min={-1080}
        max={1080}
        onChange={(v) => update({ angle: v })}
        suffix="°"
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
          Twirling <strong>{parentLayerName}</strong>
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
