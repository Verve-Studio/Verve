import React, { useMemo } from 'react'
import { MenuBar } from '../MenuBar/MenuBar'
import type { MenuDef } from '../MenuBar/MenuBar'
import type { AdjustmentType, FilterKey } from '@/types'
import styles from './TopBar.module.scss'


// ─── TopBar ───────────────────────────────────────────────────────────────────

interface TopBarProps {
  onDebug?: () => void
  onNew?: () => void
  onOpen?: () => void
  onSave?: () => void
  onSaveAs?: () => void
  onExport?: () => void
  onUndo?: () => void
  onRedo?: () => void
  onCut?: () => void
  onCopy?: () => void
  onPaste?: () => void
  onDelete?: () => void
  onResizeImage?: () => void
  onResizeCanvas?: () => void
  onZoomIn?: () => void
  onZoomOut?: () => void
  onFitToWindow?: () => void
  onToggleGrid?: () => void
  showGrid?: boolean
  onSetNormalMode?: () => void
  onSetTiledMode?: () => void
  tiledMode?: boolean
  onToggleTileGrid?: () => void
  showTileGrid?: boolean
  onNewLayer?: () => void
  onNewLayerGroup?: () => void
  onDuplicateLayer?: () => void
  onDeleteLayer?: () => void
  onGroupLayers?: () => void
  isGroupLayersEnabled?: boolean
  onUngroupLayers?: () => void
  isUngroupLayersEnabled?: boolean
  onMergeDown?: () => void
  onMergeVisible?: () => void
  onFlattenImage?: () => void
  onRasterizeLayer?: () => void
  isRasterizeEnabled?: boolean
  onMergeSelected?: () => void
  isMergeSelectedEnabled?: boolean
  onAbout?: () => void
  onKeyboardShortcuts?: () => void
  onCreateAdjustmentLayer?: (type: AdjustmentType) => void
  isAdjustmentMenuEnabled?: boolean
  adjustmentMenuItems?: Array<{ type: AdjustmentType; label: string; group?: string }>
  effectsMenuItems?: Array<{ type: AdjustmentType; label: string; group?: string }>
  onOpenFilterDialog?: (key: FilterKey) => void
  onInstantFilter?:     (key: FilterKey) => void
  isFiltersMenuEnabled?: boolean
  filterMenuItems?: Array<{ key: FilterKey; label: string; instant?: boolean; group?: string }>
  onFreeTransform?: () => void
  isFreeTransformEnabled?: boolean
  onInvertSelection?: () => void
  onSelectAll?:       () => void
  onDeselect?:        () => void
  onSelectAllLayers?: () => void
  onDeselectLayers?:  () => void
  onFindLayers?:      () => void
  onClose?: () => void
  onCloseAll?: () => void
  onSaveACopy?: () => void
  recentFiles?: string[]
  onOpenRecent?: (path: string) => void
  onClearRecentFiles?: () => void
  onExit?: () => void
  /** When true, hides the custom menu bar (logo + menu) — used on macOS where the native app menu is shown instead. */
  isMac?: boolean
}

