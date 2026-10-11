import type { ExecContext, INode } from "../../INode";
import {
  ActionNode,
  documentInput,
} from "../_shared/nodeKit";

class CloseDocumentNode extends ActionNode {
  readonly type = "closeDocument";
  readonly label = "Close";
  readonly category = "File";
  readonly description = "Closes the document WITHOUT saving. Unconnected Document = the active document.";
  protected readonly dataInputs = [{ id: "document", label: "Document", type: "document" }] as const;

  protected async run(ctx: ExecContext) {
    const doc = (await documentInput(ctx, "document")) ?? ctx.host.activeDocument();
    if (doc) await ctx.host.closeDocument(doc);
  }
}

export const closeDocumentNode: INode = new CloseDocumentNode();
