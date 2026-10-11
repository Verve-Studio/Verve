import type { ExecContext, ExecResult, INode } from "../../INode";
import { layerOrActive } from "../_shared/nodeKit";

class LayerPropertiesNode implements INode {
  readonly type = "layerProperties";
  readonly label = "Layer Properties";
  readonly category = "Info";
  readonly domains = ["automation"] as const;
  readonly description = "Properties of the layer. Unconnected Layer = the active layer.";
  readonly inputs = [{ id: "layer", label: "Layer", type: "layer" }] as const;
  readonly outputs = [
    { id: "name", label: "Name", type: "string" },
    { id: "kind", label: "Kind", type: "string" },
    { id: "visible", label: "Visible", type: "bool" },
    { id: "opacity", label: "Opacity", type: "float" },
    { id: "blendMode", label: "Blend Mode", type: "string" },
    { id: "locked", label: "Locked", type: "bool" },
    { id: "position", label: "Position", type: "vec2" },
    { id: "size", label: "Size", type: "vec2" },
    { id: "effectType", label: "Effect Type", type: "string" },
  ] as const;

  async execute(ctx: ExecContext): Promise<ExecResult> {
    const p = ctx.host.layerProperties(await layerOrActive(ctx));
    return {
      outputs: {
        name: p.name,
        kind: p.kind,
        visible: p.visible,
        opacity: p.opacity,
        blendMode: p.blendMode,
        locked: p.locked,
        position: [p.x, p.y],
        size: [p.width, p.height],
        effectType: p.effectType,
      },
    };
  }
}

export const layerPropertiesNode: INode = new LayerPropertiesNode();
