import type { ExecContext, INode } from "../../INode";
import {
  ActionNode,
  optionalLayerInput,
  stringInput,
  stringSpec,
} from "../_shared/nodeKit";

class NewLayerGroupNode extends ActionNode {
  readonly type = "newLayerGroup";
  readonly label = "New Layer Group";
  readonly category = "Layer";
  readonly description = "Adds an empty group on top, or directly above Above (Layer → New Layer Group).";
  protected readonly dataInputs = [{ id: "name", label: "Name", type: "string", value: stringSpec("") }, { id: "above", label: "Above", type: "layer" }] as const;
  protected readonly dataOutputs = [{ id: "group", label: "Group", type: "layer" }] as const;

  protected async run(ctx: ExecContext) {
    const group = await ctx.host.newGroup({
      name: await stringInput(ctx, "name"),
      kind: "group",
      above: await optionalLayerInput(ctx, "above"),
    });
    return { group };
  }
}

export const newLayerGroupNode: INode = new NewLayerGroupNode();
