import type { ExecContext, ExecResult, INode, ShaderContext, ShaderOutputs } from "../../INode";
import { floatSpec, numberInput } from "../_shared/nodeKit";

class CombineXyNode implements INode {
  readonly type = "combineXy";
  readonly label = "Combine XY";
  readonly category = "Vector";
  readonly domains = ["shader", "automation"] as const;
  readonly inputs = [
    { id: "x", label: "X", type: "float", value: floatSpec(0) },
    { id: "y", label: "Y", type: "float", value: floatSpec(0) },
  ] as const;
  readonly outputs = [{ id: "vector", label: "Vector", type: "vec2" }] as const;

  generateShader(ctx: ShaderContext): ShaderOutputs {
    return { vector: `vec2f(${ctx.input("x") ?? "0.0"}, ${ctx.input("y") ?? "0.0"})` };
  }

  async execute(ctx: ExecContext): Promise<ExecResult> {
    return { outputs: { vector: [await numberInput(ctx, "x"), await numberInput(ctx, "y")] } };
  }
}

export const combineXyNode: INode = new CombineXyNode();
