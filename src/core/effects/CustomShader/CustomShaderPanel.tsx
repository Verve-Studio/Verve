import React from "react";
import { useAppDispatch } from "@/core/store/AppContext";
import type { GraphArgument, ParamValue } from "@/core/nodes/graphTypes";
import { resolveArgumentValue } from "@/core/nodes/graphArguments";
import { DistortionSlider } from "@/core/effects/_shared/distortionShared";
import shared from "@/core/effects/_shared/distortionPanel.module.scss";
import { ColorSwatch } from "@/ux/widgets/ColorSwatch/ColorSwatch";
import { ParentConnectorIcon } from "@/ux/windows/ToolWindowIcons";
import type { CustomShaderEffectLayer } from "./CustomShaderEffect";
import { openShaderGraph } from "./openShaderGraph";
import styles from "./CustomShaderPanel.module.scss";

interface Props {
  layer: CustomShaderEffectLayer;
  parentLayerName: string;
}

const toHex = (c: readonly number[]): string =>
  `#${c
    .slice(0, 3)
    .map((x) => Math.round(Math.min(1, Math.max(0, x)) * 255).toString(16).padStart(2, "0"))
    .join("")}`;

const fromHex = (hex: string, alpha: number): [number, number, number, number] => {
  const n = parseInt(hex.slice(1), 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255, alpha];
};

/** A number with a slider when the argument has a full range, else a
 *  plain field (clamped to whichever bound exists). */
function NumberField({
  label,
  arg,
  value,
  onChange,
}: {
  label: string;
  arg: GraphArgument;
  value: number;
  onChange: (v: number) => void;
}): React.JSX.Element {
  const step = arg.type === "int" ? 1 : (arg.step ?? 0.01);
  if (arg.min !== undefined && arg.max !== undefined && arg.max > arg.min) {
    return (
      <DistortionSlider label={label} value={value} min={arg.min} max={arg.max} step={step} onChange={onChange} />
    );
  }
  return (
    <div className={shared.row}>
      <span className={shared.label}>{label}</span>
      <input
        type="number"
        className={`${shared.numInput} ${styles.wideNum}`}
        step={step}
        min={arg.min}
        max={arg.max}
        value={value}
        onChange={(e) => {
          const v = e.target.valueAsNumber;
          if (!Number.isNaN(v)) onChange(v);
        }}
      />
    </div>
  );
}

function ArgumentField({
  arg,
  value,
  onChange,
}: {
  arg: GraphArgument;
  value: ParamValue;
  onChange: (v: ParamValue) => void;
}): React.JSX.Element {
  switch (arg.type) {
    case "float":
    case "int":
      return <NumberField label={arg.name} arg={arg} value={Number(value)} onChange={onChange} />;
    case "bool":
      return (
        <label className={shared.row}>
          <span className={shared.label}>{arg.name}</span>
          <input type="checkbox" checked={value === true} onChange={(e) => onChange(e.target.checked)} />
        </label>
      );
    case "vec2": {
      const xy = value as readonly [number, number];
      return (
        <>
          <NumberField label={`${arg.name} X`} arg={arg} value={xy[0]} onChange={(x) => onChange([x, xy[1]])} />
          <NumberField label={`${arg.name} Y`} arg={arg} value={xy[1]} onChange={(y) => onChange([xy[0], y])} />
        </>
      );
    }
    case "color": {
      const c = value as readonly [number, number, number, number];
      return (
        <div className={shared.row}>
          <span className={shared.label}>{arg.name}</span>
          <ColorSwatch value={toHex(c)} title={arg.name} onChange={(hex) => onChange(fromHex(hex, c[3]))} />
        </div>
      );
    }
  }
}

/**
 * Settings window of a Custom Shader applied as an effect: one field per
 * argument the graph declares (range and default from the shader editor's
 * Arguments section), plus a way into the graph itself.
 */
export function CustomShaderPanel({ layer, parentLayerName }: Props): React.JSX.Element {
  const dispatch = useAppDispatch();
  const { graph, args } = layer.params;
  const declared = graph.arguments ?? [];
  const setArg = (id: string, value: ParamValue): void => {
    dispatch({
      type: "UPDATE_ADJUSTMENT_LAYER",
      payload: { ...layer, params: { ...layer.params, args: { ...args, [id]: value } } },
    });
  };

  return (
    <div className={shared.content}>
      {graph.info?.description && <p className={styles.description}>{graph.info.description}</p>}
      {declared.length === 0 ? (
        <p className={styles.empty}>This effect has no settings.</p>
      ) : (
        declared.map((a) => (
          <ArgumentField
            key={a.id}
            arg={a}
            value={resolveArgumentValue(a, args?.[a.id])}
            onChange={(v) => setArg(a.id, resolveArgumentValue(a, v))}
          />
        ))
      )}
      <button type="button" className={styles.editGraph} onClick={() => openShaderGraph(layer.id)}>
        Edit Shader Graph…
      </button>
      <div className={shared.footer}>
        <span className={shared.footerInfo}>
          <ParentConnectorIcon />
          Applied to <strong>{parentLayerName}</strong>
        </span>
        <button
          className={shared.resetBtn}
          disabled={declared.length === 0}
          onClick={() =>
            dispatch({
              type: "UPDATE_ADJUSTMENT_LAYER",
              payload: { ...layer, params: { ...layer.params, args: {} } },
            })
          }
        >
          Reset
        </button>
      </div>
    </div>
  );
}
