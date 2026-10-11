import type { ExecContext, INode } from "../../INode";
import {
  ActionNode,
} from "../_shared/nodeKit";

class SaveNode extends ActionNode {
  readonly type = "save";
  readonly label = "Save";
  readonly category = "File";
  readonly description = "Saves the active document to its .verve file (File → Save). Use Save As for documents that haven't been saved as .verve yet.";
  protected readonly dataInputs = [];

  protected async run(ctx: ExecContext) {
    await ctx.host.saveDocument();
  }
}

export const saveNode: INode = new SaveNode();
