import type { ExecContext, INode } from "../../INode";
import {
  ActionNode,
  LAYER_IN,
  intInput,
  intSpec,
  layerOrActive,
} from "../_shared/nodeKit";

class ContentAwareDeleteNode extends ActionNode {
  readonly type = "contentAwareDelete";
  readonly label = "Content-Aware Delete";
  readonly category = "Edit";
  readonly description = "Removes the selection on the layer, filling it from the surrounding pixels in place (Edit → Content-Aware Delete). Unconnected Layer = the active layer.";
  readonly width = 200;
  protected readonly dataInputs = [LAYER_IN, { id: "radius", label: "Sampling Radius", type: "int", value: intSpec(200, 0) }] as const;

  protected async run(ctx: ExecContext) {
    await ctx.host.contentAwareFill(await layerOrActive(ctx), "delete", await intInput(ctx, "radius"));
  }
}

export const contentAwareDeleteNode: INode = new ContentAwareDeleteNode();
