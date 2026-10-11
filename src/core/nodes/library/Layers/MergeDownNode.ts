import type { ExecContext, INode } from "../../INode";
import {
  ActionNode,
  LAYER_IN,
  layerOrActive,
} from "../_shared/nodeKit";

class MergeDownNode extends ActionNode {
  readonly type = "mergeDown";
  readonly label = "Merge Down";
  readonly category = "Layer";
  readonly description = "Merges the layer into the layers below it (Layer → Merge Down). Unconnected Layer = the active layer.";
  protected readonly dataInputs = [LAYER_IN] as const;
  protected readonly dataOutputs = [{ id: "merged", label: "Merged", type: "layer" }] as const;

  protected async run(ctx: ExecContext) {
    return { merged: await ctx.host.mergeDown(await layerOrActive(ctx)) };
  }
}

export const mergeDownNode: INode = new MergeDownNode();
