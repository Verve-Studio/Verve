import type { ExecContext, ExecResult, INode } from "../../INode";
import { EXEC_IN, EXEC_OUT, stringInput, stringSpec } from "../_shared/nodeKit";
import { EFFECT_NODE_PARAMS, EFFECT_RESULT_OUT, EFFECT_TARGET_IN, applyCustomEffect } from "./EffectNode";

/** Effects → Custom Effects → Open Effect File: applies an .effect file. */
class OpenEffectFileNode implements INode {
  readonly type = "openEffectFile";
  readonly label = "Open Effect File";
  readonly category = "Effects";
  readonly domains = ["automation"] as const;
  readonly description =
    "Applies the custom shader effect in an .effect file (Effects → Custom Effects → Open Effect File). Its arguments use their defaults.";
  readonly width = 230;
  readonly params = EFFECT_NODE_PARAMS;
  readonly inputs = [
    EXEC_IN,
    EFFECT_TARGET_IN,
    { id: "path", label: "Path", type: "string", value: stringSpec("", "C:\fx\look.effect") },
  ] as const;
  readonly outputs = [EXEC_OUT, EFFECT_RESULT_OUT] as const;

  async execute(ctx: ExecContext): Promise<ExecResult> {
    return applyCustomEffect(ctx, await stringInput(ctx, "path"));
  }
}

export const openEffectFileNode: INode = new OpenEffectFileNode();
