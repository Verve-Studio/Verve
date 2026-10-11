// ─── Document decoding ────────────────────────────────────────────────────────
//
// Turns `.verve` and multi-layer `.exr` file bytes into a document (layer
// state + per-layer pixels) without touching app state. Shared by File →
// Open (`useFileOps`) and cell animation frame loads (`useCellAnimation`).
// Throws an Error with a user-facing message when the file is invalid.

import { decodeExrLayers } from "@/wasm";
import {
  createLayerDataBundle,
  type LayerDataBundle,
} from "@/core/store/layerPayload";
import { decodeVerveContainer, isVerveContainer } from "@/core/io/verveContainer";
import {
  readVervePayloads,
  type SavedLayerPayloads,
} from "@/core/io/verveDocument";
import { DEFAULT_SWATCHES } from "@/core/store/tabTypes";
import type {
  BackgroundFill,
  Brush,
  LayerState,
  LinkedLayerState,
  PixelBrush,
  PixelFormat,
  RGBAColor,
  SpritesheetState,
  SwatchGroup,
} from "@/types";

export interface DecodedDocument {
  width: number;
  height: number;
  pixelFormat: PixelFormat;
  backgroundFill: BackgroundFill;
  layers: LayerState[];
  activeLayerId: string | null;
  /** Pixels for every pixel-bearing layer (and adjustment masks). */
  layerData: LayerDataBundle;
  /** Present when the file stores a palette (.verve ≥ v2). */
  swatches?: RGBAColor[];
  swatchGroups?: SwatchGroup[];
  pixelBrushes?: PixelBrush[];
  brushes?: Brush[];
  /** The saved active brush id, unvalidated (it may name a brush that no
   *  longer exists). */
  activeBrushId?: unknown;
  spritesheet?: SpritesheetState;
  iccProfile?: Uint8Array;
}

// ─── Path helpers ─────────────────────────────────────────────────────────────
// The renderer can't import `node:path`; `.verve` documents and linked
// sources come from a single OS at a time, so the separator is detected from
// the input string.

function detectSep(p: string): "\\" | "/" {
  return p.includes("\\") && !p.includes("/") ? "\\" : "/";
}

/** Strip the trailing path component (filename) and return the directory. */
export function directoryOf(p: string): string {
  const sep = detectSep(p);
  const i = p.lastIndexOf(sep);
  return i >= 0 ? p.slice(0, i) : "";
}

/** Resolve `relative` against `fromDir`, collapsing `..` and `.` segments. */
function resolveRelative(fromDir: string, relative: string): string {
  if (!fromDir) return relative;
  const sep = detectSep(fromDir);
  const parts = (fromDir + sep + relative)
    .split(/[\\/]+/)
    .filter((p) => p.length > 0 && p !== ".");
  const out: string[] = [];
  for (const part of parts) {
    if (part === "..") out.pop();
    else out.push(part);
  }
  // Preserve a leading separator on POSIX paths (lost by the split).
  const leading = fromDir.startsWith("/") ? "/" : "";
  return leading + out.join(sep);
}

// ─── Validation ───────────────────────────────────────────────────────────────

function isValidSwatchArray(val: unknown): val is RGBAColor[] {
  if (!Array.isArray(val)) return false;
  const isByte = (v: unknown): boolean =>
    Number.isInteger(v) && (v as number) >= 0 && (v as number) <= 255;
  for (const item of val) {
    if (typeof item !== "object" || item === null) return false;
    const { r, g, b, a } = item as Record<string, unknown>;
    if (!isByte(r) || !isByte(g) || !isByte(b) || !isByte(a)) return false;
  }
  return true;
}

function isValidSwatchGroupsArray(
  val: unknown,
  swatchCount: number,
): val is SwatchGroup[] {
  if (!Array.isArray(val)) return false;
  const names = new Set<string>();
  for (const item of val) {
    if (typeof item !== "object" || item === null) return false;
    const { id, name, swatchIndices } = item as Record<string, unknown>;
    if (typeof id !== "string" || id === "") return false;
    if (typeof name !== "string" || name === "") return false;
    if (names.has(name)) return false;
    names.add(name);
    if (!Array.isArray(swatchIndices)) return false;
    for (const idx of swatchIndices) {
      if (!Number.isInteger(idx) || idx < 0 || idx >= swatchCount) return false;
    }
  }
  return true;
}

// ─── .verve ───────────────────────────────────────────────────────────────────

/** Decode a `.verve` file (binary container or legacy JSON). `path` resolves
 *  linked layers' relative sources. */
