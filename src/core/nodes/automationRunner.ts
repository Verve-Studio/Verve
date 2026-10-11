/**
 * Automation graph interpreter.
 *
 * Starting at the entry node (On Run), it executes exec nodes one at a time
 * along their exec links. Data inputs are pulled on demand: a pure node (no
 * exec ports) is evaluated when something reads it, and re-evaluated for
 * every exec step so it sees fresh state (e.g. a loop variable). An exec
 * node's data outputs keep the value from its last run.
 */
import type { GraphEdge, NodeGraph } from "./graphTypes";
import type { ExecContext, ExecResult, INode } from "./INode";
import { nodeRegistry } from "./nodeRegistry";
import { nodePorts, paramValue } from "./graphOps";
import { convertValue, type RuntimeValue } from "./values";
import type { AutomationHost } from "./automationHost";

export interface RunOptions {
  signal?: AbortSignal;
  /** Entry node type. */
  entry?: string;
  /** Guard against runaway workflows. */
  maxSteps?: number;
}

export type RunResult =
  | { ok: true; steps: number }
  | { ok: false; nodeId: string | null; message: string; cancelled: boolean };

type Outputs = Readonly<Record<string, RuntimeValue>>;

class NodeError extends Error {
  constructor(
    readonly nodeId: string | null,
    message: string,
  ) {
    super(message);
  }
}

// Exec ports are never dynamic, so the default port set decides.
const isExecNode = (def: INode): boolean =>
  def.inputs.some((p) => p.type === "exec") || def.outputs.some((p) => p.type === "exec");

export async function runAutomation(
  graph: NodeGraph,
  host: AutomationHost,
  options: RunOptions = {},
): Promise<RunResult> {
  const signal = options.signal ?? new AbortController().signal;
  const maxSteps = options.maxSteps ?? 100_000;
  const nodes = new Map(graph.nodes.map((n) => [n.id, n]));
  const incoming = new Map<string, GraphEdge>();
  const outgoing = new Map<string, GraphEdge>();
  for (const e of graph.edges) {
    incoming.set(`${e.to.node}:${e.to.port}`, e);
    outgoing.set(`${e.from.node}:${e.from.port}`, e);
  }

  const execOutputs = new Map<string, Outputs>();
  const variables = new Map<string, RuntimeValue>();
  let pureCache = new Map<string, Promise<Outputs>>();
  let steps = 0;

  const lookup = (nodeId: string): [NonNullable<ReturnType<typeof nodes.get>>, INode] => {
    const node = nodes.get(nodeId);
    const def = node && nodeRegistry.get(node.type);
    if (!node || !def) throw new NodeError(nodeId, `Unknown node type "${node?.type}"`);
    if (!def.domains.includes("automation") || !def.execute) {
      throw new NodeError(nodeId, `${def.label} can't be used in a workflow`);
    }
    return [node, def];
  };

  const call = async (nodeId: string, def: INode, ctx: ExecContext): Promise<ExecResult> => {
    try {
      return (await def.execute!(ctx)) ?? {};
    } catch (err) {
      if (err instanceof NodeError || signal.aborted) throw err;
      throw new NodeError(nodeId, err instanceof Error ? err.message : String(err));
    }
  };

  const evalPure = (nodeId: string): Promise<Outputs> => {
    let p = pureCache.get(nodeId);
    if (!p) {
      const [, def] = lookup(nodeId);
      p = call(nodeId, def, makeCtx(nodeId)).then((r) => r.outputs ?? {});
      pureCache.set(nodeId, p);
    }
    return p;
  };

  const makeCtx = (nodeId: string): ExecContext => {
    const [node, def] = lookup(nodeId);
    return {
      input: async (id) => {
        const port = nodePorts(def, node, graph).inputs.find((p) => p.id === id);
        if (!port || port.type === "exec") return undefined;
        const edge = incoming.get(`${nodeId}:${id}`);
        if (edge) {
          const [, srcDef] = lookup(edge.from.node);
          let value: RuntimeValue | undefined;
          if (isExecNode(srcDef)) {
            const outs = execOutputs.get(edge.from.node);
            if (!outs || !(edge.from.port in outs)) {
              throw new NodeError(nodeId, `${srcDef.label} hasn't run yet`);
            }
            value = outs[edge.from.port];
          } else {
            value = (await evalPure(edge.from.node))[edge.from.port];
          }
          return value === undefined ? undefined : convertValue(value, port.type);
        }
        if (!port.value) return undefined;
        return convertValue(paramValue(def, node, id, graph) as RuntimeValue, port.type);
      },
      param: (id) => paramValue(def, node, id, graph),
      isConnected: (id) => incoming.has(`${nodeId}:${id}`),
      host,
      signal,
      variables,
      setOutputs: (values) => {
        execOutputs.set(nodeId, { ...execOutputs.get(nodeId), ...values });
        pureCache = new Map();
      },
      runBranch: (id) => runFrom(outgoing.get(`${nodeId}:${id}`)?.to.node ?? null),
    };
  };

  /** Run an exec chain until it ends. */
  const runFrom = async (start: string | null): Promise<void> => {
    let current = start;
    while (current) {
      signal.throwIfAborted();
      if (++steps > maxSteps) throw new NodeError(current, "Step limit reached");
      const [, def] = lookup(current);
      pureCache = new Map();
      const res = await call(current, def, makeCtx(current));
      if (res.outputs) execOutputs.set(current, { ...execOutputs.get(current), ...res.outputs });
      const next =
        res.next === undefined ? def.outputs.find((p) => p.type === "exec")?.id : res.next;
      current = next ? (outgoing.get(`${current}:${next}`)?.to.node ?? null) : null;
    }
  };

  const entry = options.entry ?? "onRun";
  const entries = graph.nodes.filter((n) => n.type === entry);
  if (entries.length === 0) {
    return { ok: false, nodeId: null, message: "Add an On Run node", cancelled: false };
  }

  try {
    for (const e of entries) await runFrom(e.id);
    return { ok: true, steps };
  } catch (err) {
    if (signal.aborted) {
      return { ok: false, nodeId: null, message: "Cancelled", cancelled: true };
    }
    const e = err instanceof NodeError ? err : new NodeError(null, String(err));
    return { ok: false, nodeId: e.nodeId, message: e.message, cancelled: false };
  }
}
