import type { ExecContext, INode } from "../../INode";
import {
  ActionNode,
} from "../_shared/nodeKit";

class MergeVisibleNode extends ActionNode {
  readonly type = "mergeVisible";
  readonly label = "Merge Visible";
  readonly category = "Layer";
  readonly description = "Merges every visible top-level layer into one (Layer → Merge Visible).";
  protected readonly dataInputs = [];
  protected readonly dataOutputs = [{ id: "merged", label: "Merged", type: "layer" }] as const;

  protected async run(ctx: ExecContext) {
    return { merged: await ctx.host.mergeVisible() };
  }
}

export const mergeVisibleNode: INode = new MergeVisibleNode();
