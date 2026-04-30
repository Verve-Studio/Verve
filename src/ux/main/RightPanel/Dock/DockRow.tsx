import React, { useRef } from 'react'
import type { DockRowConfig, PanelId } from './types'
import { dockStore } from './dockStore'
import styles from './DockRow.module.scss'

interface DockRowProps {
  row: DockRowConfig
  isLast: boolean
  isDragging: boolean
  dragPanelId: PanelId | null
  renderPanel: (panelId: PanelId) => React.ReactNode
  /** Called when drag starts on a tab in this row. */
  onTabDragStart: (panelId: PanelId, tabIndex: number, rowId: string) => void
  /** Drop on this row's tab bar: move dragged panel here at the given index. */
  onDropOnRow: (targetRowId: string, insertAt: number) => void
  /** Drop on the top/bottom drop zone: create new row. */
  onDropZone: (afterRowId: string | null) => void
  /** ID of the row above this one — used for the top drop zone. */
  prevRowId: string | null
}

// Module-level drag-over state (used only for visual feedback, per-row)
export function DockRow({
  row, isLast, isDragging, dragPanelId,
  renderPanel, onTabDragStart, onDropOnRow, onDropZone, prevRowId,
}: DockRowProps): React.JSX.Element {
  const [dragOverTabIndex, setDragOverTabIndex] = React.useState<number | null>(null)
  const [tabBarDragOver, setTabBarDragOver] = React.useState(false)
  const [topZoneDragOver, setTopZoneDragOver] = React.useState(false)

  const resizingRef = useRef<{ startY: number; startHeight: number } | null>(null)

  // ── Tab drag handlers ──────────────────────────────────────────────────────

  function handleTabDragStart(panelId: PanelId, idx: number, e: React.DragEvent) {
    e.dataTransfer.effectAllowed = 'move'
    onTabDragStart(panelId, idx, row.id)
  }

  function handleTabDragOver(idx: number, e: React.DragEvent) {
    e.preventDefault()
    e.stopPropagation()
    e.dataTransfer.dropEffect = 'move'
    setDragOverTabIndex(idx)
    setTabBarDragOver(false)
  }

  function handleTabBarDragOver(e: React.DragEvent) {
    e.preventDefault()
    e.dataTransfer.dropEffect = 'move'
    // Only activate if not over a specific tab
    setTabBarDragOver(true)
    setDragOverTabIndex(null)
  }

  function handleTabDrop(idx: number, e: React.DragEvent) {
    e.preventDefault()
    e.stopPropagation()
    setDragOverTabIndex(null)
    setTabBarDragOver(false)
    onDropOnRow(row.id, idx)
  }

  function handleTabBarDrop(e: React.DragEvent) {
    e.preventDefault()
    setTabBarDragOver(false)
    setDragOverTabIndex(null)
    onDropOnRow(row.id, row.panels.length)
  }

  function handleDragLeave(e: React.DragEvent) {
    // Only clear if leaving the tab bar entirely
    const rel = e.relatedTarget as Node | null
    const bar = e.currentTarget as HTMLElement
    if (rel && bar.contains(rel)) return
    setDragOverTabIndex(null)
    setTabBarDragOver(false)
  }

  function handleDragEnd() {
    setDragOverTabIndex(null)
    setTabBarDragOver(false)
  }

  // ── Top drop zone ──────────────────────────────────────────────────────────

  function handleTopZoneDragOver(e: React.DragEvent) {
    e.preventDefault()
    e.stopPropagation()
    e.dataTransfer.dropEffect = 'move'
    setTopZoneDragOver(true)
  }

  function handleTopZoneDrop(e: React.DragEvent) {
    e.preventDefault()
    setTopZoneDragOver(false)
    // Insert new row BEFORE this row, i.e. after prevRowId
    onDropZone(prevRowId)
  }

  // ── Resize handle ──────────────────────────────────────────────────────────

  function handleResizeMouseDown(e: React.MouseEvent) {
    e.preventDefault()
    const startHeight = row.height ?? 200
    resizingRef.current = { startY: e.clientY, startHeight }

    const onMove = (me: MouseEvent) => {
      if (!resizingRef.current) return
      const delta = me.clientY - resizingRef.current.startY
      const newH = Math.max(80, resizingRef.current.startHeight + delta)
      dockStore.setRowHeight(row.id, newH)
    }

    const onUp = (me: MouseEvent) => {
      if (!resizingRef.current) return
      const delta = me.clientY - resizingRef.current.startY
      const newH = Math.max(80, resizingRef.current.startHeight + delta)
      dockStore.setRowHeight(row.id, newH)
      resizingRef.current = null
      document.removeEventListener('mousemove', onMove)
      document.removeEventListener('mouseup', onUp)
    }

    document.addEventListener('mousemove', onMove)
    document.addEventListener('mouseup', onUp)
  }

  // ── Close tab ──────────────────────────────────────────────────────────────

  function handleCloseTab(e: React.MouseEvent, panelId: PanelId) {
    e.stopPropagation()
    dockStore.closePanel(panelId)
  }

  // ── Height style ──────────────────────────────────────────────────────────

  const rowStyle: React.CSSProperties = isLast
    ? { flex: '1 1 0', minHeight: 100 }
    : { flex: `0 0 ${row.height ?? 200}px`, minHeight: 80 }

  // ── Render ─────────────────────────────────────────────────────────────────

  return (
    <div className={styles.row} style={rowStyle}>
      {/* Top drop zone — shows between rows during drag */}
      {isDragging && (
        <div
          className={[styles.dropZone, topZoneDragOver ? styles.dropZoneActive : ''].join(' ')}
          onDragOver={handleTopZoneDragOver}
          onDragLeave={() => setTopZoneDragOver(false)}
          onDrop={handleTopZoneDrop}
        />
      )}

      {/* Tab bar */}
      <div
        className={[styles.tabBar, tabBarDragOver ? styles.tabBarDragOver : ''].join(' ')}
        onDragOver={handleTabBarDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleTabBarDrop}
      >
        {row.panels.map((panelId, idx) => {
          const isActive = row.activePanel === panelId
          const isDraggedTab = dragPanelId === panelId
          const isDragTarget = dragOverTabIndex === idx
          return (
            <button
              key={panelId}
              draggable
              className={[
                styles.tab,
                isActive ? styles.tabActive : '',
                isDragTarget ? styles.tabDragOver : '',
                isDraggedTab ? styles.tabDragging : '',
              ].join(' ')}
              onClick={() => dockStore.setActivePanel(row.id, panelId)}
              onDragStart={(e) => handleTabDragStart(panelId, idx, e)}
              onDragOver={(e) => handleTabDragOver(idx, e)}
              onDragLeave={(e) => { e.stopPropagation(); setDragOverTabIndex(null) }}
              onDrop={(e) => handleTabDrop(idx, e)}
              onDragEnd={handleDragEnd}
            >
              <span className={styles.tabLabel}>{panelId}</span>
              <span
                className={styles.closeBtn}
                role="button"
                aria-label={`Close ${panelId}`}
                onClick={(e) => handleCloseTab(e, panelId)}
              >
                ×
              </span>
            </button>
          )
        })}
        <div className={styles.tabSpacer} />
      </div>

      {/* Panel content */}
      <div className={styles.content}>
        {renderPanel(row.activePanel)}
      </div>

      {/* Resize handle — only on non-last rows */}
      {!isLast && (
        <div
          className={styles.resizeHandle}
          onMouseDown={handleResizeMouseDown}
        />
      )}
    </div>
  )
}
