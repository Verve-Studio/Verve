import type { ExecContext, ExecResult, INode } from "../../INode";
import { stringInput, stringSpec } from "../_shared/nodeKit";

class ParseNumberNode implements INode {
  readonly type = "parseNumber";
  readonly label = "Parse Number";
  readonly category = "Text";
  readonly domains = ["automation"] as const;
  readonly description = "Reads a number from text; Valid is false when it isn't one.";
  readonly inputs = [{ id: "text", label: "Text", type: "string", value: stringSpec("0") }] as const;
  readonly outputs = [
    { id: "value", label: "Value", type: "float" },
    { id: "valid", label: "Valid", type: "bool" },
  ] as const;

  async execute(ctx: ExecContext): Promise<ExecResult> {
    const text = (await stringInput(ctx, "text")).trim().replace(",", ".");
    const n = text === "" ? NaN : Number(text);
    const valid = Number.isFinite(n);
    return { outputs: { value: valid ? n : 0, valid } };
  }
}

export const parseNumberNode: INode = new ParseNumberNode();
