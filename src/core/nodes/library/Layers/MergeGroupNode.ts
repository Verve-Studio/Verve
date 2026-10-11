import type { ExecContext, INode } from "../../INode";
import {
  ActionNode,
  LAYER_IN,
  layerOrActive,
} from "../_shared/nodeKit";

class MergeGroupNode extends ActionNode {
  readonly type = "mergeGroup";
  readonly label = "Merge Group";
  readonly category = "Layer";
  readonly description = "Bakes a group's contents into one pixel layer. Unconnected Layer = the active layer.";
  protected readonly dataInputs = [LAYER_IN] as const;
  protected readonly dataOutputs = [{ id: "merged", label: "Merged", type: "layer" }] as const;

  protected async run(ctx: ExecContext) {
    return { merged: await ctx.host.mergeGroup(await layerOrActive(ctx)) };
  }
}

export const mergeGroupNode: INode = new MergeGroupNode();