export function TopBar({ onDebug, onNew, onOpen, onSave, onSaveAs, onExport, onUndo, onRedo, onCut, onCopy, onPaste, onDelete, onResizeImage, onResizeCanvas, onZoomIn, onZoomOut, onFitToWindow, onToggleGrid, showGrid, onSetNormalMode, onSetTiledMode, tiledMode, onToggleTileGrid, showTileGrid, onNewLayer, onNewLayerGroup, onDuplicateLayer, onDeleteLayer, onGroupLayers, isGroupLayersEnabled, onUngroupLayers, isUngroupLayersEnabled, onMergeDown, onMergeVisible, onFlattenImage, onRasterizeLayer, isRasterizeEnabled, onMergeSelected, isMergeSelectedEnabled, onAbout, onKeyboardShortcuts, onCreateAdjustmentLayer, isAdjustmentMenuEnabled, adjustmentMenuItems, effectsMenuItems, onOpenFilterDialog, onInstantFilter, isFiltersMenuEnabled, filterMenuItems, onFreeTransform, isFreeTransformEnabled, onInvertSelection, onSelectAll, onDeselect, onSelectAllLayers, onDeselectLayers, onFindLayers, onClose, onCloseAll, onSaveACopy, recentFiles, onOpenRecent, onClearRecentFiles, onExit, isMac }: TopBarProps): React.JSX.Element {
  const menus = useMemo((): MenuDef[] => [
    {
      label: 'File',
      items: [
        { label: 'New\u2026',        shortcut: 'Ctrl+N',       action: onNew },
        { label: 'Open\u2026',       shortcut: 'Ctrl+O',       action: onOpen },
        {
          label: 'Open Recent',
          submenu: (recentFiles && recentFiles.length > 0)
            ? [
                ...recentFiles.map(path => ({
                  label: path.split(/[\\/]/).pop() ?? path,
                  action: () => onOpenRecent?.(path),
                })),
                { separator: true, label: '' },
                { label: 'Clear Recent', action: onClearRecentFiles },
              ]
            : [{ label: 'No Recent Files', disabled: true }],
        },
        { separator: true, label: '' },
        { label: 'Close',            action: onClose },
        { label: 'Close All',        action: onCloseAll },
        { separator: true, label: '' },
        { label: 'Save',             shortcut: 'Ctrl+S',       action: onSave },
        { label: 'Save As\u2026',    shortcut: 'Ctrl+Shift+S', action: onSaveAs },
        { label: 'Save a Copy\u2026',                          action: onSaveACopy },
        { label: 'Export As\u2026',  shortcut: 'Ctrl+E',       action: onExport },
        { separator: true, label: '' },
        { label: 'Exit',             action: onExit },
      ]
    },
    {
      label: 'Edit',
      items: [
        { label: 'Undo', shortcut: 'Ctrl+Z', action: onUndo },
        { label: 'Redo', shortcut: 'Ctrl+Y', action: onRedo },
        { separator: true, label: '' },
        { label: 'Cut',    shortcut: 'Ctrl+X', action: onCut },
        { label: 'Copy',   shortcut: 'Ctrl+C', action: onCopy },
        { label: 'Paste',  shortcut: 'Ctrl+V', action: onPaste },
        { label: 'Delete', shortcut: 'Del',    action: onDelete },
        { separator: true, label: '' },
        { label: 'Resize Image…',        action: onResizeImage },
        { label: 'Resize Image Canvas…', action: onResizeCanvas },
        { separator: true, label: '' },
        { label: 'Transform\u2026', shortcut: 'Ctrl+T', disabled: !isFreeTransformEnabled, action: onFreeTransform },
      ]
    },
    {
      label: 'Select',
      items: [
        { label: 'All',              shortcut: 'Ctrl+A',       action: onSelectAll },
        { label: 'Deselect',         shortcut: 'Ctrl+D',       action: onDeselect },
        { separator: true, label: '' },
        { label: 'All Layers',       shortcut: 'Alt+Ctrl+A',   action: onSelectAllLayers },
        { label: 'Deselect Layers',                            action: onDeselectLayers },
        { separator: true, label: '' },
        { label: 'Find Layers',      shortcut: isMac ? 'Alt+Shift+Cmd+F' : 'Alt+Shift+Ctrl+F', action: onFindLayers },
        { separator: true, label: '' },
        { label: 'Invert Selection', shortcut: 'Ctrl+Shift+I', action: onInvertSelection },
      ]
    },
    {
      label: 'Layer',
      items: [
        { label: 'New Layer',       shortcut: 'Ctrl+Shift+N', action: onNewLayer },
        { label: 'New Layer Group',                           action: onNewLayerGroup },
        { label: 'Duplicate Layer',                           action: onDuplicateLayer },
        { label: 'Delete Layer',                              action: onDeleteLayer },
        { separator: true, label: '' },
        { label: 'Rasterize Layer', disabled: !isRasterizeEnabled, action: onRasterizeLayer },
        { separator: true, label: '' },
        { label: 'Group Layers',   shortcut: 'Ctrl+G',       disabled: !isGroupLayersEnabled,   action: onGroupLayers },
        { label: 'Ungroup Layers', shortcut: 'Ctrl+Shift+G', disabled: !isUngroupLayersEnabled, action: onUngroupLayers },
        { separator: true, label: '' },
        { label: 'Merge Selected',  disabled: !isMergeSelectedEnabled, action: onMergeSelected },
        { label: 'Merge Down',    action: onMergeDown },
        { label: 'Merge Visible', action: onMergeVisible },
        { label: 'Flatten Image', action: onFlattenImage },
      ]
    },
    {
      label: 'Adjustments',
      items: (() => {
        const result: MenuDef['items'] = []
        let lastGroup: string | undefined = undefined
        for (const item of (adjustmentMenuItems ?? [])) {
          if (item.group !== undefined && item.group !== lastGroup && lastGroup !== undefined) {
            result.push({ separator: true, label: '' })
          }
          lastGroup = item.group
          result.push({
            label:    item.label,
            disabled: !isAdjustmentMenuEnabled,
            action:   () => onCreateAdjustmentLayer?.(item.type),
          })
        }
        return result
      })(),
    },
    {
      label: 'Effects',
      items: (() => {
        const result: MenuDef['items'] = []
        let lastGroup: string | undefined = undefined
        for (const item of (effectsMenuItems ?? [])) {
          if (item.group !== undefined && item.group !== lastGroup && lastGroup !== undefined) {
            result.push({ separator: true, label: '' })
          }
          lastGroup = item.group
          result.push({
            label:    item.label,
            disabled: !isAdjustmentMenuEnabled,
            action:   () => onCreateAdjustmentLayer?.(item.type),
          })
        }
        return result
      })(),
    },
    {
      label: 'Filters',
      items: (() => {
        const result: MenuDef['items'] = []
        let lastGroup: string | undefined = undefined
        for (const item of (filterMenuItems ?? [])) {
          if (item.group !== undefined && item.group !== lastGroup && lastGroup !== undefined) {
            result.push({ separator: true, label: '' })
          }
          lastGroup = item.group
          result.push({
            label:    item.label,
            disabled: !isFiltersMenuEnabled,
            action:   () => item.instant
              ? onInstantFilter?.(item.key)
              : onOpenFilterDialog?.(item.key),
          })
        }
        return result
      })(),
    },
    {
      label: 'View',
      items: [
        { label: 'Zoom In',       shortcut: 'Ctrl+=', action: onZoomIn },
        { label: 'Zoom Out',      shortcut: 'Ctrl+-', action: onZoomOut },
        { label: 'Fit to Window', shortcut: 'Ctrl+0', action: onFitToWindow },
        { separator: true, label: '' },
        { label: 'Show Grid', shortcut: 'Ctrl+\'', action: onToggleGrid, checked: showGrid },
        { separator: true, label: '' },
        { label: 'Normal Mode', action: onSetNormalMode, checked: !tiledMode },
        { label: 'Tiled Mode',  action: onSetTiledMode,  checked: !!tiledMode },
        { separator: true, label: '' },
        { label: 'Show Tile Grid', action: onToggleTileGrid, checked: !!showTileGrid, disabled: !tiledMode },
      ]
    },
    {
      label: 'Help',
      items: [
        { label: 'About PixelShop',      action: onAbout },
        { label: 'Keyboard Shortcuts', shortcut: '?', action: onKeyboardShortcuts },
      ]
    }
  ], [isMac, onNew, onOpen, onSave, onSaveAs, onExport, onUndo, onRedo, onCut, onCopy, onPaste, onDelete, onResizeImage, onResizeCanvas, onZoomIn, onZoomOut, onFitToWindow, onToggleGrid, showGrid, onSetNormalMode, onSetTiledMode, tiledMode, onToggleTileGrid, showTileGrid, onNewLayer, onNewLayerGroup, onDuplicateLayer, onDeleteLayer, onGroupLayers, isGroupLayersEnabled, onUngroupLayers, isUngroupLayersEnabled, onMergeDown, onMergeVisible, onFlattenImage, onRasterizeLayer, isRasterizeEnabled, onMergeSelected, isMergeSelectedEnabled, onAbout, onKeyboardShortcuts, onCreateAdjustmentLayer, isAdjustmentMenuEnabled, adjustmentMenuItems, effectsMenuItems, onOpenFilterDialog, onInstantFilter, isFiltersMenuEnabled, filterMenuItems, onFreeTransform, isFreeTransformEnabled, onInvertSelection, onSelectAll, onDeselect, onSelectAllLayers, onDeselectLayers, onFindLayers, onClose, onCloseAll, onSaveACopy, recentFiles, onOpenRecent, onClearRecentFiles, onExit])

  // On macOS the native application menu replaces the entire custom top bar.
  if (isMac) return <></>

  return (
    <div className={styles.topBar}>
      {/* Left: Logo + menus */}
      <div className={styles.left}>
        {/* PS-style home/logo icon */}
        <button className={styles.logoBtn} aria-label="PixelShop home" title="PixelShop">
          <svg viewBox="0 0 16 16" fill="currentColor" width="16" height="16">
            <rect x="1" y="1" width="6" height="6" rx="1" />
            <rect x="9" y="1" width="6" height="6" rx="1" />
            <rect x="1" y="9" width="6" height="6" rx="1" />
            <rect x="9" y="9" width="6" height="6" rx="1" />
          </svg>
        </button>

        <div className={styles.menuDivider} />

        <MenuBar menus={menus} />
      </div>

      {tiledMode && (
        <div className={styles.center}>
          <span className={styles.tiledBadge}>TILED</span>
        </div>
      )}

      {/* Right: debug button */}
      <div className={styles.right}>
        <button
          className={styles.debugBtn}
          onClick={onDebug}
          title="Open DevTools"
          aria-label="Open DevTools"
        >
          <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4"
            strokeLinecap="round" strokeLinejoin="round" width="14" height="14">
            <polyline points="4,6 1,8 4,10" />
            <polyline points="12,6 15,8 12,10" />
            <line x1="9" y1="3" x2="7" y2="13" />
          </svg>
        </button>
      </div>
    </div>
  )
}
