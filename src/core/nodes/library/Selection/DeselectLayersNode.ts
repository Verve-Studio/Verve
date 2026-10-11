import type { ExecContext, INode } from "../../INode";
import {
  ActionNode,
} from "../_shared/nodeKit";

class DeselectLayersNode extends ActionNode {
  readonly type = "deselectLayers";
  readonly label = "Deselect Layers";
  readonly category = "Select";
  readonly description = "Clears the Layers panel selection (Select → Deselect Layers).";
  protected readonly dataInputs = [];

  protected async run(ctx: ExecContext) {
    await ctx.host.deselectLayers();
  }
}

export const deselectLayersNode: INode = new DeselectLayersNode();
