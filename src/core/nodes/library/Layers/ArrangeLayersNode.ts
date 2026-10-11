import type { ExecContext, INode } from "../../INode";
import type { ArrangeOp } from "../../automationHost";
import {
  ActionNode,
  LAYERS_IN,
  enumParam,
  enumSpec,
  layersOrActive,
} from "../_shared/nodeKit";

class ArrangeLayersNode extends ActionNode {
  readonly type = "arrangeLayers";
  readonly label = "Order";
  readonly category = "Layer";
  readonly description = "Moves top-level layers in the stack (Layer → Order). Unconnected Layers = the active layer.";
  readonly params = [
    {
      id: "op",
      label: "Order",
      spec: enumSpec("front", [
        ["front", "Bring to Front"],
        ["back", "Bring to Back"],
        ["forward", "Forward"],
        ["backward", "Backward"],
        ["reverse", "Reverse Order"],
      ]),
    },
  ];
  protected readonly dataInputs = [LAYERS_IN] as const;

  protected async run(ctx: ExecContext) {
    await ctx.host.arrangeLayers(await layersOrActive(ctx), enumParam(ctx, "op") as ArrangeOp);
  }
}

export const arrangeLayersNode: INode = new ArrangeLayersNode();
