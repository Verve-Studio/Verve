import type { ExecContext, ExecResult, INode } from "../../INode";
import { stringInput, stringSpec } from "../_shared/nodeKit";
import { joinPath, splitPath } from "../_shared/paths";

class ChangeExtensionNode implements INode {
  readonly type = "changeExtension";
  readonly label = "Change Extension";
  readonly category = "Path";
  readonly domains = ["automation"] as const;
  readonly description = "The path with its extension replaced (e.g. photo.tif → photo.png).";
  readonly width = 200;
  readonly inputs = [
    { id: "path", label: "Path", type: "string", value: stringSpec() },
    { id: "extension", label: "Extension", type: "string", value: stringSpec("png") },
  ] as const;
  readonly outputs = [{ id: "path", label: "Path", type: "string" }] as const;

  async execute(ctx: ExecContext): Promise<ExecResult> {
    const { folder, stem } = splitPath(await stringInput(ctx, "path"));
    const ext = (await stringInput(ctx, "extension")).replace(/^\./, "");
    return { outputs: { path: joinPath(folder, ext ? `${stem}.${ext}` : stem) } };
  }
}

export const changeExtensionNode: INode = new ChangeExtensionNode();
