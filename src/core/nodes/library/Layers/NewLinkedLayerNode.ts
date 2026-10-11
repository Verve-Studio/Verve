import type { ExecContext, INode } from "../../INode";
import {
  ActionNode,
  LAYER_OUT,
  stringInput,
  stringSpec,
} from "../_shared/nodeKit";

class NewLinkedLayerNode extends ActionNode {
  readonly type = "newLinkedLayer";
  readonly label = "New Linked Layer";
  readonly category = "Layer";
  readonly description = "Adds a layer that keeps a live link to an image file (Layer → New Linked Layer).";
  readonly width = 210;
  protected readonly dataInputs = [{ id: "path", label: "Path", type: "string", value: stringSpec("", "C:\\images\\photo.png") }, { id: "name", label: "Name", type: "string", value: stringSpec("") }] as const;
  protected readonly dataOutputs = [LAYER_OUT] as const;

  protected async run(ctx: ExecContext) {
    const path = await stringInput(ctx, "path");
    if (!path) throw new Error("No file path");
    return { layer: await ctx.host.newLinkedLayer(path, (await stringInput(ctx, "name")) || undefined) };
  }
}

export const newLinkedLayerNode: INode = new NewLinkedLayerNode();
