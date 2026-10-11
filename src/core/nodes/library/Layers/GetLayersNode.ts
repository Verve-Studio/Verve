import type { ExecContext, ExecResult, INode } from "../../INode";
import type { LayerKind } from "../../automationHost";
import { makeList } from "../../values";
import { boolSpec, enumSpec } from "../_shared/nodeKit";

/** Layers of the active document as a list, top to bottom. */
class GetLayersNode implements INode {
  readonly type = "getLayers";
  readonly label = "Get Layers";
  readonly category = "Layer";
  readonly domains = ["automation"] as const;
  readonly description =
    "The active document's layers, top to bottom. Recursive includes layers inside groups.";
  readonly inputs = [];
  readonly outputs = [
    { id: "layers", label: "Layers", type: "list" },
    { id: "count", label: "Count", type: "int" },
  ] as const;
  readonly params = [
    { id: "visibleOnly", label: "Visible Only", spec: boolSpec(false) },
    { id: "recursive", label: "Recursive", spec: boolSpec(false) },
    {
      id: "kind",
      label: "Kind",
      spec: enumSpec("all", [
        ["all", "All"],
        ["pixel", "Pixel"],
        ["text", "Text"],
        ["shape", "Shape"],
        ["path", "Path"],
        ["frame", "Frame"],
        ["linked", "Linked"],
        ["group", "Group"],
        ["composite", "Composite"],
        ["effect", "Effect"],
        ["mask", "Mask"],
      ]),
    },
  ];

  execute(ctx: ExecContext): ExecResult {
    const kind = String(ctx.param("kind"));
    const all = ctx.host.layers({
      visibleOnly: ctx.param("visibleOnly") === true,
      recursive: ctx.param("recursive") === true,
      attachments: kind === "effect" || kind === "mask",
    });
    const layers =
      kind === "all"
        ? all
        : all.filter((l) => ctx.host.layerProperties(l).kind === (kind as LayerKind));
    return { outputs: { layers: makeList(layers), count: layers.length } };
  }
}

export const getLayersNode: INode = new GetLayersNode();
