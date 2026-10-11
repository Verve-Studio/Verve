import type { ExecContext, INode } from "../../INode";
import {
  ActionNode,
  LAYERS_IN,
  enumParam,
  enumSpec,
  layersOrActive,
  stringInput,
  stringSpec,
} from "../_shared/nodeKit";

class GroupLayersNode extends ActionNode {
  readonly type = "groupLayers";
  readonly label = "Group Layers";
  readonly category = "Layer";
  readonly description = "Puts the layers (siblings) into a new group or composite. Unconnected Layers = the active layer.";
  readonly params = [
    { id: "kind", label: "Kind", spec: enumSpec("group", [["group", "Group"], ["composite", "Composite"]]) },
  ];
  protected readonly dataInputs = [LAYERS_IN, { id: "name", label: "Name", type: "string", value: stringSpec("") }] as const;
  protected readonly dataOutputs = [{ id: "group", label: "Group", type: "layer" }] as const;

  protected async run(ctx: ExecContext) {
    const group = await ctx.host.groupLayers(await layersOrActive(ctx), {
      name: (await stringInput(ctx, "name")) || undefined,
      kind: enumParam(ctx, "kind") === "composite" ? "composite" : "group",
    });
    return { group };
  }
}

export const groupLayersNode: INode = new GroupLayersNode();
