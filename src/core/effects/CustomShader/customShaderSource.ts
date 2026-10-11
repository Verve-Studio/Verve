/** Full WGSL modules for compiled shader graphs (rendering and checks). */
import {
  CONTEXT_SLOTS,
  layerSourceDeclarations,
  uniformDeclaration,
} from "@/core/nodes/shaderCompiler";
import { getShader } from "../shaderLoader";

/** First binding of the layer-source textures (after the standard five). */
export const LAYER_SOURCE_BINDING = 5;

/** Host shader + the graph's uniform and layer-texture declarations + its
 *  compiled code. */
export function assembleShaderSource(code: string, slots: number, layerSources = 0): string {
  return [
    getShader("custom-shader-host"),
    uniformDeclaration(slots, 0, 2),
    layerSourceDeclarations(layerSources, 0, LAYER_SOURCE_BINDING),
    code,
  ].join("\n");
}

/** Renders the layer unchanged; used while a graph doesn't compile. */
export const PASSTHROUGH_SOURCE = assembleShaderSource(
  `fn ng_shade(ng_uv: vec2f, ng_pixel: vec2f, ng_src: vec4f) -> vec4f {
  return ng_src;
}`,
  CONTEXT_SLOTS,
);
