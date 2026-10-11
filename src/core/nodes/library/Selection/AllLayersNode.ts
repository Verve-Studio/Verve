import type { ExecContext, INode } from "../../INode";
import {
  ActionNode,
} from "../_shared/nodeKit";

class AllLayersNode extends ActionNode {
  readonly type = "selectAllLayers";
  readonly label = "All Layers";
  readonly category = "Select";
  readonly description = "Selects every layer in the Layers panel (Select → All Layers).";
  protected readonly dataInputs = [];

  protected async run(ctx: ExecContext) {
    await ctx.host.selectAllLayers();
  }
}

export const allLayersNode: INode = new AllLayersNode();
