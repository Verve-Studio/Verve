import type { ExecContext, ExecResult, INode, ShaderContext, ShaderOutputs } from "../../INode";
import { colorSpec, vectorInput } from "../_shared/nodeKit";

const CHANNELS = ["r", "g", "b", "a"] as const;

class SeparateRgbaNode implements INode {
  readonly type = "separateRgba";
  readonly label = "Separate RGBA";
  readonly category = "Color";
  readonly domains = ["shader", "automation"] as const;
  readonly inputs = [{ id: "color", label: "Color", type: "color", value: colorSpec(1, 1, 1) }] as const;
  readonly outputs = CHANNELS.map((c) => ({ id: c, label: c.toUpperCase(), type: "float" as const }));

  generateShader(ctx: ShaderContext): ShaderOutputs {
    const c = `(${ctx.input("color") ?? "vec4f(1.0)"})`;
    return Object.fromEntries(CHANNELS.map((ch) => [ch, `${c}.${ch}`]));
  }

  async execute(ctx: ExecContext): Promise<ExecResult> {
    const c = await vectorInput(ctx, "color", [1, 1, 1, 1]);
    return { outputs: Object.fromEntries(CHANNELS.map((ch, i) => [ch, c[i]])) };
  }
}

export const separateRgbaNode: INode = new SeparateRgbaNode();
