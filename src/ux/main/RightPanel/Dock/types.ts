export type PanelId = 'Color' | 'Swatches' | 'Navigator' | 'Layers' | 'History' | 'Info'

export const ALL_PANEL_IDS: readonly PanelId[] = [
  'Color', 'Swatches', 'Navigator', 'Layers', 'History', 'Info',
] as const

export const PANEL_LABELS: Record<PanelId, string> = {
  Color: 'Color',
  Swatches: 'Swatches',
  Navigator: 'Navigator',
  Layers: 'Layers',
  History: 'History',
  Info: 'Info',
}

export interface DockRowConfig {
  id: string
  panels: PanelId[]
  activePanel: PanelId
  /** Fixed height in px. null = flex (takes remaining space — only the last row). */
  height: number | null
}

export interface FloatingWindow {
  id: string
  panelId: PanelId
  x: number
  y: number
  width: number
  height: number
}

export interface DockLayout {
  rows: DockRowConfig[]
  closedPanels: PanelId[]
  floatingWindows: FloatingWindow[]
}

export const DEFAULT_LAYOUT: DockLayout = {
  rows: [
    { id: 'row-color',  panels: ['Color', 'Swatches', 'Navigator'], activePanel: 'Color',  height: 280 },
    { id: 'row-layers', panels: ['Layers', 'History', 'Info'],       activePanel: 'Layers', height: null },
  ],
  closedPanels: [],
  floatingWindows: [],
}
