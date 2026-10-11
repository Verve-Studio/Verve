import type { ExecContext, INode } from "../../INode";
import {
  ActionNode,
  LAYER_OUT,
  optionalLayerInput,
  stringInput,
  stringSpec,
  vectorInput,
} from "../_shared/nodeKit";

class ImportImageAsLayerNode extends ActionNode {
  readonly type = "importImageAsLayer";
  readonly label = "Open into new Layer";
  readonly category = "File";
  readonly description = "Decodes an image file into a new pixel layer in the document's colour mode (File → Open into new Layer). Centred unless Position is connected.";
  readonly width = 210;
  protected readonly dataInputs = [{ id: "path", label: "Path", type: "string", value: stringSpec("", "C:\\images\\photo.png") }, { id: "name", label: "Name", type: "string", value: stringSpec("") }, { id: "above", label: "Above", type: "layer" }, { id: "position", label: "Position", type: "vec2" }] as const;
  protected readonly dataOutputs = [LAYER_OUT] as const;

  protected async run(ctx: ExecContext) {
    const path = await stringInput(ctx, "path");
    if (!path) throw new Error("No file path");
    const position = ctx.isConnected("position") ? await vectorInput(ctx, "position", [0, 0]) : null;
    const layer = await ctx.host.importImageAsLayer(path, {
      name: (await stringInput(ctx, "name")) || undefined,
      above: ctx.isConnected("above") ? await optionalLayerInput(ctx, "above") : undefined,
      position: position ? { x: position[0], y: position[1] } : undefined,
    });
    return { layer };
  }
}

export const importImageAsLayerNode: INode = new ImportImageAsLayerNode();
