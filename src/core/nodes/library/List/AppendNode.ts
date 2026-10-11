import type { ExecContext, ExecResult, INode } from "../../INode";
import { makeList } from "../../values";
import { intInput, listInput } from "../_shared/nodeKit";

class AppendNode implements INode {
  readonly type = "listAppend";
  readonly label = "Append";
  readonly category = "List";
  readonly domains = ["automation"] as const;
  readonly description = "Copy of the list with Value added at the end (or inserted at Index when Index >= 0).";
  readonly inputs = [
    { id: "list", label: "List", type: "list" },
    { id: "value", label: "Value", type: "any", value: { kind: "string", default: "" } },
    { id: "index", label: "Insert At", type: "int", value: { kind: "int", default: -1 } }
  ] as const;
  readonly outputs = [{ id: "list", label: "List", type: "list" }] as const;

  async execute(ctx: ExecContext): Promise<ExecResult> {
    const items = [...(await listInput(ctx, "list"))];
    const value = (await ctx.input("value")) ?? null;
    const at = await intInput(ctx, "index");
    if (at < 0 || at >= items.length) items.push(value);
    else items.splice(at, 0, value);
    return { outputs: { list: makeList(items) } };
  }
}

export const appendNode: INode = new AppendNode();
