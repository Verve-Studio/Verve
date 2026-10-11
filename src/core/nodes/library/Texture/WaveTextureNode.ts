import type { INode, ShaderContext, ShaderOutputs } from "../../INode";
import { enumSpec, floatSpec, vec2Spec } from "../_shared/nodeKit";
import { aspectExpr, registerCommon } from "../_shared/shaderKit";

const PROFILES: Record<string, { label: string; wgsl: string }> = {
  sine: { label: "Sine", wgsl: "0.5 - 0.5 * cos(t * NG_TAU)" },
  saw: { label: "Saw", wgsl: "fract(t)" },
  triangle: { label: "Triangle", wgsl: "1.0 - abs(fract(t) * 2.0 - 1.0)" },
  square: { label: "Square", wgsl: "step(0.5, fract(t))" },
};

/** Stripes (bands) or concentric rings with a choice of wave profile. */
class WaveTextureNode implements INode {
  readonly type = "waveTexture";
  readonly label = "Wave";
  readonly category = "Texture";
  readonly domains = ["shader"] as const;
  readonly description =
    "Bands or rings (0–1) with a sine, saw, triangle or square profile. Scale is waves per canvas height.";
  readonly width = 180;
  readonly inputs = [
    { id: "uv", label: "UV", type: "vec2" },
    { id: "center", label: "Center", type: "vec2", value: vec2Spec(0.5, 0.5) },
    { id: "scale", label: "Scale", type: "float", value: floatSpec(10, 0, undefined, 0.05) },
    { id: "angle", label: "Angle (°)", type: "float", value: floatSpec(0, -360, 360, 0.5) },
    { id: "phase", label: "Phase", type: "float", value: floatSpec(0, undefined, undefined, 0.01) },
  ] as const;
  readonly outputs = [
    { id: "fac", label: "Fac", type: "float" },
    { id: "color", label: "Color", type: "color" },
  ] as const;
  readonly params = [
    {
      id: "type",
      label: "Type",
      spec: enumSpec("bands", [
        ["bands", "Bands"],
        ["rings", "Rings"],
      ]),
    },
    {
      id: "profile",
      label: "Profile",
      spec: enumSpec("sine", Object.entries(PROFILES).map(([id, p]) => [id, p.label])),
    },
  ] as const;

  generateShader(ctx: ShaderContext): ShaderOutputs {
    registerCommon(ctx);
    const profileId = PROFILES[String(ctx.param("profile"))] ? String(ctx.param("profile")) : "sine";
    const rings = ctx.param("type") === "rings";
    const name = `ng_wave_${rings ? "rings" : "bands"}_${profileId}`;
    const fn = ctx.helper(
      name,
      `fn ${name}(uv: vec2f, c: vec2f, scale: f32, deg: f32, phase: f32, a: vec2f) -> f32 {
  let d = ng_rotate2((uv - c) * a * vec2f(1.0, -1.0), -deg);
  let t = ${rings ? "length(d)" : "d.x"} * scale - phase;
  return ${PROFILES[profileId].wgsl};
}`,
    );
    const args = [
      ctx.input("uv") ?? ctx.uv,
      ctx.input("center") ?? "vec2f(0.5)",
      ctx.input("scale") ?? "10.0",
      ctx.input("angle") ?? "0.0",
      ctx.input("phase") ?? "0.0",
      aspectExpr(ctx),
    ];
    const fac = ctx.local("f32", `${fn}(${args.join(", ")})`);
    return { fac, color: `vec4f(vec3f(${fac}), 1.0)` };
  }
}

export const waveTextureNode: INode = new WaveTextureNode();
