import type { ExecContext, INode } from "../../INode";
import {
  ActionNode,
  LAYER_IN,
  LAYER_OUT,
  boolInput,
  boolSpec,
  layerOrActive,
} from "../_shared/nodeKit";

class SetLayerLockedNode extends ActionNode {
  readonly type = "setLayerLocked";
  readonly label = "Set Layer Locked";
  readonly category = "Layer";
  readonly description = "Locks or unlocks the layer. Unconnected Layer = the active layer.";
  protected readonly dataInputs = [LAYER_IN, { id: "locked", label: "Locked", type: "bool", value: boolSpec(true) }] as const;
  protected readonly dataOutputs = [LAYER_OUT] as const;

  protected async run(ctx: ExecContext) {
    const layer = await ctx.host.setLayerProperties(await layerOrActive(ctx), {
      locked: await boolInput(ctx, "locked"),
    });
    return { layer };
  }
}

export const setLayerLockedNode: INode = new SetLayerLockedNode();
