import type { INode, ShaderContext, ShaderOutputs } from "../../INode";
import { colorSpec, floatSpec } from "../_shared/nodeKit";

class CheckerNode implements INode {
  readonly type = "checker";
  readonly label = "Checker";
  readonly category = "Texture";
  readonly domains = ["shader"] as const;
  readonly inputs = [
    { id: "uv", label: "UV", type: "vec2" },
    { id: "a", label: "Color 1", type: "color", value: colorSpec(0.8, 0.8, 0.8) },
    { id: "b", label: "Color 2", type: "color", value: colorSpec(0.2, 0.2, 0.2) },
    { id: "scale", label: "Scale", type: "float", value: floatSpec(8, 0, undefined, 0.05) },
  ] as const;
  readonly outputs = [{ id: "color", label: "Color", type: "color" }] as const;

  generateShader(ctx: ShaderContext): ShaderOutputs {
    const fn = ctx.helper(
      "ng_checker",
      `fn ng_checker(uv: vec2f, a: vec4f, b: vec4f, scale: f32) -> vec4f {
  let cell = floor(uv * scale);
  return select(b, a, (cell.x + cell.y) % 2.0 == 0.0);
}`,
    );
    const a = ctx.input("a") ?? "vec4f(1.0)";
    const b = ctx.input("b") ?? "vec4f(0.0, 0.0, 0.0, 1.0)";
    return { color: `${fn}(${ctx.input("uv") ?? ctx.uv}, ${a}, ${b}, ${ctx.input("scale") ?? "8.0"})` };
  }
}

export const checkerNode: INode = new CheckerNode();
