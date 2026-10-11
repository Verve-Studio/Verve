import type { ExecContext, ExecResult, INode } from "../../INode";
import { formatValue, makeList } from "../../values";
import { boolSpec, listInput, stringInput, wildcardRegExp } from "../_shared/nodeKit";

class FilterTextNode implements INode {
  readonly type = "listFilterText";
  readonly label = "Filter By Text";
  readonly category = "List";
  readonly domains = ["automation"] as const;
  readonly description = "Items whose text matches Pattern (wildcards * and ?, e.g. *.png), or that don't with Invert.";
  readonly inputs = [
    { id: "list", label: "List", type: "list" },
    { id: "pattern", label: "Pattern", type: "string", value: { kind: "string", default: "*" } }
  ] as const;
  readonly outputs = [{ id: "list", label: "List", type: "list" }] as const;
  readonly params = [{ id: "invert", label: "Invert", spec: boolSpec(false) }];

  async execute(ctx: ExecContext): Promise<ExecResult> {
    const items = await listInput(ctx, "list");
    const re = wildcardRegExp(await stringInput(ctx, "pattern"));
    const invert = ctx.param("invert") === true;
    return { outputs: { list: makeList(items.filter((v) => re.test(formatValue(v)) !== invert)) } };
  }
}

export const filterTextNode: INode = new FilterTextNode();
