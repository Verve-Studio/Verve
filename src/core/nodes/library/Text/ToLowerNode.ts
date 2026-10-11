import type { ExecContext, ExecResult, INode } from "../../INode";
import { stringInput, stringSpec } from "../_shared/nodeKit";

class ToLowerNode implements INode {
  readonly type = "textLower";
  readonly label = "To Lower";
  readonly category = "Text";
  readonly domains = ["automation"] as const;
  readonly description = "Lower-case copy of the text.";
  readonly inputs = [{ id: "text", label: "Text", type: "string", value: stringSpec() }] as const;
  readonly outputs = [{ id: "result", label: "Text", type: "string" }] as const;

  async execute(ctx: ExecContext): Promise<ExecResult> {
    return { outputs: { result: (await stringInput(ctx, "text")).toLowerCase() } };
  }
}

export const toLowerNode: INode = new ToLowerNode();
