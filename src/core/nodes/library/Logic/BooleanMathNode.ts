import type { ExecContext, ExecResult, INode, NodePorts, ShaderContext, ShaderOutputs } from "../../INode";
import type { ParamValue } from "../../graphTypes";
import { enumSpec, memoPorts } from "../_shared/nodeKit";

interface Op {
  label: string;
  unary?: boolean;
  /** Over WGSL `bool` expressions. */
  wgsl: (a: string, b: string) => string;
  js: (a: boolean, b: boolean) => boolean;
}

const OPS: Record<string, Op> = {
  and: { label: "And", wgsl: (a, b) => `${a} && ${b}`, js: (a, b) => a && b },
  or: { label: "Or", wgsl: (a, b) => `${a} || ${b}`, js: (a, b) => a || b },
  not: { label: "Not", unary: true, wgsl: (a) => `!${a}`, js: (a) => !a },
  xor: { label: "Xor", wgsl: (a, b) => `${a} != ${b}`, js: (a, b) => a !== b },
  nand: { label: "Nand", wgsl: (a, b) => `!(${a} && ${b})`, js: (a, b) => !(a && b) },
  nor: { label: "Nor", wgsl: (a, b) => `!(${a} || ${b})`, js: (a, b) => !(a || b) },
  imply: { label: "Imply", wgsl: (a, b) => `!${a} || ${b}`, js: (a, b) => !a || b },
};

const A = { id: "a", label: "A", type: "bool", value: { kind: "bool", default: false } } as const;
const B = { id: "b", label: "B", type: "bool", value: { kind: "bool", default: false } } as const;
const OUTPUTS = [{ id: "result", label: "Result", type: "bool" }] as const;

const portsFor = memoPorts((op) => ({
  inputs: OPS[op]?.unary ? [A] : [A, B],
  outputs: OUTPUTS,
}));

class BooleanMathNode implements INode {
  readonly type = "booleanMath";
  readonly label = "Boolean Math";
  readonly category = "Logic";
  readonly domains = ["shader", "automation"] as const;
  readonly inputs = [A, B];
  readonly outputs = OUTPUTS;
  readonly params = [
    {
      id: "op",
      label: "Operation",
      spec: enumSpec("and", Object.entries(OPS).map(([id, op]) => [id, op.label])),
    },
  ];

  ports(params: Readonly<Record<string, ParamValue>>): NodePorts {
    return portsFor(String(params.op));
  }

  private op(ctx: { param(id: string): unknown }): Op {
    return OPS[String(ctx.param("op"))] ?? OPS.and;
  }

  generateShader(ctx: ShaderContext): ShaderOutputs {
    // Shader bools are f32 0/1.
    const a = `(${ctx.input("a") ?? "0.0"} > 0.5)`;
    const b = `(${ctx.input("b") ?? "0.0"} > 0.5)`;
    return { result: `select(0.0, 1.0, ${this.op(ctx).wgsl(a, b)})` };
  }

  async execute(ctx: ExecContext): Promise<ExecResult> {
    const a = (await ctx.input("a")) === true;
    const b = (await ctx.input("b")) === true;
    return { outputs: { result: this.op(ctx).js(a, b) } };
  }
}

export const booleanMathNode: INode = new BooleanMathNode();
