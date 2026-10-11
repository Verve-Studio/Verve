import type { ExecContext, ExecResult, INode } from "../../INode";
import { stringInput, stringSpec } from "../_shared/nodeKit";

class ToUpperNode implements INode {
  readonly type = "textUpper";
  readonly label = "To Upper";
  readonly category = "Text";
  readonly domains = ["automation"] as const;
  readonly description = "Upper-case copy of the text.";
  readonly inputs = [{ id: "text", label: "Text", type: "string", value: stringSpec() }] as const;
  readonly outputs = [{ id: "result", label: "Text", type: "string" }] as const;

  async execute(ctx: ExecContext): Promise<ExecResult> {
    return { outputs: { result: (await stringInput(ctx, "text")).toUpperCase() } };
  }
}

export const toUpperNode: INode = new ToUpperNode();
