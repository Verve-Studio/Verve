import type { ExecContext, ExecResult, INode } from "../../INode";
import { formatValue, makeList } from "../../values";
import { enumSpec, listInput } from "../_shared/nodeKit";

class SortNode implements INode {
  readonly type = "listSort";
  readonly label = "Sort";
  readonly category = "List";
  readonly domains = ["automation"] as const;
  readonly description = "Sorted copy of the list. Numbers sort numerically; text naturally (file2 before file10).";
  readonly inputs = [
    { id: "list", label: "List", type: "list" }
  ] as const;
  readonly outputs = [{ id: "list", label: "List", type: "list" }] as const;
  readonly params = [
    {
      id: "order",
      label: "Order",
      spec: enumSpec("ascending", [
        ["ascending", "Ascending"],
        ["descending", "Descending"],
      ]),
    },
  ];

  async execute(ctx: ExecContext): Promise<ExecResult> {
    const items = [...(await listInput(ctx, "list"))];
    const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });
    items.sort((a, b) =>
      typeof a === "number" && typeof b === "number"
        ? a - b
        : collator.compare(formatValue(a), formatValue(b)),
    );
    if (ctx.param("order") === "descending") items.reverse();
    return { outputs: { list: makeList(items) } };
  }
}

export const sortNode: INode = new SortNode();
