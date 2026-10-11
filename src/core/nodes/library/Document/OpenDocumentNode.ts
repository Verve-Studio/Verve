import type { ExecContext, INode } from "../../INode";
import {
  ActionNode,
  DOCUMENT_OUT,
  stringInput,
  stringSpec,
} from "../_shared/nodeKit";

class OpenDocumentNode extends ActionNode {
  readonly type = "openDocument";
  readonly label = "Open";
  readonly category = "File";
  readonly description = "Opens a file as a document and makes it active: .verve, .psd, and every image format the app reads (PNG, JPEG, WebP, AVIF, GIF, BMP, TGA, PCX, TIFF, EXR, HDR, DDS).";
  readonly width = 200;
  protected readonly dataInputs = [{ id: "path", label: "Path", type: "string", value: stringSpec("", "C:\\images\\photo.png") }] as const;
  protected readonly dataOutputs = [DOCUMENT_OUT] as const;

  protected async run(ctx: ExecContext) {
    const path = await stringInput(ctx, "path");
    if (!path) throw new Error("No file path");
    return { document: await ctx.host.openDocument(path) };
  }
}

export const openDocumentNode: INode = new OpenDocumentNode();
