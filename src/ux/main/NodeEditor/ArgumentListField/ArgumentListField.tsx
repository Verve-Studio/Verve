import React from "react";
import type { ArgumentType, GraphArgument } from "@/core/nodes/graphTypes";
import {
  ARGUMENT_TYPES,
  argumentSpec,
  defaultArgumentValue,
  isNumericArgument,
  newArgumentId,
  resolveArgumentValue,
} from "@/core/nodes/graphArguments";
import { PORT_COLORS } from "@/core/nodes/portTypes";
import { NodeParamField } from "../NodeParamField/NodeParamField";
import styles from "./ArgumentListField.module.scss";

interface ArgumentListFieldProps {
  args: readonly GraphArgument[];
  onChange: (args: readonly GraphArgument[]) => void;
}

/** Optional number: empty = unset. Commits on blur / Enter. */
function OptionalNumber({
  label,
  value,
  onCommit,
}: {
  label: string;
  value: number | undefined;
  onCommit: (v: number | undefined) => void;
}): React.JSX.Element {
  return (
    <label className={styles.bound}>
      <span>{label}</span>
      <input
        key={String(value)}
        className={styles.boundInput}
        defaultValue={value ?? ""}
        placeholder="—"
        spellCheck={false}
        onBlur={(e) => {
          const text = e.currentTarget.value.trim().replace(",", ".");
          const n = text === "" ? undefined : Number(text);
          if (n !== undefined && !Number.isFinite(n)) {
            e.currentTarget.value = value === undefined ? "" : String(value);
            return;
          }
          if (n !== value) onCommit(n);
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter") e.currentTarget.blur();
        }}
      />
    </label>
  );
}

/**
 * Edits a shader graph's effect arguments: name, type, default value and,
 * for numbers and vectors, the allowed range and slider step. Each argument
 * becomes a socket on the Layer Input node and a field in the effect's
 * settings window.
 */
export function ArgumentListField({ args, onChange }: ArgumentListFieldProps): React.JSX.Element {
  const update = (i: number, patch: Partial<GraphArgument>): void => {
    onChange(
      args.map((a, k) => {
        if (k !== i) return a;
        const next = { ...a, ...patch };
        // Keep the range ordered and the default inside it.
        if (next.min !== undefined && next.max !== undefined && next.min > next.max) {
          [next.min, next.max] = [next.max, next.min];
        }
        return { ...next, default: resolveArgumentValue(next, next.default) };
      }),
    );
  };
  const setType = (i: number, type: ArgumentType): void =>
    onChange(
      args.map((a, k) =>
        k === i ? { id: a.id, name: a.name, type, default: defaultArgumentValue(type) } : a,
      ),
    );
  const add = (): void => {
    // First free name: "Amount", "Amount 2", "Amount 3", …
    const taken = new Set(args.map((a) => a.name));
    let name = "Amount";
    for (let n = 2; taken.has(name); n++) name = `Amount ${n}`;
    onChange([
      ...args,
      { id: newArgumentId(), name, type: "float", default: 0.5, min: 0, max: 1 },
    ]);
  };

  return (
    <div className={styles.list}>
      {args.map((a, i) => (
        <div key={a.id} className={styles.arg}>
          <div className={styles.head}>
            <label className={styles.nameBox}>
              <span className={styles.dot} style={{ background: PORT_COLORS[a.type] }} />
              <input
                key={a.name}
                className={styles.name}
                defaultValue={a.name}
                spellCheck={false}
                aria-label="Argument name"
                onBlur={(e) => {
                  const name = e.currentTarget.value.trim();
                  if (name && name !== a.name) update(i, { name });
                  else e.currentTarget.value = a.name;
                }}
                onKeyDown={(e) => {
                  if (e.key === "Enter") e.currentTarget.blur();
                }}
              />
            </label>
            <select
              className={styles.type}
              value={a.type}
              aria-label="Argument type"
              onChange={(e) => setType(i, e.target.value as ArgumentType)}
            >
              {ARGUMENT_TYPES.map((t) => (
                <option key={t.type} value={t.type}>
                  {t.label}
                </option>
              ))}
            </select>
            <button
              type="button"
              className={styles.remove}
              aria-label={`Remove ${a.name}`}
              title={`Remove ${a.name}`}
              onClick={() => onChange(args.filter((_, k) => k !== i))}
            >
              ×
            </button>
          </div>
          <NodeParamField
            label="Default"
            spec={argumentSpec(a)}
            value={a.default}
            onChange={(v) => update(i, { default: v })}
          />
          {isNumericArgument(a) && (
            <div className={styles.bounds}>
              <OptionalNumber label="Min" value={a.min} onCommit={(min) => update(i, { min })} />
              <OptionalNumber label="Max" value={a.max} onCommit={(max) => update(i, { max })} />
              {a.type !== "int" && (
                <OptionalNumber label="Step" value={a.step} onCommit={(step) => update(i, { step })} />
              )}
            </div>
          )}
        </div>
      ))}
      <button type="button" className={styles.add} onClick={add}>
        + Add argument
      </button>
    </div>
  );
}
