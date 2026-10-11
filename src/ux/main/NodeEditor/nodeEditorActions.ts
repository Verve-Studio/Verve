/**
 * Opening the node editor in a mode. The editor has no mode switch of its
 * own: it shows the Shader Editor or the Automation Editor depending on how
 * it was opened (View → Shader Editor / Automation Editor, a Custom Shader
 * layer, the startup screen's automation actions).
 */
import { useSyncExternalStore } from "react";
import type { GraphDomain } from "@/core/nodes/graphTypes";
import { dockStore } from "@/ux/main/RightPanel/Dock/dockStore";
import { nodeEditorStore } from "./nodeEditorStore";

/** Show the node editor in `domain` (docked unless `fullWindow`). */
export function openNodeEditor(domain: GraphDomain, fullWindow = false): void {
  nodeEditorStore.setDomain(domain);
  dockStore.setNodeEditorOpen(true);
  if (fullWindow) dockStore.setNodeEditorFullWindow(true);
}

/** View menu: close the editor when it's showing `domain`, else show it. */
export function toggleNodeEditor(domain: GraphDomain): void {
  if (currentMode() === domain) dockStore.setNodeEditorOpen(false);
  else openNodeEditor(domain);
}

/** The open editor's mode, or null when it's closed. */
function currentMode(): GraphDomain | null {
  return dockStore.getSnapshot().nodeEditor.open ? nodeEditorStore.getDomain() : null;
}

const subscribe = (fn: () => void): (() => void) => {
  const offDock = dockStore.subscribe(fn);
  const offEditor = nodeEditorStore.subscribe(fn);
  return () => {
    offDock();
    offEditor();
  };
};

/** Re-renders when the editor opens, closes or changes mode (menus). */
export function useNodeEditorMode(): GraphDomain | null {
  return useSyncExternalStore(subscribe, currentMode);
}
