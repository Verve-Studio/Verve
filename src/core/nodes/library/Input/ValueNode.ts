import type { ExecResult, INode, ShaderContext, ShaderOutputs, ExecContext } from "../../INode";
import { floatSpec } from "../_shared/nodeKit";

class ValueNode implements INode {
  readonly type = "value";
  readonly label = "Value";
  readonly category = "Input";
  readonly domains = ["shader", "automation"] as const;
  readonly inputs = [];
  readonly outputs = [{ id: "value", label: "Value", type: "float" }] as const;
  readonly params = [{ id: "value", label: "Value", spec: floatSpec(0.5) }];

  generateShader(ctx: ShaderContext): ShaderOutputs {
    return { value: ctx.uniform("value") };
  }

  execute(ctx: ExecContext): ExecResult {
    return { outputs: { value: Number(ctx.param("value")) } };
  }
}

export const valueNode: INode = new ValueNode();
