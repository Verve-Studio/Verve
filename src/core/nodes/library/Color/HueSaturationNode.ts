import type { ExecContext, ExecResult, INode, ShaderContext, ShaderOutputs } from "../../INode";
import { colorSpec, floatSpec, numberInput, vectorInput } from "../_shared/nodeKit";

const HELPER = /* wgsl */ `fn ng_hue_sat(c: vec4f, hue: f32, sat: f32, val: f32) -> vec4f {
  let k = vec4f(0.0, -1.0 / 3.0, 2.0 / 3.0, -1.0);
  let p = select(vec4f(c.gb, k.xy), vec4f(c.bg, k.wz), c.g < c.b);
  let q = select(vec4f(p.xyw, c.r), vec4f(c.r, p.yzx), p.x <= c.r);
  let d = q.x - min(q.w, q.y);
  let h = fract(abs(q.z + (q.w - q.y) / (6.0 * d + 1e-10)) + hue);
  let s = clamp(d / (q.x + 1e-10) * sat, 0.0, 1.0);
  let v = q.x * val;
  let rgb = v * mix(vec3f(1.0), clamp(abs(fract(vec3f(h) + vec3f(1.0, 2.0 / 3.0, 1.0 / 3.0)) * 6.0 - 3.0) - 1.0, vec3f(0.0), vec3f(1.0)), s);
  return vec4f(rgb, c.a);
}`;

/** Shift hue (turns), scale saturation and value in HSV. */
class HueSaturationNode implements INode {
  readonly type = "hueSaturation";
  readonly label = "Hue/Saturation";
  readonly category = "Color";
  readonly domains = ["shader", "automation"] as const;
  readonly width = 180;
  readonly inputs = [
    { id: "color", label: "Color", type: "color", value: colorSpec(1, 1, 1) },
    { id: "hue", label: "Hue", type: "float", value: floatSpec(0, -0.5, 0.5, 0.005) },
    { id: "saturation", label: "Saturation", type: "float", value: floatSpec(1, 0, 2) },
    { id: "value", label: "Value", type: "float", value: floatSpec(1, 0, 2) },
  ] as const;
  readonly outputs = [{ id: "color", label: "Color", type: "color" }] as const;

  generateShader(ctx: ShaderContext): ShaderOutputs {
    const fn = ctx.helper("ng_hue_sat", HELPER);
    const c = ctx.input("color") ?? "vec4f(1.0)";
    const h = ctx.input("hue") ?? "0.0";
    const s = ctx.input("saturation") ?? "1.0";
    const v = ctx.input("value") ?? "1.0";
    return { color: `${fn}(${c}, ${h}, ${s}, ${v})` };
  }

  async execute(ctx: ExecContext): Promise<ExecResult> {
    const [r, g, b, a] = await vectorInput(ctx, "color", [1, 1, 1, 1]);
    const max = Math.max(r, g, b);
    const d = max - Math.min(r, g, b);
    let h = 0;
    if (d > 0) {
      if (max === r) h = ((g - b) / d) % 6;
      else if (max === g) h = (b - r) / d + 2;
      else h = (r - g) / d + 4;
      h /= 6;
    }
    h = h + (await numberInput(ctx, "hue"));
    h -= Math.floor(h);
    const s = Math.min(1, Math.max(0, (max > 0 ? d / max : 0) * (await numberInput(ctx, "saturation"))));
    const v = max * (await numberInput(ctx, "value"));
    const ch = (n: number): number => {
      const k = (n + h * 6) % 6;
      return v - v * s * Math.max(0, Math.min(k, 4 - k, 1));
    };
    return { outputs: { color: [ch(5), ch(3), ch(1), a] } };
  }
}

export const hueSaturationNode: INode = new HueSaturationNode();
