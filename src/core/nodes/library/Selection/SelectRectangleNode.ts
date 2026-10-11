import type { ExecContext, INode } from "../../INode";
import type { SelectionMode } from "../../automationHost";
import {
  ActionNode,
  enumParam,
  enumSpec,
  floatSpec,
  numberInput,
  vec2Spec,
  vectorInput,
} from "../_shared/nodeKit";

class SelectRectangleNode extends ActionNode {
  readonly type = "selectRectangle";
  readonly label = "Select Rectangle";
  readonly category = "Select";
  readonly description = "Selects a rectangle (canvas pixels), combined with the current selection by Mode.";
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
  protected readonly dataInputs = [{ id: "position", label: "Position", type: "vec2", value: vec2Spec(0, 0, 1) }, { id: "size", label: "Size", type: "vec2", value: vec2Spec(256, 256, 1) }, { id: "feather", label: "Feather", type: "float", value: floatSpec(0, 0, 250, 0.5) }] as const;

  protected async run(ctx: ExecContext) {
    const [x, y] = await vectorInput(ctx, "position", [0, 0]);
    const [width, height] = await vectorInput(ctx, "size", [1, 1]);
    await ctx.host.selectRect({ x, y, width, height }, enumParam(ctx, "mode") as SelectionMode, await numberInput(ctx, "feather"));
  }
}

export const selectRectangleNode: INode = new SelectRectangleNode();
