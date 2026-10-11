import type { INode, ShaderContext, ShaderOutputs } from "../../INode";

class SeparateXyzNode implements INode {
  readonly type = "separateXyz";
  readonly label = "Separate XYZ";
  readonly category = "Vector";
  readonly domains = ["shader"] as const;
  readonly inputs = [{ id: "vector", label: "Vector", type: "vec3" }] as const;
  readonly outputs = [
    { id: "x", label: "X", type: "float" },
    { id: "y", label: "Y", type: "float" },
    { id: "z", label: "Z", type: "float" },
  ] as const;

  generateShader(ctx: ShaderContext): ShaderOutputs {
    const v = `(${ctx.input("vector") ?? "vec3f(0.0)"})`;
    return { x: `${v}.x`, y: `${v}.y`, z: `${v}.z` };
  }
}

export const separateXyzNode: INode = new SeparateXyzNode();
