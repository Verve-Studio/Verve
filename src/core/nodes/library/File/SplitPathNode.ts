import type { ExecContext, ExecResult, INode } from "../../INode";
import { stringInput, stringSpec } from "../_shared/nodeKit";
import { splitPath } from "../_shared/paths";

class SplitPathNode implements INode {
  readonly type = "splitPath";
  readonly label = "Split Path";
  readonly category = "Path";
  readonly domains = ["automation"] as const;
  readonly description = "Folder, file name, name without extension and extension of a path.";
  readonly width = 200;
  readonly inputs = [{ id: "path", label: "Path", type: "string", value: stringSpec() }] as const;
  readonly outputs = [
    { id: "folder", label: "Folder", type: "string" },
    { id: "name", label: "File Name", type: "string" },
    { id: "stem", label: "Stem", type: "string" },
    { id: "extension", label: "Extension", type: "string" },
  ] as const;

  async execute(ctx: ExecContext): Promise<ExecResult> {
    return { outputs: { ...splitPath(await stringInput(ctx, "path")) } };
  }
}

export const splitPathNode: INode = new SplitPathNode();
