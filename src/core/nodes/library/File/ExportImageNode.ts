import type { ExecContext, ExecResult, INode, NodePorts, PortDef } from "../../INode";
import type { ParamValue } from "../../graphTypes";
import {
  DDS_COMPRESSIONS,
  DEFAULT_EXPORT_SETTINGS,
  EXPORT_FORMATS,
  EXR_COMPRESSIONS,
  applyExportExtension,
  isLdrExport,
  supportsLayerMode,
  type DdsCompression,
  type ExportFormat,
  type ExportSettings,
  type LayerExportMode,
} from "@/core/io/exportSettings";
import type { ToneMappingOperator } from "@/types";
import { isLayerRef, isList } from "../../values";
import { splitPath } from "../_shared/paths";
import {
  EXEC_IN,
  EXEC_OUT,
  boolSpec,
  colorSpec,
  enumSpec,
  intSpec,
  memoPorts,
  numberInput,
  stringInput,
  stringSpec,
  vectorInput,
} from "../_shared/nodeKit";

const PATH_IN: PortDef = {
  id: "path",
  label: "Path",
  type: "string",
  value: stringSpec("", "C:\\out\\image.png"),
};
const QUALITY = (def: number): PortDef => ({
  id: "quality",
  label: "Quality",
  type: "int",
  value: intSpec(def, 1, 100),
});
const TONE_MAP: PortDef[] = [
  {
    id: "toneMap",
    label: "HDR Tone Map",
    type: "string",
    value: enumSpec("display", [
      ["display", "As Displayed"],
      ["clamp", "Clamp"],
      ["reinhard", "Reinhard"],
    ]),
  },
  { id: "exposure", label: "HDR Exposure (EV)", type: "float", value: { kind: "float", default: 0, min: -10, max: 10, step: 0.05 } },
];

/** Inputs for one format / layer-mode configuration (mirrors the Export
 *  dialog: each format shows only its own options). */
const portsFor = memoPorts((key) => {
  const [format, mode] = key.split("|") as [ExportFormat, LayerExportMode];
  const inputs: PortDef[] = [EXEC_IN, PATH_IN];
  switch (format) {
    case "jpeg":
      inputs.push(QUALITY(DEFAULT_EXPORT_SETTINGS.jpegQuality), {
        id: "background",
        label: "Background",
        type: "color",
        value: colorSpec(1, 1, 1),
      });
      break;
    case "webp":
      inputs.push(QUALITY(DEFAULT_EXPORT_SETTINGS.webpQuality));
      break;
    case "exr":
      inputs.push(
        {
          id: "exrCompression",
          label: "Compression",
          type: "string",
          value: enumSpec("0", EXR_COMPRESSIONS.map((c) => [String(c.value), c.label])),
        },
        { id: "halfFloat", label: "Half Float (16-bit)", type: "bool", value: boolSpec(false) },
      );
      break;
    case "dds":
      inputs.push(
        {
          id: "ddsCompression",
          label: "Compression",
          type: "string",
          value: enumSpec("bc7", DDS_COMPRESSIONS.map((c) => [c.value, c.hdrOnly ? `${c.label} (float docs)` : c.label])),
        },
        { id: "mipLevels", label: "Mip Levels", type: "int", value: intSpec(1, 1, 16) },
      );
      break;
  }
  if (format !== "exr" && format !== "hdr" && format !== "tiff32") inputs.push(...TONE_MAP);
  if (mode === "separate") inputs.push({ id: "layers", label: "Layers", type: "list" });
  return { inputs, outputs: [EXEC_OUT, { id: "path", label: "Path", type: "string" }] };
});

const formatOf = (v: ParamValue): ExportFormat =>
  EXPORT_FORMATS.some((f) => f.format === v) ? (v as ExportFormat) : "png";
const modeOf = (v: ParamValue): LayerExportMode =>
  v === "multilayer" || v === "separate" ? v : "single";

/** Layer kinds the Export dialog offers for per-layer export. */
const EXPORTABLE = new Set(["pixel", "text", "shape", "path", "frame", "linked", "composite"]);

function toHex(c: readonly number[]): string {
  const h = (v: number): string => Math.round(Math.min(1, Math.max(0, v)) * 255).toString(16).padStart(2, "0");
  return `#${h(c[0] ?? 1)}${h(c[1] ?? 1)}${h(c[2] ?? 1)}`;
}

