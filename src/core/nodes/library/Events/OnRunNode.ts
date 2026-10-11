import type { INode } from "../../INode";
import { EXEC_OUT } from "../_shared/nodeKit";

/** Entry point: the runner starts here and follows its exec output. */
class OnRunNode implements INode {
  readonly type = "onRun";
  readonly label = "On Run";
  readonly category = "Events";
  readonly domains = ["automation"] as const;
  readonly description = "Starts the workflow when it is run.";
  readonly inputs = [];
  readonly outputs = [EXEC_OUT];
  readonly unique = true;

  execute(): void {}
}

export const onRunNode: INode = new OnRunNode();
