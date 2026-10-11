import type { ExecContext, ExecResult, INode, ShaderContext, ShaderOutputs } from "../../INode";
import { colorSpec, enumSpec, floatSpec, numberInput, vectorInput } from "../_shared/nodeKit";

interface Mode {
  label: string;
  /** Blend of `a` and `b` (vec3f expressions). */
  wgsl: string;
  /** Same, per channel. */
  js: (a: number, b: number) => number;
}

const MODES: Record<string, Mode> = {
  mix: { label: "Mix", wgsl: "b", js: (_a, b) => b },
  multiply: { label: "Multiply", wgsl: "a * b", js: (a, b) => a * b },
  screen: { label: "Screen", wgsl: "1.0 - (1.0 - a) * (1.0 - b)", js: (a, b) => 1 - (1 - a) * (1 - b) },
  overlay: {
    label: "Overlay",
    wgsl: "select(1.0 - 2.0 * (1.0 - a) * (1.0 - b), 2.0 * a * b, a < vec3f(0.5))",
    js: (a, b) => (a < 0.5 ? 2 * a * b : 1 - 2 * (1 - a) * (1 - b)),
  },
  add: { label: "Add", wgsl: "a + b", js: (a, b) => a + b },
  subtract: { label: "Subtract", wgsl: "a - b", js: (a, b) => a - b },
  difference: { label: "Difference", wgsl: "abs(a - b)", js: (a, b) => Math.abs(a - b) },
};

class MixNode implements INode {
  readonly type = "mix";
  readonly label = "Mix";
  readonly category = "Color";
  readonly domains = ["shader", "automation"] as const;
  readonly description = "Blend B over A; Factor fades the blend in.";
  readonly inputs = [
    { id: "factor", label: "Factor", type: "float", value: floatSpec(0.5, 0, 1) },
    { id: "a", label: "A", type: "color", value: colorSpec(0, 0, 0) },
    { id: "b", label: "B", type: "color", value: colorSpec(1, 1, 1) },
  ] as const;
  readonly outputs = [{ id: "color", label: "Color", type: "color" }] as const;
  readonly params = [
    {
      id: "mode",
      label: "Blend",
      spec: enumSpec("mix", Object.entries(MODES).map(([id, m]) => [id, m.label])),
    },
  ];

  private mode(ctx: { param(id: string): unknown }): [string, Mode] {
    const id = String(ctx.param("mode"));
    return MODES[id] ? [id, MODES[id]] : ["mix", MODES.mix];
  }

  generateShader(ctx: ShaderContext): ShaderOutputs {
    const [id, mode] = this.mode(ctx);
    const fn = ctx.helper(
      `ng_mix_${id}`,
      `fn ng_mix_${id}(f: f32, ca: vec4f, cb: vec4f) -> vec4f {
  let a = ca.rgb;
  let b = cb.rgb;
  return vec4f(mix(a, ${mode.wgsl}, f), mix(ca.a, cb.a, f));
}`,
    );
    const f = ctx.input("factor") ?? "0.5";
    const a = ctx.input("a") ?? "vec4f(0.0, 0.0, 0.0, 1.0)";
    const b = ctx.input("b") ?? "vec4f(1.0)";
    return { color: `${fn}(${f}, ${a}, ${b})` };
  }

  async execute(ctx: ExecContext): Promise<ExecResult> {
    const [, mode] = this.mode(ctx);
    const f = await numberInput(ctx, "factor");
    const a = await vectorInput(ctx, "a", [0, 0, 0, 1]);
    const b = await vectorInput(ctx, "b", [1, 1, 1, 1]);
    const lerp = (x: number, y: number): number => x + (y - x) * f;
    const rgb = [0, 1, 2].map((i) => lerp(a[i], mode.js(a[i], b[i])));
    return { outputs: { color: [...rgb, lerp(a[3], b[3])] } };
  }
}

export const mixNode: INode = new MixNode();
