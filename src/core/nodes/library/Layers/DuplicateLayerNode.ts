import type { ExecContext, INode } from "../../INode";
import {
  ActionNode,
  LAYER_IN,
  layerOrActive,
  stringInput,
  stringSpec,
} from "../_shared/nodeKit";

class DuplicateLayerNode extends ActionNode {
  readonly type = "duplicateLayer";
  readonly label = "Duplicate Layer";
  readonly category = "Layer";
  readonly description = "Copies the layer (with its mask and effects, or a group with its contents) directly above it. Unconnected Layer = the active layer.";
  protected readonly dataInputs = [LAYER_IN, { id: "name", label: "Name", type: "string", value: stringSpec("") }] as const;
  protected readonly dataOutputs = [{ id: "copy", label: "Copy", type: "layer" }] as const;

  protected async run(ctx: ExecContext) {
    const copy = await ctx.host.duplicateLayer(await layerOrActive(ctx), (await stringInput(ctx, "name")) || undefined);
    return { copy };
  }
}

export const duplicateLayerNode: INode = new DuplicateLayerNode();
