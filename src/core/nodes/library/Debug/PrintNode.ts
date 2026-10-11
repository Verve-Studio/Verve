import type { ExecContext, ExecResult, INode } from "../../INode";
import { EXEC_IN, EXEC_OUT } from "../_shared/nodeKit";
import { convertValue } from "../../values";

class PrintNode implements INode {
  readonly type = "print";
  readonly label = "Print";
  readonly category = "Debug";
  readonly domains = ["automation"] as const;
  readonly inputs = [
    EXEC_IN,
    { id: "message", label: "Message", type: "any", value: { kind: "string", default: "" } },
  ] as const;
  readonly outputs = [EXEC_OUT];

  async execute(ctx: ExecContext): Promise<ExecResult> {
    const message = await ctx.input("message");
    ctx.host.log(String(convertValue(message ?? "", "string")));
    return {};
  }
}

export const printNode: INode = new PrintNode();
