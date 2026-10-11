import type { ExecContext, INode } from "../../INode";
import {
  ActionNode,
  LAYER_IN,
  layerOrActive,
} from "../_shared/nodeKit";

class CutNode extends ActionNode {
  readonly type = "cut";
  readonly label = "Cut";
  readonly category = "Edit";
  readonly description = "Copies the layer's pixels inside the selection to the clipboard and erases them. Unconnected Layer = the active layer.";
  protected readonly dataInputs = [LAYER_IN] as const;

  protected async run(ctx: ExecContext) {
    await ctx.host.cut(await layerOrActive(ctx));
  }
}

export const cutNode: INode = new CutNode();