/** Writes the active document to an image file with every format option
 *  the Export dialog has (File → Export As). */
class ExportImageNode implements INode {
  readonly type = "exportImage";
  readonly label = "Export As";
  readonly category = "File";
  readonly domains = ["automation"] as const;
  readonly description =
    "Exports the active document (File → Export As). EXR / HDR / 32-bit TIFF and float DDS need an RGB/32 Float document; 8-bit formats tone map float documents as set. Separate writes one file per layer (<name>_<layer>.ext).";
  readonly width = 230;
  readonly params = [
    {
      id: "format",
      label: "Format",
      spec: enumSpec(
        "png",
        EXPORT_FORMATS.map((f) => [f.format, f.hdrOnly ? `${f.label} (float docs)` : f.label]),
      ),
    },
    {
      id: "layerMode",
      label: "Layers",
      spec: enumSpec("single", [
        ["single", "Flatten to single image"],
        ["multilayer", "Keep layers (PSD / EXR)"],
        ["separate", "Separate file per layer"],
      ]),
    },
    { id: "fixExtension", label: "Fix Extension", spec: boolSpec(true) },
    { id: "createFolder", label: "Create Folder", spec: boolSpec(true) },
  ];
  readonly inputs = portsFor("png|single").inputs;
  readonly outputs = portsFor("png|single").outputs;

  ports(params: Readonly<Record<string, ParamValue>>): NodePorts {
    return portsFor(`${formatOf(params.format)}|${modeOf(params.layerMode)}`);
  }

  async execute(ctx: ExecContext): Promise<ExecResult> {
    const format = formatOf(ctx.param("format"));
    const layerMode = modeOf(ctx.param("layerMode"));
    if (!supportsLayerMode(format, layerMode)) {
      throw new Error(
        layerMode === "multilayer"
          ? "Keeping layers needs PSD or OpenEXR"
          : `${format.toUpperCase()} can't export a file per layer`,
      );
    }
    let path = await stringInput(ctx, "path");
    if (!path) throw new Error("No export path");
    if (ctx.param("fixExtension") === true) path = applyExportExtension(path, format);
    if (ctx.param("createFolder") === true) {
      const { folder } = splitPath(path);
      if (folder) await ctx.host.makeDirectory(folder);
    }

    const settings: ExportSettings = { ...DEFAULT_EXPORT_SETTINGS, filePath: path, format, layerMode };
    if (format === "jpeg") {
      settings.jpegQuality = await numberInput(ctx, "quality");
      settings.jpegBackground = toHex(await vectorInput(ctx, "background", [1, 1, 1, 1]));
    } else if (format === "webp") {
      settings.webpQuality = await numberInput(ctx, "quality");
    } else if (format === "exr") {
      settings.exrCompression = Math.min(3, Math.max(0, Number(await stringInput(ctx, "exrCompression")) || 0)) as 0 | 1 | 2 | 3;
      settings.exrHalfFloat = (await ctx.input("halfFloat")) === true;
    } else if (format === "dds") {
      const c = await stringInput(ctx, "ddsCompression");
      settings.ddsCompression = DDS_COMPRESSIONS.some((d) => d.value === c) ? (c as DdsCompression) : "bc7";
      settings.ddsMipLevels = await numberInput(ctx, "mipLevels");
    }
    if (isLdrExport(settings) && ctx.host.document().format === "rgba32f") {
      const op = await stringInput(ctx, "toneMap");
      if (op === "clamp" || op === "reinhard") {
        settings.toneMapping = {
          operator: op as ToneMappingOperator,
          exposureEV: await numberInput(ctx, "exposure"),
        };
      }
    }
    if (layerMode === "separate") {
      let layers;
      if (ctx.isConnected("layers")) {
        const v = await ctx.input("layers");
        layers = (isList(v) ? v.items : [v]).filter(isLayerRef);
      } else {
        layers = ctx.host
          .layers({ recursive: true })
          .filter((l) => EXPORTABLE.has(ctx.host.layerProperties(l).kind));
      }
      settings.perLayerIds = layers.map((l) => l.id);
    }
    await ctx.host.exportImage(settings);
    return { outputs: { path } };
  }
}

export const exportImageNode: INode = new ExportImageNode();
