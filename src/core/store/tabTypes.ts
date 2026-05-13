import type { DocumentScope } from "@/core/store/scope";
import type {
  LayerState,
  BackgroundFill,
  RGBAColor,
  SwatchGroup,
  PixelBrush,
  Brush,
  PixelFormat,
  ToneMappingOperator,
  SpritesheetState,
  PaletteAnimationState,
} from "@/types";

// ─── Default swatch palette ───────────────────────────────────────────────────

export const DEFAULT_SWATCHES: RGBAColor[] = [
  { r: 0, g: 0, b: 0, a: 255 },
  { r: 255, g: 255, b: 255, a: 255 },
  { r: 192, g: 192, b: 192, a: 255 },
  { r: 128, g: 128, b: 128, a: 255 },
  { r: 255, g: 0, b: 0, a: 255 },
  { r: 128, g: 0, b: 0, a: 255 },
  { r: 255, g: 255, b: 0, a: 255 },
  { r: 128, g: 128, b: 0, a: 255 },
  { r: 0, g: 255, b: 0, a: 255 },
  { r: 0, g: 128, b: 0, a: 255 },
  { r: 0, g: 255, b: 255, a: 255 },
  { r: 0, g: 128, b: 128, a: 255 },
  { r: 0, g: 0, b: 255, a: 255 },
  { r: 0, g: 0, b: 128, a: 255 },
  { r: 255, g: 0, b: 255, a: 255 },
  { r: 128, g: 0, b: 128, a: 255 },
  { r: 255, g: 128, b: 0, a: 255 },
  { r: 255, g: 200, b: 150, a: 255 },
];

// ─── Tab snapshot ─────────────────────────────────────────────────────────────

export interface TabSnapshot {
  canvasWidth: number;
  canvasHeight: number;
  backgroundFill: BackgroundFill;
  layers: LayerState[];
  activeLayerId: string | null;
  zoom: number;
  swatches: RGBAColor[];
  swatchGroups: SwatchGroup[];
  /** Pixel brushes stored with this document. */
  pixelBrushes: PixelBrush[];
  /** Paint brushes stored with this document. */
  brushes?: Brush[];
  /** Currently selected paint brush id (looked up first in document, then user store). */
  activeBrushId?: string | null;
  pixelFormat: PixelFormat;
  spritesheet?: SpritesheetState;
  paletteAnimation?: PaletteAnimationState;
  /** Raw ICC profile bytes carried with the document. Travels through tab
   *  switches and document re-opens; serialized to disk when the document
   *  itself is saved (PNG/JPEG/TIFF embed it as part of export). */
  iccProfile?: Uint8Array;
}

// ─── Tab record ───────────────────────────────────────────────────────────────

export interface TabRecord {
  id: string;
  title: string;
  filePath: string | null;
  snapshot: TabSnapshot;
  /** Pixel data for each layer — null while tab is active (data lives in WebGL) */
  savedLayerData: Map<string, string> | null;
  /**
   * Per-document store bundle (selection, history, crop, transform, …).
   * Each tab owns its own instance; switching tabs calls `setActiveScope`
   * on this object — no copying or restore-from-snapshot dance.
   */
  scope: DocumentScope;
  /** Incremented to force this tab's Canvas to remount (resize / crop). */
  canvasKey: number;
  /** Session-only: tiled mode toggle for this tab. Not persisted to document. */
  tiledMode: boolean;
  /** Session-only: tile grid overlay visibility for this tab. Not persisted. */
  showTileGrid: boolean;
  pixelFormat: PixelFormat;
  /** Session-only: HDR display exposure (EV stops) for this tab. Not persisted. */
  exposureEV: number;
  /** Session-only: tone-mapping operator for this tab. Not persisted. */
  toneMappingOperator: ToneMappingOperator;
  /** Session-only: id (in `lutStore`) of the active view-transform LUT for
   *  this tab, or `null` for none. The view transform is canvas-only — it
   *  affects on-screen display, never exports — so it lives on the tab
   *  record alongside exposure / tone-map settings rather than in document
   *  state. Not persisted to disk. */
  viewTransformLutId: string | null;
  /** Session-only: whether this tab is in animation mode. Not persisted. */
  animationMode: boolean;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

export function makeTabId(): string {
  return `tab-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

export function fileTitle(p: string): string {
  return p.split(/[\\/]/).pop() ?? "Untitled";
}

export const INITIAL_SNAPSHOT: TabSnapshot = {
  canvasWidth: 512,
  canvasHeight: 512,
  backgroundFill: "white",
  layers: [
    {
      id: "layer-0",
      name: "Background",
      visible: true,
      opacity: 1,
      locked: false,
      blendMode: "normal",
    },
  ],
  activeLayerId: "layer-0",
  zoom: 1,
  swatches: DEFAULT_SWATCHES,
  swatchGroups: [],
  pixelBrushes: [],
  brushes: [],
  activeBrushId: null,
  pixelFormat: "rgba8",
};
