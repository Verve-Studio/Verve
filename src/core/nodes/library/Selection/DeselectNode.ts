import type { ExecContext, INode } from "../../INode";
import {
  ActionNode,
} from "../_shared/nodeKit";

class DeselectNode extends ActionNode {
  readonly type = "deselect";
  readonly label = "Deselect";
  readonly category = "Select";
  readonly description = "Removes the selection.";
  protected readonly dataInputs = [];

  protected async run(ctx: ExecContext) {
    await ctx.host.deselect();
  }
}

export const deselectNode: INode = new DeselectNode();
