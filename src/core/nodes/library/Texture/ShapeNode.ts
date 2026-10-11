import type { INode, NodePorts, PortDef, ShaderContext, ShaderOutputs } from "../../INode";
import type { ParamValue } from "../../graphTypes";
import { enumSpec, floatSpec, memoPorts, vec2Spec } from "../_shared/nodeKit";
import { aspectExpr, registerCommon } from "../_shared/shaderKit";

const P = {
  uv: { id: "uv", label: "UV", type: "vec2" },
  center: { id: "center", label: "Center", type: "vec2", value: vec2Spec(0.5, 0.5) },
  radius: { id: "radius", label: "Radius", type: "float", value: floatSpec(0.25, 0, 10, 0.002) },
  size: { id: "size", label: "Size", type: "vec2", value: vec2Spec(0.3, 0.2, 0.002) },
  roundness: { id: "roundness", label: "Roundness", type: "float", value: floatSpec(0, 0, 1) },
  sides: { id: "sides", label: "Sides", type: "float", value: floatSpec(6, 3, 64, 0.05) },
  points: { id: "points", label: "Points", type: "float", value: floatSpec(5, 3, 64, 0.05) },
  inner: { id: "inner", label: "Inner Radius", type: "float", value: floatSpec(0.5, 0, 1) },
  thickness: { id: "thickness", label: "Thickness", type: "float", value: floatSpec(0.05, 0, 10, 0.001) },
  rotation: { id: "rotation", label: "Rotation (°)", type: "float", value: floatSpec(0, -360, 360, 0.5) },
  softness: { id: "softness", label: "Softness", type: "float", value: floatSpec(0, 0, 1, 0.001) },
} satisfies Record<string, PortDef>;

interface Shape {
  label: string;
  inputs: readonly PortDef[];
  /** WGSL signed distance in canvas heights; `p` is the rotated offset. */
  sdf: string;
}

const SHAPES: Record<string, Shape> = {
  circle: { label: "Circle", inputs: [P.radius], sdf: "length(p) - radius" },
  rectangle: {
    label: "Rectangle",
    inputs: [P.size, P.roundness],
    sdf: `ng_sd_box(p, size * 0.5, roundness * min(size.x, size.y) * 0.5)`,
  },
  ellipse: {
    label: "Ellipse",
    inputs: [P.size],
    sdf: "(length(p / max(size * 0.5, vec2f(1e-6))) - 1.0) * min(size.x, size.y) * 0.5",
  },
  polygon: { label: "Polygon", inputs: [P.radius, P.sides], sdf: "ng_sd_polygon(p, radius, sides)" },
  star: {
    label: "Star",
    inputs: [P.radius, P.points, P.inner],
    sdf: "ng_sd_star(p, radius, points, inner)",
  },
  ring: { label: "Ring", inputs: [P.radius, P.thickness], sdf: "abs(length(p) - radius) - thickness * 0.5" },
};

const OUTPUTS: readonly PortDef[] = [
  { id: "mask", label: "Mask", type: "float" },
  { id: "distance", label: "Distance", type: "float" },
];
const portsFor = memoPorts((shape) => ({
  inputs: [P.uv, P.center, ...(SHAPES[shape] ?? SHAPES.circle).inputs, P.rotation, P.softness],
  outputs: OUTPUTS,
}));

const SDF_HELPERS = /* wgsl */ `fn ng_sd_box(p: vec2f, half: vec2f, r: f32) -> f32 {
  let q = abs(p) - half + vec2f(r);
  return length(max(q, vec2f(0.0))) + min(max(q.x, q.y), 0.0) - r;
}
fn ng_sd_polygon(p: vec2f, r: f32, sides: f32) -> f32 {
  let n = max(floor(sides), 3.0);
  let s = NG_TAU / n;
  let a = atan2(p.x, p.y) + NG_PI;
  return cos(floor(0.5 + a / s) * s - a) * length(p) - r * cos(s * 0.5);
}
fn ng_sd_star(p0: vec2f, r: f32, points: f32, inner: f32) -> f32 {
  let n = max(floor(points), 3.0);
  // inner 0 → sharpest star, 1 → regular polygon.
  let m = 2.0 + clamp(inner, 0.0, 1.0) * (n - 2.0);
  let an = NG_PI / n;
  let en = NG_PI / m;
  let acs = vec2f(cos(an), sin(an));
  let ecs = vec2f(cos(en), sin(en));
  let a = atan2(p0.x, p0.y);
  let bn = a - 2.0 * an * floor(a / (2.0 * an)) - an;
  var p = length(p0) * vec2f(cos(bn), abs(sin(bn)));
  p -= r * acs;
  p += ecs * clamp(-dot(p, ecs), 0.0, r * acs.y / ecs.y);
  return length(p) * sign(p.x);
}`;

/** Anti-aliased shape mask from a signed distance field. */
class ShapeNode implements INode {
  readonly type = "shape";
  readonly label = "Shape";
  readonly category = "Texture";
  readonly domains = ["shader"] as const;
  readonly description =
    "Circle, rectangle, ellipse, polygon, star or ring as an anti-aliased mask (1 inside), plus its " +
    "signed distance (negative inside). Sizes are in canvas heights.";
  readonly width = 180;
  readonly params = [
    {
      id: "shape",
      label: "Shape",
      spec: enumSpec("circle", Object.entries(SHAPES).map(([id, s]) => [id, s.label])),
    },
  ];
  readonly inputs = portsFor("circle").inputs;
  readonly outputs = OUTPUTS;

  ports(params: Readonly<Record<string, ParamValue>>): NodePorts {
    return portsFor(String(params.shape));
  }

  generateShader(ctx: ShaderContext): ShaderOutputs {
    registerCommon(ctx);
    ctx.helper("ng_sdf", SDF_HELPERS);
    const id = SHAPES[String(ctx.param("shape"))] ? String(ctx.param("shape")) : "circle";
    const shape = SHAPES[id];
    const name = `ng_shape_${id}`;
    const params = shape.inputs.map((p) => `${p.id}: ${p.type === "vec2" ? "vec2f" : "f32"}`);
    const fn = ctx.helper(
      name,
      `fn ${name}(uv: vec2f, c: vec2f, deg: f32, a: vec2f${params.map((p) => `, ${p}`).join("")}) -> f32 {
  let p = ng_rotate2((uv - c) * a * vec2f(1.0, -1.0), -deg);
  return ${shape.sdf};
}`,
    );
    const args = [
      ctx.input("uv") ?? ctx.uv,
      ctx.input("center") ?? "vec2f(0.5)",
      ctx.input("rotation") ?? "0.0",
      aspectExpr(ctx),
      ...shape.inputs.map((p) => ctx.input(p.id) ?? (p.type === "vec2" ? "vec2f(0.0)" : "0.0")),
    ];
    const dist = ctx.local("f32", `${fn}(${args.join(", ")})`);
    // One pixel of anti-aliasing (in canvas heights) plus the softness.
    const aa = `${ctx.texelSize}.y`;
    const soft = `max(${ctx.input("softness") ?? "0.0"}, 0.0)`;
    return {
      mask: `(1.0 - smoothstep(-0.5 * ${aa} - ${soft}, 0.5 * ${aa}, ${dist}))`,
      distance: dist,
    };
  }
}

export const shapeNode: INode = new ShapeNode();
