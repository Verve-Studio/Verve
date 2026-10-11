import type { ExecContext, INode } from "../../INode";
import {
  ActionNode,
  LAYER_IN,
  layerOrActive,
} from "../_shared/nodeKit";

class SetActiveLayerNode extends ActionNode {
  readonly type = "setActiveLayer";
  readonly label = "Set Active Layer";
  readonly category = "Layer";
  readonly description = "Makes the layer the active one (the target of nodes with an unconnected Layer).";
  protected readonly dataInputs = [LAYER_IN] as const;

  protected async run(ctx: ExecContext) {
    await ctx.host.setActiveLayer(await layerOrActive(ctx));
  }
}

export const setActiveLayerNode: INode = new SetActiveLayerNode();
