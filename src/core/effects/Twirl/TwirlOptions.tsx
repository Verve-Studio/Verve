import React from "react";
import { useAppContext } from "@/core/store/AppContext";
import type { TwirlEffectLayer } from "@/core/effects/Twirl/TwirlEffect";
import { effectRegistry } from "@/core/effects";
import { ParentConnectorIcon } from "@/ux/windows/ToolWindowIcons";
import {
  DistortionSlider,
  DistortionSegmented,
  EDGE_MODES,
} from "@/core/effects/_shared/distortionShared";
import styles from "@/core/effects/_shared/distortionPanel.module.scss";

interface Props {
  layer: TwirlEffectLayer;
  parentLayerName: string;
}

const getDefaultParams = (): TwirlEffectLayer["params"] =>
  effectRegistry.get("twirl")!.defaultParams as TwirlEffectLayer["params"];

export function TwirlOptions({
  layer,
  parentLayerName,
}: Props): React.JSX.Element {
  const { dispatch } = useAppContext();
  const p = layer.params;
  const update = (patch: Partial<TwirlEffectLayer["params"]>): void => {
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
