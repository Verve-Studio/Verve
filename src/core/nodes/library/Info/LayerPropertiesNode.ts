import type { ExecContext, ExecResult, INode } from "../../INode";
import { layerInput } from "../_shared/nodeKit";

class LayerPropertiesNode implements INode {
  readonly type = "layerProperties";
  readonly label = "Layer Properties";
  readonly category = "Info";
  readonly domains = ["automation"] as const;
  readonly inputs = [{ id: "layer", label: "Layer", type: "layer" }] as const;
  readonly outputs = [
    { id: "name", label: "Name", type: "string" },
    { id: "kind", label: "Kind", type: "string" },
    { id: "visible", label: "Visible", type: "bool" },
    { id: "opacity", label: "Opacity", type: "float" },
    { id: "position", label: "Position", type: "vec2" },
    { id: "size", label: "Size", type: "vec2" },
  ] as const;

  async execute(ctx: ExecContext): Promise<ExecResult> {
    const p = ctx.host.layerProperties(await layerInput(ctx, "layer"));
    return {
      outputs: {
        name: p.name,
        kind: p.kind,
        visible: p.visible,
        opacity: p.opacity,
        position: [p.x, p.y],
        size: [p.width, p.height],
      },
    };
  }
}

export const layerPropertiesNode: INode = new LayerPropertiesNode();
