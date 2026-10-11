/** Full WGSL modules for compiled shader graphs (rendering and checks). */
import { CONTEXT_SLOTS, uniformDeclaration } from "@/core/nodes/shaderCompiler";
import { getShader } from "../shaderLoader";

/** Host shader + the graph's uniform declaration + its compiled code. */
export function assembleShaderSource(code: string, slots: number): string {
  return `${getShader("custom-shader-host")}\n${uniformDeclaration(slots, 0, 2)}\n${code}`;
}

/** Renders the layer unchanged; used while a graph doesn't compile. */
export const PASSTHROUGH_SOURCE = assembleShaderSource(
  `fn ng_shade(ng_uv: vec2f, ng_pixel: vec2f, ng_src: vec4f) -> vec4f {
  return ng_src;
}`,
  CONTEXT_SLOTS,
);
