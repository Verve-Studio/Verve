import React, { useState, useRef } from "react";
import type { PanelId } from "./types";
import { dockStore } from "./dockStore";
import { useDockLayout } from "./useDockLayout";
import { DockRow } from "./DockRow";
import { ToolWindow } from "./ToolWindow";
import styles from "./Dock.module.scss";

interface DockProps {
  renderPanel: (panelId: PanelId) => React.ReactNode;
}

export function Dock({ renderPanel }: DockProps): React.JSX.Element {
  const layout = useDockLayout();
  const [isDragging, setIsDragging] = useState(false);
  const [bottomZoneDragOver, setBottomZoneDragOver] = useState(false);

  // Module-level drag state (refs so handlers always see latest values)
  const dragPanelRef = useRef<PanelId | null>(null);
  const dragSourceRowRef = useRef<string | null>(null);
  const dockRef = useRef<HTMLDivElement>(null);

  // ── Drag start ─────────────────────────────────────────────────────────────

  function handleTabDragStart(
    panelId: PanelId,
    _tabIndex: number,
    rowId: string,
  ) {
    dragPanelRef.current = panelId;
    dragSourceRowRef.current = rowId;
    setIsDragging(true);
  }

  // ── Drop on an existing row's tab bar ──────────────────────────────────────

  function handleDropOnRow(targetRowId: string, insertAt: number) {
    const panelId = dragPanelRef.current;
    const sourceRowId = dragSourceRowRef.current;
    if (!panelId || !sourceRowId) return;
    dockStore.moveToRow(panelId, sourceRowId, targetRowId, insertAt);
    endDrag();
  }

  // ── Drop on a drop zone (create new row) ───────────────────────────────────

  function handleDropZone(afterRowId: string | null) {
    const panelId = dragPanelRef.current;
    const sourceRowId = dragSourceRowRef.current;
    if (!panelId || !sourceRowId) return;
    // Only split if not dropping into a zone that would put panel in same row alone
    // (no-op if source row only has one panel and it's the same position)
    dockStore.splitToNewRow(panelId, sourceRowId, afterRowId);
    endDrag();
  }

  // ── Bottom drop zone ───────────────────────────────────────────────────────

  function handleBottomZoneDragOver(e: React.DragEvent) {
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    setBottomZoneDragOver(true);
  }

  function handleBottomZoneDrop(e: React.DragEvent) {
    e.preventDefault();
    setBottomZoneDragOver(false);
    const lastRow = layout.rows[layout.rows.length - 1];
    handleDropZone(lastRow?.id ?? null);
  }

  // ── End drag ───────────────────────────────────────────────────────────────

  function endDrag() {
    dragPanelRef.current = null;
    dragSourceRowRef.current = null;
    setIsDragging(false);
    setBottomZoneDragOver(false);
  }

  // Use a capture-phase dragend on the container to always reset state
  function handleContainerDragEnd(e: React.DragEvent) {
    const panelId = dragPanelRef.current;
    const sourceRowId = dragSourceRowRef.current;
    if (panelId && sourceRowId && dockRef.current) {
      const rect = dockRef.current.getBoundingClientRect();
      const outside =
        e.clientX < rect.left - 20 ||
        e.clientX > rect.right + 20 ||
        e.clientY < rect.top - 20 ||
        e.clientY > rect.bottom + 20;
      if (outside) {
        dockStore.tearOffPanel(
          panelId,
          sourceRowId,
          e.clientX - 140,
          e.clientY - 13,
        );
        endDrag();
        return;
      }
    }
    endDrag();
  }

  return (
    <div
      ref={dockRef}
      className={styles.dock}
      onDragEnd={handleContainerDragEnd}
    >
      {layout.rows.map((row, idx) => (
        <DockRow
          key={row.id}
          row={row}
          isLast={idx === layout.rows.length - 1}
          isDragging={isDragging}
          dragPanelId={dragPanelRef.current}
          renderPanel={renderPanel}
          onTabDragStart={handleTabDragStart}
          onDropOnRow={handleDropOnRow}
          onDropZone={handleDropZone}
          prevRowId={idx > 0 ? layout.rows[idx - 1].id : null}
        />
      ))}

      {/* Bottom drop zone — create a new row below all existing rows */}
      {isDragging && (
        <div
          className={[
            styles.bottomDropZone,
            bottomZoneDragOver ? styles.bottomDropZoneActive : "",
          ].join(" ")}
          onDragOver={handleBottomZoneDragOver}
          onDragLeave={() => setBottomZoneDragOver(false)}
          onDrop={handleBottomZoneDrop}
        />
      )}

      {/* Floating ToolWindows — rendered via portals to document.body */}
      {layout.floatingWindows.map((win) => (
        <ToolWindow key={win.id} win={win} renderPanel={renderPanel} />
      ))}
    </div>
  );
}
