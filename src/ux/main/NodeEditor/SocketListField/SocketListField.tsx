import React, { memo } from "react";
import type { SocketDecl, SocketDirection } from "@/core/nodes/graphTypes";
import type { PortType, SubgraphSpec } from "@/core/nodes/INode";
import { PORT_COLORS } from "@/core/nodes/portTypes";
import { newSocketId } from "@/core/nodes/subgraphs";
import styles from "./SocketListField.module.scss";

const TYPE_LABELS: Partial<Record<PortType, string>> = {
  float: "Float",
  int: "Integer",
  bool: "Boolean",
  vec2: "Vector",
  vec3: "Vector 3",
  color: "Color",
  string: "Text",
  layer: "Layer",
};

const DIRECTION_LABELS: Record<SocketDirection, string> = {
  in: "In",
  out: "Out",
  both: "In / Out",
};

interface SocketListFieldProps {
  spec: SubgraphSpec;
  sockets: readonly SocketDecl[];
  onChange: (sockets: readonly SocketDecl[]) => void;
}

/** Edits a subgraph's interface: one row per socket (name, type,
 *  direction when the kind allows several, remove) and an add row. */
export const SocketListField = memo(function SocketListField({
  spec,
  sockets,
  onChange,
}: SocketListFieldProps): React.JSX.Element {
  const update = (i: number, patch: Partial<SocketDecl>): void =>
    onChange(sockets.map((s, k) => (k === i ? { ...s, ...patch } : s)));
  const add = (): void => {
    const taken = new Set(sockets.map((s) => s.name));
    let n = sockets.length + 1;
    while (taken.has(`Value ${n}`)) n++;
    onChange([
      ...sockets,
      { id: newSocketId(), name: `Value ${n}`, type: spec.types[0], direction: spec.directions[0] },
    ]);
  };

  return (
    <div className={styles.list} data-nodrag>
      {sockets.map((s, i) => (
        <div key={s.id} className={styles.row}>
          <span className={styles.dot} style={{ background: PORT_COLORS[s.type] }} />
          <input
            // Re-mount on outside renames (undo) so the field shows them.
            key={s.name}
            className={styles.name}
            defaultValue={s.name}
            spellCheck={false}
            title="Rename"
            onBlur={(e) => {
              const name = e.currentTarget.value.trim();
              if (name && name !== s.name) update(i, { name });
              else e.currentTarget.value = s.name;
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter") e.currentTarget.blur();
            }}
          />
          <select
            className={styles.select}
            value={s.type}
            title="Type"
            onChange={(e) => update(i, { type: e.target.value as PortType })}
          >
            {spec.types.map((t) => (
              <option key={t} value={t}>
                {TYPE_LABELS[t] ?? t}
              </option>
            ))}
          </select>
          {spec.directions.length > 1 && (
            <select
              className={styles.select}
              value={s.direction}
              title="Direction"
              onChange={(e) => update(i, { direction: e.target.value as SocketDirection })}
            >
              {spec.directions.map((d) => (
                <option key={d} value={d}>
                  {DIRECTION_LABELS[d]}
                </option>
              ))}
            </select>
          )}
          <button
            type="button"
            className={styles.remove}
            title={`Remove ${s.name}`}
            aria-label={`Remove ${s.name}`}
            onClick={() => onChange(sockets.filter((_, k) => k !== i))}
          >
            ×
          </button>
        </div>
      ))}
      <button type="button" className={styles.add} onClick={add}>
        + Add to {spec.socketsLabel.toLowerCase()}
      </button>
    </div>
  );
});
