import type { ExecContext, INode } from "../../INode";
import {
  ActionNode,
} from "../_shared/nodeKit";

class CopyMergedNode extends ActionNode {
  readonly type = "copyMerged";
  readonly label = "Copy Merged";
  readonly category = "Edit";
  readonly description = "Copies the visible image inside the selection to the clipboard (Edit → Copy Merged).";
  protected readonly dataInputs = [];

  protected async run(ctx: ExecContext) {
    const layer = ctx.host.activeLayer();
    if (!layer) throw new Error("The document has no layers");
    await ctx.host.copy(layer, true);
  }
}

export const copyMergedNode: INode = new CopyMergedNode();
