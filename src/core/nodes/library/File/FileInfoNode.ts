import type { ExecContext, INode } from "../../INode";
import {
  ActionNode,
  stringInput,
  stringSpec,
} from "../_shared/nodeKit";

class FileInfoNode extends ActionNode {
  readonly type = "fileInfo";
  readonly label = "File Info";
  readonly category = "File";
  readonly description = "Whether the path exists, whether it's a folder, its size in bytes and its modification time (ISO date).";
  readonly width = 200;
  protected readonly dataInputs = [{ id: "path", label: "Path", type: "string", value: stringSpec("") }] as const;
  protected readonly dataOutputs = [{ id: "exists", label: "Exists", type: "bool" }, { id: "isFolder", label: "Is Folder", type: "bool" }, { id: "size", label: "Size", type: "float" }, { id: "modified", label: "Modified", type: "string" }] as const;

  protected async run(ctx: ExecContext) {
    const path = await stringInput(ctx, "path");
    if (!path) throw new Error("No path");
    const s = await ctx.host.statPath(path);
    return {
      exists: s.exists,
      isFolder: s.isDirectory,
      size: s.size,
      modified: s.exists ? new Date(s.modified).toISOString() : "",
    };
  }
}

export const fileInfoNode: INode = new FileInfoNode();
