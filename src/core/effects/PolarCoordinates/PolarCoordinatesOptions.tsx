import React from "react";
import { useAppContext } from "@/core/store/AppContext";
import type { PolarCoordinatesEffectLayer } from "@/core/effects/PolarCoordinates/PolarCoordinatesEffect";
import { effectRegistry } from "@/core/effects";
import { ParentConnectorIcon } from "@/ux/windows/ToolWindowIcons";
import {
  DistortionSlider,
  DistortionSegmented,
  EDGE_MODES,
} from "@/core/effects/_shared/distortionShared";
import styles from "@/core/effects/_shared/distortionPanel.module.scss";

interface Props {
  layer: PolarCoordinatesEffectLayer;
  parentLayerName: string;
}

const getDefaultParams = (): PolarCoordinatesEffectLayer["params"] =>
  effectRegistry.get("polar-coordinates")!.defaultParams as PolarCoordinatesEffectLayer["params"];

const MODES: PolarCoordinatesEffectLayer["params"]["mode"][] = [
  "rect-to-polar",
  "polar-to-rect",
];

const MODE_LABEL: Record<
  PolarCoordinatesEffectLayer["params"]["mode"],
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
    patch: Partial<PolarCoordinatesEffectLayer["params"]>,
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
