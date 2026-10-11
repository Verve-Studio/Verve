import type { ExecContext, INode } from "../../INode";
import {
  ActionNode,
  LAYER_IN,
  LAYER_OUT,
  floatSpec,
  layerOrActive,
  numberInput,
} from "../_shared/nodeKit";

class SetLayerOpacityNode extends ActionNode {
  readonly type = "setLayerOpacity";
  readonly label = "Set Layer Opacity";
  readonly category = "Layer";
  readonly description = "Sets the layer's opacity (0–1). Unconnected Layer = the active layer.";
  protected readonly dataInputs = [LAYER_IN, { id: "opacity", label: "Opacity", type: "float", value: floatSpec(1, 0, 1) }] as const;
  protected readonly dataOutputs = [LAYER_OUT] as const;

  protected async run(ctx: ExecContext) {
    const layer = await ctx.host.setLayerProperties(await layerOrActive(ctx), {
      opacity: await numberInput(ctx, "opacity"),
    });
    return { layer };
  }
}

export const setLayerOpacityNode: INode = new SetLayerOpacityNode();
