import type { ExecContext, INode } from "../../INode";
import {
  ActionNode,
  LAYER_IN,
  layerOrActive,
} from "../_shared/nodeKit";

class CopyNode extends ActionNode {
  readonly type = "copy";
  readonly label = "Copy";
  readonly category = "Edit";
  readonly description = "Copies the layer's pixels inside the selection (or all of them) to the clipboard (Edit → Copy). Unconnected Layer = the active layer.";
  protected readonly dataInputs = [LAYER_IN] as const;

  protected async run(ctx: ExecContext) {
    await ctx.host.copy(await layerOrActive(ctx), false);
  }
}

export const copyNode: INode = new CopyNode();
