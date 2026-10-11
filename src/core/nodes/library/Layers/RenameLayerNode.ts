import type { ExecContext, INode } from "../../INode";
import {
  ActionNode,
  LAYER_IN,
  LAYER_OUT,
  layerOrActive,
  stringInput,
  stringSpec,
} from "../_shared/nodeKit";

class RenameLayerNode extends ActionNode {
  readonly type = "renameLayer";
  readonly label = "Rename Layer";
  readonly category = "Layer";
  readonly description = "Changes the layer's name. Unconnected Layer = the active layer.";
  protected readonly dataInputs = [LAYER_IN, { id: "name", label: "Name", type: "string", value: stringSpec("Layer") }] as const;
  protected readonly dataOutputs = [LAYER_OUT] as const;

  protected async run(ctx: ExecContext) {
    const layer = await ctx.host.setLayerProperties(await layerOrActive(ctx), {
      name: (await stringInput(ctx, "name")) || "Layer",
    });
    return { layer };
  }
}

export const renameLayerNode: INode = new RenameLayerNode();
