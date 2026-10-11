import type { ExecContext, ExecResult, INode, ShaderContext, ShaderOutputs } from "../../INode";
import { vectorInput } from "../_shared/nodeKit";

/** Canvas pixels → UV (0–1). Unconnected Pixel = the current pixel. */
class PixelToUvNode implements INode {
  readonly type = "pixelToUv";
  readonly label = "Pixel to UV";
  readonly category = "Vector";
  readonly domains = ["shader", "automation"] as const;
  readonly inputs = [{ id: "pixel", label: "Pixel", type: "vec2" }] as const;
  readonly outputs = [{ id: "uv", label: "UV", type: "vec2" }] as const;

  generateShader(ctx: ShaderContext): ShaderOutputs {
    return { uv: `((${ctx.input("pixel") ?? ctx.pixel}) * ${ctx.texelSize})` };
  }

  async execute(ctx: ExecContext): Promise<ExecResult> {
    const p = await vectorInput(ctx, "pixel", [0, 0]);
    const d = ctx.host.document();
    return { outputs: { uv: [p[0] / d.width, p[1] / d.height] } };
  }
}

export const pixelToUvNode: INode = new PixelToUvNode();
