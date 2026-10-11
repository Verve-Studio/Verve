import type { ExecContext, INode } from "../../INode";
import { makeList } from "../../values";
import { splitPath } from "../_shared/paths";
import {
  ActionNode,
  boolInput,
  boolSpec,
  stringInput,
  stringSpec,
  wildcardRegExp,
} from "../_shared/nodeKit";

class ListFilesNode extends ActionNode {
  readonly type = "listFiles";
  readonly label = "List Files";
  readonly category = "File";
  readonly description = "Files in Folder whose name matches Pattern (wildcards; several separated by ;), as full paths sorted by name. Images Only keeps the formats the app can open.";
  readonly width = 210;
  readonly params = [
    { id: "imagesOnly", label: "Images Only", spec: boolSpec(true) },
  ];
  protected readonly dataInputs = [{ id: "folder", label: "Folder", type: "string", value: stringSpec("", "C:\\images") }, { id: "pattern", label: "Pattern", type: "string", value: stringSpec("*", "*.png;*.jpg") }, { id: "recursive", label: "Include Subfolders", type: "bool", value: boolSpec(false) }] as const;
  protected readonly dataOutputs = [{ id: "files", label: "Files", type: "list" }, { id: "count", label: "Count", type: "int" }] as const;

  protected async run(ctx: ExecContext) {
    const folder = await stringInput(ctx, "folder");
    if (!folder) throw new Error("No folder");
    const re = wildcardRegExp(await stringInput(ctx, "pattern"));
    const images = new Set(ctx.host.supportedImageExtensions());
    const entries = await ctx.host.listDirectory(folder, {
      recursive: await boolInput(ctx, "recursive"),
      files: true,
      folders: false,
    });
    const files = entries
      .filter((e) => re.test(e.name))
      .filter((e) => ctx.param("imagesOnly") !== true || images.has(splitPath(e.name).extension))
      .map((e) => e.path);
    return { files: makeList(files), count: files.length };
  }
}

export const listFilesNode: INode = new ListFilesNode();
