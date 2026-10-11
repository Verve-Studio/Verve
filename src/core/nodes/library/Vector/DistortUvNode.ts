import type { INode, NodePorts, PortDef, ShaderContext, ShaderOutputs } from "../../INode";
import type { ParamValue } from "../../graphTypes";
import { enumSpec, floatSpec, memoPorts, vec2Spec } from "../_shared/nodeKit";
import { aspectExpr, registerCommon } from "../_shared/shaderKit";

const P = {
  uv: { id: "uv", label: "UV", type: "vec2" },
  center: { id: "center", label: "Center", type: "vec2", value: vec2Spec(0.5, 0.5) },
  radius: { id: "radius", label: "Radius", type: "float", value: floatSpec(0.4, 0, 4) },
  angle: { id: "angle", label: "Angle (°)", type: "float", value: floatSpec(180, -3600, 3600, 1) },
  amount: { id: "amount", label: "Amount", type: "float", value: floatSpec(0.5, -1, 1) },
  amplitude: { id: "amplitude", label: "Amplitude", type: "float", value: floatSpec(0.01, -1, 1, 0.0005) },
  frequency: { id: "frequency", label: "Frequency", type: "float", value: floatSpec(20, 0, 500, 0.1) },
  phase: { id: "phase", label: "Phase", type: "float", value: floatSpec(0, undefined, undefined, 0.01) },
} satisfies Record<string, PortDef>;

const MODES: Record<string, { label: string; inputs: readonly PortDef[] }> = {
  twirl: { label: "Twirl", inputs: [P.uv, P.center, P.radius, P.angle] },
  pinch: { label: "Pinch / Bulge", inputs: [P.uv, P.center, P.radius, P.amount] },
  ripple: { label: "Ripple", inputs: [P.uv, P.center, P.amplitude, P.frequency, P.phase] },
  wave: { label: "Wave", inputs: [P.uv, P.amplitude, P.frequency, P.phase] },
};

const OUTPUTS: readonly PortDef[] = [{ id: "uv", label: "UV", type: "vec2" }];
const portsFor = memoPorts((mode) => ({ inputs: (MODES[mode] ?? MODES.twirl).inputs, outputs: OUTPUTS }));

/** Positions are in canvas heights (aspect-corrected) so effects stay round. */
const HELPERS: Record<string, string> = {
  twirl: /* wgsl */ `fn ng_twirl(uv: vec2f, c: vec2f, radius: f32, deg: f32, a: vec2f) -> vec2f {
  let d = (uv - c) * a;
  let t = clamp(1.0 - length(d) / max(radius, 1e-6), 0.0, 1.0);
  return c + ng_rotate2(d, deg * t * t) / a;
}`,
  pinch: /* wgsl */ `fn ng_pinch(uv: vec2f, c: vec2f, radius: f32, amount: f32, a: vec2f) -> vec2f {
  let d = (uv - c) * a;
  let x = length(d) / max(radius, 1e-6);
  if (x >= 1.0 || x <= 0.0) { return uv; }
  let k = clamp(amount, -1.0, 1.0);
  return c + d * pow(sin(x * NG_PI * 0.5), -k) / a;
}`,
  ripple: /* wgsl */ `fn ng_ripple(uv: vec2f, c: vec2f, amp: f32, freq: f32, phase: f32, a: vec2f) -> vec2f {
  let d = (uv - c) * a;
  let r = length(d);
  if (r <= 0.0) { return uv; }
  let off = sin((r * freq - phase) * NG_TAU) * amp;
  return uv + (d / r) * off / a;
}`,
  wave: /* wgsl */ `fn ng_wave(uv: vec2f, amp: f32, freq: f32, phase: f32, a: vec2f) -> vec2f {
  let p = uv * a;
  let off = vec2f(sin((p.y * freq + phase) * NG_TAU), sin((p.x * freq + phase) * NG_TAU)) * amp;
  return uv + off / a;
}`,
};

/** Distort UV coordinates; feed the result to Sample Layer (or a texture). */
class DistortUvNode implements INode {
  readonly type = "distortUv";
  readonly label = "Distort UV";
  readonly category = "Vector";
  readonly domains = ["shader"] as const;
  readonly description =
    "Twirl, pinch / bulge, ripple or wave the UV coordinates. Connect the result to Sample Layer's UV " +
    "to distort the image. Radius and amplitude are in canvas heights.";
  readonly width = 180;
  readonly params = [
    {
      id: "mode",
      label: "Type",
      spec: enumSpec("twirl", Object.entries(MODES).map(([id, m]) => [id, m.label])),
    },
  ];
  readonly inputs = portsFor("twirl").inputs;
  readonly outputs = OUTPUTS;

  ports(params: Readonly<Record<string, ParamValue>>): NodePorts {
    return portsFor(String(params.mode));
  }

  generateShader(ctx: ShaderContext): ShaderOutputs {
    registerCommon(ctx);
    const mode = MODES[String(ctx.param("mode"))] ? String(ctx.param("mode")) : "twirl";
    const fn = ctx.helper(`ng_${mode}`, HELPERS[mode]);
    const v = (id: keyof typeof P, fallback: string): string => ctx.input(id) ?? fallback;
    const uv = v("uv", ctx.uv);
    const center = v("center", "vec2f(0.5)");
    const a = aspectExpr(ctx);
    let args: string[];
    switch (mode) {
      case "pinch":
        args = [uv, center, v("radius", "0.4"), v("amount", "0.5"), a];
        break;
      case "ripple":
        args = [uv, center, v("amplitude", "0.01"), v("frequency", "20.0"), v("phase", "0.0"), a];
        break;
      case "wave":
        args = [uv, v("amplitude", "0.01"), v("frequency", "20.0"), v("phase", "0.0"), a];
        break;
      default:
        args = [uv, center, v("radius", "0.4"), v("angle", "180.0"), a];
    }
    return { uv: `${fn}(${args.join(", ")})` };
  }
}

export const distortUvNode: INode = new DistortUvNode();
