import type { ExecContext, ExecResult, INode, NodePorts, PortDef } from "../../INode";
import type { ParamValue } from "../../graphTypes";
import { makeList, type RuntimeValue } from "../../values";
import { intSpec, memoPorts, stringSpec } from "../_shared/nodeKit";

const MAX_ITEMS = 32;
const itemCount = (v: ParamValue): number => Math.min(MAX_ITEMS, Math.max(0, Number(v) || 0));

const portsFor = memoPorts((key) => {
  const inputs: PortDef[] = [];
  for (let i = 0; i < Number(key); i++) {
    inputs.push({ id: `item${i}`, label: `Item ${i}`, type: "any", value: stringSpec() });
  }
  return { inputs, outputs: [{ id: "list", label: "List", type: "list" }] };
});

/** A list from its item inputs (0 items = an empty list). */
class MakeListNode implements INode {
  readonly type = "makeList";
  readonly label = "Make List";
  readonly category = "List";
  readonly domains = ["automation"] as const;
  readonly description = "Builds a list from the item inputs, in order.";
  readonly params = [{ id: "count", label: "Items", spec: intSpec(2, 0, MAX_ITEMS) }];
  readonly inputs = portsFor("2").inputs;
  readonly outputs = portsFor("2").outputs;

  ports(params: Readonly<Record<string, ParamValue>>): NodePorts {
    return portsFor(String(itemCount(params.count)));
  }

  async execute(ctx: ExecContext): Promise<ExecResult> {
    const items: RuntimeValue[] = [];
    for (let i = 0; i < itemCount(ctx.param("count")); i++) {
      items.push((await ctx.input(`item${i}`)) ?? null);
    }
    return { outputs: { list: makeList(items) } };
  }
}

export const makeListNode: INode = new MakeListNode();
