import type { ExecContext, ExecResult, INode, ShaderContext, ShaderOutputs } from "../../INode";
import { vec2Spec, vectorInput } from "../_shared/nodeKit";

class SeparateXyNode implements INode {
  readonly type = "separateXy";
  readonly label = "Separate XY";
  readonly category = "Vector";
  readonly domains = ["shader", "automation"] as const;
  readonly inputs = [{ id: "vector", label: "Vector", type: "vec2", value: vec2Spec(0, 0) }] as const;
  readonly outputs = [
    { id: "x", label: "X", type: "float" },
    { id: "y", label: "Y", type: "float" },
  ] as const;

  generateShader(ctx: ShaderContext): ShaderOutputs {
    const v = `(${ctx.input("vector") ?? "vec2f(0.0)"})`;
    return { x: `${v}.x`, y: `${v}.y` };
  }

  async execute(ctx: ExecContext): Promise<ExecResult> {
    const v = await vectorInput(ctx, "vector", [0, 0]);
    return { outputs: { x: v[0], y: v[1] } };
  }
}

export const separateXyNode: INode = new SeparateXyNode();
