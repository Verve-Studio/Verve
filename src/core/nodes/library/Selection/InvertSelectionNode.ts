import type { ExecContext, INode } from "../../INode";
import {
  ActionNode,
} from "../_shared/nodeKit";

class InvertSelectionNode extends ActionNode {
  readonly type = "invertSelection";
  readonly label = "Invert Selection";
  readonly category = "Select";
  readonly description = "Inverts the selection.";
  protected readonly dataInputs = [];

  protected async run(ctx: ExecContext) {
    await ctx.host.invertSelection();
  }
}

export const invertSelectionNode: INode = new InvertSelectionNode();
