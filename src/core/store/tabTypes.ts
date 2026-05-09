import type { HistoryEntry } from "@/core/store/historyStore";
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
}

// ─── Tab record ───────────────────────────────────────────────────────────────

export interface TabRecord {
  id: string;
  title: string;
  filePath: string | null;
  snapshot: TabSnapshot;
  /** Pixel data for each layer — null while tab is active (data lives in WebGL) */
  savedLayerData: Map<string, string> | null;
  /** History stack — null while tab is active (historyStore holds the live data) */
  savedHistory: { entries: HistoryEntry[]; currentIndex: number } | null;
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
