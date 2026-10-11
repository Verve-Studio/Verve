import type { ExecContext, ExecResult, INode } from "../../INode";
import { makeList } from "../../values";
import { layerOrActive } from "../_shared/nodeKit";

class LayerChildrenNode implements INode {
  readonly type = "layerChildren";
  readonly label = "Layer Children";
  readonly category = "Layer";
  readonly domains = ["automation"] as const;
  readonly description =
    "A group's layers (top to bottom), or the mask and effects attached to a layer. Unconnected Layer = the active layer.";
  readonly inputs = [{ id: "layer", label: "Layer", type: "layer" }] as const;
  readonly outputs = [
    { id: "children", label: "Children", type: "list" },
    { id: "count", label: "Count", type: "int" },
  ] as const;

  async execute(ctx: ExecContext): Promise<ExecResult> {
    const children = ctx.host.layerChildren(await layerOrActive(ctx));
    return { outputs: { children: makeList(children), count: children.length } };
  }
}

export const layerChildrenNode: INode = new LayerChildrenNode();
