import type { ExecContext, INode } from "../../INode";
import type { BackgroundFill, PixelFormat } from "@/types";
import {
  ActionNode,
  DOCUMENT_OUT,
  enumParam,
  enumSpec,
  intInput,
  intSpec,
  stringInput,
  stringSpec,
} from "../_shared/nodeKit";

class NewDocumentNode extends ActionNode {
  readonly type = "newDocument";
  readonly label = "New";
  readonly category = "File";
  readonly description = "Creates a new document and makes it active.";
  readonly params = [
    {
      id: "format",
      label: "Color Mode",
      spec: enumSpec("rgba8", [
        ["rgba8", "RGB/8"],
        ["rgba32f", "RGB/32 Float"],
        ["indexed8", "Indexed/8"],
      ]),
    },
    {
      id: "background",
      label: "Background",
      spec: enumSpec("white", [
        ["white", "White"],
        ["black", "Black"],
        ["transparent", "Transparent"],
      ]),
    },
  ];
  protected readonly dataInputs = [{ id: "width", label: "Width", type: "int", value: intSpec(1920, 1, 32768) }, { id: "height", label: "Height", type: "int", value: intSpec(1080, 1, 32768) }, { id: "name", label: "Name", type: "string", value: stringSpec("") }] as const;
  protected readonly dataOutputs = [DOCUMENT_OUT] as const;

  protected async run(ctx: ExecContext) {
    const document = await ctx.host.newDocument({
      name: (await stringInput(ctx, "name")) || undefined,
      width: await intInput(ctx, "width"),
      height: await intInput(ctx, "height"),
      pixelFormat: enumParam(ctx, "format") as PixelFormat,
      background: enumParam(ctx, "background") as BackgroundFill,
    });
    return { document };
  }
}

export const newDocumentNode: INode = new NewDocumentNode();
