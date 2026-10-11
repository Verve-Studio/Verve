import type { ExecContext, ExecResult, INode, ShaderContext, ShaderOutputs } from "../../INode";
import { colorSpec, floatSpec, numberInput, vectorInput } from "../_shared/nodeKit";

class InvertNode implements INode {
  readonly type = "invert";
  readonly label = "Invert";
  readonly category = "Color";
  readonly domains = ["shader", "automation"] as const;
  readonly inputs = [
    { id: "factor", label: "Factor", type: "float", value: floatSpec(1, 0, 1) },
    { id: "color", label: "Color", type: "color", value: colorSpec(0, 0, 0) },
  ] as const;
  readonly outputs = [{ id: "color", label: "Color", type: "color" }] as const;

  generateShader(ctx: ShaderContext): ShaderOutputs {
    const fn = ctx.helper(
      "ng_invert",
      `fn ng_invert(f: f32, c: vec4f) -> vec4f {
  return vec4f(mix(c.rgb, 1.0 - c.rgb, f), c.a);
}`,
    );
    return { color: `${fn}(${ctx.input("factor") ?? "1.0"}, ${ctx.input("color") ?? "vec4f(0.0, 0.0, 0.0, 1.0)"})` };
  }

  async execute(ctx: ExecContext): Promise<ExecResult> {
    const f = await numberInput(ctx, "factor");
    const c = await vectorInput(ctx, "color", [0, 0, 0, 1]);
    const ch = (x: number): number => x + (1 - 2 * x) * f;
    return { outputs: { color: [ch(c[0]), ch(c[1]), ch(c[2]), c[3]] } };
  }
}

export const invertNode: INode = new InvertNode();
