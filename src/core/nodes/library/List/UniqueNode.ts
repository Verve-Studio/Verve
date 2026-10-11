import type { ExecContext, ExecResult, INode } from "../../INode";
import { makeList, valuesEqual, type RuntimeValue } from "../../values";
import { listInput } from "../_shared/nodeKit";

class UniqueNode implements INode {
  readonly type = "listUnique";
  readonly label = "Remove Duplicates";
  readonly category = "List";
  readonly domains = ["automation"] as const;
  readonly description = "The list with repeated items removed (first one kept).";
  readonly inputs = [
    { id: "list", label: "List", type: "list" }
  ] as const;
  readonly outputs = [{ id: "list", label: "List", type: "list" }] as const;

  async execute(ctx: ExecContext): Promise<ExecResult> {
    const out: RuntimeValue[] = [];
    for (const item of await listInput(ctx, "list")) {
      if (!out.some((o) => valuesEqual(o, item))) out.push(item);
    }
    return { outputs: { list: makeList(out) } };
  }
}

export const uniqueNode: INode = new UniqueNode();
