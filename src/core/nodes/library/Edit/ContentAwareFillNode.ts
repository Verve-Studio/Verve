import type { ExecContext, INode } from "../../INode";
import {
  ActionNode,
  LAYER_IN,
  intInput,
  intSpec,
  layerOrActive,
} from "../_shared/nodeKit";

class ContentAwareFillNode extends ActionNode {
  readonly type = "contentAwareFill";
  readonly label = "Content-Aware Fill";
  readonly category = "Edit";
  readonly description = "Fills the selection from the surrounding pixels into a new layer (Edit → Content-Aware Fill). Unconnected Layer = the active layer.";
  readonly width = 200;
  protected readonly dataInputs = [LAYER_IN, { id: "radius", label: "Sampling Radius", type: "int", value: intSpec(200, 0) }] as const;

  protected async run(ctx: ExecContext) {
    await ctx.host.contentAwareFill(await layerOrActive(ctx), "fill", await intInput(ctx, "radius"));
  }
}

export const contentAwareFillNode: INode = new ContentAwareFillNode();
