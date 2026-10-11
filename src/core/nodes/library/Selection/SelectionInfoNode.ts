import type { ExecContext, ExecResult, INode } from "../../INode";

class SelectionInfoNode implements INode {
  readonly type = "selectionInfo";
  readonly label = "Selection Info";
  readonly category = "Select";
  readonly domains = ["automation"] as const;
  readonly description = "Whether something is selected, and the selection's bounds.";
  readonly inputs = [];
  readonly outputs = [
    { id: "hasSelection", label: "Has Selection", type: "bool" },
    { id: "position", label: "Position", type: "vec2" },
    { id: "size", label: "Size", type: "vec2" },
  ] as const;

  execute(ctx: ExecContext): ExecResult {
    const b = ctx.host.selectionBounds();
    return {
      outputs: {
        hasSelection: b !== null,
        position: b ? [b.x, b.y] : [0, 0],
        size: b ? [b.width, b.height] : [0, 0],
      },
    };
  }
}

export const selectionInfoNode: INode = new SelectionInfoNode();
