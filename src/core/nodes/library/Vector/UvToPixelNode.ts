import type { ExecContext, ExecResult, INode, ShaderContext, ShaderOutputs } from "../../INode";
import { vectorInput } from "../_shared/nodeKit";

/** UV (0–1) → canvas pixels. Unconnected UV = the current pixel's UV. */
class UvToPixelNode implements INode {
  readonly type = "uvToPixel";
  readonly label = "UV to Pixel";
  readonly category = "Vector";
  readonly domains = ["shader", "automation"] as const;
  readonly inputs = [{ id: "uv", label: "UV", type: "vec2" }] as const;
  readonly outputs = [{ id: "pixel", label: "Pixel", type: "vec2" }] as const;

  generateShader(ctx: ShaderContext): ShaderOutputs {
    return { pixel: `((${ctx.input("uv") ?? ctx.uv}) * ${ctx.resolution})` };
  }

  async execute(ctx: ExecContext): Promise<ExecResult> {
    const uv = await vectorInput(ctx, "uv", [0, 0]);
    const d = ctx.host.document();
    return { outputs: { pixel: [uv[0] * d.width, uv[1] * d.height] } };
  }
}

export const uvToPixelNode: INode = new UvToPixelNode();
