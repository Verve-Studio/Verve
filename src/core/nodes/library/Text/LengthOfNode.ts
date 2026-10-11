import type { ExecContext, ExecResult, INode } from "../../INode";
import { stringInput, stringSpec } from "../_shared/nodeKit";

class LengthOfNode implements INode {
  readonly type = "textLength";
  readonly label = "Length Of";
  readonly category = "Text";
  readonly domains = ["automation"] as const;
  readonly description = "Number of characters in the text.";
  readonly inputs = [{ id: "text", label: "Text", type: "string", value: stringSpec() }] as const;
  readonly outputs = [{ id: "length", label: "Length", type: "int" }] as const;

  async execute(ctx: ExecContext): Promise<ExecResult> {
    return { outputs: { length: (await stringInput(ctx, "text")).length } };
  }
}

export const lengthOfNode: INode = new LengthOfNode();
