import type { ExecContext, ExecResult, INode } from "../../INode";
import { formatValue } from "../../values";
import { listInput, stringInput, stringSpec } from "../_shared/nodeKit";

class JoinNode implements INode {
  readonly type = "textJoin";
  readonly label = "Join";
  readonly category = "Text";
  readonly domains = ["automation"] as const;
  readonly description = "Joins a list's items into one text with a separator.";
  readonly inputs = [
    { id: "list", label: "List", type: "list" },
    { id: "separator", label: "Separator", type: "string", value: stringSpec(", ") },
  ] as const;
  readonly outputs = [{ id: "result", label: "Text", type: "string" }] as const;

  async execute(ctx: ExecContext): Promise<ExecResult> {
    const items = await listInput(ctx, "list");
    const sep = await stringInput(ctx, "separator");
    return { outputs: { result: items.map(formatValue).join(sep) } };
  }
}

export const joinNode: INode = new JoinNode();
