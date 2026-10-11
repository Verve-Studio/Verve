import type { ExecContext, INode } from "../../INode";
import {
  ActionNode,
  LAYER_IN,
  LAYER_OUT,
  layerOrActive,
} from "../_shared/nodeKit";

class RefreshLinkedLayerNode extends ActionNode {
  readonly type = "refreshLinkedLayer";
  readonly label = "Refresh Linked Layer";
  readonly category = "Layer";
  readonly description = "Re-reads a linked layer's source file (Layer → Refresh Linked Layer). Unconnected Layer = the active layer.";
  protected readonly dataInputs = [LAYER_IN] as const;
  protected readonly dataOutputs = [LAYER_OUT] as const;

  protected async run(ctx: ExecContext) {
    const layer = await layerOrActive(ctx);
    await ctx.host.refreshLinkedLayer(layer);
    return { layer };
  }
}

export const refreshLinkedLayerNode: INode = new RefreshLinkedLayerNode();
