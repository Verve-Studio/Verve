import type { INode, ShaderContext, ShaderOutputs } from "../../INode";
import { floatSpec } from "../_shared/nodeKit";
import { aspectExpr } from "../_shared/shaderKit";

/**
 * Clouds: fractal (fBm) gradient noise.
 *
 * - Gradient (Perlin) noise with a quintic fade: no value-noise blockiness.
 * - The lattice hash is the mod-289 permutation polynomial on integer cell
 *   coordinates, which f32 evaluates exactly on every GPU, so fine octaves
 *   don't break up into patterns the way a `fract(p * k)` hash does.
 * - Each octave is rotated so the octaves' lattices don't line up.
 * - Octaves continue down to ~2 px features (`octaves` is capped by the
 *   caller), with the last one faded in by its fractional part: full detail
 *   at any scale and resolution, without aliasing.
 * - Normalised by the octaves' RMS amplitude, so Detail and Roughness add
 *   structure without washing out the contrast.
 */
const HELPER = /* wgsl */ `fn ng_mod289(x: vec2f) -> vec2f {
  return x - floor(x / 289.0) * 289.0;
}
fn ng_perm289(x: f32) -> f32 {
  let y = (34.0 * x + 1.0) * x;
  return y - floor(y / 289.0) * 289.0;
}
fn ng_grad289(c: vec2f) -> vec2f {
  let a = ng_perm289(ng_perm289(ng_perm289(c.x) + c.y)) * (6.28318530717959 / 289.0);
  return vec2f(cos(a), sin(a));
}
fn ng_gradient_noise(p: vec2f, offset: vec2f) -> f32 {
  let i = floor(p);
  let f = p - i;
  let u = f * f * f * (f * (f * 6.0 - 15.0) + 10.0);
  let c0 = ng_mod289(i + offset);
  let c1 = ng_mod289(c0 + vec2f(1.0, 1.0));
  let a = dot(ng_grad289(c0), f);
  let b = dot(ng_grad289(vec2f(c1.x, c0.y)), f - vec2f(1.0, 0.0));
  let c = dot(ng_grad289(vec2f(c0.x, c1.y)), f - vec2f(0.0, 1.0));
  let d = dot(ng_grad289(c1), f - vec2f(1.0, 1.0));
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
}
fn ng_clouds(p: vec2f, octaves: f32, roughness: f32, seed: f32) -> f32 {
  let n = clamp(octaves, 0.0, 15.0);
  let r = clamp(roughness, 0.0, 1.0);
  let s = floor(seed);
  var offset = ng_mod289(vec2f(s * 37.0, s * 61.0));
  var q = p;
  var sum = 0.0;
  var norm = 0.0;
  var amp = 1.0;
  for (var i = 0; i < 16; i++) {
    let w = clamp(n + 1.0 - f32(i), 0.0, 1.0);
    if (w <= 0.0) { break; }
    sum += ng_gradient_noise(q, offset) * amp * w;
    norm += amp * amp * w;
    amp *= r;
    q = vec2f(0.8 * q.x - 0.6 * q.y, 0.6 * q.x + 0.8 * q.y) * 2.0;
    offset = ng_mod289(offset + vec2f(13.0, 29.0));
  }
  return clamp(0.5 + 0.95 * sum / sqrt(max(norm, 1e-6)), 0.0, 1.0);
}`;

class NoiseNode implements INode {
  readonly type = "noise";
  readonly label = "Noise";
  readonly category = "Texture";
  readonly domains = ["shader"] as const;
  readonly description =
    "Fractal cloud noise. Scale is the size of the largest features (features per canvas height); " +
    "Detail adds finer octaves down to the pixel level; Roughness sets how strong each finer " +
    "octave is; Seed picks another pattern.";
  readonly inputs = [
    { id: "uv", label: "UV", type: "vec2" },
    { id: "scale", label: "Scale", type: "float", value: floatSpec(5, 0, undefined, 0.05) },
    { id: "detail", label: "Detail", type: "float", value: floatSpec(15, 0, 15, 0.05) },
    { id: "roughness", label: "Roughness", type: "float", value: floatSpec(0.5, 0, 1) },
    { id: "seed", label: "Seed", type: "float", value: floatSpec(0, 0, undefined, 1) },
  ] as const;
  readonly outputs = [
    { id: "fac", label: "Fac", type: "float" },
    { id: "color", label: "Color", type: "color" },
  ] as const;

  generateShader(ctx: ShaderContext): ShaderOutputs {
    const fn = ctx.helper("ng_clouds", HELPER);
    const scale = ctx.local("f32", `max(${ctx.input("scale") ?? "5.0"}, 0.0)`);
    const p = ctx.local("vec2f", `(${ctx.input("uv") ?? ctx.uv}) * ${aspectExpr(ctx)} * ${scale}`);
    // Octaves whose features are at least ~2 px; more would only alias.
    const octaves = ctx.local(
      "f32",
      `min(${ctx.input("detail") ?? "15.0"}, log2(max(${ctx.resolution}.y / max(${scale}, 1e-4), 1.0)) - 1.0)`,
    );
    const roughness = ctx.input("roughness") ?? "0.5";
    const seed = ctx.local("f32", `floor(${ctx.input("seed") ?? "0.0"})`);
    const fac = ctx.local("f32", `${fn}(${p}, ${octaves}, ${roughness}, ${seed})`);
    return {
      fac,
      // Two more seeds for decorrelated green and blue channels.
      color: `vec4f(${fac}, ${fn}(${p}, ${octaves}, ${roughness}, ${seed} + 1.0), ${fn}(${p}, ${octaves}, ${roughness}, ${seed} + 2.0), 1.0)`,
    };
  }
}

export const noiseNode: INode = new NoiseNode();
