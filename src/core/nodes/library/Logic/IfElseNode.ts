import type {
  ExecContext,
  ExecResult,
  INode,
  NodePorts,
  ParamSpec,
  PortDef,
  PortType,
  ShaderContext,
  ShaderOutputs,
} from "../../INode";
import type { ParamValue } from "../../graphTypes";
import { colorSpec, enumSpec, floatSpec, memoPorts, vec2Spec } from "../_shared/nodeKit";
import { wgslType } from "../../wgsl";

/** Data types the node can switch, with inline editors for Then / Else. */
const TYPES: Record<string, { label: string; type: PortType; then?: ParamSpec; else?: ParamSpec }> = {
  float: { label: "Float", type: "float", then: floatSpec(1), else: floatSpec(0) },
  int: {
    label: "Integer",
    type: "int",
    then: { kind: "int", default: 1 },
    else: { kind: "int", default: 0 },
  },
  bool: {
    label: "Boolean",
    type: "bool",
    then: { kind: "bool", default: true },
    else: { kind: "bool", default: false },
  },
  vec2: { label: "Vector", type: "vec2", then: vec2Spec(1, 1), else: vec2Spec(0, 0) },
  vec3: { label: "Vector 3", type: "vec3" },
  color: { label: "Color", type: "color", then: colorSpec(1, 1, 1), else: colorSpec(0, 0, 0) },
  string: {
    label: "Text",
    type: "string",
    then: { kind: "string", default: "" },
    else: { kind: "string", default: "" },
  },
  layer: { label: "Layer", type: "layer" },
};

const CONDITION: PortDef = {
  id: "condition",
  label: "Condition",
  type: "bool",
  value: { kind: "bool", default: true },
};

const portsFor = memoPorts((key) => {
  const t = TYPES[key] ?? TYPES.float;
  return {
    inputs: [
      CONDITION,
      { id: "then", label: "Then", type: t.type, value: t.then },
      { id: "else", label: "Else", type: t.type, value: t.else },
    ],
    outputs: [{ id: "result", label: "Result", type: t.type }],
  };
});

/** Picks Then or Else by a condition (a value-level if / else). */
class IfElseNode implements INode {
  readonly type = "ifElse";
  readonly label = "If / Else";
  readonly category = "Logic";
  readonly domains = ["shader", "automation"] as const;
  readonly description = "Outputs Then when Condition is true, otherwise Else.";
  readonly params = [
    {
      id: "dataType",
      label: "Type",
      spec: enumSpec("float", Object.entries(TYPES).map(([id, t]) => [id, t.label])),
    },
  ];
  readonly inputs = portsFor("float").inputs;
  readonly outputs = portsFor("float").outputs;

  ports(params: Readonly<Record<string, ParamValue>>): NodePorts {
    return portsFor(String(params.dataType));
  }

  generateShader(ctx: ShaderContext): ShaderOutputs {
    const t = TYPES[String(ctx.param("dataType"))] ?? TYPES.float;
    const wt = wgslType(t.type);
    if (!wt) throw new Error(`${t.label} values aren't available in shaders`);
    const cond = ctx.input("condition") ?? "1.0";
    const yes = ctx.input("then") ?? `${wt}()`;
    const no = ctx.input("else") ?? `${wt}()`;
    return { result: `select(${no}, ${yes}, ${cond} > 0.5)` };
  }

  async execute(ctx: ExecContext): Promise<ExecResult> {
    const cond = (await ctx.input("condition")) === true;
    const value = await ctx.input(cond ? "then" : "else");
    return { outputs: { result: value ?? null } };
  }
}

export const ifElseNode: INode = new IfElseNode();
