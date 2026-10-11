import type { INode, ShaderContext, ShaderOutputs } from "../../INode";
import { colorSpec, floatSpec } from "../_shared/nodeKit";
import { fromDisplay, toDisplay } from "../_shared/shaderKit";

/** Photoshop-style Levels on RGB, in display (sRGB) values. */
class LevelsNode implements INode {
  readonly type = "levels";
  readonly label = "Levels";
  readonly category = "Color";
  readonly domains = ["shader"] as const;
  readonly description =
    "Remap tones: input black / white points and gamma (midtones), then output black / white. " +
    "Values above the white point stay above 1 (HDR).";
  readonly width = 180;
  readonly inputs = [
    { id: "color", label: "Color", type: "color", value: colorSpec(1, 1, 1) },
    { id: "inBlack", label: "Input Black", type: "float", value: floatSpec(0, 0, 1, 0.002) },
    { id: "inWhite", label: "Input White", type: "float", value: floatSpec(1, 0, 1, 0.002) },
    { id: "gamma", label: "Gamma", type: "float", value: floatSpec(1, 0.01, 10) },
    { id: "outBlack", label: "Output Black", type: "float", value: floatSpec(0, 0, 1, 0.002) },
    { id: "outWhite", label: "Output White", type: "float", value: floatSpec(1, 0, 1, 0.002) },
  ] as const;
  readonly outputs = [{ id: "color", label: "Color", type: "color" }] as const;

  generateShader(ctx: ShaderContext): ShaderOutputs {
    const fn = ctx.helper(
      "ng_levels",
      `fn ng_levels(c: vec3f, ib: f32, iw: f32, g: f32, ob: f32, ow: f32) -> vec3f {
  let x = max((c - vec3f(ib)) / max(iw - ib, 1e-5), vec3f(0.0));
  return mix(vec3f(ob), vec3f(ow), pow(x, vec3f(1.0 / max(g, 1e-3))));
}`,
    );
    const c = ctx.local("vec4f", ctx.input("color") ?? "vec4f(1.0)");
    const args = [
      toDisplay(ctx, `${c}.rgb`),
      ctx.input("inBlack") ?? "0.0",
      ctx.input("inWhite") ?? "1.0",
      ctx.input("gamma") ?? "1.0",
      ctx.input("outBlack") ?? "0.0",
      ctx.input("outWhite") ?? "1.0",
    ];
    return { color: `vec4f(${fromDisplay(ctx, `${fn}(${args.join(", ")})`)}, ${c}.a)` };
  }
}

export const levelsNode: INode = new LevelsNode();
