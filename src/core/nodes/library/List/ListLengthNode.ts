import type { ExecContext, ExecResult, INode } from "../../INode";
import { listInput } from "../_shared/nodeKit";

class ListLengthNode implements INode {
  readonly type = "listLength";
  readonly label = "List Length";
  readonly category = "List";
  readonly domains = ["automation"] as const;
  readonly description = "Number of items in the list.";
  readonly inputs = [
    { id: "list", label: "List", type: "list" }
  ] as const;
  readonly outputs = [{ id: "length", label: "Length", type: "int" }] as const;

  async execute(ctx: ExecContext): Promise<ExecResult> {
    return { outputs: { length: (await listInput(ctx, "list")).length } };
  }
}

export const listLengthNode: INode = new ListLengthNode();
