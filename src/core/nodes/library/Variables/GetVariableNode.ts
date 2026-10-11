import type { ExecContext, ExecResult, INode } from "../../INode";
import { stringSpec } from "../_shared/nodeKit";

class GetVariableNode implements INode {
  readonly type = "getVariable";
  readonly label = "Get Variable";
  readonly category = "Variables";
  readonly domains = ["automation"] as const;
  readonly description =
    "The value last stored under Name (Default when it hasn't been set yet).";
  readonly inputs = [
    { id: "default", label: "Default", type: "any", value: { kind: "string", default: "" } },
  ] as const;
  readonly outputs = [
    { id: "value", label: "Value", type: "any" },
    { id: "isSet", label: "Is Set", type: "bool" },
  ] as const;
  readonly params = [{ id: "name", label: "Name", spec: stringSpec("var") }];

  async execute(ctx: ExecContext): Promise<ExecResult> {
    const name = String(ctx.param("name"));
    if (ctx.variables.has(name)) {
      return { outputs: { value: ctx.variables.get(name) ?? null, isSet: true } };
    }
    return { outputs: { value: (await ctx.input("default")) ?? null, isSet: false } };
  }
}

export const getVariableNode: INode = new GetVariableNode();
