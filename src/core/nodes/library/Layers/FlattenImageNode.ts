import type { ExecContext, INode } from "../../INode";
import {
  ActionNode,
} from "../_shared/nodeKit";

class FlattenImageNode extends ActionNode {
  readonly type = "flattenImage";
  readonly label = "Flatten Image";
  readonly category = "Layer";
  readonly description = "Flattens the whole document into one Background layer (Layer → Flatten Image).";
  protected readonly dataInputs = [];
  protected readonly dataOutputs = [{ id: "layer", label: "Background", type: "layer" }] as const;

  protected async run(ctx: ExecContext) {
    return { layer: await ctx.host.flattenImage() };
  }
}

export const flattenImageNode: INode = new FlattenImageNode();
