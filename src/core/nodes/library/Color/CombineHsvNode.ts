import type { INode, ShaderContext, ShaderOutputs } from "../../INode";
import { floatSpec } from "../_shared/nodeKit";
import { HSV_TO_RGB } from "./SeparateHsvNode";

/** Colour from hue (0–1, wraps), saturation and value. */
class CombineHsvNode implements INode {
  readonly type = "combineHsv";
  readonly label = "Combine HSV";
  readonly category = "Color";
  readonly domains = ["shader"] as const;
  readonly inputs = [
    { id: "h", label: "Hue", type: "float", value: floatSpec(0, 0, 1, 0.002) },
    { id: "s", label: "Saturation", type: "float", value: floatSpec(1, 0, 1) },
    { id: "v", label: "Value", type: "float", value: floatSpec(1, 0, 1) },
    { id: "alpha", label: "Alpha", type: "float", value: floatSpec(1, 0, 1) },
  ] as const;
  readonly outputs = [{ id: "color", label: "Color", type: "color" }] as const;

  generateShader(ctx: ShaderContext): ShaderOutputs {
    const fn = ctx.helper("ng_hsv_to_rgb", HSV_TO_RGB);
    const hsv = `vec3f(fract(${ctx.input("h") ?? "0.0"}), clamp(${ctx.input("s") ?? "1.0"}, 0.0, 1.0), max(${ctx.input("v") ?? "1.0"}, 0.0))`;
    return { color: `vec4f(${fn}(${hsv}), ${ctx.input("alpha") ?? "1.0"})` };
  }
}

export const combineHsvNode: INode = new CombineHsvNode();
