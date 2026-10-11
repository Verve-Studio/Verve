import type { INode, NodePorts, PortDef, ShaderContext, ShaderOutputs } from "../../INode";
import type { ParamValue } from "../../graphTypes";
import { colorSpec, enumSpec, floatSpec, memoPorts, vec2Spec } from "../_shared/nodeKit";
import { aspectExpr } from "../_shared/shaderKit";

const BASE: readonly PortDef[] = [
  { id: "color", label: "Base Color", type: "color" },
  { id: "normal", label: "Normal", type: "vec3" },
];
const DIRECTIONAL: readonly PortDef[] = [
  { id: "azimuth", label: "Azimuth (°)", type: "float", value: floatSpec(135, -360, 360, 0.5) },
  { id: "elevation", label: "Elevation (°)", type: "float", value: floatSpec(45, 0, 90, 0.25) },
];
const POINT: readonly PortDef[] = [
  { id: "position", label: "Light Position", type: "vec2", value: vec2Spec(0.25, 0.25) },
  { id: "height", label: "Light Height", type: "float", value: floatSpec(0.25, 0, 4) },
  { id: "falloff", label: "Falloff", type: "float", value: floatSpec(0, 0, 10) },
];
const SHARED: readonly PortDef[] = [
  { id: "lightColor", label: "Light Color", type: "color", value: colorSpec(1, 1, 1) },
  { id: "intensity", label: "Intensity", type: "float", value: floatSpec(1, 0, 10) },
  { id: "ambient", label: "Ambient", type: "float", value: floatSpec(0.25, 0, 1) },
  { id: "specular", label: "Specular", type: "float", value: floatSpec(0.3, 0, 4) },
  { id: "shininess", label: "Shininess", type: "float", value: floatSpec(32, 1, 512, 0.5) },
];
const OUTPUTS: readonly PortDef[] = [
  { id: "color", label: "Color", type: "color" },
  { id: "diffuse", label: "Diffuse", type: "float" },
  { id: "specular", label: "Specular", type: "float" },
];

const portsFor = memoPorts((mode) => ({
  inputs: [...BASE, ...(mode === "point" ? POINT : DIRECTIONAL), ...SHARED],
  outputs: OUTPUTS,
}));

const HELPER = /* wgsl */ `struct NgLight { color: vec4f, diffuse: f32, specular: f32 }
fn ng_light(base: vec4f, n0: vec3f, l: vec3f, atten: f32, lc: vec3f, intensity: f32, ambient: f32, specAmt: f32, shininess: f32) -> NgLight {
  let n = select(normalize(n0), vec3f(0.0, 0.0, 1.0), dot(n0, n0) < 1e-8);
  let diffuse = max(dot(n, l), 0.0) * atten;
  // Blinn-Phong, viewer straight above the image.
  let h = normalize(l + vec3f(0.0, 0.0, 1.0));
  let spec = select(0.0, pow(max(dot(n, h), 0.0), shininess) * specAmt * atten, dot(n, l) > 0.0);
  let light = lc * intensity;
  let rgb = base.rgb * (vec3f(ambient) + light * diffuse) + light * spec;
  return NgLight(vec4f(rgb, base.a), diffuse, spec);
}`;

/**
 * Shade a surface by a light: Base Color (unconnected: the layer) lit
 * through Normal (unconnected: flat). Directional light comes from Azimuth
 * (counter-clockwise from the right) at Elevation above the image; a point
 * light sits at a UV position, Height above the image (in canvas heights).
 */
class LightingNode implements INode {
  readonly type = "lighting";
  readonly label = "Lighting";
  readonly category = "Surface";
  readonly domains = ["shader"] as const;
  readonly description =
    "Light a surface: Base Color (default: the layer) shaded by Normal with a directional or point " +
    "light (diffuse + Blinn-Phong specular).";
  readonly width = 200;
  readonly inputs = portsFor("directional").inputs;
  readonly outputs = OUTPUTS;
  readonly params = [
    {
      id: "mode",
      label: "Light",
      spec: enumSpec("directional", [
        ["directional", "Directional"],
        ["point", "Point"],
      ]),
    },
  ] as const;

  ports(params: Readonly<Record<string, ParamValue>>): NodePorts {
    return portsFor(String(params.mode));
  }

  generateShader(ctx: ShaderContext): ShaderOutputs {
    const fn = ctx.helper("ng_light", HELPER);
    const n = ctx.input("normal") ?? "vec3f(0.0, 0.0, 1.0)";
    let dir: string;
    let atten = "1.0";
    if (ctx.param("mode") === "point") {
      const pos = ctx.input("position") ?? "vec2f(0.25)";
      const h = ctx.input("height") ?? "0.25";
      // Image +Y is up in normal space; UV y points down.
      const d = ctx.local(
        "vec3f",
        `vec3f(((${pos}) - ${ctx.uv}) * ${aspectExpr(ctx)} * vec2f(1.0, -1.0), ${h})`,
      );
      dir = `normalize(${d})`;
      atten = `(1.0 / (1.0 + (${ctx.input("falloff") ?? "0.0"}) * dot(${d}, ${d})))`;
    } else {
      const az = `radians(${ctx.input("azimuth") ?? "135.0"})`;
      const el = `radians(${ctx.input("elevation") ?? "45.0"})`;
      dir = `vec3f(cos(${el}) * cos(${az}), cos(${el}) * sin(${az}), sin(${el}))`;
    }
    const args = [
      ctx.input("color") ?? ctx.source,
      n,
      dir,
      atten,
      `(${ctx.input("lightColor") ?? "vec4f(1.0)"}).rgb`,
      ctx.input("intensity") ?? "1.0",
      ctx.input("ambient") ?? "0.25",
      ctx.input("specular") ?? "0.3",
      ctx.input("shininess") ?? "32.0",
    ];
    const r = ctx.local("NgLight", `${fn}(${args.join(", ")})`);
    return { color: `${r}.color`, diffuse: `${r}.diffuse`, specular: `${r}.specular` };
  }
}

export const lightingNode: INode = new LightingNode();
