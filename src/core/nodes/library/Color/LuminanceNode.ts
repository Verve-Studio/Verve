import type { INode, ShaderContext, ShaderOutputs } from "../../INode";
import { colorSpec, enumSpec } from "../_shared/nodeKit";

const METHODS: Record<string, { label: string; wgsl: (c: string) => string }> = {
  luminance: { label: "Luminance (Rec. 709)", wgsl: (c) => `dot(${c}, vec3f(0.2126, 0.7152, 0.0722))` },
  average: { label: "Average", wgsl: (c) => `dot(${c}, vec3f(1.0 / 3.0))` },
  lightness: {
    label: "Lightness",
    wgsl: (c) => `0.5 * (max(max(${c}.r, ${c}.g), ${c}.b) + min(min(${c}.r, ${c}.g), ${c}.b))`,
  },
  maximum: { label: "Maximum (Value)", wgsl: (c) => `max(max(${c}.r, ${c}.g), ${c}.b)` },
};

/** Greyscale value of a colour. */
class LuminanceNode implements INode {
  readonly type = "luminance";
  readonly label = "Luminance";
  readonly category = "Color";
  readonly domains = ["shader"] as const;
  readonly description = "Greyscale value of a colour (desaturate), by luminance, average, lightness or maximum.";
  readonly inputs = [{ id: "color", label: "Color", type: "color", value: colorSpec(1, 1, 1) }] as const;
  readonly outputs = [
    { id: "value", label: "Value", type: "float" },
    { id: "color", label: "Grey", type: "color" },
  ] as const;
  readonly params = [
    {
      id: "method",
      label: "Method",
      spec: enumSpec("luminance", Object.entries(METHODS).map(([id, m]) => [id, m.label])),
    },
  ] as const;

  generateShader(ctx: ShaderContext): ShaderOutputs {
    const method = METHODS[String(ctx.param("method"))] ?? METHODS.luminance;
    const c = ctx.local("vec4f", ctx.input("color") ?? "vec4f(1.0)");
    const v = ctx.local("f32", method.wgsl(`${c}.rgb`));
    return { value: v, color: `vec4f(vec3f(${v}), ${c}.a)` };
  }
}

export const luminanceNode: INode = new LuminanceNode();
