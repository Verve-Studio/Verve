/** The Model input of the Rescale / Restore Image nodes: a dropdown of the
 *  models the dialogs offer (`upscaleModelStore`). */
import type { PortDef } from "../../INode";
import { upscaleModelStore } from "@/core/store/upscaleModelStore";
import { enumSpec } from "../_shared/nodeKit";

/** Model dropdown defaulting to `preferred` when installed, else the first
 *  model. The list key changes when the models load, so ports built from
 *  it can be memoized on it. */
export function modelPort(preferred?: string): { key: string; port: PortDef } {
  const models = upscaleModelStore.all();
  const def = models.find((m) => m.id === preferred)?.id ?? models[0]?.id ?? "";
  return {
    key: models.map((m) => m.id).join("|"),
    port: {
      id: "model",
      label: "Model",
      type: "string",
      value: enumSpec(
        def,
        models.length > 0 ? models.map((m) => [m.id, m.label]) : [["", "(no models found)"]],
      ),
    },
  };
}
