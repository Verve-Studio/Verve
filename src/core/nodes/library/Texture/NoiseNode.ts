import type { INode, ShaderContext, ShaderOutputs } from "../../INode";
import { floatSpec } from "../_shared/nodeKit";

/** Value-noise fBm. `detail` is the octave count (fractional = blend in
 *  the last octave); each octave doubles frequency and halves amplitude. */
const HELPER = /* wgsl */ `fn ng_hash2(p: vec2f) -> f32 {
  let q = fract(p * vec2f(123.34, 456.21));
  let r = q + dot(q, q + 45.32);
  return fract(r.x * r.y);
}
fn ng_value_noise(p: vec2f) -> f32 {
  let i = floor(p);
  let f = fract(p);
  let u = f * f * (3.0 - 2.0 * f);
  let a = ng_hash2(i);
  let b = ng_hash2(i + vec2f(1.0, 0.0));
  let c = ng_hash2(i + vec2f(0.0, 1.0));
  let d = ng_hash2(i + vec2f(1.0, 1.0));
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
}
fn ng_fbm(p: vec2f, detail: f32) -> f32 {
  var sum = 0.0;
  var norm = 0.0;
  var amp = 1.0;
  var q = p;
  let octaves = clamp(detail, 0.0, 15.0);
  for (var i = 0; i < 16; i++) {
    let w = clamp(octaves + 1.0 - f32(i), 0.0, 1.0);
    if (w <= 0.0) { break; }
    sum += ng_value_noise(q) * amp * w;
    norm += amp * w;
    amp *= 0.5;
    q = q * 2.0 + vec2f(17.13, 9.71);
  }
  return sum / max(norm, 1e-6);
}`;

class NoiseNode implements INode {
  readonly type = "noise";
  readonly label = "Noise";
  readonly category = "Texture";
  readonly domains = ["shader"] as const;
  readonly inputs = [
    { id: "uv", label: "UV", type: "vec2" },
    { id: "scale", label: "Scale", type: "float", value: floatSpec(5, 0, undefined, 0.05) },
    { id: "detail", label: "Detail", type: "float", value: floatSpec(2, 0, 15, 0.05) },
  ] as const;
  readonly outputs = [
    { id: "fac", label: "Fac", type: "float" },
    { id: "color", label: "Color", type: "color" },
  ] as const;

  generateShader(ctx: ShaderContext): ShaderOutputs {
    ctx.helper("ng_fbm", HELPER);
    const p = `((${ctx.input("uv") ?? ctx.uv}) * ${ctx.input("scale") ?? "5.0"})`;
    const d = ctx.input("detail") ?? "2.0";
    return {
      fac: `ng_fbm(${p}, ${d})`,
      // Three decorrelated noises for the colour channels.
      color: `vec4f(ng_fbm(${p}, ${d}), ng_fbm(${p} + vec2f(31.4, 7.7), ${d}), ng_fbm(${p} + vec2f(-12.9, 53.1), ${d}), 1.0)`,
    };
  }
}

export const noiseNode: INode = new NoiseNode();
