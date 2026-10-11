import type { ExecContext, INode } from "../../INode";
import {
  ActionNode,
} from "../_shared/nodeKit";

class SelectAllNode extends ActionNode {
  readonly type = "selectAll";
  readonly label = "All";
  readonly category = "Select";
  readonly description = "Selects the whole canvas.";
  protected readonly dataInputs = [];

  protected async run(ctx: ExecContext) {
    await ctx.host.selectAll();
  }
}

export const selectAllNode: INode = new SelectAllNode();
