import type { ExecContext, ExecResult, INode } from "../../INode";
import { boolSpec, enumSpec, stringInput, stringSpec } from "../_shared/nodeKit";

class TextCompareNode implements INode {
  readonly type = "textCompare";
  readonly label = "Text Compare";
  readonly category = "Text";
  readonly domains = ["automation"] as const;
  readonly description =
    "Tests Text against Pattern; Index is the first match position (-1 if none).";
  readonly inputs = [
    { id: "text", label: "Text", type: "string", value: stringSpec() },
    { id: "pattern", label: "Pattern", type: "string", value: stringSpec() },
  ] as const;
  readonly outputs = [
    { id: "result", label: "Result", type: "bool" },
    { id: "index", label: "Index", type: "int" },
  ] as const;
  readonly params = [
    {
      id: "operation",
      label: "Operation",
      spec: enumSpec("contains", [
        ["contains", "Contains"],
        ["equals", "Equals"],
        ["startsWith", "Starts With"],
        ["endsWith", "Ends With"],
        ["regex", "Matches Regex"],
      ]),
    },
    { id: "ignoreCase", label: "Ignore Case", spec: boolSpec(false) },
  ];

  async execute(ctx: ExecContext): Promise<ExecResult> {
    const ignore = ctx.param("ignoreCase") === true;
    const rawText = await stringInput(ctx, "text");
    const rawPattern = await stringInput(ctx, "pattern");
    const text = ignore ? rawText.toLowerCase() : rawText;
    const pattern = ignore ? rawPattern.toLowerCase() : rawPattern;
    switch (ctx.param("operation")) {
      case "equals":
        return { outputs: { result: text === pattern, index: text === pattern ? 0 : -1 } };
      case "startsWith": {
        const result = text.startsWith(pattern);
        return { outputs: { result, index: result ? 0 : -1 } };
      }
      case "endsWith": {
        const result = text.endsWith(pattern);
        return { outputs: { result, index: result ? text.length - pattern.length : -1 } };
      }
      case "regex": {
        let re: RegExp;
        try {
          re = new RegExp(rawPattern, ignore ? "i" : "");
        } catch {
          throw new Error(`Invalid regular expression "${rawPattern}"`);
        }
        const m = re.exec(rawText);
        return { outputs: { result: m !== null, index: m ? m.index : -1 } };
      }
      default: {
        const index = text.indexOf(pattern);
        return { outputs: { result: index >= 0, index } };
      }
    }
  }
}

export const textCompareNode: INode = new TextCompareNode();
