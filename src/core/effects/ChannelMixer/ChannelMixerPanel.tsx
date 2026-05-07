import React from "react";
import { useAppContext } from "@/core/store/AppContext";
import type { ChannelMixerEffectLayer } from "@/core/effects/ChannelMixer/ChannelMixerEffect";
import { effectRegistry } from "@/core/effects";
import { ParentConnectorIcon } from "@/ux/windows/ToolWindowIcons";
import styles from "./ChannelMixerPanel.module.scss";

// ─── Props ────────────────────────────────────────────────────────────────────

interface ChannelMixerPanelProps {
  layer: ChannelMixerEffectLayer;
  parentLayerName: string;
}

const getDefaultParams = (): ChannelMixerEffectLayer["params"] =>
  effectRegistry.get("channel-mixer")!.defaultParams as ChannelMixerEffectLayer["params"];

type OutputChannel = ChannelMixerEffectLayer["params"]["outputChannel"];
type SourceKey = "red" | "green" | "blue" | "constant";

// ─── Component ────────────────────────────────────────────────────────────────

export function ChannelMixerPanel({
  layer,
  parentLayerName,
}: ChannelMixerPanelProps): React.JSX.Element {
  const { dispatch } = useAppContext();
  const { monochrome, outputChannel } = layer.params;

  // When monochrome is on, sliders always edit the gray row, regardless
  // of outputChannel. The dropdown is locked to "gray" for clarity.
  const activeKey: OutputChannel = monochrome ? "gray" : outputChannel;
  const row = layer.params[activeKey];

  const updateParams = (
    next: Partial<ChannelMixerEffectLayer["params"]>,
  ): void => {
    dispatch({
      type: "UPDATE_ADJUSTMENT_LAYER",
      payload: { ...layer, params: { ...layer.params, ...next } },
    });
  };

  const updateRow = (key: SourceKey, value: number): void => {
    updateParams({ [activeKey]: { ...row, [key]: value } } as Partial<
      ChannelMixerEffectLayer["params"]
    >);
  };

  const pct = (v: number, min: number, max: number): string =>
    String((v - min) / (max - min));

  const total = row.red + row.green + row.blue;
  const totalWarn = Math.abs(total - 100) > 0.5;

  const sourceRow = (key: "red" | "green" | "blue", labelText: string) => (
    <div className={styles.row}>
      <span className={styles.label}>{labelText}</span>
      <div className={styles.trackWrap}>
        <input
          type="range"
          className={styles.track}
          min={-200}
          max={200}
          step={1}
          value={row[key]}
          style={{ "--pct": pct(row[key], -200, 200) } as React.CSSProperties}
          onChange={(e) => updateRow(key, Number(e.target.value))}
        />
      </div>
      <input
        type="number"
        className={styles.numInput}
        min={-200}
        max={200}
        step={1}
        value={row[key]}
        onChange={(e) => {
          const v = e.target.valueAsNumber;
          if (!isNaN(v))
            updateRow(key, Math.min(200, Math.max(-200, Math.round(v))));
        }}
      />
    </div>
  );

  return (
    <div className={styles.content}>
      <div className={styles.headerRow}>
        <span className={styles.headerLabel}>Output</span>
        <select
          className={styles.select}
          value={activeKey}
          disabled={monochrome}
          onChange={(e) =>
            updateParams({ outputChannel: e.target.value as OutputChannel })
          }
        >
          <option value="red">Red</option>
          <option value="green">Green</option>
          <option value="blue">Blue</option>
          {monochrome && <option value="gray">Gray</option>}
        </select>
      </div>

      <div className={styles.monoRow}>
        <input
          id={`cm-mono-${layer.id}`}
          type="checkbox"
          checked={monochrome}
          onChange={(e) => updateParams({ monochrome: e.target.checked })}
        />
        <label htmlFor={`cm-mono-${layer.id}`}>Monochrome</label>
      </div>

      <div className={styles.divider} />

      {sourceRow("red", "Red")}
      {sourceRow("green", "Green")}
      {sourceRow("blue", "Blue")}

      <div className={`${styles.totalRow}${totalWarn ? ` ${styles.warn}` : ""}`}>
        Total: {Math.round(total)}%
      </div>

      <div className={styles.row}>
        <span className={styles.label}>Constant</span>
        <div className={styles.trackWrap}>
          <input
            type="range"
            className={styles.track}
            min={-200}
            max={200}
            step={1}
            value={row.constant}
            style={
              { "--pct": pct(row.constant, -200, 200) } as React.CSSProperties
            }
            onChange={(e) => updateRow("constant", Number(e.target.value))}
          />
        </div>
        <input
          type="number"
          className={styles.numInput}
          min={-200}
          max={200}
          step={1}
          value={row.constant}
          onChange={(e) => {
            const v = e.target.valueAsNumber;
            if (!isNaN(v))
              updateRow(
                "constant",
                Math.min(200, Math.max(-200, Math.round(v))),
              );
          }}
        />
      </div>

      <div className={styles.footer}>
        <span className={styles.footerInfo}>
          <ParentConnectorIcon />
          Adjusting <strong>{parentLayerName}</strong>
        </span>
        <button
          className={styles.resetBtn}
          onClick={() =>
            dispatch({
              type: "UPDATE_ADJUSTMENT_LAYER",
              payload: { ...layer, params: getDefaultParams() },
            })
          }
          title="Reset to defaults"
        >
          Reset
        </button>
      </div>
    </div>
  );
}
