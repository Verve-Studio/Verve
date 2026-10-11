/**
 * One automation node per registered effect (adjustments, effects and
 * filters alike), generated from the effect's `paramFields` schema, so a
 * new effect appears in the node editor without a node file. Each param is
 * an input with an inline editor (connect a value to drive it). The effect
 * is applied through `AutomationHost.addEffect` — the same path as the
 * menus: a non-destructive effect layer on the target, optionally baked
 * into its pixels.
 */
import type { IPipelineEffect } from "@/core/effects/IPipelineEffect";
import { effectRegistry } from "@/core/effects/effectRegistry";
import { fieldSpec, type EffectParamField } from "@/core/effects/_shared/effectParams";
import type { ExecContext, ExecResult, INode, ParamDef, PortDef, PortType } from "../../INode";
import type { LayerRef } from "../../values";
import { boolSpec, enumSpec, EXEC_IN, EXEC_OUT, layerOrActive } from "../_shared/nodeKit";

type AnyEffect = IPipelineEffect<any, any>;

const MENU_CATEGORY = { adjustments: "Adjustments", effects: "Effects", filters: "Filters" } as const;

const portType = (field: EffectParamField): PortType | null => {
  switch (field.spec.kind) {
    case "float":
    case "int":
    case "bool":
    case "color":
    case "vec2":
      return field.spec.kind;
    case "enum":
    case "string":
      return "string";
    default:
      return null;
  }
};

const fieldPort = (field: EffectParamField): string => `f_${field.id}`;

/** Where / how the effect is applied (shared by every effect node). */
export const EFFECT_NODE_PARAMS: readonly ParamDef[] = [
  {
    id: "applyTo",
    label: "Apply To",
    spec: enumSpec("layer", [
      ["layer", "Layer"],
      ["image", "Whole Image"],
    ]),
  },
  {
    id: "result",
    label: "Result",
    spec: enumSpec("effect", [
      ["effect", "Effect layer (editable)"],
      ["bake", "Apply to pixels"],
    ]),
  },
  { id: "useSelection", label: "Limit To Selection", spec: boolSpec(true) },
];

export const EFFECT_TARGET_IN: PortDef = { id: "layer", label: "Layer", type: "layer" };
export const EFFECT_RESULT_OUT: PortDef = { id: "result", label: "Result", type: "layer" };

/** Target of an effect node from its Apply To param and Layer input. */
export async function effectTarget(ctx: ExecContext): Promise<LayerRef | "image"> {
  return ctx.param("applyTo") === "image" ? "image" : layerOrActive(ctx);
}

class EffectNode implements INode {
  readonly type: string;
  readonly label: string;
  readonly category: string;
  readonly domains = ["automation"] as const;
  readonly description: string;
  readonly width = 230;
  readonly params = EFFECT_NODE_PARAMS;
  readonly inputs: readonly PortDef[];
  readonly outputs: readonly PortDef[] = [EXEC_OUT, EFFECT_RESULT_OUT];
  private readonly fields: readonly EffectParamField[];

  constructor(private readonly effect: AnyEffect) {
    this.type = `effect.${effect.id}`;
    this.label = effect.label.replace("…", "");
    this.category = MENU_CATEGORY[effect.menu.root as keyof typeof MENU_CATEGORY] ?? "Effects";
    this.description =
      `${this.label} on the layer (unconnected = the active layer) or the whole image (all layers are wrapped in an "Image" composite). ` +
      "Result: an editable effect layer, or baked into the pixels.";
    this.fields = (effect.paramFields ?? []).filter((f) => portType(f) !== null);
    this.inputs = [
      EXEC_IN,
      EFFECT_TARGET_IN,
      ...this.fields.map(
        (f): PortDef => ({
          id: fieldPort(f),
          label: f.label,
          type: portType(f)!,
          value: fieldSpec(f, effect.defaultParams),
        }),
      ),
    ];
  }

  async execute(ctx: ExecContext): Promise<ExecResult> {
    const values: Record<string, unknown> = {};
    for (const f of this.fields) {
      const v = await ctx.input(fieldPort(f));
      if (v !== undefined && v !== null) values[f.id] = v;
    }
    const result = await ctx.host.addEffect({
      target: await effectTarget(ctx),
      effectType: this.effect.id,
      values,
      bake: ctx.param("result") === "bake",
      useSelection: ctx.param("useSelection") === true,
    });
    return { outputs: { result } };
  }
}

const cache = new Map<AnyEffect, INode>();

/** Nodes for every registered effect (except Custom Shader, which has its
 *  own node), memoized per effect. */
export function effectNodes(): INode[] {
  return effectRegistry
    .all()
    .filter((e) => e.id !== "custom-shader")
    .map((e) => {
      let node = cache.get(e);
      if (!node) {
        node = new EffectNode(e);
        cache.set(e, node);
      }
      return node;
    });
}

/** Apply a custom shader effect (.effect) by its menu name or file path,
 *  like Effects → Custom Effects / Open Effect File: the graph is copied
 *  into the layer, with its argument defaults. */
export async function applyCustomEffect(ctx: ExecContext, nameOrPath: string): Promise<ExecResult> {
  if (!nameOrPath) throw new Error("No effect chosen");
  const custom = await ctx.host.loadCustomEffect(nameOrPath);
  const result = await ctx.host.addEffect({
    target: await effectTarget(ctx),
    effectType: "custom-shader",
    values: {},
    baseParams: { graph: custom.graph, source: custom.path ?? undefined, asEffect: true },
    name: custom.name,
    bake: ctx.param("result") === "bake",
    useSelection: ctx.param("useSelection") === true,
  });
  return { outputs: { result } };
}
