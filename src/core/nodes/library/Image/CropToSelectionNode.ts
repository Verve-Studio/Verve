import type { ExecContext, INode } from "../../INode";
import {
  ActionNode,
} from "../_shared/nodeKit";

class CropToSelectionNode extends ActionNode {
  readonly type = "cropToSelection";
  readonly label = "Crop To Selection";
  readonly category = "Image";
  readonly description = "Crops the document to the selection's bounds.";
  protected readonly dataInputs = [];

  protected async run(ctx: ExecContext) {
    const bounds = ctx.host.selectionBounds();
    if (!bounds) throw new Error("There's no selection to crop to");
    await ctx.host.cropImage(bounds);
  }
}

export const cropToSelectionNode: INode = new CropToSelectionNode();
