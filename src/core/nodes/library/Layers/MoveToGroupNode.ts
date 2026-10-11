import type { ExecContext, INode } from "../../INode";
import {
  ActionNode,
  LAYER_IN,
  LAYER_OUT,
  intInput,
  layerOrActive,
  optionalLayerInput,
} from "../_shared/nodeKit";

class MoveToGroupNode extends ActionNode {
  readonly type = "moveToGroup";
  readonly label = "Move To Group";
  readonly category = "Layer";
  readonly description = "Moves the layer into Group at Index (0 = bottom, -1 = top), or out to the top level when Group is unconnected. Unconnected Layer = the active layer.";
  protected readonly dataInputs = [LAYER_IN, { id: "group", label: "Group", type: "layer" }, { id: "index", label: "Index", type: "int", value: { kind: "int", default: -1 } }] as const;
  protected readonly dataOutputs = [LAYER_OUT] as const;

  protected async run(ctx: ExecContext) {
    const layer = await layerOrActive(ctx);
    await ctx.host.moveLayerToGroup(layer, await optionalLayerInput(ctx, "group"), await intInput(ctx, "index"));
    return { layer };
  }
}

export const moveToGroupNode: INode = new MoveToGroupNode();
