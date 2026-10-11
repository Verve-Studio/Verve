import type { ExecContext, INode } from "../../INode";
import {
  ActionNode,
  LAYER_IN,
  layerOrActive,
} from "../_shared/nodeKit";

class DeleteLayerNode extends ActionNode {
  readonly type = "deleteLayer";
  readonly label = "Delete Layer";
  readonly category = "Layer";
  readonly description = "Removes the layer (and its contents, mask and effects). Unconnected Layer = the active layer.";
  protected readonly dataInputs = [LAYER_IN] as const;

  protected async run(ctx: ExecContext) {
    await ctx.host.deleteLayer(await layerOrActive(ctx));
  }
}

export const deleteLayerNode: INode = new DeleteLayerNode();
