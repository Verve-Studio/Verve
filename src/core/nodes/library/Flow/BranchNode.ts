import type { ExecContext, ExecResult, INode } from "../../INode";
import { EXEC_IN } from "../_shared/nodeKit";

class BranchNode implements INode {
  readonly type = "branch";
  readonly label = "Branch";
  readonly category = "Flow";
  readonly domains = ["automation"] as const;
  readonly inputs = [
    EXEC_IN,
    { id: "condition", label: "Condition", type: "bool", value: { kind: "bool", default: true } },
  ] as const;
  readonly outputs = [
    { id: "true", label: "True", type: "exec" },
    { id: "false", label: "False", type: "exec" },
  ] as const;

  async execute(ctx: ExecContext): Promise<ExecResult> {
    return { next: (await ctx.input("condition")) === true ? "true" : "false" };
  }
}

export const branchNode: INode = new BranchNode();
