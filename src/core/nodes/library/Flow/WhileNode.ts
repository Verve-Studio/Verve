import type { ExecContext, ExecResult, INode } from "../../INode";
import { EXEC_IN } from "../_shared/nodeKit";

class WhileNode implements INode {
  readonly type = "while";
  readonly label = "While";
  readonly category = "Flow";
  readonly domains = ["automation"] as const;
  readonly description =
    "Runs Loop Body while Condition is true (re-read before every pass), then Completed.";
  readonly inputs = [
    EXEC_IN,
    { id: "condition", label: "Condition", type: "bool", value: { kind: "bool", default: false } },
  ] as const;
  readonly outputs = [
    { id: "body", label: "Loop Body", type: "exec" },
    { id: "index", label: "Index", type: "int" },
    { id: "completed", label: "Completed", type: "exec" },
  ] as const;

  async execute(ctx: ExecContext): Promise<ExecResult> {
    for (let index = 0; ; index++) {
      ctx.signal.throwIfAborted();
      // Publishing the index also invalidates pure nodes, so Condition is fresh.
      ctx.setOutputs({ index });
      if ((await ctx.input("condition")) !== true) break;
      await ctx.runBranch("body");
    }
    return { next: "completed" };
  }
}

export const whileNode: INode = new WhileNode();
