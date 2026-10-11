import type { ExecContext, ExecResult, INode } from "../../INode";

class TextNode implements INode {
  readonly type = "text";
  readonly label = "Text";
  readonly category = "Input";
  readonly domains = ["automation"] as const;
  readonly inputs = [];
  readonly outputs = [{ id: "value", label: "Text", type: "string" }] as const;
  readonly params = [{ id: "value", label: "Text", spec: { kind: "string", default: "" } }] as const;

  execute(ctx: ExecContext): ExecResult {
    return { outputs: { value: String(ctx.param("value")) } };
  }
}

export const textNode: INode = new TextNode();
