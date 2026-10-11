import type { INode, ShaderContext, ShaderOutputs } from "../../INode";
import { enumSpec, floatSpec, vec2Spec } from "../_shared/nodeKit";

/**
 * Point: scale and rotate the UV around Pivot, then move it by Location.
 * Texture: the inverse — transforms the image the UV samples (moving
 * Location right moves the picture right).
 * Aspect-correct rotates in square pixel units so non-square canvases
 * don't shear.
 */
const HELPER = /* wgsl */ `fn ng_uv_transform(uv: vec2f, loc: vec2f, deg: f32, scale: vec2f, pivot: vec2f, inverse: bool, aspect: bool) -> vec2f {
  let a = select(vec2f(1.0), vec2f(ng_u.v[0].x / ng_u.v[0].y, 1.0), aspect);
  let r = radians(deg);
  let c = cos(r);
  let s = sin(r);
  if (!inverse) {
    let d = (uv - pivot) * scale * a;
    return vec2f(c * d.x - s * d.y, s * d.x + c * d.y) / a + pivot + loc;
  }
  let d = (uv - loc - pivot) * a;
  let safe = select(scale, vec2f(1e-6), abs(scale) < vec2f(1e-6));
  return vec2f(c * d.x + s * d.y, -s * d.x + c * d.y) / a / safe + pivot;
}`;

class UvTransformNode implements INode {
  readonly type = "uvTransform";
  readonly label = "UV Transform";
  readonly category = "Vector";
  readonly domains = ["shader"] as const;
  readonly description = "Move, rotate (degrees) and scale UV coordinates around a pivot.";
  readonly width = 190;
  readonly inputs = [
    { id: "uv", label: "UV", type: "vec2" },
    { id: "location", label: "Location", type: "vec2", value: vec2Spec(0, 0) },
    { id: "rotation", label: "Rotation", type: "float", value: floatSpec(0, undefined, undefined, 0.5) },
    { id: "scale", label: "Scale", type: "vec2", value: vec2Spec(1, 1) },
    { id: "pivot", label: "Pivot", type: "vec2", value: vec2Spec(0.5, 0.5) },
  ] as const;
  readonly outputs = [{ id: "uv", label: "UV", type: "vec2" }] as const;
  readonly params = [
    {
      id: "mode",
      label: "Type",
      spec: enumSpec("texture", [
        ["texture", "Texture"],
        ["point", "Point"],
      ]),
    },
    { id: "aspect", label: "Aspect Correct", spec: { kind: "bool", default: true } },
  ] as const;

  generateShader(ctx: ShaderContext): ShaderOutputs {
    const fn = ctx.helper("ng_uv_transform", HELPER);
    const args = [
      ctx.input("uv") ?? ctx.uv,
      ctx.input("location") ?? "vec2f(0.0)",
      ctx.input("rotation") ?? "0.0",
      ctx.input("scale") ?? "vec2f(1.0)",
      ctx.input("pivot") ?? "vec2f(0.5)",
      String(ctx.param("mode") === "texture"),
      String(ctx.param("aspect") === true),
    ];
    return { uv: `${fn}(${args.join(", ")})` };
  }
}

export const uvTransformNode: INode = new UvTransformNode();
