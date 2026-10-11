import type { ExecContext, ExecResult, INode } from "../../INode";
import { makeList } from "../../values";
import { boolSpec, stringInput, stringSpec } from "../_shared/nodeKit";

class SplitNode implements INode {
  readonly type = "textSplit";
  readonly label = "Split";
  readonly category = "Text";
  readonly domains = ["automation"] as const;
  readonly description =
    "Splits the text at every Separator into a list (empty separator = per character).";
  readonly inputs = [
    { id: "text", label: "Text", type: "string", value: stringSpec() },
    { id: "separator", label: "Separator", type: "string", value: stringSpec(",") },
  ] as const;
  readonly outputs = [{ id: "list", label: "List", type: "list" }] as const;
  readonly params = [
    { id: "trim", label: "Trim Parts", spec: boolSpec(false) },
    { id: "skipEmpty", label: "Skip Empty", spec: boolSpec(false) },
  ];

  async execute(ctx: ExecContext): Promise<ExecResult> {
    const text = await stringInput(ctx, "text");
    let parts = text.split(await stringInput(ctx, "separator"));
    if (ctx.param("trim") === true) parts = parts.map((p) => p.trim());
    if (ctx.param("skipEmpty") === true) parts = parts.filter((p) => p !== "");
    return { outputs: { list: makeList(parts) } };
  }
}

export const splitNode: INode = new SplitNode();
