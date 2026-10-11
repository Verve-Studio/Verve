import type { INode, ShaderContext, ShaderOutputs } from "../../INode";
import { floatSpec } from "../_shared/nodeKit";

class CombineXyzNode implements INode {
  readonly type = "combineXyz";
  readonly label = "Combine XYZ";
  readonly category = "Vector";
  readonly domains = ["shader"] as const;
  readonly inputs = [
    { id: "x", label: "X", type: "float", value: floatSpec(0) },
    { id: "y", label: "Y", type: "float", value: floatSpec(0) },
    { id: "z", label: "Z", type: "float", value: floatSpec(0) },
  ] as const;
  readonly outputs = [{ id: "vector", label: "Vector", type: "vec3" }] as const;

  generateShader(ctx: ShaderContext): ShaderOutputs {
    const c = (id: string): string => ctx.input(id) ?? "0.0";
    return { vector: `vec3f(${c("x")}, ${c("y")}, ${c("z")})` };
  }
}

export const combineXyzNode: INode = new CombineXyzNode();
