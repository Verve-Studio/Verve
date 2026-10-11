/** Helpers shared by shader-domain nodes. */
import type { ParamDef, ShaderContext } from "../../INode";
import { registerSampler, type SampleEdge, type SampleFilter } from "../../wgslSampling";
import { enumSpec } from "./nodeKit";

/** Which layer a sampling node reads: "" = the shaded layer, else another
 *  layer of the document by name (`ShaderContext.layerFetch`). */
export const LAYER_PARAM: ParamDef = {
  id: "layer",
  label: "Layer",
  spec: { kind: "string", default: "", placeholder: "This layer", suggest: "layers" },
};

export const FILTER_PARAM: ParamDef = {
  id: "filter",
  label: "Filter",
  spec: enumSpec("bilinear", [
    ["nearest", "Nearest"],
    ["bilinear", "Bilinear"],
    ["bicubic", "Bicubic"],
  ]),
};

export const EDGE_PARAM: ParamDef = {
  id: "edge",
  label: "Edges",
  spec: enumSpec("clamp", [
    ["clamp", "Clamp"],
    ["repeat", "Repeat"],
    ["mirror", "Mirror"],
    ["transparent", "Transparent"],
  ]),
};

/**
 * Sampling function `fn(uv: vec2f) -> vec4f` for the node's `LAYER_PARAM`.
 * Filter / edges come from `FILTER_PARAM` / `EDGE_PARAM` when the node has
 * them, else the given defaults.
 */
export function layerSampler(
  ctx: ShaderContext,
  filter?: SampleFilter,
  edge?: SampleEdge,
): string {
  const layer = String(ctx.param("layer")).trim();
  return registerSampler(
    (name, code) => ctx.helper(name, code),
    filter ?? (String(ctx.param("filter")) as SampleFilter),
    edge ?? (String(ctx.param("edge")) as SampleEdge),
    layer ? ctx.layerFetch(layer) : undefined,
  );
}

/** `vec2f` that scales a UV offset to square units (1 = canvas height), so
 *  circles stay round on non-square canvases. */
export function aspectExpr(ctx: ShaderContext): string {
  return `vec2f(${ctx.resolution}.x / ${ctx.resolution}.y, 1.0)`;
}

/** Module constants and small maths shared by node helpers. */
export function registerCommon(ctx: ShaderContext): void {
  ctx.helper(
    "ng_common",
    `const NG_PI: f32 = 3.14159265358979;
const NG_TAU: f32 = 6.28318530717959;
fn ng_rotate2(p: vec2f, deg: f32) -> vec2f {
  let r = radians(deg);
  let c = cos(r);
  let s = sin(r);
  return vec2f(c * p.x - s * p.y, s * p.x + c * p.y);
}
fn ng_hash22(p: vec2f) -> vec2f {
  var q = vec2f(dot(p, vec2f(127.1, 311.7)), dot(p, vec2f(269.5, 183.3)));
  return fract(sin(q) * 43758.5453);
}
fn ng_hash32(p: vec2f) -> vec3f {
  var q = vec3f(dot(p, vec2f(127.1, 311.7)), dot(p, vec2f(269.5, 183.3)), dot(p, vec2f(419.2, 371.9)));
  return fract(sin(q) * 43758.5453);
}`,
  );
}

const SRGB = /* wgsl */ `fn ng_srgb_encode(c: vec3f) -> vec3f {
  let x = max(c, vec3f(0.0));
  return select(1.055 * pow(x, vec3f(1.0 / 2.4)) - 0.055, x * 12.92, x <= vec3f(0.0031308));
}
fn ng_srgb_decode(c: vec3f) -> vec3f {
  let x = max(c, vec3f(0.0));
  return select(pow((x + 0.055) / 1.055, vec3f(2.4)), x / 12.92, x <= vec3f(0.04045));
}`;

/** `rgb` (vec3f, working space) as display (sRGB-encoded) values: for data
 *  stored in colours, like normal maps and height maps. Identity on sRGB
 *  documents. */
export function toDisplay(ctx: ShaderContext, rgb: string): string {
  if (!ctx.linear) return rgb;
  ctx.helper("ng_srgb", SRGB);
  return `ng_srgb_encode(${rgb})`;
}

/** Inverse of {@link toDisplay}: display values back to the working space. */
export function fromDisplay(ctx: ShaderContext, rgb: string): string {
  if (!ctx.linear) return rgb;
  ctx.helper("ng_srgb", SRGB);
  return `ng_srgb_decode(${rgb})`;
}
