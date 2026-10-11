import type { ExecContext, INode } from "../../INode";
import {
  ActionNode,
  optionalLayerInput,
  stringInput,
  stringSpec,
} from "../_shared/nodeKit";

class NewCompositeLayerNode extends ActionNode {
  readonly type = "newCompositeLayer";
  readonly label = "New Composite Layer";
  readonly category = "Layer";
  readonly description = "Adds an empty composite layer on top, or directly above Above (Layer → New Composite Layer).";
  protected readonly dataInputs = [{ id: "name", label: "Name", type: "string", value: stringSpec("") }, { id: "above", label: "Above", type: "layer" }] as const;
  protected readonly dataOutputs = [{ id: "group", label: "Group", type: "layer" }] as const;

  protected async run(ctx: ExecContext) {
    const group = await ctx.host.newGroup({
      name: await stringInput(ctx, "name"),
      kind: "composite",
      above: await optionalLayerInput(ctx, "above"),
    });
    return { group };
  }
}

export const newCompositeLayerNode: INode = new NewCompositeLayerNode();
