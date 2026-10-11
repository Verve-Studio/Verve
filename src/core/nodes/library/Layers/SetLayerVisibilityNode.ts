import type { ExecContext, INode } from "../../INode";
import {
  ActionNode,
  LAYER_IN,
  LAYER_OUT,
  boolInput,
  boolSpec,
  layerOrActive,
} from "../_shared/nodeKit";

class SetLayerVisibilityNode extends ActionNode {
  readonly type = "setLayerVisibility";
  readonly label = "Set Layer Visibility";
  readonly category = "Layer";
  readonly description = "Shows or hides the layer. Unconnected Layer = the active layer.";
  protected readonly dataInputs = [LAYER_IN, { id: "visible", label: "Visible", type: "bool", value: boolSpec(true) }] as const;
  protected readonly dataOutputs = [LAYER_OUT] as const;

  protected async run(ctx: ExecContext) {
    const layer = await ctx.host.setLayerProperties(await layerOrActive(ctx), {
      visible: await boolInput(ctx, "visible"),
    });
    return { layer };
  }
}

export const setLayerVisibilityNode: INode = new SetLayerVisibilityNode();
