import type { INode, ShaderContext, ShaderOutputs } from "../../INode";
import { enumSpec, floatSpec, vec2Spec } from "../_shared/nodeKit";
import { aspectExpr, registerCommon } from "../_shared/shaderKit";

const TYPES: readonly [string, string][] = [
  ["linear", "Linear"],
  ["radial", "Radial"],
  ["angular", "Angular"],
  ["diamond", "Diamond"],
  ["square", "Square"],
  ["spherical", "Spherical"],
];

/** Raw gradient value per type, from `d` (offset from the centre in canvas
 *  heights, rotated) and the radius. */
const SHAPES: Record<string, string> = {
  linear: "d.x / (2.0 * r) + 0.5",
  radial: "length(d) / r",
  angular: "fract(atan2(-d.y, d.x) / NG_TAU + 1.0)",
  diamond: "(abs(d.x) + abs(d.y)) / r",
  square: "max(abs(d.x), abs(d.y)) / r",
  spherical: "sqrt(max(1.0 - dot(d, d) / (r * r), 0.0))",
};

/** Gradient value (0–1) around Center: linear across 2 × Radius, radial
 *  etc. reaching 1 at Radius. Repeat tiles or mirrors values beyond 0–1. */
class GradientTextureNode implements INode {
  readonly type = "gradientTexture";
  readonly label = "Gradient";
  readonly category = "Texture";
  readonly domains = ["shader"] as const;
  readonly description =
    "Linear, radial, angular, diamond, square or spherical gradient around Center (0–1). " +
    "Feed it to Color Ramp for coloured gradients.";
  readonly width = 180;
  readonly inputs = [
    { id: "uv", label: "UV", type: "vec2" },
    { id: "center", label: "Center", type: "vec2", value: vec2Spec(0.5, 0.5) },
    { id: "angle", label: "Angle (°)", type: "float", value: floatSpec(0, -360, 360, 0.5) },
    { id: "radius", label: "Radius", type: "float", value: floatSpec(0.5, 0.001, 10) },
  ] as const;
  readonly outputs = [
    { id: "fac", label: "Fac", type: "float" },
    { id: "color", label: "Color", type: "color" },
  ] as const;
  readonly params = [
    { id: "type", label: "Type", spec: enumSpec("linear", TYPES) },
    {
      id: "repeat",
      label: "Repeat",
      spec: enumSpec("none", [
        ["none", "Clamp"],
        ["repeat", "Repeat"],
        ["mirror", "Mirror"],
      ]),
    },
  ] as const;

  generateShader(ctx: ShaderContext): ShaderOutputs {
    registerCommon(ctx);
    const type = SHAPES[String(ctx.param("type"))] ? String(ctx.param("type")) : "linear";
    const repeat = String(ctx.param("repeat"));
    const wrap =
      type === "angular"
        ? "v"
        : repeat === "repeat"
          ? "fract(v)"
          : repeat === "mirror"
            ? "1.0 - abs(fract(v * 0.5) * 2.0 - 1.0)"
            : "clamp(v, 0.0, 1.0)";
    const name = `ng_gradient_${type}_${repeat}`;
    const fn = ctx.helper(
      name,
      `fn ${name}(uv: vec2f, c: vec2f, deg: f32, radius: f32, a: vec2f) -> f32 {
  // Rotate the gradient, not the image: undo the angle on the offset.
  let d = ng_rotate2((uv - c) * a * vec2f(1.0, -1.0), -deg);
  let r = max(radius, 1e-6);
  let v = ${SHAPES[type]};
  return ${wrap};
}`,
    );
    const args = [
      ctx.input("uv") ?? ctx.uv,
      ctx.input("center") ?? "vec2f(0.5)",
      ctx.input("angle") ?? "0.0",
      ctx.input("radius") ?? "0.5",
      aspectExpr(ctx),
    ];
    const fac = ctx.local("f32", `${fn}(${args.join(", ")})`);
    return { fac, color: `vec4f(vec3f(${fac}), 1.0)` };
  }
}

export const gradientTextureNode: INode = new GradientTextureNode();
