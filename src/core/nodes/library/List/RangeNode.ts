import type { ExecContext, ExecResult, INode } from "../../INode";
import { makeList } from "../../values";
import { intInput, numberInput } from "../_shared/nodeKit";

class RangeNode implements INode {
  readonly type = "listRange";
  readonly label = "Range";
  readonly category = "List";
  readonly domains = ["automation"] as const;
  readonly description = "List of Count numbers: Start, Start + Step, …";
  readonly inputs = [
    { id: "start", label: "Start", type: "float", value: { kind: "float", default: 0 } },
    { id: "count", label: "Count", type: "int", value: { kind: "int", default: 10, min: 0 } },
    { id: "step", label: "Step", type: "float", value: { kind: "float", default: 1 } }
  ] as const;
  readonly outputs = [{ id: "list", label: "List", type: "list" }] as const;

  async execute(ctx: ExecContext): Promise<ExecResult> {
    const start = await numberInput(ctx, "start");
    const count = Math.max(0, Math.min(1_000_000, await intInput(ctx, "count")));
    const step = await numberInput(ctx, "step");
    return { outputs: { list: makeList(Array.from({ length: count }, (_, i) => start + i * step)) } };
  }
}

export const rangeNode: INode = new RangeNode();