export async function decodeVerveDocument(
  fileBytes: Uint8Array,
  path: string,
): Promise<DecodedDocument> {
  const container = isVerveContainer(fileBytes)
    ? decodeVerveContainer<Record<string, unknown>>(fileBytes)
    : null;
  const doc = (container
    ? container.doc
    : JSON.parse(new TextDecoder().decode(fileBytes))) as {
    version: number;
    pixelFormat?: string;
    canvas: {
      width: number;
      height: number;
      backgroundFill?: BackgroundFill;
    };
    activeLayerId: string | null;
    layers: Array<LayerState & SavedLayerPayloads>;
    swatches?: unknown;
    swatchGroups?: unknown;
    pixelBrushes?: unknown;
    brushes?: unknown;
    activeBrushId?: unknown;
    spritesheet?: unknown;
    iccProfile?: string | null;
    /** Version ≤ 6. */
    iccProfileBase64?: string | null;
  };

  // ── Legacy field migration ──────────────────────────────────────────────
  // Older .verve files (pre-EffectType rename) tagged adjustment/effect/
  // filter layers with `adjustmentType` instead of `effectType`. Copy the
  // legacy field forward in-place so downstream code only ever sees the
  // new name. Idempotent: if `effectType` is already present we leave it.
  if (Array.isArray(doc.layers)) {
    for (const rawLayer of doc.layers as unknown as Array<
      Record<string, unknown>
    >) {
      if (
        rawLayer &&
        typeof rawLayer === "object" &&
        "adjustmentType" in rawLayer
      ) {
        if (!("effectType" in rawLayer)) {
          rawLayer.effectType = rawLayer.adjustmentType;
        }
        delete rawLayer.adjustmentType;
      }
    }
  }

  let pixelFormat: PixelFormat = "rgba8";
  if (doc.version >= 5) {
    const fmt = doc.pixelFormat;
    if (fmt !== "rgba8" && fmt !== "rgba32f" && fmt !== "indexed8") {
      throw new Error(
        "This document uses an unsupported pixel format and cannot be opened.",
      );
    }
    pixelFormat = fmt;
  }
  let swatches: RGBAColor[] = DEFAULT_SWATCHES;
  if (doc.version >= 2) {
    if (!isValidSwatchArray(doc.swatches)) {
      throw new Error("The file contains invalid swatch data.");
    }
    swatches = doc.swatches;
  }
  let swatchGroups: SwatchGroup[] = [];
  if (doc.version >= 3) {
    if (!isValidSwatchGroupsArray(doc.swatchGroups, swatches.length)) {
      throw new Error("The file contains invalid swatch group data.");
    }
    swatchGroups = doc.swatchGroups;
  }

  const docDir = directoryOf(path);
  // Resolve every binary payload (blobs, or base64 / PNG in older files)
  // to typed arrays.
  const payloads = await readVervePayloads(
    doc,
    container ? container.blob : null,
    doc.canvas.width,
    doc.canvas.height,
  );
  const layers: LayerState[] = payloads.layers.map((meta) => {
    // For linked layers, prefer the relative path (resolved against the
    // document being opened) over the stale absolute path. The init hook
    // just reads `source.absolutePath`, so re-stamp it here.
    if ("type" in meta && meta.type === "linked") {
      const m = meta as unknown as LinkedLayerState;
      if (m.source && m.source.relativePath && docDir) {
        return {
          ...m,
          source: {
            ...m.source,
            absolutePath: resolveRelative(docDir, m.source.relativePath),
          },
        } as LayerState;
      }
    }
    return meta as LayerState;
  });

  return {
    width: doc.canvas.width,
    height: doc.canvas.height,
    pixelFormat,
    backgroundFill: doc.canvas.backgroundFill ?? "transparent",
    layers,
    activeLayerId: doc.activeLayerId ?? layers[0]?.id ?? null,
    layerData: payloads.data,
    swatches,
    swatchGroups,
    pixelBrushes: doc.version >= 4 ? payloads.pixelBrushes : [],
    brushes: payloads.brushes,
    activeBrushId: doc.activeBrushId,
    spritesheet:
      doc.version >= 6 && doc.spritesheet && typeof doc.spritesheet === "object"
        ? (doc.spritesheet as SpritesheetState)
        : undefined,
    iccProfile: payloads.iccProfile,
  };
}

// ─── .exr ─────────────────────────────────────────────────────────────────────

/** Decode an OpenEXR file into an rgba32f document, one layer per EXR layer
 *  (a plain RGBA file gives one layer). */
export async function decodeExrDocument(
  bytes: Uint8Array,
): Promise<DecodedDocument> {
  const exr = await decodeExrLayers(bytes);
  const layerData = createLayerDataBundle();
  const layers: LayerState[] = [];
  // Track names already used so we can disambiguate duplicates.
  const seenNames = new Map<string, number>();
  exr.layers.forEach((L, i) => {
    const layerId = `layer-${i}`;
    let name = L.name.trim() || (exr.layers.length === 1 ? "Background" : `Layer ${i + 1}`);
    const n = seenNames.get(name) ?? 0;
    if (n > 0) name = `${name} (${n + 1})`;
    seenNames.set(name, n + 1);
    layerData.layers.set(layerId, {
      format: "rgba32f",
      data: L.pixels,
      geo: {
        layerWidth: L.width,
        layerHeight: L.height,
        offsetX: L.offsetX,
        offsetY: L.offsetY,
      },
    });
    layers.push({
      id: layerId,
      name,
      visible: true,
      opacity: 1,
      locked: false,
      blendMode: "normal",
    });
  });
  if (layers.length === 0) throw new Error("The EXR file has no image layers.");
  return {
    width: exr.canvasWidth,
    height: exr.canvasHeight,
    pixelFormat: "rgba32f",
    backgroundFill: "transparent",
    layers,
    activeLayerId: layers[layers.length - 1]?.id ?? null,
    layerData,
  };
}
