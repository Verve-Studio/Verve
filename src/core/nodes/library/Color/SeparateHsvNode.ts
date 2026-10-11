import type { INode, ShaderContext, ShaderOutputs } from "../../INode";
import { colorSpec } from "../_shared/nodeKit";

export const RGB_TO_HSV = /* wgsl */ `fn ng_rgb_to_hsv(c: vec3f) -> vec3f {
  let k = vec4f(0.0, -1.0 / 3.0, 2.0 / 3.0, -1.0);
  let p = select(vec4f(c.gb, k.xy), vec4f(c.bg, k.wz), c.g < c.b);
  let q = select(vec4f(p.xyw, c.r), vec4f(c.r, p.yzx), p.x <= c.r);
  let d = q.x - min(q.w, q.y);
  return vec3f(fract(abs(q.z + (q.w - q.y) / (6.0 * d + 1e-10))), d / (q.x + 1e-10), q.x);
}`;

export const HSV_TO_RGB = /* wgsl */ `fn ng_hsv_to_rgb(c: vec3f) -> vec3f {
  let p = abs(fract(vec3f(c.x) + vec3f(1.0, 2.0 / 3.0, 1.0 / 3.0)) * 6.0 - 3.0);
  return c.z * mix(vec3f(1.0), clamp(p - 1.0, vec3f(0.0), vec3f(1.0)), c.y);
}`;

/** Hue (0–1), saturation and value of a colour. */
class SeparateHsvNode implements INode {
  readonly type = "separateHsv";
  readonly label = "Separate HSV";
  readonly category = "Color";
  readonly domains = ["shader"] as const;
  readonly inputs = [{ id: "color", label: "Color", type: "color", value: colorSpec(1, 1, 1) }] as const;
  readonly outputs = [
    { id: "h", label: "Hue", type: "float" },
    { id: "s", label: "Saturation", type: "float" },
    { id: "v", label: "Value", type: "float" },
    { id: "alpha", label: "Alpha", type: "float" },
  ] as const;

  generateShader(ctx: ShaderContext): ShaderOutputs {
    const fn = ctx.helper("ng_rgb_to_hsv", RGB_TO_HSV);
    const c = ctx.local("vec4f", ctx.input("color") ?? "vec4f(1.0)");
    const hsv = ctx.local("vec3f", `${fn}(${c}.rgb)`);
    return { h: `${hsv}.x`, s: `${hsv}.y`, v: `${hsv}.z`, alpha: `${c}.a` };
  }
}

export const separateHsvNode: INode = new SeparateHsvNode();
