import type { ExecContext, ExecResult, INode } from "../../INode";
import { makeList } from "../../values";
import { boolSpec, stringInput, stringSpec, wildcardRegExp } from "../_shared/nodeKit";

class FindLayerNode implements INode {
  readonly type = "findLayer";
  readonly label = "Find Layer";
  readonly category = "Layer";
  readonly domains = ["automation"] as const;
  readonly description =
    "Layers whose name matches Name (wildcards * and ?), searched top to bottom including groups. Layer is the first match.";
  readonly inputs = [
    { id: "name", label: "Name", type: "string", value: stringSpec("Layer*") },
  ] as const;
  readonly outputs = [
    { id: "layer", label: "Layer", type: "layer" },
    { id: "found", label: "Found", type: "bool" },
    { id: "matches", label: "Matches", type: "list" },
  ] as const;
  readonly params = [{ id: "includeEffects", label: "Include Effects / Masks", spec: boolSpec(false) }];

  async execute(ctx: ExecContext): Promise<ExecResult> {
    const re = wildcardRegExp(await stringInput(ctx, "name"));
    const matches = ctx.host
      .layers({ recursive: true, attachments: ctx.param("includeEffects") === true })
      .filter((l) => re.test(l.name));
    return {
      outputs: { layer: matches[0] ?? null, found: matches.length > 0, matches: makeList(matches) },
    };
  }
}

export const findLayerNode: INode = new FindLayerNode();
