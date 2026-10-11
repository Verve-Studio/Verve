import type { ExecContext, ExecResult, INode } from "../../INode";
import { stringInput, stringSpec } from "../_shared/nodeKit";

class TrimNode implements INode {
  readonly type = "textTrim";
  readonly label = "Trim";
  readonly category = "Text";
  readonly domains = ["automation"] as const;
  readonly description = "Removes leading and trailing whitespace.";
  readonly inputs = [{ id: "text", label: "Text", type: "string", value: stringSpec() }] as const;
  readonly outputs = [{ id: "result", label: "Text", type: "string" }] as const;

  async execute(ctx: ExecContext): Promise<ExecResult> {
    return { outputs: { result: (await stringInput(ctx, "text")).trim() } };
  }
}

export const trimNode: INode = new TrimNode();
