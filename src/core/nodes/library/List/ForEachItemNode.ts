import type { ExecContext, ExecResult, INode } from "../../INode";
import { EXEC_IN, listInput } from "../_shared/nodeKit";

class ForEachItemNode implements INode {
  readonly type = "forEachItem";
  readonly label = "For Each Item";
  readonly category = "List";
  readonly domains = ["automation"] as const;
  readonly description = "Runs Loop Body once per list item, then Completed.";
  readonly inputs = [EXEC_IN, { id: "list", label: "List", type: "list" }] as const;
  readonly outputs = [
    { id: "body", label: "Loop Body", type: "exec" },
    { id: "item", label: "Item", type: "any" },
    { id: "index", label: "Index", type: "int" },
    { id: "completed", label: "Completed", type: "exec" },
  ] as const;

  async execute(ctx: ExecContext): Promise<ExecResult> {
    const items = await listInput(ctx, "list");
    for (let index = 0; index < items.length; index++) {
      ctx.signal.throwIfAborted();
      ctx.setOutputs({ item: items[index], index });
      await ctx.runBranch("body");
    }
    return { next: "completed" };
  }
}

export const forEachItemNode: INode = new ForEachItemNode();
