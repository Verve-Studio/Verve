import type { ExecContext, INode } from "../../INode";
import type { RotateAmount } from "../../automationHost";
import {
  ActionNode,
  LAYERS_IN,
  enumParam,
  enumSpec,
  layersOrActive,
} from "../_shared/nodeKit";

class RotateLayersNode extends ActionNode {
  readonly type = "rotateLayers";
  readonly label = "Rotate";
  readonly category = "Layer";
  readonly description = "Rotates the layers' pixels (Layer → Rotate). Unconnected Layers = the active layer.";
  readonly params = [
    { id: "amount", label: "Rotate", spec: enumSpec("90cw", [["90cw", "90° CW"], ["180", "180° CW"], ["270cw", "270° CW"]]) },
  ];
  protected readonly dataInputs = [LAYERS_IN] as const;

  protected async run(ctx: ExecContext) {
    await ctx.host.rotateLayers(await layersOrActive(ctx), enumParam(ctx, "amount") as RotateAmount);
  }
}

export const rotateLayersNode: INode = new RotateLayersNode();
