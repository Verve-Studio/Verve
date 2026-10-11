import type { ExecContext, INode } from "../../INode";
import { EXEC_IN, stringInput, stringSpec } from "../_shared/nodeKit";

class StopNode implements INode {
  readonly type = "stop";
  readonly label = "Stop With Error";
  readonly category = "Flow";
  readonly domains = ["automation"] as const;
  readonly description = "Ends the run and reports Message as an error.";
  readonly inputs = [
    EXEC_IN,
    { id: "message", label: "Message", type: "string", value: stringSpec("Stopped") },
  ] as const;
  readonly outputs = [];

  async execute(ctx: ExecContext): Promise<never> {
    throw new Error((await stringInput(ctx, "message")) || "Stopped");
  }
}

export const stopNode: INode = new StopNode();
