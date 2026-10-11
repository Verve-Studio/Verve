/**
 * The application surface automation workflows drive.
 *
 * Nodes depend only on this interface (inversion of control): the app
 * implements it once (`useAutomationHost`) on top of the same commands its
 * menus, dialogs and panels use, and registers the implementation with
 * `automationHostProvider`. Every method acts on the active document unless
 * it takes a document; a `LayerRef` from another document makes that
 * document active first. Methods throw on failure (shown on the node).
 */
import type { ExportSettings } from "@/core/io/exportSettings";
import type { BackgroundFill, BlendMode, LayerColorSpace, PixelFormat } from "@/types";
import type { DocumentRef, LayerRef } from "./values";

export interface DocumentInfo {
  readonly name: string;
  readonly width: number;
  readonly height: number;
  /** "rgba8" | "rgba32f" | "indexed8". */
  readonly format: string;
  /** Saved file, or "" for unsaved / imported documents. */
  readonly path: string;
  readonly dirty: boolean;
}

export type LayerKind =
  | "pixel"
  | "text"
  | "shape"
  | "path"
  | "frame"
  | "linked"
  | "group"
  | "composite"
  | "mask"
  | "effect";

export interface LayerProperties {
  readonly name: string;
  readonly kind: LayerKind;
  readonly visible: boolean;
  readonly opacity: number;
  readonly blendMode: string;
  readonly locked: boolean;
  /** Top-left on the canvas and size, in pixels (0 for groups / effects). */
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  /** Effect layers: the effect id (e.g. "gaussian-blur"), else "". */
  readonly effectType: string;
}

export interface LayerQuery {
  visibleOnly?: boolean;
  /** Include layers inside groups (depth-first, top to bottom). */
  recursive?: boolean;
  /** Include masks and effect layers. */
  attachments?: boolean;
}

export interface LayerPropertyPatch {
  name?: string;
  visible?: boolean;
  opacity?: number;
  blendMode?: BlendMode;
  locked?: boolean;
  colorSpace?: LayerColorSpace;
}

export type ImageResample = "bilinear" | "nearest";
export type RotateAmount = "90cw" | "180" | "270cw";
export type FlipAxis = "horizontal" | "vertical";
export type ArrangeOp = "front" | "back" | "forward" | "backward" | "reverse";
export type AlignEdge = "left" | "centerV" | "right" | "top" | "centerH" | "bottom";
export type SelectionMode = "set" | "add" | "subtract" | "intersect";

export interface FsEntry {
  readonly path: string;
  readonly name: string;
  readonly isDirectory: boolean;
  readonly size: number;
  readonly modified: number;
}

export interface FsStat {
  readonly exists: boolean;
  readonly isDirectory: boolean;
  readonly isFile: boolean;
  readonly size: number;
  readonly modified: number;
  readonly created: number;
}

export interface AddEffectOptions {
  /** A layer, or the whole image: all top-level layers are wrapped in a
   *  composite ("Image") that the effect is attached to. */
  target: LayerRef | "image";
  /** Registered effect id. */
  effectType: string;
  /** Param values by `paramFields` id (missing → effect defaults). */
  values: Readonly<Record<string, unknown>>;
  /** Raw params merged over the defaults before `values` (custom effects). */
  baseParams?: Readonly<Record<string, unknown>>;
  name?: string;
  /** Bake the effect into the pixels (rasterize) instead of keeping a
   *  non-destructive effect layer. */
  bake: boolean;
  /** Limit the effect to the current selection. */
  useSelection: boolean;
}

export interface AutomationHost {
  log(message: string): void;

  // ── Documents ────────────────────────────────────────────────────────────
  activeDocument(): DocumentRef | null;
  documents(): DocumentRef[];
  activateDocument(doc: DocumentRef): Promise<void>;
  document(): DocumentInfo;
  newDocument(settings: {
    name?: string;
    width: number;
    height: number;
    pixelFormat: PixelFormat;
    background: BackgroundFill;
  }): Promise<DocumentRef>;
  /** Any supported file (.verve, .psd, images); becomes active. */
  openDocument(path: string): Promise<DocumentRef>;
  /** Close without saving. */
  closeDocument(doc: DocumentRef): Promise<void>;
  /** Save the active document as .verve (to `path`, or its current file). */
  saveDocument(path?: string, asCopy?: boolean): Promise<void>;
  exportImage(settings: ExportSettings): Promise<void>;

  // ── Files ────────────────────────────────────────────────────────────────
  listDirectory(path: string, options: { recursive: boolean; files: boolean; folders: boolean }): Promise<FsEntry[]>;
  statPath(path: string): Promise<FsStat>;
  makeDirectory(path: string): Promise<void>;
  /** Image file extensions the app can open (lower-case, no dot). */
  supportedImageExtensions(): readonly string[];

  // ── Image ────────────────────────────────────────────────────────────────
  resizeImage(width: number, height: number, resample: ImageResample): Promise<void>;
  resizeCanvas(width: number, height: number, anchor: { col: 0 | 1 | 2; row: 0 | 1 | 2 }): Promise<void>;
  cropImage(rect: { x: number; y: number; width: number; height: number }): Promise<void>;
  /** Crop to the bounds of the visible, non-transparent pixels. */
  trimImage(): Promise<void>;
  rotateImage(amount: RotateAmount): Promise<void>;
  flipImage(axis: FlipAxis): Promise<void>;
  convertColorMode(format: PixelFormat, sourceColorSpace?: LayerColorSpace): Promise<void>;
  upscaleModels(): Promise<{ id: string; label: string }[]>;
  /** AI rescale (rgba8 documents). */
  rescaleImage(width: number, height: number, modelId: string): Promise<void>;
  /** AI restore (rgba8 documents). */
  restoreImage(modelId: string): Promise<void>;

