import type { ExecContext, ExecResult, INode, ShaderContext, ShaderOutputs } from "../../INode";
import { floatSpec, numberInput } from "../_shared/nodeKit";

const HELPER = /* wgsl */ `fn ng_map_range(v: f32, a: f32, b: f32, c: f32, d: f32, clampT: bool) -> f32 {
  var t = select((v - a) / (b - a), 0.0, b == a);
  if (clampT) { t = clamp(t, 0.0, 1.0); }
  return c + t * (d - c);
}`;

class MapRangeNode implements INode {
  readonly type = "mapRange";
  readonly label = "Map Range";
  readonly category = "Math";
  readonly domains = ["shader", "automation"] as const;
  readonly description = "Remap a value from one range to another.";
  readonly inputs = [
    { id: "value", label: "Value", type: "float", value: floatSpec(0.5) },
    { id: "fromMin", label: "From Min", type: "float", value: floatSpec(0) },
    { id: "fromMax", label: "From Max", type: "float", value: floatSpec(1) },
    { id: "toMin", label: "To Min", type: "float", value: floatSpec(0) },
    { id: "toMax", label: "To Max", type: "float", value: floatSpec(1) },
  ] as const;
  readonly outputs = [{ id: "result", label: "Result", type: "float" }] as const;
  readonly params = [{ id: "clamp", label: "Clamp", spec: { kind: "bool", default: true } }] as const;

  generateShader(ctx: ShaderContext): ShaderOutputs {
    const fn = ctx.helper("ng_map_range", HELPER);
    const args = this.inputs.map((p) => ctx.input(p.id) ?? "0.0");
    return { result: `${fn}(${args.join(", ")}, ${ctx.param("clamp") === true})` };
  }

  async execute(ctx: ExecContext): Promise<ExecResult> {
    const [v, a, b, c, d] = await Promise.all(this.inputs.map((p) => numberInput(ctx, p.id)));
    let t = b === a ? 0 : (v - a) / (b - a);
    if (ctx.param("clamp") === true) t = Math.min(1, Math.max(0, t));
    return { outputs: { result: c + t * (d - c) } };
  }
}

export const mapRangeNode: INode = new MapRangeNode();
