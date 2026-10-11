import type { ExecContext, INode } from "../../INode";
import {
  ActionNode,
  LAYER_IN,
  layerOrActive,
} from "../_shared/nodeKit";

class UngroupLayersNode extends ActionNode {
  readonly type = "ungroupLayers";
  readonly label = "Ungroup Layers";
  readonly category = "Layer";
  readonly description = "Moves a group's layers up one level and removes the group. Unconnected Layer = the active layer.";
  protected readonly dataInputs = [LAYER_IN] as const;

  protected async run(ctx: ExecContext) {
    await ctx.host.ungroupLayers(await layerOrActive(ctx));
  }
}

export const ungroupLayersNode: INode = new UngroupLayersNode();
