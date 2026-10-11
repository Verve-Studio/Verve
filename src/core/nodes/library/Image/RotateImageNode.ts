import type { ExecContext, INode } from "../../INode";
import type { RotateAmount } from "../../automationHost";
import {
  ActionNode,
  enumParam,
  enumSpec,
} from "../_shared/nodeKit";

class RotateImageNode extends ActionNode {
  readonly type = "rotateImage";
  readonly label = "Rotate";
  readonly category = "Image";
  readonly description = "Rotates the whole canvas (Image → Rotate).";
  readonly params = [
    { id: "amount", label: "Rotate", spec: enumSpec("90cw", [["90cw", "90° CW"], ["180", "180° CW"], ["270cw", "270° CW"]]) },
  ];
  protected readonly dataInputs = [];

  protected async run(ctx: ExecContext) {
    await ctx.host.rotateImage(enumParam(ctx, "amount") as RotateAmount);
  }
}

export const rotateImageNode: INode = new RotateImageNode();
