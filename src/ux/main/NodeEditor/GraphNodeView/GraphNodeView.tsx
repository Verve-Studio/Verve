import React, { memo } from "react";
import type { GraphNode, ParamValue, SocketDecl } from "@/core/nodes/graphTypes";
import type { INode, PortDef } from "@/core/nodes/INode";
import { PORT_COLORS } from "@/core/nodes/portTypes";
import { NodeParamField } from "../NodeParamField/NodeParamField";
import { SocketListField } from "../SocketListField/SocketListField";
import { BODY_PAD, HEADER_H, ROW_H, categoryColor, type NodeLayout } from "../nodeLayout";
import styles from "./GraphNodeView.module.scss";

interface GraphNodeViewProps {
  node: GraphNode;
  def: INode;
  /** Layout for the node in its graph (cached, so stable across renders). */
  layout: NodeLayout;
  title: string;
  selected: boolean;
  /** Flag the node as the cause of a compile error. */
  error: boolean;
  /** Comma-joined ids of this node's connected inputs (a string so the
   *  memo comparison stays cheap and stable). */
  connectedInputs: string;
  onParamChange: (nodeId: string, key: string, value: ParamValue) => void;
  /** Subgraph nodes: interface edits and opening the body. */
  onSocketsChange: (nodeId: string, sockets: readonly SocketDecl[]) => void;
  onOpenBody: (nodeId: string) => void;
}

/**
 * One node. Purely presentational: pointer interaction is handled by
 * `NodeCanvas` through the `data-node-id` / `data-port-*` attributes.
 */
export const GraphNodeView = memo(function GraphNodeView({
  node,
  def,
  layout,
  title,
  selected,
  error,
  connectedInputs,
  onParamChange,
  onSocketsChange,
  onOpenBody,
}: GraphNodeViewProps): React.JSX.Element {
  const connected = new Set(connectedInputs ? connectedInputs.split(",") : []);

  return (
    <div
      className={[styles.node, selected && styles.selected, error && styles.error]
        .filter(Boolean)
        .join(" ")}
      data-node-id={node.id}
      style={{ left: node.x, top: node.y, width: layout.width }}
      title={def.description}
    >
      <div
        className={styles.header}
        style={{ height: HEADER_H, background: categoryColor(def.category) }}
      >
        <span className={styles.title}>{title}</span>
        {def.subgraph && (
          <button
            type="button"
            className={styles.open}
            data-nodrag
            title="Open (double-click the node)"
            aria-label={`Open ${title}`}
            onClick={() => onOpenBody(node.id)}
          >
            ⤢
          </button>
        )}
      </div>
      <div className={styles.body} style={{ paddingBlock: BODY_PAD }}>
        {layout.rows.map((row) => {
          if (row.kind === "sockets") {
            return (
              <div key="sockets" className={styles.row} style={{ height: ROW_H * row.rows }}>
                <SocketListField
                  spec={def.subgraph!}
                  sockets={node.body?.subgraph?.sockets ?? []}
                  onChange={(sockets) => onSocketsChange(node.id, sockets)}
                />
              </div>
            );
          }
          if (row.kind === "param") {
            const p = row.param;
            return (
              <div key={`p:${p.id}`} className={styles.row} style={{ height: ROW_H * row.rows }}>
                <NodeParamField
                  label={p.label}
                  spec={p.spec}
                  value={node.params[p.id]}
                  onChange={(v) => onParamChange(node.id, p.id, v)}
                />
              </div>
            );
          }
          const { input, output } = row;
          return (
            <div
              key={`${input?.id ?? ""}|${output?.id ?? ""}`}
              className={styles.row}
              style={{ height: ROW_H }}
            >
              {input && (
                <>
                  <Socket nodeId={node.id} side="in" port={input} />
                  {input.value && !connected.has(input.id) ? (
                    <NodeParamField
                      label={input.label}
                      spec={input.value}
                      value={node.params[input.id]}
                      onChange={(v) => onParamChange(node.id, input.id, v)}
                    />
                  ) : (
                    <span className={styles.inLabel}>{input.label}</span>
                  )}
                </>
              )}
              {output && (
                <>
                  <span className={styles.outLabel}>{output.label}</span>
                  <Socket nodeId={node.id} side="out" port={output} />
                </>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
});

function Socket({
  nodeId,
  side,
  port,
}: {
  nodeId: string;
  side: "in" | "out";
  port: PortDef;
}): React.JSX.Element {
  return (
    <span
      className={`${styles.socket} ${side === "in" ? styles.socketIn : styles.socketOut}`}
      data-node-id={nodeId}
      data-port-side={side}
      data-port-id={port.id}
      title={`${port.label || (side === "in" ? "In" : "Out")} (${port.type})`}
    >
      <span
        className={port.type === "exec" ? styles.execDot : styles.dot}
        style={{ "--socket": PORT_COLORS[port.type] } as React.CSSProperties}
      />
    </span>
  );
}
