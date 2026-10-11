import type {
  ExecContext,
  ExecResult,
  INode,
  NodePorts,
  PortDef,
  ShaderContext,
  ShaderOutputs,
} from "../../INode";
import type { ParamValue } from "../../graphTypes";
import { enumSpec, floatSpec, memoPorts, numberInput, vec2Spec, vectorInput } from "../_shared/nodeKit";

type V = readonly [number, number];

interface Op {
  label: string;
  /** Extra inputs besides A. */
  args: readonly ("b" | "scale" | "angle")[];
  /** Produces a scalar (Value) rather than a vector. */
  scalar?: boolean;
  wgsl: (a: string, b: string, s: string) => string;
  js: (a: V, b: V, s: number) => V | number;
}

const map = (a: V, f: (x: number, i: number) => number): V => [f(a[0], 0), f(a[1], 1)];

const OPS: Record<string, Op> = {
  add: { label: "Add", args: ["b"], wgsl: (a, b) => `${a} + ${b}`, js: (a, b) => map(a, (x, i) => x + b[i]) },
  subtract: { label: "Subtract", args: ["b"], wgsl: (a, b) => `${a} - ${b}`, js: (a, b) => map(a, (x, i) => x - b[i]) },
  multiply: { label: "Multiply", args: ["b"], wgsl: (a, b) => `${a} * ${b}`, js: (a, b) => map(a, (x, i) => x * b[i]) },
  divide: {
    label: "Divide",
    args: ["b"],
    wgsl: (a, b) => `select(${a} / ${b}, vec2f(0.0), ${b} == vec2f(0.0))`,
    js: (a, b) => map(a, (x, i) => (b[i] === 0 ? 0 : x / b[i])),
  },
  scale: { label: "Scale", args: ["scale"], wgsl: (a, _b, s) => `${a} * ${s}`, js: (a, _b, s) => map(a, (x) => x * s) },
  rotate: {
    label: "Rotate (degrees)",
    args: ["angle"],
    wgsl: (a, _b, s) => `vec2f(cos(radians(${s})) * ${a}.x - sin(radians(${s})) * ${a}.y, sin(radians(${s})) * ${a}.x + cos(radians(${s})) * ${a}.y)`,
    js: (a, _b, s) => {
      const r = (s * Math.PI) / 180;
      return [Math.cos(r) * a[0] - Math.sin(r) * a[1], Math.sin(r) * a[0] + Math.cos(r) * a[1]];
    },
  },
  length: { label: "Length", args: [], scalar: true, wgsl: (a) => `length(${a})`, js: (a) => Math.hypot(a[0], a[1]) },
  distance: {
    label: "Distance",
    args: ["b"],
    scalar: true,
    wgsl: (a, b) => `distance(${a}, ${b})`,
    js: (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]),
  },
  dot: { label: "Dot Product", args: ["b"], scalar: true, wgsl: (a, b) => `dot(${a}, ${b})`, js: (a, b) => a[0] * b[0] + a[1] * b[1] },
  normalize: {
    label: "Normalize",
    args: [],
    wgsl: (a) => `select(normalize(${a}), vec2f(0.0), all(${a} == vec2f(0.0)))`,
    js: (a) => {
      const l = Math.hypot(a[0], a[1]);
      return l === 0 ? [0, 0] : [a[0] / l, a[1] / l];
    },
  },
  minimum: { label: "Minimum", args: ["b"], wgsl: (a, b) => `min(${a}, ${b})`, js: (a, b) => map(a, (x, i) => Math.min(x, b[i])) },
  maximum: { label: "Maximum", args: ["b"], wgsl: (a, b) => `max(${a}, ${b})`, js: (a, b) => map(a, (x, i) => Math.max(x, b[i])) },
  absolute: { label: "Absolute", args: [], wgsl: (a) => `abs(${a})`, js: (a) => map(a, Math.abs) },
  floor: { label: "Floor", args: [], wgsl: (a) => `floor(${a})`, js: (a) => map(a, Math.floor) },
  fract: { label: "Fraction", args: [], wgsl: (a) => `fract(${a})`, js: (a) => map(a, (x) => x - Math.floor(x)) },
};

const A: PortDef = { id: "a", label: "A", type: "vec2", value: vec2Spec(0, 0) };
const EXTRA: Record<"b" | "scale" | "angle", PortDef> = {
  b: { id: "b", label: "B", type: "vec2", value: vec2Spec(0, 0) },
  scale: { id: "scale", label: "Scale", type: "float", value: floatSpec(1) },
  angle: { id: "angle", label: "Angle", type: "float", value: floatSpec(0, undefined, undefined, 0.5) },
};
const VECTOR_OUT: PortDef = { id: "vector", label: "Vector", type: "vec2" };
const VALUE_OUT: PortDef = { id: "value", label: "Value", type: "float" };

const portsFor = memoPorts((key) => {
  const op = OPS[key] ?? OPS.add;
  return { inputs: [A, ...op.args.map((a) => EXTRA[a])], outputs: [op.scalar ? VALUE_OUT : VECTOR_OUT] };
});

class VectorMathNode implements INode {
  readonly type = "vectorMath";
  readonly label = "Vector Math";
  readonly category = "Vector";
  readonly domains = ["shader", "automation"] as const;
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

  private op(ctx: { param(id: string): unknown }): Op {
    return OPS[String(ctx.param("op"))] ?? OPS.add;
  }

  generateShader(ctx: ShaderContext): ShaderOutputs {
    const op = this.op(ctx);
    const a = `(${ctx.input("a") ?? "vec2f(0.0)"})`;
    const b = `(${ctx.input("b") ?? "vec2f(0.0)"})`;
    const s = `(${ctx.input("scale") ?? ctx.input("angle") ?? "0.0"})`;
    return { [op.scalar ? "value" : "vector"]: `(${op.wgsl(a, b, s)})` };
  }

  async execute(ctx: ExecContext): Promise<ExecResult> {
    const op = this.op(ctx);
    const a = (await vectorInput(ctx, "a", [0, 0])) as unknown as V;
    const b = (await vectorInput(ctx, "b", [0, 0])) as unknown as V;
    const s = op.args.includes("angle") ? await numberInput(ctx, "angle") : await numberInput(ctx, "scale");
    const r = op.js(a, b, s);
    return { outputs: { [op.scalar ? "value" : "vector"]: r } };
  }
}

export const vectorMathNode: INode = new VectorMathNode();
