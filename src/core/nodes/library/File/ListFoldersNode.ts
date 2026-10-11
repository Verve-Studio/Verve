import type { ExecContext, INode } from "../../INode";
import { makeList } from "../../values";
import {
  ActionNode,
  boolInput,
  boolSpec,
  stringInput,
  stringSpec,
  wildcardRegExp,
} from "../_shared/nodeKit";

class ListFoldersNode extends ActionNode {
  readonly type = "listFolders";
  readonly label = "List Folders";
  readonly category = "File";
  readonly description = "Subfolders of Folder whose name matches Pattern, as full paths sorted by name.";
  readonly width = 210;
  protected readonly dataInputs = [{ id: "folder", label: "Folder", type: "string", value: stringSpec("", "C:\\images") }, { id: "pattern", label: "Pattern", type: "string", value: stringSpec("*") }, { id: "recursive", label: "Include Subfolders", type: "bool", value: boolSpec(false) }] as const;
  protected readonly dataOutputs = [{ id: "folders", label: "Folders", type: "list" }, { id: "count", label: "Count", type: "int" }] as const;

  protected async run(ctx: ExecContext) {
    const folder = await stringInput(ctx, "folder");
    if (!folder) throw new Error("No folder");
    const re = wildcardRegExp(await stringInput(ctx, "pattern"));
    const entries = await ctx.host.listDirectory(folder, {
      recursive: await boolInput(ctx, "recursive"),
      files: false,
      folders: true,
    });
    const folders = entries.filter((e) => re.test(e.name)).map((e) => e.path);
    return { folders: makeList(folders), count: folders.length };
  }
}

export const listFoldersNode: INode = new ListFoldersNode();
