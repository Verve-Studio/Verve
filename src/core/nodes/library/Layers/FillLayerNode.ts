import type { ExecContext, INode } from "../../INode";
import {
  ActionNode,
  LAYER_IN,
  LAYER_OUT,
  colorSpec,
  layerOrActive,
  vectorInput,
} from "../_shared/nodeKit";

class FillLayerNode extends ActionNode {
  readonly type = "fillLayer";
  readonly label = "Fill Layer";
  readonly category = "Layer";
  readonly description = "Fills a pixel layer with a colour (inside the selection, if any; soft selections blend). Unconnected Layer = the active layer.";
  protected readonly dataInputs = [LAYER_IN, { id: "color", label: "Color", type: "color", value: colorSpec(1, 1, 1) }] as const;
  protected readonly dataOutputs = [LAYER_OUT] as const;

  protected async run(ctx: ExecContext) {
    const layer = await layerOrActive(ctx);
    await ctx.host.fillLayer(layer, await vectorInput(ctx, "color", [1, 1, 1, 1]));
    return { layer };
  }
}

export const fillLayerNode: INode = new FillLayerNode();
