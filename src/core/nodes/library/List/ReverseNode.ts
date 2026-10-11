import type { ExecContext, ExecResult, INode } from "../../INode";
import { makeList } from "../../values";
import { listInput } from "../_shared/nodeKit";

class ReverseNode implements INode {
  readonly type = "listReverse";
  readonly label = "Reverse";
  readonly category = "List";
  readonly domains = ["automation"] as const;
  readonly description = "The list in reverse order.";
  readonly inputs = [
    { id: "list", label: "List", type: "list" }
  ] as const;
  readonly outputs = [{ id: "list", label: "List", type: "list" }] as const;

  async execute(ctx: ExecContext): Promise<ExecResult> {
    return { outputs: { list: makeList([...(await listInput(ctx, "list"))].reverse()) } };
  }
}

export const reverseNode: INode = new ReverseNode();
