import type { ExecContext, ExecResult, INode } from "../../INode";
import { stringInput, stringSpec } from "../_shared/nodeKit";
import { joinPath } from "../_shared/paths";

class JoinPathNode implements INode {
  readonly type = "joinPath";
  readonly label = "Join Path";
  readonly category = "Path";
  readonly domains = ["automation"] as const;
  readonly description = "Folder + file name, with the right separator.";
  readonly width = 200;
  readonly inputs = [
    { id: "folder", label: "Folder", type: "string", value: stringSpec("", "C:\\images") },
    { id: "name", label: "Name", type: "string", value: stringSpec("", "out.png") },
  ] as const;
  readonly outputs = [{ id: "path", label: "Path", type: "string" }] as const;

  async execute(ctx: ExecContext): Promise<ExecResult> {
    return {
      outputs: { path: joinPath(await stringInput(ctx, "folder"), await stringInput(ctx, "name")) },
    };
  }
}

export const joinPathNode: INode = new JoinPathNode();
