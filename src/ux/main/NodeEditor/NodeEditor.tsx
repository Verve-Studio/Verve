import React, { memo, useRef, useSyncExternalStore } from "react";
import type { GraphDomain } from "@/core/nodes/graphTypes";
import { dockStore } from "@/ux/main/RightPanel/Dock/dockStore";
import { NodeCanvas } from "./NodeCanvas/NodeCanvas";
import { ShaderLayerEditor } from "./ShaderLayerEditor/ShaderLayerEditor";
import { nodeEditorStore } from "./nodeEditorStore";
import styles from "./NodeEditor.module.scss";

const MIN_HEIGHT = 140;
/** Canvas space kept visible above the editor while resizing. */
const MIN_CANVAS = 120;

const DOMAINS: { id: GraphDomain; label: string }[] = [
  { id: "shader", label: "Shader" },
  { id: "automation", label: "Automation" },
];

const subscribeDock = (fn: () => void): (() => void) => dockStore.subscribe(fn);
const getNodeEditorConfig = () => dockStore.getSnapshot().nodeEditor;

interface NodeEditorMountProps {
  /** Records an app history entry (custom shader edits). */
  captureHistory: (label: string) => void;
}

/** Renders the node editor when it's open in the dock layout. */
export function NodeEditorMount({ captureHistory }: NodeEditorMountProps): React.JSX.Element | null {
  const config = useSyncExternalStore(subscribeDock, getNodeEditorConfig);
  return config.open ? (
    <NodeEditor height={config.height} captureHistory={captureHistory} />
  ) : null;
}

/** Node editor docked under the canvas (View → Node Editor). */
const NodeEditor = memo(function NodeEditor({
  height,
  captureHistory,
}: {
  height: number;
  captureHistory: (label: string) => void;
}): React.JSX.Element {
  const domain = useSyncExternalStore(nodeEditorStore.subscribe, nodeEditorStore.getDomain);
  const shaderLayerId = useSyncExternalStore(
    nodeEditorStore.subscribe,
    nodeEditorStore.getShaderLayerId,
  );
  const panelRef = useRef<HTMLElement>(null);
  const resize = useRef<{ y: number; h: number; max: number } | null>(null);

  return (
    <section ref={panelRef} className={styles.panel} style={{ height }}>
      <div
        className={styles.resizeHandle}
        onPointerDown={(e) => {
          if (e.button !== 0) return;
          const column = panelRef.current?.parentElement;
          e.currentTarget.setPointerCapture(e.pointerId);
          resize.current = {
            y: e.clientY,
            h: height,
            max: Math.max(MIN_HEIGHT, (column?.clientHeight ?? 600) - MIN_CANVAS),
          };
        }}
        onPointerMove={(e) => {
          const r = resize.current;
          if (!r) return;
          const h = Math.round(Math.min(r.max, Math.max(MIN_HEIGHT, r.h + r.y - e.clientY)));
          dockStore.setNodeEditorHeight(h);
        }}
        onPointerUp={() => {
          resize.current = null;
        }}
        onPointerCancel={() => {
          resize.current = null;
        }}
      />
      <header className={styles.header}>
        <span className={styles.title}>Node Editor</span>
        <div className={styles.segmented} role="tablist">
          {DOMAINS.map((d) => (
            <button
              key={d.id}
              type="button"
              role="tab"
              aria-selected={domain === d.id}
              className={domain === d.id ? styles.segActive : undefined}
              onClick={() => nodeEditorStore.setDomain(d.id)}
            >
              {d.label}
            </button>
          ))}
        </div>
        <span className={styles.hint}>
          Right-click menu · Shift+A add · Drag sockets to link · Ctrl+G frame · Middle/right-drag pan · Wheel zoom · F fit
        </span>
        <button
          type="button"
          className={styles.close}
          title="Close Node Editor"
          aria-label="Close Node Editor"
          onClick={() => dockStore.setNodeEditorOpen(false)}
        >
          ×
        </button>
      </header>
      {domain === "shader" ? (
        <ShaderLayerEditor layerId={shaderLayerId} captureHistory={captureHistory} />
      ) : (
        <NodeCanvas key="automation" doc={nodeEditorStore.automationDocument()} />
      )}
    </section>
  );
});
