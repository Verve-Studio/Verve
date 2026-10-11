import type { INode, NodePorts, PortDef, ShaderContext, ShaderOutputs } from "../../INode";
import type { ParamValue } from "../../graphTypes";
import { enumSpec, memoPorts, vec2Spec } from "../_shared/nodeKit";
import { aspectExpr, registerCommon } from "../_shared/shaderKit";

const UV: PortDef = { id: "uv", label: "UV", type: "vec2" };
const CENTER: PortDef = { id: "center", label: "Center", type: "vec2", value: vec2Spec(0.5, 0.5) };
const POLAR_IN: PortDef = { id: "uv", label: "Polar (angle, radius)", type: "vec2" };

const portsFor = memoPorts((mode) =>
  mode === "fromPolar"
    ? { inputs: [POLAR_IN, CENTER], outputs: [{ id: "uv", label: "UV", type: "vec2" }] }
    : {
        inputs: [UV, CENTER],
        outputs: [
          { id: "uv", label: "Polar", type: "vec2" },
          { id: "angle", label: "Angle", type: "float" },
          { id: "radius", label: "Radius", type: "float" },
        ],
      },
);

/**
 * To Polar: UV → (angle 0–1 counter-clockwise from the right, distance
 * from Center in canvas heights). From Polar: the inverse. Sampling a layer
 * at the To Polar result unwraps it; From Polar wraps a strip into a circle.
 */
class PolarCoordinatesNode implements INode {
  readonly type = "polarCoordinates";
  readonly label = "Polar Coordinates";
  readonly category = "Vector";
  readonly domains = ["shader"] as const;
  readonly description =
    "Convert UV to polar coordinates around Center (angle 0–1, radius in canvas heights) or back. " +
    "Use with Sample Layer for polar unwraps, tunnels and radial patterns.";
  readonly width = 190;
  readonly params = [
    {
      id: "mode",
      label: "Direction",
      spec: enumSpec("toPolar", [
        ["toPolar", "To Polar"],
        ["fromPolar", "From Polar"],
      ]),
    },
  ];
  readonly inputs = portsFor("toPolar").inputs;
  readonly outputs = portsFor("toPolar").outputs;

  ports(params: Readonly<Record<string, ParamValue>>): NodePorts {
    return portsFor(String(params.mode));
  }

  generateShader(ctx: ShaderContext): ShaderOutputs {
    registerCommon(ctx);
    const uv = ctx.input("uv") ?? ctx.uv;
    const center = ctx.input("center") ?? "vec2f(0.5)";
    const aspect = aspectExpr(ctx);
    if (ctx.param("mode") === "fromPolar") {
      const p = `(${uv})`;
      return {
        uv: `(${center}) + vec2f(cos(${p}.x * NG_TAU), -sin(${p}.x * NG_TAU)) * ${p}.y / ${aspect}`,
      };
    }
    // UV y points down; angles run counter-clockwise on screen.
    const d = ctx.local("vec2f", `((${uv}) - (${center})) * ${aspect} * vec2f(1.0, -1.0)`);
    const angle = ctx.local("f32", `fract(atan2(${d}.y, ${d}.x) / NG_TAU + 1.0)`);
    const radius = ctx.local("f32", `length(${d})`);
    return { uv: `vec2f(${angle}, ${radius})`, angle, radius };
  }
}

export const polarCoordinatesNode: INode = new PolarCoordinatesNode();
