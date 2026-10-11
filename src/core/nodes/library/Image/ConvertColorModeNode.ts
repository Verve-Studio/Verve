import type { ExecContext, INode } from "../../INode";
import type { LayerColorSpace, PixelFormat } from "@/types";
import {
  ActionNode,
  enumParam,
  enumSpec,
} from "../_shared/nodeKit";

class ConvertColorModeNode extends ActionNode {
  readonly type = "convertColorMode";
  readonly label = "Color Mode";
  readonly category = "Image";
  readonly description = "Converts the document between RGB/8, RGB/32 Float and Indexed/8 (Image → Color Mode). Source Colour Space applies to RGB/8 → RGB/32 Float: what the 8-bit values encode.";
  readonly width = 200;
  readonly params = [
    {
      id: "format",
      label: "Color Mode",
      spec: enumSpec("rgba32f", [
        ["rgba8", "RGB/8"],
        ["rgba32f", "RGB/32 Float"],
        ["indexed8", "Indexed/8"],
      ]),
    },
    {
      id: "sourceColorSpace",
      label: "Source Colour Space",
      spec: enumSpec("auto", [
        ["auto", "Auto"],
        ["srgb", "sRGB"],
        ["linear-srgb", "Linear sRGB"],
        ["aces-cg", "ACEScg"],
        ["slog3", "S-Log3"],
        ["logc3", "LogC3"],
        ["vlog", "V-Log"],
        ["red-log3g10", "RED Log3G10"],
        ["clog3", "C-Log3"],
        ["apple-log", "Apple Log"],
      ]),
    },
  ];
  protected readonly dataInputs = [];

  protected async run(ctx: ExecContext) {
    await ctx.host.convertColorMode(
      enumParam(ctx, "format") as PixelFormat,
      enumParam(ctx, "sourceColorSpace") as LayerColorSpace,
    );
  }
}

export const convertColorModeNode: INode = new ConvertColorModeNode();
