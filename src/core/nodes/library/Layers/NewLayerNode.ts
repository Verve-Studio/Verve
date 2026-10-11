import type { ExecContext, INode } from "../../INode";
import {
  ActionNode,
  LAYER_OUT,
  optionalLayerInput,
  stringInput,
  stringSpec,
} from "../_shared/nodeKit";

class NewLayerNode extends ActionNode {
  readonly type = "newLayer";
  readonly label = "New Layer";
  readonly category = "Layer";
  readonly description = "Adds an empty pixel layer on top, or directly above Above (in the same group).";
  protected readonly dataInputs = [{ id: "name", label: "Name", type: "string", value: stringSpec("") }, { id: "above", label: "Above", type: "layer" }] as const;
  protected readonly dataOutputs = [LAYER_OUT] as const;

  protected async run(ctx: ExecContext) {
    const layer = await ctx.host.newLayer({
      name: await stringInput(ctx, "name"),
      above: await optionalLayerInput(ctx, "above"),
    });
    return { layer };
  }
}

export const newLayerNode: INode = new NewLayerNode();
