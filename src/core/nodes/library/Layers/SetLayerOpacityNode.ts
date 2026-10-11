import type { ExecContext, ExecResult, INode } from "../../INode";
import { EXEC_IN, EXEC_OUT, floatSpec, layerInput, numberInput } from "../_shared/nodeKit";

class SetLayerOpacityNode implements INode {
  readonly type = "setLayerOpacity";
  readonly label = "Set Layer Opacity";
  readonly category = "Layers";
  readonly domains = ["automation"] as const;
  readonly width = 180;
  readonly inputs = [
    EXEC_IN,
    { id: "layer", label: "Layer", type: "layer" },
    { id: "opacity", label: "Opacity", type: "float", value: floatSpec(1, 0, 1) },
  ] as const;
  readonly outputs = [EXEC_OUT];

  async execute(ctx: ExecContext): Promise<ExecResult> {
    const layer = await layerInput(ctx, "layer");
    const opacity = Math.min(1, Math.max(0, await numberInput(ctx, "opacity")));
    await ctx.host.setLayerOpacity(layer, opacity);
    return {};
  }
}

export const setLayerOpacityNode: INode = new SetLayerOpacityNode();
