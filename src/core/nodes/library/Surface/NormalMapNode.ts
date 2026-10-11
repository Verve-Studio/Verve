import type { INode, ShaderContext, ShaderOutputs } from "../../INode";
import { colorSpec, floatSpec } from "../_shared/nodeKit";
import { toDisplay } from "../_shared/shaderKit";

/** Decode a normal-map colour (e.g. Sample Layer of a normal-map layer)
 *  into a normal for Lighting. */
class NormalMapNode implements INode {
  readonly type = "normalMap";
  readonly label = "Normal Map";
  readonly category = "Surface";
  readonly domains = ["shader"] as const;
  readonly description =
    "Decode a normal-map colour (0.5, 0.5, 1 = flat) into a normal. Strength scales the bumps.";
  readonly inputs = [
    { id: "color", label: "Color", type: "color", value: colorSpec(0.5, 0.5, 1) },
    { id: "strength", label: "Strength", type: "float", value: floatSpec(1, 0, 10) },
  ] as const;
  readonly outputs = [{ id: "normal", label: "Normal", type: "vec3" }] as const;
  readonly params = [
    { id: "flipY", label: "Flip Y (DirectX)", spec: { kind: "bool", default: false } },
  ] as const;

  generateShader(ctx: ShaderContext): ShaderOutputs {
    const fn = ctx.helper(
      "ng_normal_map",
      `fn ng_normal_map(rgb: vec3f, strength: f32, flipY: bool) -> vec3f {
  var n = rgb * 2.0 - 1.0;
  if (flipY) { n.y = -n.y; }
  let v = vec3f(n.xy * strength, max(n.z, 1e-4));
  return normalize(v);
}`,
    );
    // Normal-map values are display values (see Normal from Height).
    const rgb = toDisplay(ctx, `(${ctx.input("color") ?? "vec4f(0.5, 0.5, 1.0, 1.0)"}).rgb`);
    const strength = ctx.input("strength") ?? "1.0";
    return { normal: `${fn}(${rgb}, ${strength}, ${ctx.param("flipY") === true})` };
  }
}

export const normalMapNode: INode = new NormalMapNode();
