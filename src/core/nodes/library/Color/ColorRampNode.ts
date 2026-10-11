import type { INode, NodePorts, PortDef, ShaderContext, ShaderOutputs } from "../../INode";
import type { ParamValue } from "../../graphTypes";
import { colorSpec, enumSpec, floatSpec, memoPorts } from "../_shared/nodeKit";

/** Default stop colours (grey ramp) and positions per stop count. */
const DEFAULTS: Record<number, readonly [number, number][]> = {
  2: [[0, 0], [1, 1]],
  3: [[0, 0], [0.5, 0.5], [1, 1]],
  4: [[0, 0], [0.33, 1 / 3], [0.67, 2 / 3], [1, 1]],
  5: [[0, 0], [0.25, 0.25], [0.5, 0.5], [0.75, 0.75], [1, 1]],
};

const FAC: PortDef = { id: "fac", label: "Fac", type: "float", value: floatSpec(0.5, 0, 1) };
const OUTPUTS: readonly PortDef[] = [
  { id: "color", label: "Color", type: "color" },
  { id: "alpha", label: "Alpha", type: "float" },
];

const portsFor = memoPorts((key) => {
  const n = DEFAULTS[Number(key)] ? Number(key) : 2;
  const stops = DEFAULTS[n].flatMap(([pos, grey], i): PortDef[] => [
    { id: `c${i}`, label: `Color ${i + 1}`, type: "color", value: colorSpec(grey, grey, grey) },
    { id: `p${i}`, label: `Position ${i + 1}`, type: "float", value: floatSpec(pos, 0, 1) },
  ]);
  return { inputs: [FAC, ...stops], outputs: OUTPUTS };
});

const BLEND: Record<string, string> = {
  linear: "t",
  smooth: "t * t * (3.0 - 2.0 * t)",
  constant: "0.0",
};

/** WGSL for an n-stop ramp; stops are taken in order (keep positions
 *  ascending). */
function rampCode(name: string, n: number, interp: string): string {
  const params = Array.from({ length: n }, (_, i) => `c${i}: vec4f, p${i}: f32`).join(", ");
  const lines = [`fn ${name}(f: f32, ${params}) -> vec4f {`, `  if (f <= p0) { return c0; }`];
  for (let i = 0; i < n - 1; i++) {
    lines.push(
      `  if (f < p${i + 1}) {`,
      `    let t = clamp((f - p${i}) / max(p${i + 1} - p${i}, 1e-6), 0.0, 1.0);`,
      `    return mix(c${i}, c${i + 1}, ${BLEND[interp]});`,
      `  }`,
    );
  }
  lines.push(`  return c${n - 1};`, `}`);
  return lines.join("\n");
}

/** Map a value (0–1) to a colour through 2–5 stops (gradient map). */
class ColorRampNode implements INode {
  readonly type = "colorRamp";
  readonly label = "Color Ramp";
  readonly category = "Color";
  readonly domains = ["shader"] as const;
  readonly description =
    "Map Fac (0–1) to a colour through 2–5 colour stops — a gradient map. Keep stop positions in " +
    "ascending order.";
  readonly width = 190;
  readonly params = [
    {
      id: "stops",
      label: "Stops",
      spec: enumSpec("2", [
        ["2", "2 stops"],
        ["3", "3 stops"],
        ["4", "4 stops"],
        ["5", "5 stops"],
      ]),
    },
    {
      id: "interpolation",
      label: "Interpolation",
      spec: enumSpec("linear", [
        ["linear", "Linear"],
        ["smooth", "Smooth"],
        ["constant", "Constant"],
      ]),
    },
  ];
  readonly inputs = portsFor("2").inputs;
  readonly outputs = OUTPUTS;

  ports(params: Readonly<Record<string, ParamValue>>): NodePorts {
    return portsFor(String(params.stops));
  }

  generateShader(ctx: ShaderContext): ShaderOutputs {
    const n = DEFAULTS[Number(ctx.param("stops"))] ? Number(ctx.param("stops")) : 2;
    const interp = BLEND[String(ctx.param("interpolation"))] ? String(ctx.param("interpolation")) : "linear";
    const name = `ng_ramp_${n}_${interp}`;
    const fn = ctx.helper(name, rampCode(name, n, interp));
    const args = [ctx.input("fac") ?? "0.5"];
    for (let i = 0; i < n; i++) {
      args.push(ctx.input(`c${i}`) ?? "vec4f(0.0, 0.0, 0.0, 1.0)", ctx.input(`p${i}`) ?? "0.0");
    }
    const color = ctx.local("vec4f", `${fn}(${args.join(", ")})`);
    return { color, alpha: `${color}.a` };
  }
}

export const colorRampNode: INode = new ColorRampNode();
