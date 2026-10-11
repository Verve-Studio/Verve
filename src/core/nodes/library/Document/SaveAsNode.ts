import type { ExecContext, INode } from "../../INode";
import {
  ActionNode,
  stringInput,
  stringSpec,
} from "../_shared/nodeKit";

class SaveAsNode extends ActionNode {
  readonly type = "saveAs";
  readonly label = "Save As";
  readonly category = "File";
  readonly description = "Saves the active document as a .verve file at Path and links the document to it (File → Save As).";
  readonly width = 200;
  protected readonly dataInputs = [{ id: "path", label: "Path", type: "string", value: stringSpec("", "C:\\out\\image.verve") }] as const;

  protected async run(ctx: ExecContext) {
    const path = await stringInput(ctx, "path");
    if (!path) throw new Error("No file path");
    await ctx.host.saveDocument(path);
  }
}

export const saveAsNode: INode = new SaveAsNode();
