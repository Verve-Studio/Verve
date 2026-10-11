import type { ExecContext, INode } from "../../INode";
import {
  ActionNode,
  LAYERS_IN,
  layersOrActive,
} from "../_shared/nodeKit";

class MergeLayersNode extends ActionNode {
  readonly type = "mergeLayers";
  readonly label = "Merge Selected";
  readonly category = "Layer";
  readonly description = "Merges two or more top-level layers into one pixel layer (Layer → Merge Selected).";
  protected readonly dataInputs = [LAYERS_IN] as const;
  protected readonly dataOutputs = [{ id: "merged", label: "Merged", type: "layer" }] as const;

  protected async run(ctx: ExecContext) {
    return { merged: await ctx.host.mergeLayers(await layersOrActive(ctx)) };
  }
}

export const mergeLayersNode: INode = new MergeLayersNode();
