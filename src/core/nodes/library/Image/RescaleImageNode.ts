import type { ExecContext, ExecResult, INode, NodePorts, PortDef } from "../../INode";
import {
  EXEC_IN,
  EXEC_OUT,
  enumParam,
  enumSpec,
  floatSpec,
  memoPorts,
  numberInput,
  stringInput,
  upscaleModel,
} from "../_shared/nodeKit";
import { modelPort } from "./upscaleModelPorts";

const WIDTH: PortDef = { id: "width", label: "Width", type: "float", value: floatSpec(2048, 1, 32768, 1) };
const portsFor = memoPorts((): NodePorts => ({
  inputs: [EXEC_IN, WIDTH, modelPort().port],
  outputs: [EXEC_OUT],
}));

/** Image → Rescale Image: AI upscale with the dialog's model list. */
class RescaleImageNode implements INode {
  readonly type = "rescaleImage";
  readonly label = "Rescale Image";
  readonly category = "Image";
  readonly domains = ["automation"] as const;
  readonly description =
    "Upscales the document with an AI model (Image → Rescale Image; RGB/8 documents). The aspect ratio is kept: the height follows Width.";
  readonly width = 210;
  readonly params = [
    { id: "units", label: "Units", spec: enumSpec("pixels", [["pixels", "Pixels"], ["percent", "Percent"]]) },
  ];

  get inputs(): readonly PortDef[] {
    return portsFor(modelPort().key).inputs;
  }
  get outputs(): readonly PortDef[] {
    return portsFor(modelPort().key).outputs;
  }
  ports(): NodePorts {
    return portsFor(modelPort().key);
  }

  async execute(ctx: ExecContext): Promise<ExecResult> {
    const doc = ctx.host.document();
    const width = await numberInput(ctx, "width");
    const w = enumParam(ctx, "units") === "percent" ? (doc.width * width) / 100 : width;
    const h = Math.max(1, Math.round((w * doc.height) / doc.width));
    await ctx.host.rescaleImage(w, h, await upscaleModel(ctx, await stringInput(ctx, "model")));
    return {};
  }
}

export const rescaleImageNode: INode = new RescaleImageNode();
