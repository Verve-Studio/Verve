import type { ExecContext, INode } from "../../INode";
import {
  ActionNode,
  documentInput,
} from "../_shared/nodeKit";

class SetActiveDocumentNode extends ActionNode {
  readonly type = "setActiveDocument";
  readonly label = "Set Active Document";
  readonly category = "File";
  readonly description = "Switches to the document; following nodes act on it.";
  protected readonly dataInputs = [{ id: "document", label: "Document", type: "document" }] as const;

  protected async run(ctx: ExecContext) {
    const doc = await documentInput(ctx, "document");
    if (!doc) throw new Error("No document connected");
    await ctx.host.activateDocument(doc);
  }
}

export const setActiveDocumentNode: INode = new SetActiveDocumentNode();
