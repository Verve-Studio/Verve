import type { ExecContext, ExecResult, INode, NodePorts, PortDef } from "../../INode";
import type { ParamValue } from "../../graphTypes";
import { EXEC_IN, intSpec, memoPorts } from "../_shared/nodeKit";

const MAX_OUTPUTS = 10;
const outputCount = (v: ParamValue): number => Math.min(MAX_OUTPUTS, Math.max(2, Number(v) || 2));

const portsFor = memoPorts((key) => {
  const outputs: PortDef[] = [];
  for (let i = 0; i < Number(key); i++) outputs.push({ id: `then${i}`, label: `Then ${i}`, type: "exec" });
  return { inputs: [EXEC_IN], outputs };
});

class SequenceNode implements INode {
  readonly type = "sequence";
  readonly label = "Sequence";
  readonly category = "Flow";
  readonly domains = ["automation"] as const;
  readonly description = "Runs each Then output's chain in order.";
  readonly params = [{ id: "count", label: "Outputs", spec: intSpec(2, 2, MAX_OUTPUTS) }];
  readonly inputs = portsFor("2").inputs;
  readonly outputs = portsFor("2").outputs;

  ports(params: Readonly<Record<string, ParamValue>>): NodePorts {
    return portsFor(String(outputCount(params.count)));
  }

  async execute(ctx: ExecContext): Promise<ExecResult> {
    for (let i = 0; i < outputCount(ctx.param("count")); i++) await ctx.runBranch(`then${i}`);
    return { next: null };
  }
}

export const sequenceNode: INode = new SequenceNode();
