import type { ExecContext, INode } from "../../INode";
import {
  ActionNode,
  boolSpec,
  enumParam,
  enumSpec,
  floatSpec,
  imageSize,
  numberInput,
} from "../_shared/nodeKit";

class ResizeImageNode extends ActionNode {
  readonly type = "resizeImage";
  readonly label = "Resize Image";
  readonly category = "Image";
  readonly description = "Resamples the whole document (Image → Resize Image). With Constrain Proportions the height follows the width.";
  readonly params = [
    { id: "units", label: "Units", spec: enumSpec("pixels", [["pixels", "Pixels"], ["percent", "Percent"]]) },
    { id: "constrain", label: "Constrain Proportions", spec: boolSpec(true) },
    {
      id: "filter",
      label: "Resample",
      spec: enumSpec("bilinear", [["bilinear", "Bilinear (smooth)"], ["nearest", "Nearest Neighbour (sharp)"]]),
    },
  ];
  protected readonly dataInputs = [{ id: "width", label: "Width", type: "float", value: floatSpec(1024, 1, 32768, 1) }, { id: "height", label: "Height", type: "float", value: floatSpec(1024, 1, 32768, 1) }] as const;

  protected async run(ctx: ExecContext) {
    const doc = ctx.host.document();
    const [w, h] = imageSize(enumParam(ctx, "units"), await numberInput(ctx, "width"), await numberInput(ctx, "height"), doc);
    const height = ctx.param("constrain") === true ? Math.max(1, Math.round((w * doc.height) / doc.width)) : h;
    await ctx.host.resizeImage(w, height, enumParam(ctx, "filter") === "nearest" ? "nearest" : "bilinear");
  }
}

export const resizeImageNode: INode = new ResizeImageNode();
