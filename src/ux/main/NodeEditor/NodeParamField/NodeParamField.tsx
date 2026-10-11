import React, { memo, useEffect, useRef, useState } from "react";
import { isKernelValue, type KernelValue, type ParamValue } from "@/core/nodes/graphTypes";
import type { ParamSpec } from "@/core/nodes/INode";
import { ColorSwatch } from "@/ux/widgets/ColorSwatch/ColorSwatch";
import styles from "./NodeParamField.module.scss";

interface NodeParamFieldProps {
  label: string;
  spec: ParamSpec;
  value: ParamValue | undefined;
  onChange: (value: ParamValue) => void;
}

/** Inline editor for a node parameter or an unconnected input. Carries
 *  `data-nodrag` so pointer-downs on it don't start a node drag. */
export const NodeParamField = memo(function NodeParamField({
  label,
  spec,
  value,
  onChange,
}: NodeParamFieldProps): React.JSX.Element {
  const v = value ?? spec.default;
  switch (spec.kind) {
    case "float":
    case "int":
      return (
        <ScrubField
          label={label}
          value={typeof v === "number" ? v : spec.default}
          min={spec.min}
          max={spec.max}
          step={spec.kind === "int" ? 1 : (spec.step ?? 0.01)}
          integer={spec.kind === "int"}
          onChange={onChange}
        />
      );
    case "bool":
      return (
        <label className={styles.check} data-nodrag>
          <input
            type="checkbox"
            checked={v === true}
            onChange={(e) => onChange(e.target.checked)}
          />
          <span>{label}</span>
        </label>
      );
    case "enum":
      return (
        <select
          className={styles.select}
          data-nodrag
          title={label}
          value={String(v)}
          onChange={(e) => onChange(e.target.value)}
        >
          {spec.options.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
      );
    case "color": {
      const c = Array.isArray(v) && v.length === 4 ? v : spec.default;
      return (
        <div className={styles.labeled} data-nodrag>
          <span className={styles.label}>{label}</span>
          <ColorSwatch
            className={styles.swatch}
            value={toHex(c)}
            title={label}
            onChange={(hex) => onChange([...fromHex(hex), c[3]] as const)}
          />
        </div>
      );
    }
    case "vec2": {
      const xy = Array.isArray(v) && v.length === 2 ? v : spec.default;
      const step = spec.step ?? 0.01;
      return (
        <div className={styles.pair}>
          <ScrubField
            label="X"
            value={xy[0]}
            step={step}
            onChange={(x) => onChange([x, xy[1]] as const)}
          />
          <ScrubField
            label="Y"
            value={xy[1]}
            step={step}
            onChange={(y) => onChange([xy[0], y] as const)}
          />
        </div>
      );
    }
    case "kernel":
      return (
        <KernelField
          spec={spec}
          value={isKernelValue(v) ? v : spec.default}
          onChange={onChange}
        />
      );
    case "string":
      return (
        <div className={styles.labeled} data-nodrag>
          <span className={styles.label}>{label}</span>
          <input
            className={styles.text}
            type="text"
            value={String(v)}
            placeholder={spec.placeholder}
            spellCheck={false}
            onChange={(e) => onChange(e.target.value)}
          />
        </div>
      );
  }
});

// ─── Kernel grid ──────────────────────────────────────────────────────────────

/** Re-centre `weights` (size `from`) in a `to × to` grid, cropping or
 *  padding with zeros. */
function resizeKernel(k: KernelValue, to: number): KernelValue {
  const off = (to - k.size) / 2;
  const weights: number[] = [];
  for (let y = 0; y < to; y++) {
    for (let x = 0; x < to; x++) {
      const sx = x - off;
      const sy = y - off;
      const inside = sx >= 0 && sy >= 0 && sx < k.size && sy < k.size;
      weights.push(inside ? (k.weights[sy * k.size + sx] ?? 0) : 0);
    }
  }
  return { size: to, weights };
}

function KernelField({
  spec,
  value,
  onChange,
}: {
  spec: Extract<ParamSpec, { kind: "kernel" }>;
  value: KernelValue;
  onChange: (value: ParamValue) => void;
}): React.JSX.Element {
  const { size, weights } = value;
  const setWeight = (i: number, text: string): void => {
    const n = Number(text.trim().replace(",", "."));
    if (!Number.isFinite(n) || n === weights[i]) return;
    const next = [...weights];
    next[i] = n;
    onChange({ size, weights: next });
  };
  return (
    <div className={styles.kernel} data-nodrag>
      <div className={styles.kernelBar}>
        <select
          className={styles.select}
          title="Kernel size"
          value={size}
          onChange={(e) => onChange(resizeKernel(value, Number(e.target.value)))}
        >
          {spec.sizes.map((n) => (
            <option key={n} value={n}>
              {n} × {n}
            </option>
          ))}
        </select>
        {spec.presets && (
          <select
            className={styles.select}
            title="Load a preset"
            value=""
            onChange={(e) => {
              const preset = spec.presets![Number(e.target.value)];
              if (preset) onChange({ size, weights: preset.build(size) });
            }}
          >
            <option value="" disabled>
              Preset…
            </option>
            {spec.presets.map((p, i) => (
              <option key={p.label} value={i}>
                {p.label}
              </option>
            ))}
          </select>
        )}
      </div>
      <div className={styles.kernelGrid} style={{ gridTemplateColumns: `repeat(${size}, 1fr)` }}>
        {weights.map((w, i) => (
          <input
            // Re-mount when the value changes from outside (preset, undo).
            key={`${i}:${w}`}
            className={styles.kernelCell}
            defaultValue={+w.toFixed(4)}
            spellCheck={false}
            onBlur={(e) => setWeight(i, e.currentTarget.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") e.currentTarget.blur();
            }}
          />
        ))}
      </div>
    </div>
  );
}

// ─── Scrub field ──────────────────────────────────────────────────────────────

interface ScrubFieldProps {
  label: string;
  value: number;
  min?: number;
  max?: number;
  step: number;
  integer?: boolean;
  onChange: (value: number) => void;
}

/** Drag horizontally to change the value (Shift = fine); click without
 *  dragging to type a value. Shows a fill bar when the range is bounded. */
function ScrubField({
  label,
  value,
  min,
  max,
  step,
  integer,
  onChange,
}: ScrubFieldProps): React.JSX.Element {
  const [editing, setEditing] = useState(false);
  const drag = useRef<{ x: number; start: number; moved: boolean } | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (editing) inputRef.current?.select();
  }, [editing]);

  const clamp = (n: number): number => {
    let r = integer ? Math.round(n) : n;
    if (min !== undefined) r = Math.max(min, r);
    if (max !== undefined) r = Math.min(max, r);
    return r;
  };

  const commitText = (text: string): void => {
    setEditing(false);
    const n = Number(text.trim().replace(",", "."));
    if (Number.isFinite(n)) onChange(clamp(n));
  };

  if (editing) {
    return (
      <input
        ref={inputRef}
        className={styles.scrubInput}
        data-nodrag
        defaultValue={formatNumber(value, integer)}
        onBlur={(e) => commitText(e.currentTarget.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") commitText(e.currentTarget.value);
          else if (e.key === "Escape") setEditing(false);
        }}
      />
    );
  }

  const bounded = min !== undefined && max !== undefined && max > min;
  const fill = bounded ? ((value - min) / (max - min)) * 100 : 0;

  return (
    <div
      className={styles.scrub}
      data-nodrag
      style={bounded ? { "--fill": `${fill}%` } as React.CSSProperties : undefined}
      onPointerDown={(e) => {
        if (e.button !== 0) return;
        e.currentTarget.setPointerCapture(e.pointerId);
        drag.current = { x: e.clientX, start: value, moved: false };
      }}
      onPointerMove={(e) => {
        const d = drag.current;
        if (!d) return;
        const dx = e.clientX - d.x;
        if (!d.moved && Math.abs(dx) < 3) return;
        d.moved = true;
        onChange(clamp(d.start + dx * step * (e.shiftKey ? 0.1 : 1)));
      }}
      onPointerUp={() => {
        const d = drag.current;
        drag.current = null;
        if (d && !d.moved) setEditing(true);
      }}
      onPointerCancel={() => {
        drag.current = null;
      }}
    >
      {bounded && <span className={styles.fill} />}
      <span className={styles.label}>{label}</span>
      <span className={styles.value}>{formatNumber(value, integer)}</span>
    </div>
  );
}

function formatNumber(n: number, integer?: boolean): string {
  if (integer) return String(Math.round(n));
  return Math.abs(n) >= 1000 ? n.toFixed(0) : n.toFixed(3);
}

function toHex(c: readonly number[]): string {
  const h = (x: number): string =>
    Math.round(Math.min(1, Math.max(0, x)) * 255)
      .toString(16)
      .padStart(2, "0");
  return `#${h(c[0])}${h(c[1])}${h(c[2])}`;
}

function fromHex(hex: string): [number, number, number] {
  const n = parseInt(hex.replace("#", ""), 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}
