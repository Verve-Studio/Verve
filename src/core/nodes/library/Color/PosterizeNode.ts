import type { INode, ShaderContext, ShaderOutputs } from "../../INode";
import { colorSpec, floatSpec } from "../_shared/nodeKit";
import { fromDisplay, toDisplay } from "../_shared/shaderKit";

/** Reduce each RGB channel to a number of evenly spaced (display) levels. */
class PosterizeNode implements INode {
  readonly type = "posterize";
  readonly label = "Posterize";
  readonly category = "Color";
  readonly domains = ["shader"] as const;
  readonly description = "Reduce each colour channel to a number of evenly spaced levels.";
  readonly inputs = [
    { id: "color", label: "Color", type: "color", value: colorSpec(1, 1, 1) },
    { id: "levels", label: "Levels", type: "float", value: floatSpec(4, 2, 256, 0.05) },
  ] as const;
  readonly outputs = [{ id: "color", label: "Color", type: "color" }] as const;

  generateShader(ctx: ShaderContext): ShaderOutputs {
    const c = ctx.local("vec4f", ctx.input("color") ?? "vec4f(1.0)");
    const steps = ctx.local("f32", `max(floor(${ctx.input("levels") ?? "4.0"}), 2.0) - 1.0`);
    const rgb = toDisplay(ctx, `${c}.rgb`);
    const q = `(round(clamp(${rgb}, vec3f(0.0), vec3f(1.0)) * ${steps}) / ${steps})`;
    return { color: `vec4f(${fromDisplay(ctx, q)}, ${c}.a)` };
  }
}

export const posterizeNode: INode = new PosterizeNode();
