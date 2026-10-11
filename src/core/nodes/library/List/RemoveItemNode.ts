import type { ExecContext, ExecResult, INode } from "../../INode";
import { makeList } from "../../values";
import { intInput, listInput, resolveIndex } from "../_shared/nodeKit";

class RemoveItemNode implements INode {
  readonly type = "listRemoveItem";
  readonly label = "Remove Item";
  readonly category = "List";
  readonly domains = ["automation"] as const;
  readonly description = "Copy of the list without the item at Index (negative counts from the end).";
  readonly inputs = [
    { id: "list", label: "List", type: "list" },
    { id: "index", label: "Index", type: "int", value: { kind: "int", default: 0 } }
  ] as const;
  readonly outputs = [{ id: "list", label: "List", type: "list" },
    { id: "removed", label: "Removed", type: "any" },
  ] as const;

  async execute(ctx: ExecContext): Promise<ExecResult> {
    const items = [...(await listInput(ctx, "list"))];
    const i = resolveIndex(await intInput(ctx, "index"), items.length);
    const removed = i === null ? null : items.splice(i, 1)[0];
    return { outputs: { list: makeList(items), removed } };
  }
}

export const removeItemNode: INode = new RemoveItemNode();
