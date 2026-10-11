import type { ExecContext, ExecResult, INode, ShaderContext, ShaderOutputs } from "../../INode";
import { colorSpec } from "../_shared/nodeKit";

class ColorNode implements INode {
  readonly type = "color";
  readonly label = "Color";
  readonly category = "Input";
  readonly domains = ["shader", "automation"] as const;
  readonly inputs = [];
  readonly outputs = [{ id: "color", label: "Color", type: "color" }] as const;
  readonly params = [{ id: "color", label: "Color", spec: colorSpec(1, 1, 1) }];

  generateShader(ctx: ShaderContext): ShaderOutputs {
    return { color: ctx.uniform("color") };
  }

  execute(ctx: ExecContext): ExecResult {
    const c = ctx.param("color");
    return { outputs: { color: Array.isArray(c) ? c : [1, 1, 1, 1] } };
  }
}

export const colorNode: INode = new ColorNode();
