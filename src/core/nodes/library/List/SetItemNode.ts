import type { ExecContext, ExecResult, INode } from "../../INode";
import { makeList } from "../../values";
import { intInput, listInput, resolveIndex } from "../_shared/nodeKit";

class SetItemNode implements INode {
  readonly type = "listSetItem";
  readonly label = "Set Item";
  readonly category = "List";
  readonly domains = ["automation"] as const;
  readonly description = "Copy of the list with the item at Index replaced (negative counts from the end).";
  readonly inputs = [
    { id: "list", label: "List", type: "list" },
    { id: "index", label: "Index", type: "int", value: { kind: "int", default: 0 } },
    { id: "value", label: "Value", type: "any", value: { kind: "string", default: "" } }
  ] as const;
  readonly outputs = [{ id: "list", label: "List", type: "list" }] as const;

  async execute(ctx: ExecContext): Promise<ExecResult> {
    const items = [...(await listInput(ctx, "list"))];
    const i = resolveIndex(await intInput(ctx, "index"), items.length);
    if (i === null) throw new Error(`Index out of range (list has ${items.length} items)`);
    items[i] = (await ctx.input("value")) ?? null;
    return { outputs: { list: makeList(items) } };
  }
}

export const setItemNode: INode = new SetItemNode();
