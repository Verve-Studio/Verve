/**
 * WGSL helpers for sampling a layer with a choice of filter and edge
 * handling. Built on a clamped texel fetch — the host's `ng_load(p: vec2i)`
 * for the shaded layer, or `ShaderContext.layerFetch` for another layer —
 * and the canvas size in `ng_u.v[0]` (see shaderCompiler.ts).
 */

export type SampleFilter = "nearest" | "bilinear" | "bicubic";
export type SampleEdge = "clamp" | "repeat" | "mirror" | "transparent";

/** Name suffix that keeps helpers built on different fetches apart. */
function suffix(load: string): string {
  return load === "ng_load" ? "" : `_${load}`;
}

/** Texel fetch at integer pixel `p` with edge handling, built on `load`. */
function edgeFetch(edge: SampleEdge, load: string): [string, string] {
  const name = `ng_fetch_${edge}${suffix(load)}`;
  const size = "let s = vec2i(ng_u.v[0].xy);";
  let body: string;
  switch (edge) {
    case "clamp":
      body = `return ${load}(p);`;
      break;
    case "repeat":
      body = `${size}
  return ${load}(((p % s) + s) % s);`;
      break;
    case "mirror":
      body = `${size}
  let period = 2 * s;
  let m = ((p % period) + period) % period;
  return ${load}(select(m, period - vec2i(1) - m, m >= s));`;
      break;
    case "transparent":
      body = `${size}
  if (any(p < vec2i(0)) || any(p >= s)) { return vec4f(0.0); }
  return ${load}(p);`;
      break;
  }
  return [name, `fn ${name}(p: vec2i) -> vec4f {\n  ${body}\n}`];
}

function filterCode(name: string, fetch: string, filter: SampleFilter): string {
  const head = `fn ${name}(uv: vec2f) -> vec4f {\n  let pix = uv * ng_u.v[0].xy;`;
  switch (filter) {
    case "nearest":
      return `${head}
  return ${fetch}(vec2i(floor(pix)));
}`;
    case "bilinear":
      return `${head}
  let q = pix - vec2f(0.5);
  let p0 = floor(q);
  let f = q - p0;
  let c = vec2i(p0);
  let a = mix(${fetch}(c), ${fetch}(c + vec2i(1, 0)), f.x);
  let b = mix(${fetch}(c + vec2i(0, 1)), ${fetch}(c + vec2i(1, 1)), f.x);
  return mix(a, b, f.y);
}`;
    case "bicubic":
      // Catmull-Rom, 4×4 taps.
      return `${head}
  let q = pix - vec2f(0.5);
  let p0 = floor(q);
  let f = q - p0;
  let c = vec2i(p0);
  var sum = vec4f(0.0);
  for (var j = -1; j <= 2; j++) {
    let wy = ng_catmull_rom(f.y - f32(j));
    var row = vec4f(0.0);
    for (var i = -1; i <= 2; i++) {
      row += ${fetch}(c + vec2i(i, j)) * ng_catmull_rom(f.x - f32(i));
    }
    sum += row * wy;
  }
  return sum;
}`;
  }
}

const CATMULL_ROM = `fn ng_catmull_rom(x: f32) -> f32 {
  let t = abs(x);
  if (t < 1.0) { return 1.5 * t * t * t - 2.5 * t * t + 1.0; }
  if (t < 2.0) { return -0.5 * t * t * t + 2.5 * t * t - 4.0 * t + 2.0; }
  return 0.0;
}`;

/**
 * Register the helpers for a filter/edge combination through `helper`
 * (`ShaderContext.helper`) and return the name of the sampling function,
 * `fn(uv: vec2f) -> vec4f`. `load` is the texel fetch to build on (default:
 * the shaded layer).
 */
export function registerSampler(
  helper: (name: string, code: string) => string,
  filter: SampleFilter,
  edge: SampleEdge,
  load = "ng_load",
): string {
  const [fetchName, fetchCode] = edgeFetch(edge, load);
  helper(fetchName, fetchCode);
  if (filter === "bicubic") helper("ng_catmull_rom", CATMULL_ROM);
  const name = `ng_sample_${filter}_${edge}${suffix(load)}`;
  return helper(name, filterCode(name, fetchName, filter));
}

/** Register the edge-handled integer fetch, `fn(p: vec2i) -> vec4f`. */
export function registerFetch(
  helper: (name: string, code: string) => string,
  edge: SampleEdge,
): string {
  const [name, code] = edgeFetch(edge, "ng_load");
  return helper(name, code);
}
