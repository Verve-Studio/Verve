import type { ExecContext, INode } from "../../INode";
import type { SelectionMode } from "../../automationHost";
import {
  ActionNode,
  LAYER_IN,
  enumParam,
  enumSpec,
  layerOrActive,
} from "../_shared/nodeKit";

class SelectLayerPixelsNode extends ActionNode {
  readonly type = "selectLayerPixels";
  readonly label = "Select Layer Pixels";
  readonly category = "Select";
  readonly description = "Selects the layer's opaque pixels (alpha becomes selection strength). Unconnected Layer = the active layer.";
  readonly params = [
    {
      id: "mode",
      label: "Mode",
      spec: enumSpec("set", [
        ["set", "Replace"],
        ["add", "Add"],
        ["subtract", "Subtract"],
        ["intersect", "Intersect"],
      ]),
    },
  ];
  protected readonly dataInputs = [LAYER_IN] as const;

  protected async run(ctx: ExecContext) {
    await ctx.host.selectLayerAlpha(await layerOrActive(ctx), enumParam(ctx, "mode") as SelectionMode);
  }
}

export const selectLayerPixelsNode: INode = new SelectLayerPixelsNode();
