import type { ExecContext, ExecResult, INode } from "../../INode";
import { intSpec, numberInput } from "../_shared/nodeKit";

class FormatNumberNode implements INode {
  readonly type = "formatNumber";
  readonly label = "Format Number";
  readonly category = "Text";
  readonly domains = ["automation"] as const;
  readonly description =
    "Number as text with fixed decimals, zero-padded to Min Digits (e.g. 7 → 007).";
  readonly inputs = [
    { id: "value", label: "Value", type: "float", value: { kind: "float", default: 0 } },
  ] as const;
  readonly outputs = [{ id: "result", label: "Text", type: "string" }] as const;
  readonly params = [
    { id: "decimals", label: "Decimals", spec: intSpec(0, 0, 10) },
    { id: "digits", label: "Min Digits", spec: intSpec(1, 1, 20) },
  ];

  async execute(ctx: ExecContext): Promise<ExecResult> {
    const v = await numberInput(ctx, "value");
    const text = Math.abs(v).toFixed(Math.max(0, Number(ctx.param("decimals")) || 0));
    const [int, frac] = text.split(".");
    const padded = int.padStart(Math.max(1, Number(ctx.param("digits")) || 1), "0");
    return { outputs: { result: `${v < 0 ? "-" : ""}${padded}${frac ? `.${frac}` : ""}` } };
  }
}

export const formatNumberNode: INode = new FormatNumberNode();
