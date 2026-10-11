import type { ExecContext, INode } from "../../INode";
import {
  ActionNode,
  LAYERS_IN,
  layersOrActive,
} from "../_shared/nodeKit";

class SelectLayersNode extends ActionNode {
  readonly type = "selectLayers";
  readonly label = "Select Layers";
  readonly category = "Layer";
  readonly description = "Selects the layers in the Layers panel (the last one becomes active).";
  protected readonly dataInputs = [LAYERS_IN] as const;

  protected async run(ctx: ExecContext) {
    await ctx.host.selectLayers(await layersOrActive(ctx));
  }
}

export const selectLayersNode: INode = new SelectLayersNode();
