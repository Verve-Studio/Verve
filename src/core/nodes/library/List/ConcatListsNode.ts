import type { ExecContext, ExecResult, INode } from "../../INode";
import { makeList } from "../../values";
import { listInput } from "../_shared/nodeKit";

class ConcatListsNode implements INode {
  readonly type = "listConcat";
  readonly label = "Concatenate Lists";
  readonly category = "List";
  readonly domains = ["automation"] as const;
  readonly description = "List A followed by List B.";
  readonly inputs = [
    { id: "a", label: "A", type: "list" },
    { id: "b", label: "B", type: "list" }
  ] as const;
  readonly outputs = [{ id: "list", label: "List", type: "list" }] as const;

  async execute(ctx: ExecContext): Promise<ExecResult> {
    const a = await listInput(ctx, "a");
    const b = await listInput(ctx, "b");
    return { outputs: { list: makeList([...a, ...b]) } };
  }
}

export const concatListsNode: INode = new ConcatListsNode();
