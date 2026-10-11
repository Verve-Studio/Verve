import type { ExecContext, INode } from "../../INode";
import {
  ActionNode,
  LAYER_IN,
  LAYER_OUT,
  layerOrActive,
} from "../_shared/nodeKit";

class ClearLayerNode extends ActionNode {
  readonly type = "clearLayer";
  readonly label = "Delete";
  readonly category = "Edit";
  readonly description = "Erases a pixel layer's pixels inside the selection, or all of them without one (Edit → Delete). Unconnected Layer = the active layer.";
  protected readonly dataInputs = [LAYER_IN] as const;
  protected readonly dataOutputs = [LAYER_OUT] as const;

  protected async run(ctx: ExecContext) {
    const layer = await layerOrActive(ctx);
    await ctx.host.clearLayer(layer);
    return { layer };
  }
}

export const clearLayerNode: INode = new ClearLayerNode();
