import type { ExecContext, INode } from "../../INode";
import {
  ActionNode,
  LAYERS_IN,
  enumParam,
  enumSpec,
  layersOrActive,
} from "../_shared/nodeKit";

class FlipLayersNode extends ActionNode {
  readonly type = "flipLayers";
  readonly label = "Flip";
  readonly category = "Layer";
  readonly description = "Mirrors the layers' pixels (Layer → Flip). Unconnected Layers = the active layer.";
  readonly params = [
    { id: "axis", label: "Flip", spec: enumSpec("horizontal", [["horizontal", "Horizontal"], ["vertical", "Vertical"]]) },
  ];
  protected readonly dataInputs = [LAYERS_IN] as const;

  protected async run(ctx: ExecContext) {
    await ctx.host.flipLayers(await layersOrActive(ctx), enumParam(ctx, "axis") === "vertical" ? "vertical" : "horizontal");
  }
}

export const flipLayersNode: INode = new FlipLayersNode();
