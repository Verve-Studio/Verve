import type { INode, ShaderContext, ShaderOutputs } from "../../INode";
import { enumSpec, floatSpec } from "../_shared/nodeKit";
import { EDGE_PARAM, LAYER_PARAM, fromDisplay, layerSampler, toDisplay } from "../_shared/shaderKit";

const CHANNELS: readonly [string, string][] = [
  ["luminance", "Luminance"],
  ["alpha", "Alpha"],
  ["red", "Red"],
  ["green", "Green"],
  ["blue", "Blue"],
];

/**
 * Surface normals from a height map: a Sobel gradient of the height read
 * from a layer (this one, or another by name). Normals are tangent space,
 * +X right, +Y up (OpenGL; Flip Y gives DirectX), +Z out of the image.
 */
class NormalFromHeightNode implements INode {
  readonly type = "normalFromHeight";
  readonly label = "Normal from Height";
  readonly category = "Surface";
  readonly domains = ["shader"] as const;
  readonly description =
    "Surface normals from a height map (a layer's luminance, alpha or a channel). " +
    "Feed Normal into Lighting for bump / emboss shading, or output Normal Map as a normal-map texture.";
  readonly width = 200;
  readonly inputs = [
    { id: "uv", label: "UV", type: "vec2" },
    { id: "strength", label: "Strength", type: "float", value: floatSpec(2, 0, 50, 0.05) },
    { id: "distance", label: "Distance (px)", type: "float", value: floatSpec(1, 0.1, 64, 0.05) },
  ] as const;
  readonly outputs = [
    { id: "normal", label: "Normal", type: "vec3" },
    { id: "normalMap", label: "Normal Map", type: "color" },
    { id: "height", label: "Height", type: "float" },
    { id: "slope", label: "Slope", type: "float" },
  ] as const;
  readonly params = [
    LAYER_PARAM,
    { id: "channel", label: "Height", spec: enumSpec("luminance", CHANNELS) },
    { id: "invert", label: "Invert Height", spec: { kind: "bool", default: false } },
    { id: "flipY", label: "Flip Y (DirectX)", spec: { kind: "bool", default: false } },
    EDGE_PARAM,
  ] as const;

  generateShader(ctx: ShaderContext): ShaderOutputs {
    const sample = layerSampler(ctx, "bilinear");
    const channel = String(ctx.param("channel"));
    // Height maps hold display values: read colour channels perceptually
    // on linear documents.
    const height = ((): string => {
      const c = `${sample}(uv)`;
      if (channel === "alpha") return `${c}.a`;
      const rgb = toDisplay(ctx, `${c}.rgb`);
      if (channel === "red") return `(${rgb}).r`;
      if (channel === "green") return `(${rgb}).g`;
      if (channel === "blue") return `(${rgb}).b`;
      return `dot(${rgb}, vec3f(0.2126, 0.7152, 0.0722))`;
    })();
    const heightFn = ctx.helper(
      `ng_height_${sample}_${channel}`,
      `fn ng_height_${sample}_${channel}(uv: vec2f) -> f32 {
  return ${height};
}`,
    );
    const name = `ng_nfh_${heightFn}`;
    const nfh = ctx.helper(
      name,
      `// xyz = normal, w = slope (gradient magnitude).
fn ${name}(uv: vec2f, d: vec2f, strength: f32, flipY: bool) -> vec4f {
  let tl = ${heightFn}(uv + vec2f(-d.x, -d.y));
  let t  = ${heightFn}(uv + vec2f(0.0, -d.y));
  let tr = ${heightFn}(uv + vec2f(d.x, -d.y));
  let l  = ${heightFn}(uv + vec2f(-d.x, 0.0));
  let r  = ${heightFn}(uv + vec2f(d.x, 0.0));
  let bl = ${heightFn}(uv + vec2f(-d.x, d.y));
  let b  = ${heightFn}(uv + vec2f(0.0, d.y));
  let br = ${heightFn}(uv + vec2f(d.x, d.y));
  // Sobel; UV y points down, normal Y points up.
  let gx = (tr + 2.0 * r + br) - (tl + 2.0 * l + bl);
  let gy = (bl + 2.0 * b + br) - (tl + 2.0 * t + tr);
  var n = normalize(vec3f(-gx * strength, gy * strength, 1.0));
  if (flipY) { n.y = -n.y; }
  return vec4f(n, length(vec2f(gx, gy)));
}`,
    );
    const uv = ctx.input("uv") ?? ctx.uv;
    const invert = ctx.param("invert") === true;
    const strength = `(${ctx.input("strength") ?? "2.0"})${invert ? " * -1.0" : ""}`;
    const dist = `(${ctx.texelSize} * max(${ctx.input("distance") ?? "1.0"}, 0.0))`;
    const res = ctx.local("vec4f", `${nfh}(${uv}, ${dist}, ${strength}, ${ctx.param("flipY") === true})`);
    const h = `${heightFn}(${uv})`;
    return {
      normal: `${res}.xyz`,
      // Encoded like a normal-map texture (0.5, 0.5, 1 = flat). Its values
      // are display values: decoded on linear documents so the result
      // exports as a standard normal map.
      normalMap: `vec4f(${fromDisplay(ctx, `${res}.xyz * 0.5 + 0.5`)}, 1.0)`,
      height: invert ? `(1.0 - ${h})` : h,
      slope: `${res}.w`,
    };
  }
}

export const normalFromHeightNode: INode = new NormalFromHeightNode();
