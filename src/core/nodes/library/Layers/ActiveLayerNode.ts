import type { ExecContext, ExecResult, INode } from "../../INode";

class ActiveLayerNode implements INode {
  readonly type = "activeLayer";
  readonly label = "Get Active Layer";
  readonly category = "Layer";
  readonly domains = ["automation"] as const;
  readonly description =
    "The active document's active layer (the one selected in the Layers panel), and whether there is one.";
  readonly inputs = [];
  readonly outputs = [
    { id: "layer", label: "Layer", type: "layer" },
    { id: "hasLayer", label: "Has Layer", type: "bool" },
  ] as const;

  execute(ctx: ExecContext): ExecResult {
    const layer = ctx.host.activeLayer();
    return { outputs: { layer, hasLayer: layer !== null } };
  }
}

export const activeLayerNode: INode = new ActiveLayerNode();
