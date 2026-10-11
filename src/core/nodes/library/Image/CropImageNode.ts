import type { ExecContext, INode } from "../../INode";
import {
  ActionNode,
  vec2Spec,
  vectorInput,
} from "../_shared/nodeKit";

class CropImageNode extends ActionNode {
  readonly type = "cropImage";
  readonly label = "Crop Image";
  readonly category = "Image";
  readonly description = "Crops the document to a rectangle (canvas pixels).";
  protected readonly dataInputs = [{ id: "position", label: "Position", type: "vec2", value: vec2Spec(0, 0, 1) }, { id: "size", label: "Size", type: "vec2", value: vec2Spec(512, 512, 1) }] as const;

  protected async run(ctx: ExecContext) {
    const [x, y] = await vectorInput(ctx, "position", [0, 0]);
    const [width, height] = await vectorInput(ctx, "size", [1, 1]);
    await ctx.host.cropImage({ x, y, width, height });
  }
}

export const cropImageNode: INode = new CropImageNode();
