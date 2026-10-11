import type { ExecContext, INode } from "../../INode";
import {
  ActionNode,
  stringInput,
  stringSpec,
} from "../_shared/nodeKit";

class SaveACopyNode extends ActionNode {
  readonly type = "saveCopy";
  readonly label = "Save a Copy";
  readonly category = "File";
  readonly description = "Writes a .verve copy of the active document to Path without relinking the document (File → Save a Copy).";
  readonly width = 200;
  protected readonly dataInputs = [{ id: "path", label: "Path", type: "string", value: stringSpec("", "C:\\out\\image.verve") }] as const;

  protected async run(ctx: ExecContext) {
    const path = await stringInput(ctx, "path");
    if (!path) throw new Error("No file path");
    await ctx.host.saveDocument(path, true);
  }
}

export const saveACopyNode: INode = new SaveACopyNode();
