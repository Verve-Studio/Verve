import type { ExecContext, INode } from "../../INode";
import {
  ActionNode,
  LAYER_IN,
  LAYER_OUT,
  boolInput,
  boolSpec,
  layerOrActive,
  vec2Spec,
  vectorInput,
} from "../_shared/nodeKit";

class MoveLayerNode extends ActionNode {
  readonly type = "moveLayer";
  readonly label = "Move Layer";
  readonly category = "Layer";
  readonly description = "Moves the layer's content to Position (its top-left on the canvas), or by Position when Relative. Unconnected Layer = the active layer.";
  protected readonly dataInputs = [LAYER_IN, { id: "position", label: "Position", type: "vec2", value: vec2Spec(0, 0, 1) }, { id: "relative", label: "Relative", type: "bool", value: boolSpec(true) }] as const;
  protected readonly dataOutputs = [LAYER_OUT] as const;

  protected async run(ctx: ExecContext) {
    const layer = await layerOrActive(ctx);
    const [x, y] = await vectorInput(ctx, "position", [0, 0]);
    await ctx.host.moveLayer(layer, x, y, await boolInput(ctx, "relative"));
    return { layer };
  }
}

export const moveLayerNode: INode = new MoveLayerNode();
