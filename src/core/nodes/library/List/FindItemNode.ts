import type { ExecContext, ExecResult, INode } from "../../INode";
import { valuesEqual } from "../../values";
import { listInput } from "../_shared/nodeKit";

class FindItemNode implements INode {
  readonly type = "listFind";
  readonly label = "Find Item";
  readonly category = "List";
  readonly domains = ["automation"] as const;
  readonly description = "Index of the first item equal to Value (-1 when absent).";
  readonly inputs = [
    { id: "list", label: "List", type: "list" },
    { id: "value", label: "Value", type: "any", value: { kind: "string", default: "" } }
  ] as const;
  readonly outputs = [{ id: "index", label: "Index", type: "int" },
    { id: "found", label: "Found", type: "bool" },
  ] as const;

  async execute(ctx: ExecContext): Promise<ExecResult> {
    const items = await listInput(ctx, "list");
    const value = (await ctx.input("value")) ?? null;
    const index = items.findIndex((item) => valuesEqual(item, value));
    return { outputs: { index, found: index >= 0 } };
  }
}

export const findItemNode: INode = new FindItemNode();
