import type { INode, ShaderContext, ShaderOutputs } from "../../INode";

/** Geometry of the layer the shader is applied to. Composite layers span
 *  the whole canvas. */
class LayerInfoNode implements INode {
  readonly type = "layerInfo";
  readonly label = "Layer Info";
  readonly category = "Info";
  readonly domains = ["shader"] as const;
  readonly description =
    "Position and size of the layer this shader is applied to, and the pixel's position within it.";
  readonly inputs = [];
  readonly outputs = [
    { id: "position", label: "Position", type: "vec2" },
    { id: "size", label: "Size", type: "vec2" },
    { id: "center", label: "Center", type: "vec2" },
    { id: "localUv", label: "Layer UV", type: "vec2" },
    { id: "inside", label: "Inside Layer", type: "bool" },
  ] as const;

  generateShader(ctx: ShaderContext): ShaderOutputs {
    const o = ctx.layerOrigin;
    const s = ctx.layerSize;
    const local = `((${ctx.pixel} - ${o}) / max(${s}, vec2f(1.0)))`;
    return {
      position: o,
      size: s,
      center: `(${o} + ${s} * 0.5)`,
      localUv: local,
      inside: `select(0.0, 1.0, all(${local} >= vec2f(0.0)) && all(${local} < vec2f(1.0)))`,
    };
  }
}

export const layerInfoNode: INode = new LayerInfoNode();
