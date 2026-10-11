import type { ExecContext, ExecResult, INode, ShaderContext, ShaderOutputs } from "../../INode";
import { enumSpec, floatSpec, numberInput } from "../_shared/nodeKit";

/** Tolerance for Equal / Not Equal (float noise). */
const EPSILON = 1e-5;

const OPS: Record<string, { wgsl: (a: string, b: string) => string; js: (a: number, b: number) => boolean }> = {
  eq: { wgsl: (a, b) => `abs(${a} - ${b}) < ${EPSILON}`, js: (a, b) => Math.abs(a - b) < EPSILON },
  ne: { wgsl: (a, b) => `abs(${a} - ${b}) >= ${EPSILON}`, js: (a, b) => Math.abs(a - b) >= EPSILON },
  lt: { wgsl: (a, b) => `${a} < ${b}`, js: (a, b) => a < b },
  gt: { wgsl: (a, b) => `${a} > ${b}`, js: (a, b) => a > b },
};

class CompareNode implements INode {
  readonly type = "compare";
  readonly label = "Compare";
  readonly category = "Logic";
  readonly domains = ["shader", "automation"] as const;
  readonly inputs = [
    { id: "a", label: "A", type: "float", value: floatSpec(0, undefined, undefined, 0.1) },
    { id: "b", label: "B", type: "float", value: floatSpec(0, undefined, undefined, 0.1) },
  ] as const;
  readonly outputs = [{ id: "result", label: "Result", type: "bool" }] as const;
  readonly params = [
    {
      id: "op",
      label: "Operation",
      spec: enumSpec("eq", [
        ["eq", "Equal"],
        ["ne", "Not Equal"],
        ["lt", "Less Than"],
        ["gt", "Greater Than"],
      ]),
    },
  ];

  generateShader(ctx: ShaderContext): ShaderOutputs {
    const op = OPS[String(ctx.param("op"))] ?? OPS.eq;
    const a = `(${ctx.input("a") ?? "0.0"})`;
    const b = `(${ctx.input("b") ?? "0.0"})`;
    // Shader bools are f32 0/1.
    return { result: `select(0.0, 1.0, ${op.wgsl(a, b)})` };
  }

  async execute(ctx: ExecContext): Promise<ExecResult> {
    const op = OPS[String(ctx.param("op"))] ?? OPS.eq;
    return { outputs: { result: op.js(await numberInput(ctx, "a"), await numberInput(ctx, "b")) } };
  }
}

export const compareNode: INode = new CompareNode();
