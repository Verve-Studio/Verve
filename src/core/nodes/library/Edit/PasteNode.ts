import type { ExecContext, INode } from "../../INode";
import {
  ActionNode,
  LAYER_OUT,
} from "../_shared/nodeKit";

class PasteNode extends ActionNode {
  readonly type = "paste";
  readonly label = "Paste";
  readonly category = "Edit";
  readonly description = "Pastes the clipboard image as a new layer.";
  protected readonly dataInputs = [];
  protected readonly dataOutputs = [LAYER_OUT] as const;

  protected async run(ctx: ExecContext) {
    return { layer: await ctx.host.paste() };
  }
}

export const pasteNode: INode = new PasteNode();
