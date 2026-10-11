import type { ExecContext, ExecResult, INode } from "../../INode";
import { EXEC_IN, EXEC_OUT, layerInput, stringInput } from "../_shared/nodeKit";

class RenameLayerNode implements INode {
  readonly type = "renameLayer";
  readonly label = "Rename Layer";
  readonly category = "Layers";
  readonly domains = ["automation"] as const;
  readonly inputs = [
    EXEC_IN,
    { id: "layer", label: "Layer", type: "layer" },
    { id: "name", label: "Name", type: "string", value: { kind: "string", default: "" } },
  ] as const;
  readonly outputs = [EXEC_OUT];

  async execute(ctx: ExecContext): Promise<ExecResult> {
    const layer = await layerInput(ctx, "layer");
    const name = await stringInput(ctx, "name");
    if (!name) throw new Error("Name is empty");
    await ctx.host.renameLayer(layer, name);
    return {};
  }
}

export const renameLayerNode: INode = new RenameLayerNode();
