import type { ExecContext, INode } from "../../INode";
import {
  ActionNode,
} from "../_shared/nodeKit";

class TrimImageNode extends ActionNode {
  readonly type = "trimImage";
  readonly label = "Trim Image";
  readonly category = "Image";
  readonly description = "Crops away transparent borders: the canvas shrinks to the visible pixels.";
  protected readonly dataInputs = [];

  protected async run(ctx: ExecContext) {
    await ctx.host.trimImage();
  }
}

export const trimImageNode: INode = new TrimImageNode();
