import type { ExecContext, ExecResult, INode } from "../../INode";
import { layerOrActive } from "../_shared/nodeKit";

class LayerParentNode implements INode {
  readonly type = "layerParent";
  readonly label = "Layer Parent";
  readonly category = "Layer";
  readonly domains = ["automation"] as const;
  readonly description =
    "The group containing the layer, or the layer an effect / mask is attached to. Unconnected Layer = the active layer.";
  readonly inputs = [{ id: "layer", label: "Layer", type: "layer" }] as const;
  readonly outputs = [
    { id: "parent", label: "Parent", type: "layer" },
    { id: "hasParent", label: "Has Parent", type: "bool" },
  ] as const;

  async execute(ctx: ExecContext): Promise<ExecResult> {
    const parent = ctx.host.layerParent(await layerOrActive(ctx));
    return { outputs: { parent, hasParent: parent !== null } };
  }
}

export const layerParentNode: INode = new LayerParentNode();
