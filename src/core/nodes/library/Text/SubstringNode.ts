import type { ExecContext, ExecResult, INode } from "../../INode";
import { intInput, stringInput, stringSpec } from "../_shared/nodeKit";

class SubstringNode implements INode {
  readonly type = "textSubstring";
  readonly label = "Substring";
  readonly category = "Text";
  readonly domains = ["automation"] as const;
  readonly description =
    "Part of the text from Start (negative counts from the end) for Length characters (-1 = to the end).";
  readonly inputs = [
    { id: "text", label: "Text", type: "string", value: stringSpec() },
    { id: "start", label: "Start", type: "int", value: { kind: "int", default: 0 } },
    { id: "length", label: "Length", type: "int", value: { kind: "int", default: -1 } },
  ] as const;
  readonly outputs = [{ id: "result", label: "Text", type: "string" }] as const;

  async execute(ctx: ExecContext): Promise<ExecResult> {
    const text = await stringInput(ctx, "text");
    const raw = await intInput(ctx, "start");
    const length = await intInput(ctx, "length");
    const start = Math.max(0, raw < 0 ? text.length + raw : raw);
    const end = length < 0 ? text.length : start + length;
    return { outputs: { result: text.slice(start, end) } };
  }
}

export const substringNode: INode = new SubstringNode();
