import type { INode, ShaderContext, ShaderOutputs } from "../../INode";
import { enumSpec, floatSpec } from "../_shared/nodeKit";

/**
 * Blur of whatever is connected to Color. The connected nodes render once
 * over the canvas in a pass of their own (`ctx.inputPass`), the host blurs
 * that with the separable Gaussian / Box Blur filters, and this node reads
 * the result at the pixel. Radius is fixed per frame (not per pixel).
 */
class BlurColorNode implements INode {
  readonly type = "blurColor";
  readonly label = "Blur Color";
  readonly category = "Filter";
  readonly domains = ["shader"] as const;
  readonly description =
    "Blur the connected colour (noise, a computed pattern, the layer after other nodes) by " +
    "Radius pixels. The connected nodes render once in an extra pass, so a blur costs about " +
    "as much as a Gaussian Blur filter. Inside a loop body it can only blur values computed " +
    "in the body.";
  readonly width = 180;
  readonly inputs = [{ id: "color", label: "Color", type: "color" }] as const;
  readonly outputs = [
    { id: "color", label: "Color", type: "color" },
    { id: "alpha", label: "Alpha", type: "float" },
  ] as const;
  readonly params = [
    { id: "radius", label: "Radius (px)", spec: floatSpec(8, 0, 250, 1) },
    {
      id: "kind",
      label: "Type",
      spec: enumSpec("gaussian", [
        ["gaussian", "Gaussian"],
        ["box", "Box"],
      ]),
    },
  ];
  readonly requiredInputs = ["color"];

  generateShader(ctx: ShaderContext): ShaderOutputs {
    const radius = Math.round(Math.min(250, Math.max(0, Number(ctx.param("radius")) || 0)));
    const kind = ctx.param("kind") === "box" ? "box" : "gaussian";
    const fetch = ctx.inputPass("color", { kind, radius });
    const color = ctx.local("vec4f", fetch ? `${fetch}(vec2i(floor(${ctx.pixel})))` : "vec4f(0.0)");
    return { color, alpha: `${color}.a` };
  }
}

export const blurColorNode: INode = new BlurColorNode();
