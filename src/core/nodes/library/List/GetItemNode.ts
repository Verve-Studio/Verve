import type { ExecContext, ExecResult, INode } from "../../INode";
import { intInput, listInput, resolveIndex } from "../_shared/nodeKit";

class GetItemNode implements INode {
  readonly type = "listGetItem";
  readonly label = "Get Item";
  readonly category = "List";
  readonly domains = ["automation"] as const;
  readonly description = "Item at Index (negative counts from the end). Found is false when out of range.";
  readonly inputs = [
    { id: "list", label: "List", type: "list" },
    { id: "index", label: "Index", type: "int", value: { kind: "int", default: 0 } }
  ] as const;
  readonly outputs = [{ id: "item", label: "Item", type: "any" },
    { id: "found", label: "Found", type: "bool" },
  ] as const;

  async execute(ctx: ExecContext): Promise<ExecResult> {
    const items = await listInput(ctx, "list");
    const i = resolveIndex(await intInput(ctx, "index"), items.length);
    return { outputs: { item: i === null ? null : items[i], found: i !== null } };
  }
}

export const getItemNode: INode = new GetItemNode();
