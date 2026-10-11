import type { INode, NodePorts, PortDef, ShaderContext, ShaderOutputs } from "../../INode";
import type { ParamValue } from "../../graphTypes";
import { enumSpec, floatSpec, memoPorts } from "../_shared/nodeKit";

interface Op {
  label: string;
  /** Extra inputs besides A. */
  args: readonly ("b" | "scale" | "factor")[];
  /** Produces a scalar (Value) rather than a vector. */
  scalar?: boolean;
  wgsl: (a: string, b: string, s: string) => string;
}

const OPS: Record<string, Op> = {
  add: { label: "Add", args: ["b"], wgsl: (a, b) => `${a} + ${b}` },
  subtract: { label: "Subtract", args: ["b"], wgsl: (a, b) => `${a} - ${b}` },
  multiply: { label: "Multiply", args: ["b"], wgsl: (a, b) => `${a} * ${b}` },
  divide: {
    label: "Divide",
    args: ["b"],
    wgsl: (a, b) => `select(${a} / ${b}, vec3f(0.0), ${b} == vec3f(0.0))`,
  },
  scale: { label: "Scale", args: ["scale"], wgsl: (a, _b, s) => `${a} * ${s}` },
  cross: { label: "Cross Product", args: ["b"], wgsl: (a, b) => `cross(${a}, ${b})` },
  dot: { label: "Dot Product", args: ["b"], scalar: true, wgsl: (a, b) => `dot(${a}, ${b})` },
  length: { label: "Length", args: [], scalar: true, wgsl: (a) => `length(${a})` },
  distance: { label: "Distance", args: ["b"], scalar: true, wgsl: (a, b) => `distance(${a}, ${b})` },
  normalize: {
    label: "Normalize",
    args: [],
    wgsl: (a) => `select(normalize(${a}), vec3f(0.0), all(${a} == vec3f(0.0)))`,
  },
  reflect: { label: "Reflect", args: ["b"], wgsl: (a, b) => `reflect(${a}, normalize(${b}))` },
  mix: { label: "Mix", args: ["b", "factor"], wgsl: (a, b, s) => `mix(${a}, ${b}, ${s})` },
  minimum: { label: "Minimum", args: ["b"], wgsl: (a, b) => `min(${a}, ${b})` },
  maximum: { label: "Maximum", args: ["b"], wgsl: (a, b) => `max(${a}, ${b})` },
  absolute: { label: "Absolute", args: [], wgsl: (a) => `abs(${a})` },
  negate: { label: "Negate", args: [], wgsl: (a) => `-${a}` },
};

const A: PortDef = { id: "a", label: "A", type: "vec3" };
const EXTRA: Record<"b" | "scale" | "factor", PortDef> = {
  b: { id: "b", label: "B", type: "vec3" },
  scale: { id: "scale", label: "Scale", type: "float", value: floatSpec(1) },
  factor: { id: "factor", label: "Factor", type: "float", value: floatSpec(0.5, 0, 1) },
};
const VECTOR_OUT: PortDef = { id: "vector", label: "Vector", type: "vec3" };
const VALUE_OUT: PortDef = { id: "value", label: "Value", type: "float" };

const portsFor = memoPorts((key) => {
  const op = OPS[key] ?? OPS.add;
  return { inputs: [A, ...op.args.map((a) => EXTRA[a])], outputs: [op.scalar ? VALUE_OUT : VECTOR_OUT] };
});

/** Maths on 3D vectors (normals, light directions, RGB as XYZ). Build
 *  constant vectors with Combine XYZ. */
class Vector3MathNode implements INode {
  readonly type = "vector3Math";
  readonly label = "Vector3 Math";
  readonly category = "Vector";
  readonly domains = ["shader"] as const;
  readonly description =
    "Maths on 3D vectors such as normals and light directions. Unconnected vectors are (0, 0, 0); " +
    "build constants with Combine XYZ.";
  readonly params = [
    {
      id: "op",
      label: "Operation",
      spec: enumSpec("add", Object.entries(OPS).map(([id, op]) => [id, op.label])),
    },
  ];
  readonly inputs = portsFor("add").inputs;
  readonly outputs = portsFor("add").outputs;

  ports(params: Readonly<Record<string, ParamValue>>): NodePorts {
    return portsFor(String(params.op));
  }

  generateShader(ctx: ShaderContext): ShaderOutputs {
    const op = OPS[String(ctx.param("op"))] ?? OPS.add;
    const a = `(${ctx.input("a") ?? "vec3f(0.0)"})`;
    const b = `(${ctx.input("b") ?? "vec3f(0.0)"})`;
    const s = `(${ctx.input("scale") ?? ctx.input("factor") ?? "0.0"})`;
    return { [op.scalar ? "value" : "vector"]: `(${op.wgsl(a, b, s)})` };
  }
}

export const vector3MathNode: INode = new Vector3MathNode();
