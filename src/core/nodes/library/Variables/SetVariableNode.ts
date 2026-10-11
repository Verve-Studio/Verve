import type { ExecContext, ExecResult, INode } from "../../INode";
import { EXEC_IN, EXEC_OUT, stringSpec } from "../_shared/nodeKit";

/** Stores a value under a name for the rest of the run (e.g. a list that a
 *  loop appends to). */
class SetVariableNode implements INode {
  readonly type = "setVariable";
  readonly label = "Set Variable";
  readonly category = "Variables";
  readonly domains = ["automation"] as const;
  readonly description = "Stores Value under Name for the rest of the run.";
  readonly inputs = [
    EXEC_IN,
    { id: "value", label: "Value", type: "any", value: { kind: "string", default: "" } },
  ] as const;
  readonly outputs = [EXEC_OUT, { id: "value", label: "Value", type: "any" }] as const;
  readonly params = [{ id: "name", label: "Name", spec: stringSpec("var") }];

  async execute(ctx: ExecContext): Promise<ExecResult> {
    const value = (await ctx.input("value")) ?? null;
    ctx.variables.set(String(ctx.param("name")), value);
    return { outputs: { value } };
  }
}

export const setVariableNode: INode = new SetVariableNode();
