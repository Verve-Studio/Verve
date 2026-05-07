import React from "react";
import { useAppContext } from "@/core/store/AppContext";
import type { DisplaceAdjustmentLayer } from "@/types";
import { effectRegistry } from "@/core/effects";
import { ParentConnectorIcon } from "@/ux/windows/ToolWindowIcons";
import {
  DistortionSlider,
  DistortionSegmented,
  EDGE_MODES,
} from "@/core/effects/_shared/distortionShared";
import styles from "@/core/effects/_shared/distortionPanel.module.scss";

interface Props {
  layer: DisplaceAdjustmentLayer;
  parentLayerName: string;
}

const getDefaultParams = (): DisplaceAdjustmentLayer["params"] =>
  effectRegistry.get("displace")!.defaultParams as DisplaceAdjustmentLayer["params"];

export function DisplaceOptions({
  layer,
  parentLayerName,
}: Props): React.JSX.Element {
  const { dispatch } = useAppContext();
  const p = layer.params;
  const update = (patch: Partial<DisplaceAdjustmentLayer["params"]>): void => {
    dispatch({
      type: "UPDATE_ADJUSTMENT_LAYER",
      payload: { ...layer, params: { ...layer.params, ...patch } },
    });
  };

  return (
    <div className={styles.content}>
      <DistortionSlider
        label="H Scale"
        value={p.horizontalScale}
        min={-200}
        max={200}
        onChange={(v) => update({ horizontalScale: v })}
        suffix="px"
      />
      <DistortionSlider
        label="V Scale"
        value={p.verticalScale}
        min={-200}
        max={200}
        onChange={(v) => update({ verticalScale: v })}
        suffix="px"
      />
      <DistortionSlider
        label="Frequency"
        value={p.noiseFrequency}
        min={1}
        max={200}
        onChange={(v) => update({ noiseFrequency: v })}
      />
      <DistortionSlider
        label="Seed"
        value={p.seed}
        min={0}
        max={9999}
        onChange={(v) => update({ seed: v })}
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
          Displacing <strong>{parentLayerName}</strong>
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
