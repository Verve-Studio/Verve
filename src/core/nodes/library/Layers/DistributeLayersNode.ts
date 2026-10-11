import type { ExecContext, INode } from "../../INode";
import {
  ActionNode,
  LAYERS_IN,
  enumParam,
  enumSpec,
  layersOrActive,
} from "../_shared/nodeKit";

class DistributeLayersNode extends ActionNode {
  readonly type = "distributeLayers";
  readonly label = "Distribute";
  readonly category = "Layer";
  readonly description = "Spaces the layers' content evenly (three or more layers).";
  readonly params = [
    { id: "axis", label: "Axis", spec: enumSpec("horizontal", [["horizontal", "Horizontally"], ["vertical", "Vertically"]]) },
  ];
  protected readonly dataInputs = [LAYERS_IN] as const;

  protected async run(ctx: ExecContext) {
    await ctx.host.distributeLayers(await layersOrActive(ctx), enumParam(ctx, "axis") === "vertical" ? "vertical" : "horizontal");
  }
}

export const distributeLayersNode: INode = new DistributeLayersNode();
