import type { INode, ShaderContext, ShaderOutputs } from "../../INode";
import { isKernelValue, type KernelValue } from "../../graphTypes";
import { enumSpec, floatSpec } from "../_shared/nodeKit";
import { registerFetch, type SampleEdge } from "../../wgslSampling";
import { KERNEL_PRESETS } from "./kernelPresets";

const SIZES = [3, 5, 7] as const;
const DEFAULT_KERNEL: KernelValue = {
  size: 3,
  weights: KERNEL_PRESETS.find((p) => p.id === "gaussian")!.build(3),
};

/** Weighted sum of the size × size pixels around `center`; weights and the
 *  normalization factor are read from the uniform buffer at slot `b`. */
function convolveCode(name: string, fetch: string, size: number): string {
  const r = (size - 1) / 2;
  return `fn ${name}(center: vec2i, b: i32) -> vec4f {
  var sum = vec4f(0.0);
  for (var j = 0; j < ${size}; j++) {
    for (var i = 0; i < ${size}; i++) {
      let k = j * ${size} + i;
      sum += ${fetch}(center + vec2i(i - ${r}, j - ${r})) * ng_u.v[b + k / 4][k % 4];
    }
  }
  let n = ${size * size};
  return sum * ng_u.v[b + n / 4][n % 4];
}`;
}

const APPLY = /* wgsl */ `fn ng_kernel_apply(src: vec4f, conv: vec4f, strength: f32, bias: f32, convolveAlpha: bool) -> vec4f {
  let result = vec4f(conv.rgb + vec3f(bias), select(src.a, conv.a, convolveAlpha));
  return mix(src, result, strength);
}`;

/**
 * Convolution: the output colour is the weighted sum of the pixels around
 * the sample position, with weights from the kernel grid. Weights are
 * uniforms, so editing them is live; changing the size rebuilds the shader.
 */
class SampleKernelNode implements INode {
  readonly type = "sampleKernel";
  readonly label = "Convolution Kernel";
  readonly category = "Filter";
  readonly domains = ["shader"] as const;
  readonly description =
    "Weighted sum of the surrounding pixels (blur, sharpen, edge detect, emboss, …).";
  readonly width = 220;
  readonly inputs = [
    { id: "uv", label: "UV", type: "vec2" },
    { id: "strength", label: "Strength", type: "float", value: floatSpec(1, 0, 1) },
    { id: "bias", label: "Bias", type: "float", value: floatSpec(0, -1, 1) },
  ] as const;
  readonly outputs = [{ id: "color", label: "Color", type: "color" }] as const;
  readonly params = [
    {
      id: "kernel",
      label: "Kernel",
      spec: { kind: "kernel", default: DEFAULT_KERNEL, sizes: SIZES, presets: KERNEL_PRESETS },
    },
    { id: "normalize", label: "Normalize", spec: { kind: "bool", default: true } },
    { id: "convolveAlpha", label: "Convolve Alpha", spec: { kind: "bool", default: false } },
    {
      id: "edge",
      label: "Edges",
      spec: enumSpec("clamp", [
        ["clamp", "Clamp"],
        ["repeat", "Repeat"],
        ["mirror", "Mirror"],
        ["transparent", "Transparent"],
      ]),
    },
  ] as const;

  generateShader(ctx: ShaderContext): ShaderOutputs {
    const raw = ctx.param("kernel");
    const kernel =
      isKernelValue(raw) && (SIZES as readonly number[]).includes(raw.size) ? raw : DEFAULT_KERNEL;
    const n = kernel.size * kernel.size;
    const weights = Array.from({ length: n }, (_, i) => kernel.weights[i] ?? 0);
    const sum = weights.reduce((s, w) => s + w, 0);
    const norm = ctx.param("normalize") === true && Math.abs(sum) > 1e-6 ? 1 / sum : 1;
    const { slot } = ctx.uniformFloats([...weights, norm]);

    const edge = String(ctx.param("edge")) as SampleEdge;
    const fetch = registerFetch((name, code) => ctx.helper(name, code), edge);
    const name = `ng_convolve_${kernel.size}_${edge}`;
    const convolve = ctx.helper(name, convolveCode(name, fetch, kernel.size));
    const apply = ctx.helper("ng_kernel_apply", APPLY);

    const center = `vec2i(floor((${ctx.input("uv") ?? ctx.uv}) * ${ctx.resolution}))`;
    const args = [
      `${fetch}(${center})`,
      `${convolve}(${center}, ${slot})`,
      ctx.input("strength") ?? "1.0",
      ctx.input("bias") ?? "0.0",
      String(ctx.param("convolveAlpha") === true),
    ];
    return { color: `${apply}(${args.join(", ")})` };
  }
}

export const sampleKernelNode: INode = new SampleKernelNode();
