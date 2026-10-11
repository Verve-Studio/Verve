/**
 * The open automation workflow: its editing document, the file it was
 * opened from / saved to, and whether it has unsaved changes. There's one
 * workflow at a time (the node editor's Automation tab). Module-level so
 * the node editor, the startup screen and the unsaved-changes reporter
 * share it.
 */
// Registers the node types (the new workflow starts with an On Run node).
import "./index";
import { NodeGraphDocument } from "./NodeGraphDocument";
import { createNode } from "./graphOps";
import { newGraphId, type NodeGraph } from "./graphTypes";
import { nodeRegistry } from "./nodeRegistry";

export interface AutomationSessionState {
  readonly document: NodeGraphDocument;
  /** The `.automation` file, or null for a new workflow. */
  readonly path: string | null;
  /** File name without extension, or "Untitled Workflow". */
  readonly name: string;
  readonly dirty: boolean;
}

function newGraph(): NodeGraph {
  return {
    id: newGraphId(),
    name: "Workflow",
    domain: "automation",
    nodes: [createNode(nodeRegistry.get("onRun")!, 0, 0)],
    edges: [],
  };
}

const nameOf = (path: string | null): string =>
  path ? (path.split(/[\/]/).pop() ?? path).replace(/\.automation$/i, "") : "Untitled Workflow";

let document: NodeGraphDocument | null = null;
let path: string | null = null;
/** The graph as last saved / opened (dirty = the document moved on). */
let savedGraph: NodeGraph | null = null;
let snapshot: AutomationSessionState | null = null;
let unsubscribeDoc: (() => void) | null = null;
/** Dirty state listeners last saw. */
let reportedDirty = false;
const listeners = new Set<() => void>();

const isDirty = (): boolean => document !== null && document.graph !== savedGraph;

function emit(): void {
  snapshot = null;
  reportedDirty = isDirty();
  listeners.forEach((fn) => fn());
}

function install(doc: NodeGraphDocument, file: string | null): void {
  unsubscribeDoc?.();
  document = doc;
  path = file;
  savedGraph = doc.graph;
  // Dirty state follows the document's edits (undoing back to the saved
  // graph makes it clean again).
  unsubscribeDoc = doc.subscribe(() => {
    if (isDirty() !== reportedDirty) emit();
  });
  emit();
}

export const automationSession = {
  subscribe(fn: () => void): () => void {
    listeners.add(fn);
    return () => listeners.delete(fn);
  },

  /** Current state (stable between changes, for `useSyncExternalStore`). */
  getSnapshot(): AutomationSessionState {
    if (!document) install(new NodeGraphDocument(newGraph()), null);
    snapshot ??= {
      document: document!,
      path,
      name: nameOf(path),
      dirty: isDirty(),
    };
    return snapshot;
  },

  /** Start an empty workflow (an On Run node). */
  newWorkflow(): void {
    install(new NodeGraphDocument(newGraph()), null);
  },

  /** Replace the workflow with `graph` from `file`. */
  open(graph: NodeGraph, file: string): void {
    install(new NodeGraphDocument(graph), file);
  },

  /** The workflow was written to `file`. */
  markSaved(file: string): void {
    path = file;
    savedGraph = automationSession.getSnapshot().document.graph;
    emit();
  },
};
