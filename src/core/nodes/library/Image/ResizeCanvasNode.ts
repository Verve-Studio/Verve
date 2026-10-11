import type { ExecContext, INode } from "../../INode";
import {
  ActionNode,
  enumParam,
  enumSpec,
  floatSpec,
  imageSize,
  numberInput,
} from "../_shared/nodeKit";

class ResizeCanvasNode extends ActionNode {
  readonly type = "resizeCanvas";
  readonly label = "Resize Image Canvas";
  readonly category = "Image";
  readonly description = "Changes the canvas size without scaling the pixels (Image → Resize Image Canvas); Anchor keeps that side in place.";
  readonly params = [
    { id: "units", label: "Units", spec: enumSpec("pixels", [["pixels", "Pixels"], ["percent", "Percent"]]) },
    { id: "anchor", label: "Anchor", spec: enumSpec("1,1", [
        ["0,0", "Top Left"],
        ["1,0", "Top"],
        ["2,0", "Top Right"],
        ["0,1", "Left"],
        ["1,1", "Center"],
        ["2,1", "Right"],
        ["0,2", "Bottom Left"],
        ["1,2", "Bottom"],
        ["2,2", "Bottom Right"],
      ]) },
  ];
  protected readonly dataInputs = [{ id: "width", label: "Width", type: "float", value: floatSpec(1024, 1, 32768, 1) }, { id: "height", label: "Height", type: "float", value: floatSpec(1024, 1, 32768, 1) }] as const;

  protected async run(ctx: ExecContext) {
    const doc = ctx.host.document();
    const [w, h] = imageSize(enumParam(ctx, "units"), await numberInput(ctx, "width"), await numberInput(ctx, "height"), doc);
    const [col, row] = enumParam(ctx, "anchor").split(",").map(Number) as [0 | 1 | 2, 0 | 1 | 2];
    await ctx.host.resizeCanvas(w, h, { col, row });
  }
}

export const resizeCanvasNode: INode = new ResizeCanvasNode();
