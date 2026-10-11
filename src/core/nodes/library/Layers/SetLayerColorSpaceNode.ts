import type { ExecContext, INode } from "../../INode";
import type { LayerColorSpace } from "@/types";
import {
  ActionNode,
  LAYER_IN,
  LAYER_OUT,
  enumParam,
  enumSpec,
  layerOrActive,
} from "../_shared/nodeKit";

class SetLayerColorSpaceNode extends ActionNode {
  readonly type = "setLayerColorSpace";
  readonly label = "Set Layer Color Space";
  readonly category = "Layer";
  readonly description = "Declares what a pixel layer's values encode (camera log, linear, …), as in the Layers panel. Unconnected Layer = the active layer.";
  readonly params = [
    {
      id: "colorSpace",
      label: "Color Space",
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
  protected readonly dataInputs = [LAYER_IN] as const;
  protected readonly dataOutputs = [LAYER_OUT] as const;

  protected async run(ctx: ExecContext) {
    const layer = await ctx.host.setLayerProperties(await layerOrActive(ctx), {
      colorSpace: enumParam(ctx, "colorSpace") as LayerColorSpace,
    });
    return { layer };
  }
}

export const setLayerColorSpaceNode: INode = new SetLayerColorSpaceNode();
