/** Full WGSL modules for compiled shader graphs (rendering and checks). */
import {
  CONTEXT_SLOTS,
  layerSourceDeclarations,
  passDeclarations,
  uniformDeclaration,
  type ShaderPass,
} from "@/core/nodes/shaderCompiler";
import { getShader } from "../shaderLoader";

/** First binding of the layer-source textures (after the standard five). */
export const LAYER_SOURCE_BINDING = 5;

/** Fragment entry point that renders intermediate pass `index`. */
export function passEntryPoint(index: number): string {
  return `fs_custom_pass${index}`;
}

/** Host shader + the graph's uniform, layer-texture and pass-texture
 *  declarations + its compiled code, plus one fragment entry point per
 *  intermediate pass (`passEntryPoint`). Pass textures are bound after the
 *  layer sources. */
export function assembleShaderSource(
  code: string,
  slots: number,
  layerSources = 0,
  passes: readonly ShaderPass[] = [],
): string {
  const entries = passes.map(
    (p, i) => `@fragment
fn ${passEntryPoint(i)}(in: AdjVertOut) -> @location(0) vec4f {
  let dims = vec2f(textureDimensions(srcTex));
  return ${p.entry}(in.uv, in.uv * dims, textureLoad(srcTex, vec2i(in.pos.xy), 0));
}`,
  );
  return [
    getShader("custom-shader-host"),
    uniformDeclaration(slots, 0, 2),
    layerSourceDeclarations(layerSources, 0, LAYER_SOURCE_BINDING),
    passDeclarations(passes.length, 0, LAYER_SOURCE_BINDING + layerSources),
    code,
    ...entries,
  ].join("\n");
}

/** Renders the layer unchanged; used while a graph doesn't compile. */
export const PASSTHROUGH_SOURCE = assembleShaderSource(
  `fn ng_shade(ng_uv: vec2f, ng_pixel: vec2f, ng_src: vec4f) -> vec4f {
  return ng_src;
}`,
  CONTEXT_SLOTS,
);