  // ── Layers ───────────────────────────────────────────────────────────────
  activeLayer(): LayerRef | null;
  setActiveLayer(layer: LayerRef): Promise<void>;
  selectLayers(layers: readonly LayerRef[]): Promise<void>;
  /** Select → All Layers / Deselect Layers. */
  selectAllLayers(): Promise<void>;
  deselectLayers(): Promise<void>;
  /** Top to bottom. */
  layers(query: LayerQuery): LayerRef[];
  layerProperties(layer: LayerRef): LayerProperties;
  /** Direct children (groups), or attached masks / effects (leaves). */
  layerChildren(layer: LayerRef): LayerRef[];
  /** Owning group, or the layer an effect / mask is attached to. */
  layerParent(layer: LayerRef): LayerRef | null;
  newLayer(options: { name?: string; above?: LayerRef | null }): Promise<LayerRef>;
  newGroup(options: { name?: string; kind: "group" | "composite"; above?: LayerRef | null }): Promise<LayerRef>;
  duplicateLayer(layer: LayerRef, name?: string): Promise<LayerRef>;
  deleteLayer(layer: LayerRef): Promise<void>;
  setLayerProperties(layer: LayerRef, patch: LayerPropertyPatch): Promise<LayerRef>;
  /** Move pixel content: to (x, y), or by (x, y) when `relative`. */
  moveLayer(layer: LayerRef, x: number, y: number, relative: boolean): Promise<void>;
  arrangeLayers(layers: readonly LayerRef[], op: ArrangeOp): Promise<void>;
  /** Move into `group` at `index` (0 = bottom, -1 = top), or out to the top level. */
  moveLayerToGroup(layer: LayerRef, group: LayerRef | null, index: number): Promise<void>;
  groupLayers(layers: readonly LayerRef[], options: { name?: string; kind: "group" | "composite" }): Promise<LayerRef>;
  ungroupLayers(group: LayerRef): Promise<void>;
  mergeLayers(layers: readonly LayerRef[]): Promise<LayerRef>;
  mergeDown(layer: LayerRef): Promise<LayerRef>;
  mergeVisible(): Promise<LayerRef>;
  mergeGroup(group: LayerRef): Promise<LayerRef>;
  flattenImage(): Promise<LayerRef>;
  rasterizeLayer(layer: LayerRef): Promise<LayerRef>;
  addLayerMask(layer: LayerRef, fromSelection: boolean): Promise<LayerRef>;
  alignLayers(layers: readonly LayerRef[], edge: AlignEdge): Promise<void>;
  distributeLayers(layers: readonly LayerRef[], axis: FlipAxis): Promise<void>;
  rotateLayers(layers: readonly LayerRef[], amount: RotateAmount): Promise<void>;
  flipLayers(layers: readonly LayerRef[], axis: FlipAxis): Promise<void>;
  importImageAsLayer(path: string, options: { name?: string; above?: LayerRef | null; position?: { x: number; y: number } }): Promise<LayerRef>;
  newLinkedLayer(path: string, name?: string): Promise<LayerRef>;
  refreshLinkedLayer(layer: LayerRef): Promise<void>;
  /** Fill the layer (inside the selection, if any) with an sRGB 0–1 colour. */
  fillLayer(layer: LayerRef, color: readonly number[]): Promise<void>;
  /** Erase the layer's pixels inside the selection (Edit → Delete). */
  clearLayer(layer: LayerRef): Promise<void>;

  // ── Effects ──────────────────────────────────────────────────────────────
  /** Returns the effect layer, or the baked pixel layer when `bake`. */
  addEffect(options: AddEffectOptions): Promise<LayerRef>;
  /** A custom (.effect) shader effect by its menu name or file path. */
  loadCustomEffect(nameOrPath: string): Promise<{ name: string; graph: unknown; path: string | null }>;
  /** Change an existing effect layer's params (by `paramFields` id). */
  setEffectValues(effect: LayerRef, values: Readonly<Record<string, unknown>>): Promise<void>;

  // ── Selection ────────────────────────────────────────────────────────────
  selectAll(): Promise<void>;
  deselect(): Promise<void>;
  invertSelection(): Promise<void>;
  selectRect(rect: { x: number; y: number; width: number; height: number }, mode: SelectionMode, feather: number): Promise<void>;
  /** Select the layer's opaque pixels (alpha → selection strength). */
  selectLayerAlpha(layer: LayerRef, mode: SelectionMode): Promise<void>;
  hasSelection(): boolean;
  /** Selection bounds, or null when nothing is selected. */
  selectionBounds(): { x: number; y: number; width: number; height: number } | null;

  // ── Edit ─────────────────────────────────────────────────────────────────
  copy(layer: LayerRef, merged: boolean): Promise<void>;
  cut(layer: LayerRef): Promise<void>;
  /** Paste the clipboard image as a new layer. */
  paste(): Promise<LayerRef>;
  /** Paste as a new layer masked by the selection (Edit → Paste Into). */
  pasteInto(): Promise<LayerRef>;
  /** Content-aware fill / delete inside the selection on the layer. */
  contentAwareFill(layer: LayerRef, mode: "fill" | "delete", samplingRadius: number): Promise<void>;
}
