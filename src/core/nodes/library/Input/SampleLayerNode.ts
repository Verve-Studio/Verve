import type { INode, ParamDef, ShaderContext, ShaderOutputs } from "../../INode";
import { enumSpec, vec2Spec } from "../_shared/nodeKit";
import { registerSampler, type SampleEdge, type SampleFilter } from "../../wgslSampling";

/** Read the layer — or another layer of the document, by name — at another
 *  position (distortions, offsets, tiling, layers driving the shader). */
class SampleLayerNode implements INode {
  readonly type = "sampleLayer";
  readonly label = "Sample Layer";
  readonly category = "Input";
  readonly domains = ["shader"] as const;
  readonly description =
    "Read the layer at a UV position (unconnected: the current pixel), shifted by Offset pixels. " +
    "Set Layer to read another layer of the document by name (its own pixels, without opacity, " +
    "mask or effects; transparent when no layer has that name).";
  readonly width = 180;
  readonly inputs = [
    { id: "uv", label: "UV", type: "vec2" },
    { id: "offset", label: "Offset (px)", type: "vec2", value: vec2Spec(0, 0, 0.1) },
  ] as const;
  readonly outputs = [
    { id: "color", label: "Color", type: "color" },
    { id: "alpha", label: "Alpha", type: "float" },
  ] as const;
  readonly params: readonly ParamDef[] = [
    {
      id: "layer",
      label: "Layer",
      spec: { kind: "string", default: "", placeholder: "This layer", suggest: "layers" },
    },
    {
      id: "filter",
      label: "Filter",
      spec: enumSpec("bilinear", [
        ["nearest", "Nearest"],
        ["bilinear", "Bilinear"],
        ["bicubic", "Bicubic"],
      ]),
    },
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
  ];

  generateShader(ctx: ShaderContext): ShaderOutputs {
    const layer = String(ctx.param("layer")).trim();
    const sample = registerSampler(
      (name, code) => ctx.helper(name, code),
      String(ctx.param("filter")) as SampleFilter,
      String(ctx.param("edge")) as SampleEdge,
      layer ? ctx.layerFetch(layer) : undefined,
    );
    const uv = ctx.input("uv") ?? ctx.uv;
    const offset = ctx.input("offset") ?? "vec2f(0.0)";
    const color = `${sample}((${uv}) + (${offset}) * ${ctx.texelSize})`;
    return { color, alpha: `(${color}).a` };
  }
}

export const sampleLayerNode: INode = new SampleLayerNode();
