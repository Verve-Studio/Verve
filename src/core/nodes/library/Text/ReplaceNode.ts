import type { ExecContext, ExecResult, INode } from "../../INode";
import { boolSpec, stringInput, stringSpec } from "../_shared/nodeKit";

class ReplaceNode implements INode {
  readonly type = "textReplace";
  readonly label = "Replace";
  readonly category = "Text";
  readonly domains = ["automation"] as const;
  readonly description = "Replaces every occurrence of Find with Replace With.";
  readonly inputs = [
    { id: "text", label: "Text", type: "string", value: stringSpec() },
    { id: "find", label: "Find", type: "string", value: stringSpec() },
    { id: "replace", label: "Replace With", type: "string", value: stringSpec() },
  ] as const;
  readonly outputs = [{ id: "result", label: "Text", type: "string" }] as const;
  readonly params = [{ id: "ignoreCase", label: "Ignore Case", spec: boolSpec(false) }];

  async execute(ctx: ExecContext): Promise<ExecResult> {
    const text = await stringInput(ctx, "text");
    const find = await stringInput(ctx, "find");
    const replace = await stringInput(ctx, "replace");
    if (!find) return { outputs: { result: text } };
    const escaped = find.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const re = new RegExp(escaped, ctx.param("ignoreCase") === true ? "gi" : "g");
    return { outputs: { result: text.replace(re, () => replace) } };
  }
}

export const replaceNode: INode = new ReplaceNode();
