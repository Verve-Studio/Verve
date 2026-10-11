import type { ExecContext, INode } from "../../INode";
import {
  ActionNode,
  LAYER_IN,
  boolInput,
  boolSpec,
  layerOrActive,
} from "../_shared/nodeKit";

class AddLayerMaskNode extends ActionNode {
  readonly type = "addLayerMask";
  readonly label = "Add Layer Mask";
  readonly category = "Layer";
  readonly description = "Adds a layer mask: white (reveal all), or from the current selection. Unconnected Layer = the active layer.";
  protected readonly dataInputs = [LAYER_IN, { id: "fromSelection", label: "From Selection", type: "bool", value: boolSpec(false) }] as const;
  protected readonly dataOutputs = [{ id: "mask", label: "Mask", type: "layer" }] as const;

  protected async run(ctx: ExecContext) {
    const mask = await ctx.host.addLayerMask(await layerOrActive(ctx), await boolInput(ctx, "fromSelection"));
    return { mask };
  }
}

export const addLayerMaskNode: INode = new AddLayerMaskNode();
