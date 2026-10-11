import type { ExecContext, ExecResult, INode, NodePorts, PortDef } from "../../INode";
import type { ParamValue } from "../../graphTypes";
import { convertValue } from "../../values";
import { intSpec, memoPorts, stringSpec } from "../_shared/nodeKit";

const MAX_INPUTS = 16;
const inputCount = (v: ParamValue): number => Math.min(MAX_INPUTS, Math.max(2, Number(v) || 2));

const portsFor = memoPorts((key) => {
  const inputs: PortDef[] = [];
  for (let i = 0; i < Number(key); i++) {
    inputs.push({ id: `in${i}`, label: String.fromCharCode(65 + i), type: "any", value: stringSpec() });
  }
  return { inputs, outputs: [{ id: "result", label: "Text", type: "string" }] };
});

/** Joins its inputs into one text (non-text values are formatted). */
class ConcatNode implements INode {
  readonly type = "textConcat";
  readonly label = "Concatenate";
  readonly category = "Text";
  readonly domains = ["automation"] as const;
  readonly description = "Joins the inputs, in order, with an optional separator.";
  readonly params = [
    { id: "count", label: "Inputs", spec: intSpec(2, 2, MAX_INPUTS) },
    { id: "separator", label: "Separator", spec: stringSpec("") },
  ];
  readonly inputs = portsFor("2").inputs;
  readonly outputs = portsFor("2").outputs;

  ports(params: Readonly<Record<string, ParamValue>>): NodePorts {
    return portsFor(String(inputCount(params.count)));
  }

  async execute(ctx: ExecContext): Promise<ExecResult> {
    const parts: string[] = [];
    for (let i = 0; i < inputCount(ctx.param("count")); i++) {
      const v = await ctx.input(`in${i}`);
      parts.push(v === undefined ? "" : String(convertValue(v, "string")));
    }
    return { outputs: { result: parts.join(String(ctx.param("separator"))) } };
  }
}

export const concatNode: INode = new ConcatNode();
