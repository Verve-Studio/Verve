import type { INode, ShaderContext, ShaderOutputs } from "../../INode";
import { vec2Spec } from "../_shared/nodeKit";
import { EDGE_PARAM, FILTER_PARAM, LAYER_PARAM, layerSampler } from "../_shared/shaderKit";

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
  readonly params = [LAYER_PARAM, FILTER_PARAM, EDGE_PARAM];

  generateShader(ctx: ShaderContext): ShaderOutputs {
    const sample = layerSampler(ctx);
    const uv = ctx.input("uv") ?? ctx.uv;
    const offset = ctx.input("offset") ?? "vec2f(0.0)";
    const color = `${sample}((${uv}) + (${offset}) * ${ctx.texelSize})`;
    return { color, alpha: `(${color}).a` };
  }
}

export const sampleLayerNode: INode = new SampleLayerNode();
