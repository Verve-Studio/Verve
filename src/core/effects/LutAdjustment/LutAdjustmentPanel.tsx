import React, { useEffect, useState } from "react";
import { useAppContext } from "@/core/store/AppContext";
import type { LutAdjustmentEffectLayer } from "./LutAdjustmentEffect";
import { ParentConnectorIcon } from "@/ux/windows/ToolWindowIcons";
import { lutStore } from "@/core/lut";
import type { LutTransform } from "@/core/lut";
import { LutSelectOptions } from "@/core/lut/lutSelectOptions";
import styles from "./LutAdjustmentPanel.module.scss";

interface LutAdjustmentPanelProps {
  layer: LutAdjustmentEffectLayer;
  parentLayerName: string;
}

function useLutList(): LutTransform[] {
  const [list, setList] = useState<LutTransform[]>(() => lutStore.all());
  useEffect(() => lutStore.subscribe(() => setList(lutStore.all())), []);
  return list;
}

const DEFAULT_PARAMS: LutAdjustmentEffectLayer["params"] = {
  lutId: "",
  intensity: 100,
};

export function LutAdjustmentPanel({
  layer,
  parentLayerName,
}: LutAdjustmentPanelProps): React.JSX.Element {
  const { dispatch } = useAppContext();
  const { lutId, intensity } = layer.params;
  const luts = useLutList();

  const updateParams = (
    patch: Partial<LutAdjustmentEffectLayer["params"]>,
  ): void => {
    dispatch({
      type: "UPDATE_ADJUSTMENT_LAYER",
      payload: { ...layer, params: { ...layer.params, ...patch } },
    });
  };

  const handleReset = (): void => updateParams(DEFAULT_PARAMS);

  return (
    <div className={styles.content}>
      <div className={styles.row}>
        <label className={styles.label}>LUT</label>
        <select
          className={styles.select}
          value={lutId}
          onChange={(e) => updateParams({ lutId: e.target.value })}
        >
          <option value="">— None —</option>
          <LutSelectOptions luts={luts} />
        </select>
      </div>

      <div className={styles.row}>
        <label className={styles.label}>Intensity</label>
        <div
          className={styles.trackWrap}
          style={
            {
              ["--pct" as string]: String(intensity / 100),
            } as React.CSSProperties
          }
        >
          <input
            type="range"
            min={0}
            max={100}
            step={1}
            value={intensity}
            onChange={(e) =>
              updateParams({ intensity: Number(e.target.value) })
            }
            className={styles.track}
          />
        </div>
        <input
          type="number"
          min={0}
          max={100}
          value={intensity}
          onChange={(e) =>
            updateParams({
              intensity: Math.min(
                100,
                Math.max(0, Math.round(Number(e.target.value) || 0)),
              ),
            })
          }
          className={styles.numInput}
        />
      </div>

      <div className={styles.footer}>
        <span className={styles.footerInfo}>
          <ParentConnectorIcon />
          Adjusting <strong>{parentLayerName}</strong>
        </span>
        <button className={styles.resetBtn} onClick={handleReset}>
          Reset
        </button>
      </div>
    </div>
  );
}
