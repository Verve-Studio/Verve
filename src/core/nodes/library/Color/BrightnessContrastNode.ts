import type { ExecContext, ExecResult, INode, ShaderContext, ShaderOutputs } from "../../INode";
import { colorSpec, floatSpec, numberInput, vectorInput } from "../_shared/nodeKit";

/** out = max((1 + contrast) · c + brightness − contrast / 2, 0), RGB only. */
class BrightnessContrastNode implements INode {
  readonly type = "brightnessContrast";
  readonly label = "Brightness/Contrast";
  readonly category = "Color";
  readonly domains = ["shader", "automation"] as const;
  readonly width = 180;
  readonly inputs = [
    { id: "color", label: "Color", type: "color", value: colorSpec(1, 1, 1) },
    { id: "brightness", label: "Brightness", type: "float", value: floatSpec(0, -1, 1) },
    { id: "contrast", label: "Contrast", type: "float", value: floatSpec(0, -1, 1) },
  ] as const;
  readonly outputs = [{ id: "color", label: "Color", type: "color" }] as const;

  generateShader(ctx: ShaderContext): ShaderOutputs {
    const fn = ctx.helper(
      "ng_brightness_contrast",
      `fn ng_brightness_contrast(c: vec4f, brightness: f32, contrast: f32) -> vec4f {
  return vec4f(max((1.0 + contrast) * c.rgb + brightness - contrast * 0.5, vec3f(0.0)), c.a);
}`,
    );
    const c = ctx.input("color") ?? "vec4f(1.0)";
    return {
      color: `${fn}(${c}, ${ctx.input("brightness") ?? "0.0"}, ${ctx.input("contrast") ?? "0.0"})`,
    };
  }

  async execute(ctx: ExecContext): Promise<ExecResult> {
    const c = await vectorInput(ctx, "color", [1, 1, 1, 1]);
    const br = await numberInput(ctx, "brightness");
    const co = await numberInput(ctx, "contrast");
    const ch = (x: number): number => Math.max((1 + co) * x + br - co * 0.5, 0);
    return { outputs: { color: [ch(c[0]), ch(c[1]), ch(c[2]), c[3]] } };
  }
}

export const brightnessContrastNode: INode = new BrightnessContrastNode();
