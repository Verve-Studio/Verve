import type { ExecContext, INode } from "../../INode";
import {
  ActionNode,
  enumParam,
  enumSpec,
} from "../_shared/nodeKit";

class FlipImageNode extends ActionNode {
  readonly type = "flipImage";
  readonly label = "Flip";
  readonly category = "Image";
  readonly description = "Mirrors the whole canvas (Image → Flip).";
  readonly params = [
    { id: "axis", label: "Flip", spec: enumSpec("horizontal", [["horizontal", "Horizontal"], ["vertical", "Vertical"]]) },
  ];
  protected readonly dataInputs = [];

  protected async run(ctx: ExecContext) {
    await ctx.host.flipImage(enumParam(ctx, "axis") === "vertical" ? "vertical" : "horizontal");
  }
}

export const flipImageNode: INode = new FlipImageNode();
