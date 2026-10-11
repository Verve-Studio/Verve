import type { ExecContext, ExecResult, INode, NodePorts, ShaderContext, ShaderOutputs } from "../../INode";
import type { ParamValue } from "../../graphTypes";
import { enumSpec, floatSpec, memoPorts, numberInput } from "../_shared/nodeKit";

interface Op {
  label: string;
  /** Uses only A (B is hidden). */
  unary?: boolean;
  wgsl: (a: string, b: string) => string;
  js: (a: number, b: number) => number;
}

/** Division and modulo by zero yield 0 in both domains. */
const OPS: Record<string, Op> = {
  add: { label: "Add", wgsl: (a, b) => `${a} + ${b}`, js: (a, b) => a + b },
  subtract: { label: "Subtract", wgsl: (a, b) => `${a} - ${b}`, js: (a, b) => a - b },
  multiply: { label: "Multiply", wgsl: (a, b) => `${a} * ${b}`, js: (a, b) => a * b },
  divide: {
    label: "Divide",
    wgsl: (a, b) => `select(${a} / ${b}, 0.0, ${b} == 0.0)`,
    js: (a, b) => (b === 0 ? 0 : a / b),
  },
  power: { label: "Power", wgsl: (a, b) => `pow(${a}, ${b})`, js: (a, b) => Math.pow(a, b) },
  min: { label: "Minimum", wgsl: (a, b) => `min(${a}, ${b})`, js: Math.min },
  max: { label: "Maximum", wgsl: (a, b) => `max(${a}, ${b})`, js: Math.max },
  modulo: {
    label: "Modulo",
    wgsl: (a, b) => `select(${a} % ${b}, 0.0, ${b} == 0.0)`,
    js: (a, b) => (b === 0 ? 0 : a % b),
  },
  abs: { label: "Absolute", unary: true, wgsl: (a) => `abs(${a})`, js: Math.abs },
  floor: { label: "Floor", unary: true, wgsl: (a) => `floor(${a})`, js: Math.floor },
  fract: { label: "Fraction", unary: true, wgsl: (a) => `fract(${a})`, js: (a) => a - Math.floor(a) },
  sqrt: { label: "Square Root", unary: true, wgsl: (a) => `sqrt(max(${a}, 0.0))`, js: (a) => Math.sqrt(Math.max(a, 0)) },
  sin: { label: "Sine", unary: true, wgsl: (a) => `sin(${a})`, js: Math.sin },
  cos: { label: "Cosine", unary: true, wgsl: (a) => `cos(${a})`, js: Math.cos },
};

const A = { id: "a", label: "A", type: "float", value: floatSpec(0) } as const;
const B = { id: "b", label: "B", type: "float", value: floatSpec(0) } as const;
const OUTPUTS = [{ id: "result", label: "Result", type: "float" }] as const;
const portsFor = memoPorts((op) => ({
  inputs: OPS[op]?.unary ? [A] : [A, B],
  outputs: OUTPUTS,
}));

class MathNode implements INode {
  readonly type = "math";
  readonly label = "Math";
  readonly category = "Math";
  readonly domains = ["shader", "automation"] as const;
  readonly inputs = [A, B];
  readonly outputs = OUTPUTS;
  readonly params = [
    {
      id: "op",
      label: "Operation",
      spec: enumSpec("add", Object.entries(OPS).map(([id, op]) => [id, op.label])),
    },
  ];

  ports(params: Readonly<Record<string, ParamValue>>): NodePorts {
    return portsFor(String(params.op));
  }

  private op(ctx: { param(id: string): unknown }): Op {
    return OPS[String(ctx.param("op"))] ?? OPS.add;
  }

  generateShader(ctx: ShaderContext): ShaderOutputs {
    const a = `(${ctx.input("a") ?? "0.0"})`;
    const b = `(${ctx.input("b") ?? "0.0"})`;
    return { result: `(${this.op(ctx).wgsl(a, b)})` };
  }

  async execute(ctx: ExecContext): Promise<ExecResult> {
    const a = await numberInput(ctx, "a");
    const b = await numberInput(ctx, "b");
    return { outputs: { result: this.op(ctx).js(a, b) } };
  }
}

export const mathNode: INode = new MathNode();
