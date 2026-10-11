import type { ExecContext, INode } from "../../INode";
import {
  ActionNode,
  stringInput,
  stringSpec,
} from "../_shared/nodeKit";

class CreateFolderNode extends ActionNode {
  readonly type = "createFolder";
  readonly label = "Create Folder";
  readonly category = "File";
  readonly description = "Creates the folder (and any missing parent folders).";
  readonly width = 200;
  protected readonly dataInputs = [{ id: "folder", label: "Folder", type: "string", value: stringSpec("", "C:\\images") }] as const;
  protected readonly dataOutputs = [{ id: "folder", label: "Folder", type: "string" }] as const;

  protected async run(ctx: ExecContext) {
    const folder = await stringInput(ctx, "folder");
    if (!folder) throw new Error("No folder");
    await ctx.host.makeDirectory(folder);
    return { folder };
  }
}

export const createFolderNode: INode = new CreateFolderNode();
