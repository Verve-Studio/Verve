import type { ExecContext, ExecResult, INode } from "../../INode";
import { makeList } from "../../values";

/** The document the user is working on (or that the workflow last opened /
 *  switched to): lets a workflow act on the current document, or branch
 *  when none is open. */
class ActiveDocumentNode implements INode {
  readonly type = "activeDocument";
  readonly label = "Get Active Document";
  readonly category = "File";
  readonly domains = ["automation"] as const;
  readonly description =
    "The active document (the one you're working on), whether one is open, its name and file, and every open document.";
  readonly inputs = [];
  readonly outputs = [
    { id: "document", label: "Document", type: "document" },
    { id: "hasDocument", label: "Has Document", type: "bool" },
    { id: "name", label: "Name", type: "string" },
    { id: "path", label: "File", type: "string" },
    { id: "documents", label: "All Documents", type: "list" },
  ] as const;

  execute(ctx: ExecContext): ExecResult {
    const document = ctx.host.activeDocument();
    const info = document ? ctx.host.document() : null;
    return {
      outputs: {
        document,
        hasDocument: document !== null,
        name: info?.name ?? "",
        path: info?.path ?? "",
        documents: makeList(ctx.host.documents()),
      },
    };
  }
}

export const activeDocumentNode: INode = new ActiveDocumentNode();
