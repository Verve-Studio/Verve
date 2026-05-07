import type {
  DockLayout,
  PanelId,
  DockRowConfig,
  FloatingWindow,
} from "./types";
import { DEFAULT_LAYOUT, ALL_PANEL_IDS } from "./types";

// ─── Save debounce ────────────────────────────────────────────────────────────

let _saveTimer: ReturnType<typeof setTimeout> | null = null;

function scheduleSave(layout: DockLayout): void {
  if (_saveTimer !== null) clearTimeout(_saveTimer);
  _saveTimer = setTimeout(() => {
    void window.api.saveDockLayout(layout);
    _saveTimer = null;
  }, 400);
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function removeFromRow(
  layout: DockLayout,
  panelId: PanelId,
  sourceRowId: string,
): DockLayout {
  return {
    ...layout,
    rows: layout.rows
      .map((r) => {
        if (r.id !== sourceRowId) return r;
        const panels = r.panels.filter((p) => p !== panelId);
        const activePanel = panels.includes(r.activePanel)
          ? r.activePanel
          : (panels[0] ?? r.activePanel);
        return { ...r, panels, activePanel };
      })
      .filter((r) => r.panels.length > 0),
  };
}

function findRowContaining(
  layout: DockLayout,
  panelId: PanelId,
): DockRowConfig | undefined {
  return layout.rows.find((r) => r.panels.includes(panelId));
}

// ─── DockStore ────────────────────────────────────────────────────────────────

type Listener = () => void;

class DockStore {
  private _layout: DockLayout = DEFAULT_LAYOUT;
  private _listeners = new Set<Listener>();
  private _loaded = false;

  // ── Subscriptions ────────────────────────────────────────────────────────────

  subscribe(fn: Listener): () => void {
    this._listeners.add(fn);
    return () => this._listeners.delete(fn);
  }

  getSnapshot(): DockLayout {
    return this._layout;
  }

  private _emit(): void {
    this._listeners.forEach((fn) => fn());
  }

  private _set(next: DockLayout, save = true): void {
    this._layout = next;
    this._emit();
    if (save && this._loaded) scheduleSave(next);
  }

  // ── Lifecycle ─────────────────────────────────────────────────────────────────

  async load(): Promise<void> {
    try {
      const raw = await window.api.loadDockLayout();
      if (raw && typeof raw === "object") {
        this._layout = this._migrate(raw as Partial<DockLayout>);
        this._emit();
      }
    } catch {
      /* ignore */
    }
    this._loaded = true;
  }

  private _migrate(raw: Partial<DockLayout>): DockLayout {
    const known = new Set<string>(ALL_PANEL_IDS);

    const rows: DockRowConfig[] = (raw.rows ?? [])
      .map((r) => {
        const panels = (r.panels ?? []).filter((p): p is PanelId =>
          known.has(p),
        );
        const activePanel: PanelId = known.has(r.activePanel as string)
          ? (r.activePanel as PanelId)
          : (panels[0] ?? "Layers");
        return {
          id:
            typeof r.id === "string" && r.id
              ? r.id
              : `row-${Math.random().toString(36).slice(2)}`,
          panels,
          activePanel,
          height: typeof r.height === "number" ? r.height : null,
        };
      })
      .filter((r) => r.panels.length > 0);

    const closedPanels: PanelId[] = (raw.closedPanels ?? []).filter(
      (p): p is PanelId => known.has(p),
    );

    const floatingWindows: FloatingWindow[] = (
      (raw as Partial<DockLayout>).floatingWindows ?? []
    ).filter(
      (w): w is FloatingWindow =>
        typeof w === "object" &&
        w !== null &&
        typeof w.id === "string" &&
        known.has((w as FloatingWindow).panelId),
    );

    // Ensure every panel is either in a row, floating, or in closedPanels
    const placed = new Set<string>([
      ...rows.flatMap((r) => r.panels),
      ...floatingWindows.map((w) => w.panelId),
    ]);
    for (const id of ALL_PANEL_IDS) {
      if (!placed.has(id) && !closedPanels.includes(id)) {
        if (rows.length > 0) {
          rows[rows.length - 1].panels.push(id);
        } else {
          closedPanels.push(id);
        }
      }
    }

    return rows.length > 0 || floatingWindows.length > 0
      ? { rows, closedPanels, floatingWindows }
      : DEFAULT_LAYOUT;
  }

  // ── Actions ───────────────────────────────────────────────────────────────────

  setActivePanel(rowId: string, panelId: PanelId): void {
    this._set({
      ...this._layout,
      rows: this._layout.rows.map((r) =>
        r.id === rowId ? { ...r, activePanel: panelId } : r,
      ),
    });
  }

  reorderTab(rowId: string, fromIndex: number, toIndex: number): void {
    this._set({
      ...this._layout,
      rows: this._layout.rows.map((r) => {
        if (r.id !== rowId) return r;
        const panels = [...r.panels];
        const [moved] = panels.splice(fromIndex, 1);
        panels.splice(toIndex, 0, moved);
        return { ...r, panels };
      }),
    });
  }

  moveToRow(
    panelId: PanelId,
    sourceRowId: string,
    targetRowId: string,
    insertAt: number,
  ): void {
    if (sourceRowId === targetRowId) {
      const row = this._layout.rows.find((r) => r.id === sourceRowId);
      if (!row) return;
      const fromIndex = row.panels.indexOf(panelId);
      if (fromIndex === -1) return;
      this.reorderTab(sourceRowId, fromIndex, insertAt);
      return;
    }
    let next = removeFromRow(this._layout, panelId, sourceRowId);
    next = {
      ...next,
      rows: next.rows.map((r) => {
        if (r.id !== targetRowId) return r;
        const panels = [...r.panels.filter((p) => p !== panelId)];
        panels.splice(Math.min(insertAt, panels.length), 0, panelId);
        return { ...r, panels, activePanel: panelId };
      }),
    };
    this._set(next);
  }

  /** Insert panelId into a brand-new row, positioned after afterRowId (or at top if null). */
  splitToNewRow(
    panelId: PanelId,
    sourceRowId: string,
    afterRowId: string | null,
  ): void {
    let next = removeFromRow(this._layout, panelId, sourceRowId);
    const newRow: DockRowConfig = {
      id: `row-${Date.now()}`,
      panels: [panelId],
      activePanel: panelId,
      height: 200,
    };
    if (afterRowId === null) {
      next = { ...next, rows: [newRow, ...next.rows] };
    } else {
      const idx = next.rows.findIndex((r) => r.id === afterRowId);
      const insertIdx = idx === -1 ? next.rows.length : idx + 1;
      next = {
        ...next,
        rows: [
          ...next.rows.slice(0, insertIdx),
          newRow,
          ...next.rows.slice(insertIdx),
        ],
      };
    }
    this._set(next);
  }

  closePanel(panelId: PanelId): void {
    const sourceRow = findRowContaining(this._layout, panelId);
    let next = sourceRow
      ? removeFromRow(this._layout, panelId, sourceRow.id)
      : this._layout;
    // Also remove from floating windows
    next = {
      ...next,
      floatingWindows: next.floatingWindows.filter(
        (w) => w.panelId !== panelId,
      ),
      closedPanels: [
        ...next.closedPanels.filter((p) => p !== panelId),
        panelId,
      ],
    };
    this._set(next);
  }

  openPanel(panelId: PanelId): void {
    // Remove from closedPanels, add to the last row
    const rows = this._layout.rows;
    if (rows.length === 0) {
      this._set({
        ...this._layout,
        rows: [
          {
            id: `row-${Date.now()}`,
            panels: [panelId],
            activePanel: panelId,
            height: null,
          },
        ],
        closedPanels: this._layout.closedPanels.filter((p) => p !== panelId),
      });
      return;
    }
    const lastRow = rows[rows.length - 1];
    this._set({
      ...this._layout,
      rows: rows.map((r) =>
        r.id === lastRow.id
          ? {
              ...r,
              panels: [...r.panels.filter((p) => p !== panelId), panelId],
              activePanel: panelId,
            }
          : r,
      ),
      closedPanels: this._layout.closedPanels.filter((p) => p !== panelId),
    });
  }

  tearOffPanel(
    panelId: PanelId,
    sourceRowId: string,
    x: number,
    y: number,
  ): void {
    let next = removeFromRow(this._layout, panelId, sourceRowId);
    const win: FloatingWindow = {
      id: `fw-${Date.now()}`,
      panelId,
      x: Math.max(0, x),
      y: Math.max(0, y),
      width: 280,
      height: 400,
    };
    next = {
      ...next,
      floatingWindows: [...next.floatingWindows, win],
    };
    this._set(next);
  }

  dockFloatingWindow(windowId: string): void {
    const win = this._layout.floatingWindows.find((w) => w.id === windowId);
    if (!win) return;
    let next: DockLayout = {
      ...this._layout,
      floatingWindows: this._layout.floatingWindows.filter(
        (w) => w.id !== windowId,
      ),
    };
    const rows = next.rows;
    if (rows.length === 0) {
      next = {
        ...next,
        rows: [
          {
            id: `row-${Date.now()}`,
            panels: [win.panelId],
            activePanel: win.panelId,
            height: null,
          },
        ],
      };
    } else {
      const lastRow = rows[rows.length - 1];
      next = {
        ...next,
        rows: rows.map((r) =>
          r.id === lastRow.id
            ? {
                ...r,
                panels: [
                  ...r.panels.filter((p) => p !== win.panelId),
                  win.panelId,
                ],
                activePanel: win.panelId,
              }
            : r,
        ),
      };
    }
    this._set(next);
  }

  moveFloatingWindow(windowId: string, x: number, y: number): void {
    this._set({
      ...this._layout,
      floatingWindows: this._layout.floatingWindows.map((w) =>
        w.id === windowId ? { ...w, x, y } : w,
      ),
    });
  }

  resizeFloatingWindow(windowId: string, width: number, height: number): void {
    this._set({
      ...this._layout,
      floatingWindows: this._layout.floatingWindows.map((w) =>
        w.id === windowId ? { ...w, width, height } : w,
      ),
    });
  }

  resetLayout(): void {
    this._set({ ...DEFAULT_LAYOUT });
  }

  togglePanel(panelId: PanelId): void {
    const isOpen =
      this._layout.rows.some((r) => r.panels.includes(panelId)) ||
      this._layout.floatingWindows.some((w) => w.panelId === panelId);
    if (isOpen) {
      this.closePanel(panelId);
    } else {
      this.openPanel(panelId);
    }
  }

  /** Update height live (called during resize drag) — debounced save. */
  setRowHeight(rowId: string, height: number): void {
    this._set({
      ...this._layout,
      rows: this._layout.rows.map((r) =>
        r.id === rowId ? { ...r, height } : r,
      ),
    });
  }

  get openPanelIds(): PanelId[] {
    const inRows = new Set<PanelId>(this._layout.rows.flatMap((r) => r.panels));
    const floating = new Set<PanelId>(
      this._layout.floatingWindows.map((w) => w.panelId),
    );
    return ALL_PANEL_IDS.filter((id) => inRows.has(id) || floating.has(id));
  }
}

export const dockStore = new DockStore();
