import type { ExecContext, ExecResult, INode } from "../../INode";
import { makeList } from "../../values";
import { intInput, listInput } from "../_shared/nodeKit";

class SliceNode implements INode {
  readonly type = "listSlice";
  readonly label = "Slice";
  readonly category = "List";
  readonly domains = ["automation"] as const;
  readonly description = "Items from Start up to, not including, End (negative values count from the end).";
  readonly inputs = [
    { id: "list", label: "List", type: "list" },
    { id: "start", label: "Start", type: "int", value: { kind: "int", default: 0 } },
    { id: "end", label: "End", type: "int", value: { kind: "int", default: 1000000 } }
  ] as const;
  readonly outputs = [{ id: "list", label: "List", type: "list" }] as const;

  async execute(ctx: ExecContext): Promise<ExecResult> {
    const items = await listInput(ctx, "list");
    const start = await intInput(ctx, "start");
    const end = await intInput(ctx, "end");
    return { outputs: { list: makeList(items.slice(start, end)) } };
  }
}

export const sliceNode: INode = new SliceNode();
