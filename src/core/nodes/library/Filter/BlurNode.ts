import type { INode, ShaderContext, ShaderOutputs } from "../../INode";
import { enumSpec, floatSpec } from "../_shared/nodeKit";
import { EDGE_PARAM, LAYER_PARAM, layerSampler } from "../_shared/shaderKit";

const QUALITY: Record<string, number> = { low: 16, medium: 32, high: 64, best: 128 };

/**
 * Disc blur of a layer: `n` bilinear taps on a golden-angle (Vogel) spiral
 * filling a disc of Radius pixels, Gaussian- or box-weighted. Radius is a
 * uniform, so dragging it is live; Quality sets the tap count.
 */
class BlurNode implements INode {
  readonly type = "blur";
  readonly label = "Blur";
  readonly category = "Filter";
  readonly domains = ["shader"] as const;
  readonly description =
    "Blur this layer (or another, by name) with a Radius in pixels. Higher Quality takes more " +
    "samples: smoother large blurs, slower rendering.";
  readonly width = 180;
  readonly inputs = [
    { id: "uv", label: "UV", type: "vec2" },
    { id: "radius", label: "Radius (px)", type: "float", value: floatSpec(8, 0, 500, 0.1) },
  ] as const;
  readonly outputs = [
    { id: "color", label: "Color", type: "color" },
    { id: "alpha", label: "Alpha", type: "float" },
  ] as const;
  readonly params = [
    LAYER_PARAM,
    {
      id: "kind",
      label: "Type",
      spec: enumSpec("gaussian", [
        ["gaussian", "Gaussian"],
        ["box", "Disc"],
      ]),
    },
    {
      id: "quality",
      label: "Quality",
      spec: enumSpec("medium", [
        ["low", "Low (16)"],
        ["medium", "Medium (32)"],
        ["high", "High (64)"],
        ["best", "Best (128)"],
      ]),
    },
    EDGE_PARAM,
  ];

  generateShader(ctx: ShaderContext): ShaderOutputs {
    const sample = layerSampler(ctx, "bilinear");
    const n = QUALITY[String(ctx.param("quality"))] ?? 32;
    const gaussian = ctx.param("kind") !== "box";
    const name = `ng_blur_${n}_${gaussian ? "g" : "b"}_${sample}`;
    const fn = ctx.helper(
      name,
      `fn ${name}(uv: vec2f, radius: vec2f) -> vec4f {
  var sum = vec4f(0.0);
  var wsum = 0.0;
  for (var i = 0; i < ${n}; i++) {
    let t = (f32(i) + 0.5) / ${n}.0;
    let r = sqrt(t);
    let a = f32(i) * 2.39996323;
    let w = ${gaussian ? "exp(-4.0 * t)" : "1.0"};
    // Premultiplied, so transparent pixels don't darken the edges.
    let c = ${sample}(uv + vec2f(cos(a), sin(a)) * r * radius);
    sum += vec4f(c.rgb * c.a, c.a) * w;
    wsum += w;
  }
  let avg = sum / wsum;
  return vec4f(select(vec3f(0.0), avg.rgb / avg.a, avg.a > 1e-6), avg.a);
}`,
    );
    const uv = ctx.input("uv") ?? ctx.uv;
    const radius = `(max(${ctx.input("radius") ?? "8.0"}, 0.0) * ${ctx.texelSize})`;
    const color = ctx.local("vec4f", `${fn}(${uv}, ${radius})`);
    return { color, alpha: `${color}.a` };
  }
}

export const blurNode: INode = new BlurNode();
