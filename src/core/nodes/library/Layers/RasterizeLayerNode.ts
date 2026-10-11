import type { ExecContext, INode } from "../../INode";
import {
  ActionNode,
  LAYER_IN,
  LAYER_OUT,
  layerOrActive,
} from "../_shared/nodeKit";

class RasterizeLayerNode extends ActionNode {
  readonly type = "rasterizeLayer";
  readonly label = "Rasterize Layer";
  readonly category = "Layer";
  readonly description = "Bakes the layer with its mask and effects (or a group / composite with its contents) into a pixel layer. Unconnected Layer = the active layer.";
  protected readonly dataInputs = [LAYER_IN] as const;
  protected readonly dataOutputs = [LAYER_OUT] as const;

  protected async run(ctx: ExecContext) {
    return { layer: await ctx.host.rasterizeLayer(await layerOrActive(ctx)) };
  }
}

export const rasterizeLayerNode: INode = new RasterizeLayerNode();
