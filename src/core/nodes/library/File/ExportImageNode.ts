import type { ExecContext, ExecResult, INode } from "../../INode";
import type { ExportFormat } from "../../values";
import { EXEC_IN, EXEC_OUT, enumSpec, stringInput } from "../_shared/nodeKit";

const FORMATS: readonly ExportFormat[] = ["png", "jpeg", "webp", "tiff"];

class ExportImageNode implements INode {
  readonly type = "exportImage";
  readonly label = "Export Image";
  readonly category = "File";
  readonly domains = ["automation"] as const;
  readonly width = 200;
  readonly inputs = [
    EXEC_IN,
    {
      id: "path",
      label: "Path",
      type: "string",
      value: { kind: "string", default: "", placeholder: "C:\\out\\image.png" },
    },
  ] as const;
  readonly outputs = [EXEC_OUT];
  readonly params = [
    {
      id: "format",
      label: "Format",
      spec: enumSpec("png", [
        ["png", "PNG"],
        ["jpeg", "JPEG"],
        ["webp", "WebP"],
        ["tiff", "TIFF"],
      ]),
    },
  ];

  async execute(ctx: ExecContext): Promise<ExecResult> {
    const path = await stringInput(ctx, "path");
    if (!path) throw new Error("No export path");
    const format = String(ctx.param("format")) as ExportFormat;
    await ctx.host.exportImage(path, FORMATS.includes(format) ? format : "png");
    return {};
  }
}

export const exportImageNode: INode = new ExportImageNode();
