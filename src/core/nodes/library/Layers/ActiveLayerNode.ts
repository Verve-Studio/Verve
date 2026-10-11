import type { ExecContext, ExecResult, INode } from "../../INode";

class ActiveLayerNode implements INode {
  readonly type = "activeLayer";
  readonly label = "Active Layer";
  readonly category = "Layers";
  readonly domains = ["automation"] as const;
  readonly inputs = [];
  readonly outputs = [{ id: "layer", label: "Layer", type: "layer" }] as const;

  execute(ctx: ExecContext): ExecResult {
    return { outputs: { layer: ctx.host.activeLayer() } };
  }
}

export const activeLayerNode: INode = new ActiveLayerNode();
