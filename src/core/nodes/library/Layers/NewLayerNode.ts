import type { ExecContext, ExecResult, INode } from "../../INode";
import { EXEC_IN, EXEC_OUT, stringInput } from "../_shared/nodeKit";

class NewLayerNode implements INode {
  readonly type = "newLayer";
  readonly label = "New Layer";
  readonly category = "Layers";
  readonly domains = ["automation"] as const;
  readonly inputs = [
    EXEC_IN,
    { id: "name", label: "Name", type: "string", value: { kind: "string", default: "Layer" } },
  ] as const;
  readonly outputs = [EXEC_OUT, { id: "layer", label: "Layer", type: "layer" }] as const;

  async execute(ctx: ExecContext): Promise<ExecResult> {
    const layer = await ctx.host.newLayer((await stringInput(ctx, "name")) || "Layer");
    return { outputs: { layer } };
  }
}

export const newLayerNode: INode = new NewLayerNode();
