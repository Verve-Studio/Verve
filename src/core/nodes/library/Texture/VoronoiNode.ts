import type { INode, ShaderContext, ShaderOutputs } from "../../INode";
import { floatSpec } from "../_shared/nodeKit";
import { aspectExpr, registerCommon } from "../_shared/shaderKit";

/** F1 / F2 cell noise; x = F1, y = F2, zw = id of the nearest cell. */
const HELPER = /* wgsl */ `fn ng_voronoi(p: vec2f, randomness: f32) -> vec4f {
  let cell = floor(p);
  let f = p - cell;
  var d1 = 8.0;
  var d2 = 8.0;
  var id = vec2f(0.0);
  for (var j = -1; j <= 1; j++) {
    for (var i = -1; i <= 1; i++) {
      let g = vec2f(f32(i), f32(j));
      let o = ng_hash22(cell + g) * randomness;
      let d = length(g + o - f);
      if (d < d1) {
        d2 = d1;
        d1 = d;
        id = cell + g;
      } else if (d < d2) {
        d2 = d;
      }
    }
  }
  return vec4f(d1, d2, id);
}`;

class VoronoiNode implements INode {
  readonly type = "voronoi";
  readonly label = "Voronoi";
  readonly category = "Texture";
  readonly domains = ["shader"] as const;
  readonly description =
    "Cellular (Worley) noise: distance to the nearest cell point, cell edges (F2 − F1) and a random " +
    "colour per cell. Scale is cells per canvas height.";
  readonly inputs = [
    { id: "uv", label: "UV", type: "vec2" },
    { id: "scale", label: "Scale", type: "float", value: floatSpec(8, 0, undefined, 0.05) },
    { id: "randomness", label: "Randomness", type: "float", value: floatSpec(1, 0, 1) },
  ] as const;
  readonly outputs = [
    { id: "distance", label: "Distance", type: "float" },
    { id: "edge", label: "Edge", type: "float" },
    { id: "color", label: "Cell Color", type: "color" },
  ] as const;

  generateShader(ctx: ShaderContext): ShaderOutputs {
    registerCommon(ctx);
    const fn = ctx.helper("ng_voronoi", HELPER);
    const p = `((${ctx.input("uv") ?? ctx.uv}) * ${aspectExpr(ctx)} * (${ctx.input("scale") ?? "8.0"}))`;
    const v = ctx.local("vec4f", `${fn}(${p}, clamp(${ctx.input("randomness") ?? "1.0"}, 0.0, 1.0))`);
    return {
      distance: `${v}.x`,
      edge: `(${v}.y - ${v}.x)`,
      color: `vec4f(ng_hash32(${v}.zw), 1.0)`,
    };
  }
}

export const voronoiNode: INode = new VoronoiNode();
