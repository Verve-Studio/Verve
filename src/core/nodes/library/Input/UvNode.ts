import type { INode, ShaderContext, ShaderOutputs } from "../../INode";

class UvNode implements INode {
  readonly type = "uv";
  readonly label = "UV";
  readonly category = "Input";
  readonly domains = ["shader"] as const;
  readonly description = "Position of the current pixel: normalized (0–1) and in pixels.";
  readonly inputs = [];
  readonly outputs = [
    { id: "uv", label: "UV", type: "vec2" },
    { id: "pixel", label: "Pixel", type: "vec2" },
  ] as const;

  generateShader(ctx: ShaderContext): ShaderOutputs {
    return { uv: ctx.uv, pixel: ctx.pixel };
  }
}

export const uvNode: INode = new UvNode();
