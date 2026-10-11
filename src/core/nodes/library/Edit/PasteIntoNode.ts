import type { ExecContext, INode } from "../../INode";
import {
  ActionNode,
  LAYER_OUT,
} from "../_shared/nodeKit";

class PasteIntoNode extends ActionNode {
  readonly type = "pasteInto";
  readonly label = "Paste Into";
  readonly category = "Edit";
  readonly description = "Pastes the clipboard image as a new layer masked by the selection (Edit → Paste Into).";
  protected readonly dataInputs = [];
  protected readonly dataOutputs = [LAYER_OUT] as const;

  protected async run(ctx: ExecContext) {
    return { layer: await ctx.host.pasteInto() };
  }
}

export const pasteIntoNode: INode = new PasteIntoNode();
