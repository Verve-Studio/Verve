import type { ExecContext, ExecResult, INode, NodePorts, PortDef } from "../../INode";
import { DEFAULT_RESTORE_MODEL } from "@/core/store/upscaleModelStore";
import { EXEC_IN, EXEC_OUT, memoPorts, stringInput, upscaleModel } from "../_shared/nodeKit";
import { modelPort } from "./upscaleModelPorts";

const portsFor = memoPorts((): NodePorts => ({
  inputs: [EXEC_IN, modelPort(DEFAULT_RESTORE_MODEL).port],
  outputs: [EXEC_OUT],
}));

/** Image → Restore Image: AI detail restore with the dialog's model list. */
class RestoreImageNode implements INode {
  readonly type = "restoreImage";
  readonly label = "Restore Image";
  readonly category = "Image";
  readonly domains = ["automation"] as const;
  readonly description =
    "Restores detail with an AI model without changing the size (Image → Restore Image; RGB/8 documents).";
  readonly width = 210;

  get inputs(): readonly PortDef[] {
    return portsFor(modelPort().key).inputs;
  }
  get outputs(): readonly PortDef[] {
    return portsFor(modelPort().key).outputs;
  }
  ports(): NodePorts {
    return portsFor(modelPort().key);
  }

  async execute(ctx: ExecContext): Promise<ExecResult> {
    const model = (await stringInput(ctx, "model")) || DEFAULT_RESTORE_MODEL;
    await ctx.host.restoreImage(await upscaleModel(ctx, model));
    return {};
  }
}

export const restoreImageNode: INode = new RestoreImageNode();
