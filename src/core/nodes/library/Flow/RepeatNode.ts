import type { ExecContext, ExecResult, INode } from "../../INode";
import { EXEC_IN, intInput } from "../_shared/nodeKit";

class RepeatNode implements INode {
  readonly type = "repeat";
  readonly label = "Repeat";
  readonly category = "Flow";
  readonly domains = ["automation"] as const;
  readonly description = "Runs Loop Body Count times (Index 0 … Count-1), then Completed.";
  readonly inputs = [
    EXEC_IN,
    { id: "count", label: "Count", type: "int", value: { kind: "int", default: 3, min: 0 } },
  ] as const;
  readonly outputs = [
    { id: "body", label: "Loop Body", type: "exec" },
    { id: "index", label: "Index", type: "int" },
    { id: "completed", label: "Completed", type: "exec" },
  ] as const;

  async execute(ctx: ExecContext): Promise<ExecResult> {
    const count = await intInput(ctx, "count");
    for (let index = 0; index < count; index++) {
      ctx.signal.throwIfAborted();
      ctx.setOutputs({ index });
      await ctx.runBranch("body");
    }
    return { next: "completed" };
  }
}

export const repeatNode: INode = new RepeatNode();
