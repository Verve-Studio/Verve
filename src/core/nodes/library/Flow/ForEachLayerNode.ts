import type { ExecContext, ExecResult, INode } from "../../INode";
import { EXEC_IN, boolSpec } from "../_shared/nodeKit";

class ForEachLayerNode implements INode {
  readonly type = "forEachLayer";
  readonly label = "For Each Layer";
  readonly category = "Flow";
  readonly domains = ["automation"] as const;
  readonly description =
    "Runs Loop Body once per layer of the active document (top to bottom), then Completed.";
  readonly inputs = [
    EXEC_IN,
    { id: "visibleOnly", label: "Visible Only", type: "bool", value: { kind: "bool", default: false } },
  ] as const;
  readonly outputs = [
    { id: "body", label: "Loop Body", type: "exec" },
    { id: "layer", label: "Layer", type: "layer" },
    { id: "index", label: "Index", type: "int" },
    { id: "completed", label: "Completed", type: "exec" },
  ] as const;
  readonly params = [{ id: "recursive", label: "Inside Groups", spec: boolSpec(false) }];

  async execute(ctx: ExecContext): Promise<ExecResult> {
    const visibleOnly = (await ctx.input("visibleOnly")) === true;
    // Snapshot first: the body may add or remove layers.
    const layers = ctx.host.layers({ visibleOnly, recursive: ctx.param("recursive") === true });
    for (let index = 0; index < layers.length; index++) {
      ctx.signal.throwIfAborted();
      ctx.setOutputs({ layer: layers[index], index });
      await ctx.runBranch("body");
    }
    return { next: "completed" };
  }
}

export const forEachLayerNode: INode = new ForEachLayerNode();
