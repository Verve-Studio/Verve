import type { INode, ShaderContext, ShaderOutputs } from "../../INode";
import { floatSpec } from "../_shared/nodeKit";

class LayerOutputNode implements INode {
  readonly type = "layerOutput";
  readonly label = "Layer Output";
  readonly category = "Output";
  readonly domains = ["shader"] as const;
  readonly description = "The final colour written for the pixel.";
  readonly inputs = [
    // Required (see requiredInputs): no inline value to fall back on.
    { id: "color", label: "Color", type: "color" },
    { id: "alpha", label: "Alpha", type: "float", value: floatSpec(1, 0, 1) },
  ] as const;
  readonly outputs = [];
  readonly unique = true;
  readonly graphOutput = true;
  readonly requiredInputs = ["color"];

  generateShader(ctx: ShaderContext): ShaderOutputs {
    const color = ctx.input("color") ?? "vec4f(0.0, 0.0, 0.0, 1.0)";
    ctx.setResult(`vec4f((${color}).rgb, ${ctx.input("alpha") ?? "1.0"})`);
    return {};
  }
}

export const layerOutputNode: INode = new LayerOutputNode();
