export type PanelId =
  | "Color"
  | "Swatches"
  | "Navigator"
  | "Layers"
  | "History"
  | "Info"
  | "Display";

export const ALL_PANEL_IDS: readonly PanelId[] = [
  "Color",
  "Swatches",
  "Navigator",
  "Layers",
  "History",
  "Info",
  "Display",
] as const;

export const PANEL_LABELS: Record<PanelId, string> = {
  Color: "Color",
  Swatches: "Swatches",
  Navigator: "Navigator",
  Layers: "Layers",
  History: "History",
  Info: "Info",
  Display: "Display",
};

export interface DockRowConfig {
  id: string;
  panels: PanelId[];
  activePanel: PanelId;
  /** Fixed height in px. null = flex (takes remaining space — only the last row). */
  height: number | null;
}

export interface FloatingWindow {
  id: string;
  panelId: PanelId;
  x: number;
  y: number;
  width: number;
  height: number;
}

/** The node editor docked under the canvas. `open` is session-only: the
 *  editor always starts closed (see `dockStore._migrate`). */
export interface BottomPanelConfig {
  open: boolean;
  /** Height in px. */
  height: number;
}

export interface DockLayout {
  rows: DockRowConfig[];
  closedPanels: PanelId[];
  floatingWindows: FloatingWindow[];
  nodeEditor: BottomPanelConfig;
}

export const DEFAULT_LAYOUT: DockLayout = {
  rows: [
    {
      id: "row-color",
      panels: ["Color", "Swatches", "Navigator"],
      activePanel: "Color",
      height: 280,
    },
    {
      id: "row-layers",
      panels: ["Layers", "History", "Info"],
      activePanel: "Layers",
      height: null,
    },
  ],
  closedPanels: ["Display"],
  floatingWindows: [],
  nodeEditor: { open: false, height: 320 },
};
