import type { ExecContext, ExecResult, INode, ShaderContext, ShaderOutputs } from "../../INode";
import { floatSpec, numberInput } from "../_shared/nodeKit";

const CHANNELS = ["r", "g", "b", "a"] as const;

class CombineRgbaNode implements INode {
  readonly type = "combineRgba";
  readonly label = "Combine RGBA";
  readonly category = "Color";
  readonly domains = ["shader", "automation"] as const;
  readonly inputs = CHANNELS.map((c) => ({
    id: c,
    label: c.toUpperCase(),
    type: "float" as const,
    value: floatSpec(c === "a" ? 1 : 0, 0, 1),
  }));
  readonly outputs = [{ id: "color", label: "Color", type: "color" }] as const;

  generateShader(ctx: ShaderContext): ShaderOutputs {
    const parts = CHANNELS.map((c) => ctx.input(c) ?? (c === "a" ? "1.0" : "0.0"));
    return { color: `vec4f(${parts.join(", ")})` };
  }

  async execute(ctx: ExecContext): Promise<ExecResult> {
    const color: number[] = [];
    for (const c of CHANNELS) color.push(await numberInput(ctx, c));
    return { outputs: { color } };
  }
}

export const combineRgbaNode: INode = new CombineRgbaNode();
