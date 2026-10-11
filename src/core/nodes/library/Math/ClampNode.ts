import type { ExecContext, ExecResult, INode, ShaderContext, ShaderOutputs } from "../../INode";
import { floatSpec, numberInput } from "../_shared/nodeKit";

class ClampNode implements INode {
  readonly type = "clamp";
  readonly label = "Clamp";
  readonly category = "Math";
  readonly domains = ["shader", "automation"] as const;
  readonly inputs = [
    { id: "value", label: "Value", type: "float", value: floatSpec(0) },
    { id: "min", label: "Min", type: "float", value: floatSpec(0) },
    { id: "max", label: "Max", type: "float", value: floatSpec(1) },
  ] as const;
  readonly outputs = [{ id: "result", label: "Result", type: "float" }] as const;

  // min(max()) rather than clamp(): WGSL's clamp is undefined when lo > hi.
  generateShader(ctx: ShaderContext): ShaderOutputs {
    const v = ctx.input("value") ?? "0.0";
    const lo = ctx.input("min") ?? "0.0";
    const hi = ctx.input("max") ?? "1.0";
    return { result: `min(max(${v}, ${lo}), ${hi})` };
  }

  async execute(ctx: ExecContext): Promise<ExecResult> {
    const v = await numberInput(ctx, "value");
    const lo = await numberInput(ctx, "min");
    const hi = await numberInput(ctx, "max");
    return { outputs: { result: Math.min(Math.max(v, lo), hi) } };
  }
}

export const clampNode: INode = new ClampNode();
