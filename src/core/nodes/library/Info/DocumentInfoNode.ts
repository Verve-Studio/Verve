import type { ExecContext, ExecResult, INode, ShaderContext, ShaderOutputs } from "../../INode";

class DocumentInfoNode implements INode {
  readonly type = "documentInfo";
  readonly label = "Document Info";
  readonly category = "Info";
  readonly domains = ["shader", "automation"] as const;
  readonly description = "Canvas size and pixel format of the document.";
  readonly inputs = [];
  readonly outputs = [
    { id: "width", label: "Width", type: "float" },
    { id: "height", label: "Height", type: "float" },
    { id: "size", label: "Size", type: "vec2" },
    { id: "texelSize", label: "Texel Size", type: "vec2" },
    { id: "aspect", label: "Aspect", type: "float" },
    { id: "isFloat", label: "Is Float (HDR)", type: "bool" },
    { id: "format", label: "Format", type: "string" },
  ] as const;

  generateShader(ctx: ShaderContext): ShaderOutputs {
    const r = ctx.resolution;
    // `format` is text: automation only.
    return {
      width: `${r}.x`,
      height: `${r}.y`,
      size: r,
      texelSize: ctx.texelSize,
      aspect: `${r}.x / ${r}.y`,
      isFloat: ctx.isFloat,
    };
  }

  execute(ctx: ExecContext): ExecResult {
    const d = ctx.host.document();
    return {
      outputs: {
        width: d.width,
        height: d.height,
        size: [d.width, d.height],
        texelSize: [1 / d.width, 1 / d.height],
        aspect: d.width / d.height,
        isFloat: d.format === "rgba32f",
        format: d.format,
      },
    };
  }
}

export const documentInfoNode: INode = new DocumentInfoNode();
