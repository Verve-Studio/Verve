import type { ExecContext, INode } from "../../INode";
import type { BlendMode } from "@/types";
import {
  ActionNode,
  LAYER_IN,
  LAYER_OUT,
  enumParam,
  enumSpec,
  layerOrActive,
} from "../_shared/nodeKit";

class SetBlendModeNode extends ActionNode {
  readonly type = "setBlendMode";
  readonly label = "Set Blend Mode";
  readonly category = "Layer";
  readonly description = "Sets how the layer blends with the layers below. Unconnected Layer = the active layer.";
  readonly params = [
    {
      id: "blendMode",
      label: "Blend Mode",
      spec: enumSpec("normal", [
        ["normal", "Normal"],
        ["multiply", "Multiply"],
        ["screen", "Screen"],
        ["overlay", "Overlay"],
        ["soft-light", "Soft Light"],
        ["hard-light", "Hard Light"],
        ["darken", "Darken"],
        ["lighten", "Lighten"],
        ["difference", "Difference"],
        ["exclusion", "Exclusion"],
        ["color-dodge", "Color Dodge"],
        ["color-burn", "Color Burn"],
        ["pass-through", "Pass Through (groups)"],
      ]),
    },
  ];
  protected readonly dataInputs = [LAYER_IN] as const;
  protected readonly dataOutputs = [LAYER_OUT] as const;

  protected async run(ctx: ExecContext) {
    const layer = await ctx.host.setLayerProperties(await layerOrActive(ctx), {
      blendMode: enumParam(ctx, "blendMode") as BlendMode,
    });
    return { layer };
  }
}

export const setBlendModeNode: INode = new SetBlendModeNode();
