import type { ExecContext, ExecResult, INode, NodePorts, PortDef } from "../../INode";
import { customEffectStore } from "@/core/effects/CustomShader/customEffectStore";
import { EXEC_IN, EXEC_OUT, enumSpec, memoPorts, stringInput } from "../_shared/nodeKit";
import { EFFECT_NODE_PARAMS, EFFECT_RESULT_OUT, EFFECT_TARGET_IN, applyCustomEffect } from "./EffectNode";

/** Effect dropdown: the effects listed under Effects → Custom Effects (a
 *  connected text may also give a name or an .effect path). */
function effectPort(): { key: string; port: PortDef } {
  const usable = customEffectStore.all().filter((e) => e.graph);
  return {
    key: usable.map((e) => `${e.path}=${e.label}`).join("|"),
    port: {
      id: "effect",
      label: "Effect",
      type: "string",
      value: enumSpec(
        usable[0]?.path ?? "",
        usable.length > 0 ? usable.map((e) => [e.path, e.label]) : [["", "(no saved effects yet)"]],
      ),
    },
  };
}

const portsFor = memoPorts((): NodePorts => ({
  inputs: [EXEC_IN, EFFECT_TARGET_IN, effectPort().port],
  outputs: [EXEC_OUT, EFFECT_RESULT_OUT],
}));

/** Effects → Custom Effects: applies one of the saved custom shader effects. */
class CustomEffectsNode implements INode {
  readonly type = "customEffects";
  readonly label = "Custom Effects";
  readonly category = "Effects";
  readonly domains = ["automation"] as const;
  readonly description =
    "Applies a saved custom shader effect (Effects → Custom Effects) to the layer or the whole image. Its arguments use their defaults.";
  readonly width = 230;
  readonly params = EFFECT_NODE_PARAMS;

  get inputs(): readonly PortDef[] {
    return portsFor(effectPort().key).inputs;
  }
  get outputs(): readonly PortDef[] {
    return portsFor(effectPort().key).outputs;
  }
  ports(): NodePorts {
    return portsFor(effectPort().key);
  }

  async execute(ctx: ExecContext): Promise<ExecResult> {
    return applyCustomEffect(ctx, await stringInput(ctx, "effect"));
  }
}

export const customEffectsNode: INode = new CustomEffectsNode();
