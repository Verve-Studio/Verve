import type { ExecContext, INode } from "../../INode";
import type { AlignEdge } from "../../automationHost";
import {
  ActionNode,
  LAYERS_IN,
  enumParam,
  enumSpec,
  layersOrActive,
} from "../_shared/nodeKit";

class AlignLayersNode extends ActionNode {
  readonly type = "alignLayers";
  readonly label = "Align";
  readonly category = "Layer";
  readonly description = "Aligns the layers' content (to each other, or to the canvas for one layer). Unconnected Layers = the active layer.";
  readonly params = [
    {
      id: "edge",
      label: "Align",
      spec: enumSpec("left", [
        ["left", "Left"],
        ["centerV", "Center Vertical"],
        ["right", "Right"],
        ["top", "Top"],
        ["centerH", "Center Horizontal"],
        ["bottom", "Bottom"],
      ]),
    },
  ];
  protected readonly dataInputs = [LAYERS_IN] as const;

  protected async run(ctx: ExecContext) {
    await ctx.host.alignLayers(await layersOrActive(ctx), enumParam(ctx, "edge") as AlignEdge);
  }
}

export const alignLayersNode: INode = new AlignLayersNode();
