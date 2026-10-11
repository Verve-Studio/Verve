/**
 * UI scratchpad for running the automation workflow: run state, the node
 * that failed and the run log. Module-level so a run keeps going (and its
 * log stays) while the node editor is closed. Runs go through
 * `runAutomation` against the app's registered `AutomationHost`.
 */
import type { NodeGraph } from "@/core/nodes/graphTypes";
import { runAutomation } from "@/core/nodes/automationRunner";
import { automationHostProvider } from "@/core/nodes/automationHostProvider";

export interface LogLine {
  readonly id: number;
  readonly kind: "info" | "print" | "error" | "ok";
  readonly text: string;
}

export interface WorkflowRunState {
  readonly running: boolean;
  /** Node that caused the last failure. */
  readonly errorNodeId: string | null;
  readonly log: readonly LogLine[];
}

const MAX_LOG = 500;

let state: WorkflowRunState = { running: false, errorNodeId: null, log: [] };
let controller: AbortController | null = null;
let nextId = 1;
const listeners = new Set<() => void>();

function set(patch: Partial<WorkflowRunState>): void {
  state = { ...state, ...patch };
  listeners.forEach((fn) => fn());
}

function append(kind: LogLine["kind"], text: string): void {
  const log = [...state.log, { id: nextId++, kind, text }];
  set({ log: log.length > MAX_LOG ? log.slice(log.length - MAX_LOG) : log });
}

automationHostProvider.onLog((message) => append("print", message));

export const workflowRunStore = {
  subscribe(fn: () => void): () => void {
    listeners.add(fn);
    return () => listeners.delete(fn);
  },
  getSnapshot(): WorkflowRunState {
    return state;
  },

  async run(graph: NodeGraph): Promise<void> {
    if (state.running) return;
    const host = automationHostProvider.get();
    if (!host) {
      append("error", "The app isn't ready to run workflows yet.");
      return;
    }
    controller = new AbortController();
    set({ running: true, errorNodeId: null });
    append("info", "Running workflow…");
    const started = performance.now();
    try {
      const result = await runAutomation(graph, host, { signal: controller.signal });
      const secs = ((performance.now() - started) / 1000).toFixed(1);
      if (result.ok) {
        append("ok", `Finished in ${secs} s (${result.steps} steps).`);
      } else if (result.cancelled) {
        append("info", `Stopped after ${secs} s.`);
      } else {
        set({ errorNodeId: result.nodeId });
        append("error", result.message);
      }
    } finally {
      controller = null;
      set({ running: false });
    }
  },

  /** Cancel the run: the current operation finishes, then it stops. */
  stop(): void {
    controller?.abort();
  },

  clearLog(): void {
    set({ log: [], errorNodeId: null });
  },
};
