import React, { useEffect, useMemo, useRef, useState } from 'react'
import type { LayerState, BlendMode, MaskLayerState, AdjustmentLayerState, GroupLayerState, CompositeLayerState } from '@/types'
import { isGroupLayer, isCompositeLayer, isContainerLayer } from '@/types'
import { useAppContext } from '@/core/store/AppContext'
import { buildRootLayerIds, getParentGroup, isDescendantOf, reorderRootLayers } from '@/utils/layerTree'
import { SliderInput } from '@/ux/widgets/SliderInput/SliderInput'
import styles from './Layers.module.scss'

// ─── Constants ────────────────────────────────────────────────────────────────

const BLEND_MODES_BASE: { value: BlendMode; label: string }[] = [
  { value: 'normal',      label: 'Normal' },
  { value: 'multiply',    label: 'Multiply' },
  { value: 'screen',      label: 'Screen' },
  { value: 'overlay',     label: 'Overlay' },
  { value: 'soft-light',  label: 'Soft Light' },
  { value: 'hard-light',  label: 'Hard Light' },
  { value: 'darken',      label: 'Darken' },
  { value: 'lighten',     label: 'Lighten' },
  { value: 'difference',  label: 'Difference' },
  { value: 'exclusion',   label: 'Exclusion' },
  { value: 'color-dodge', label: 'Color Dodge' },
  { value: 'color-burn',  label: 'Color Burn' },
]

const BLEND_MODES_GROUP: { value: BlendMode; label: string }[] = [
  { value: 'pass-through', label: 'Pass Through' },
  ...BLEND_MODES_BASE,
]

// ─── Drop target ──────────────────────────────────────────────────────────────

type DropTarget =
  | { kind: 'before'; layerId: string }
  | { kind: 'after';  layerId: string }
  | { kind: 'into';   groupId: string }

// ─── Tree row ─────────────────────────────────────────────────────────────────

interface TreeRow {
  layer: LayerState
  depth: number
  /** Pixel/text/shape layers that have at least one attached child (mask/adjustment) */
  hasChildren: boolean
}

// ─── Icons ────────────────────────────────────────────────────────────────────

const EyeIcon = ({ visible }: { visible: boolean }): React.JSX.Element =>
  visible ? (
    <svg viewBox="0 0 14 14" fill="currentColor" width="12" height="12">
      <path d="M7 2C4 2 1.5 5 1.5 7S4 12 7 12s5.5-3 5.5-5S10 2 7 2zm0 8a3 3 0 110-6 3 3 0 010 6z" />
      <circle cx="7" cy="7" r="1.5" />
    </svg>
  ) : (
    <svg viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.2" width="12" height="12">
      <path d="M2 2l10 10M5.5 4.2A5.5 5.5 0 017 4c3 0 5 2.5 5.5 3-.4.7-1.3 1.8-2.5 2.5M3 5.5C2 6.2 1.5 6.8 1.5 7c.5.5 2.5 3 5.5 3 .6 0 1.2-.1 1.7-.3" strokeLinecap="round" />
    </svg>
  )

const LockIcon = ({ locked }: { locked: boolean }): React.JSX.Element =>
  locked ? (
    <svg viewBox="0 0 12 14" fill="currentColor" width="10" height="12">
      <rect x="2" y="6" width="8" height="7" rx="1" />
      <path d="M4 6V4.5a2 2 0 114 0V6" fill="none" stroke="currentColor" strokeWidth="1.3" />
    </svg>
  ) : (
    <svg viewBox="0 0 12 14" fill="none" stroke="currentColor" strokeWidth="1.3" width="10" height="12">
      <rect x="2" y="6" width="8" height="7" rx="1" />
      <path d="M4 6V4.5a2 2 0 114 0V6" strokeLinecap="round" />
    </svg>
  )

const AddLayerIcon = (): React.JSX.Element => (
  <svg viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.4" width="12" height="12">
    <rect x="2" y="4" width="8" height="8" rx="1" />
    <path d="M5 2h6a1 1 0 011 1v6" strokeLinecap="round" />
    <path d="M6 8h4M8 6v4" strokeLinecap="round" />
  </svg>
)

const AddGroupIcon = (): React.JSX.Element => (
  <svg viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.3" width="12" height="12">
    <path d="M1 4h12v8a1 1 0 01-1 1H2a1 1 0 01-1-1V4z" />
    <path d="M1 4V3a1 1 0 011-1h3l1.5 2H1z" />
    <path d="M7 8h3M8.5 6.5v3" strokeLinecap="round" />
  </svg>
)

const MaskIcon = ({ active }: { active: boolean }): React.JSX.Element => (
  <svg viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.2" width="12" height="12">
    <circle cx="7" cy="7" r="5" />
    {active
      ? <path d="M7 2v10M2 7h10" strokeLinecap="round" />
      : <path d="M2 7h10" strokeLinecap="round" />
    }
  </svg>
)

const AdjustmentIcon = (): React.JSX.Element => (
  <svg viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" width="12" height="12">
    <line x1="2" y1="4" x2="12" y2="4" />
    <circle cx="5" cy="4" r="1.5" fill="currentColor" stroke="none" />
    <line x1="2" y1="7" x2="12" y2="7" />
    <circle cx="9" cy="7" r="1.5" fill="currentColor" stroke="none" />
    <line x1="2" y1="10" x2="12" y2="10" />
    <circle cx="6" cy="10" r="1.5" fill="currentColor" stroke="none" />
  </svg>
)

const DeleteLayerIcon = (): React.JSX.Element => (
  <svg viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.4" width="12" height="12">
    <path d="M3 4h8M5 4V3h4v1M5 4v7h4V4" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
)

const FolderIcon = (): React.JSX.Element => (
  <svg viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.2" width="13" height="13">
    <path d="M1 4h12v7a1 1 0 01-1 1H2a1 1 0 01-1-1V4z" />
    <path d="M1 4V3a1 1 0 011-1h3l1.5 2H1z" />
  </svg>
)

/** Stacked-layers icon used for Composite layers */
const CompositeIcon = (): React.JSX.Element => (
  <svg viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.2" width="13" height="13">
    <rect x="1" y="8" width="12" height="4" rx="1" />
    <rect x="2" y="5" width="10" height="4" rx="1" />
    <rect x="3" y="2" width="8"  height="4" rx="1" />
  </svg>
)

// ─── Match highlight helper ──────────────────────────────────────────────────

function highlightMatch(name: string, query: string): React.ReactNode {
  if (!query) return name
  const idx = name.toLowerCase().indexOf(query.toLowerCase())
  if (idx < 0) return name
  return (
    <>
      {name.slice(0, idx)}
      <mark className={styles.nameMatchMark}>{name.slice(idx, idx + query.length)}</mark>
      {name.slice(idx + query.length)}
    </>
  )
}

// ─── Props ────────────────────────────────────────────────────────────────────

interface LayerPanelProps {
  onMergeSelected:     (ids: string[]) => void
  onMergeVisible:      () => void
  onMergeDown:         () => void
  onFlattenImage:      () => void
  onRasterizeLayer:    (layerId: string) => void
  onDuplicateLayer:    () => void
  onOpenAdjustmentPanel?: (layerId: string) => void
  onMergeGroup:        (groupId: string) => void
  onGroupSelected:     (layerIds: string[]) => void
  onUngroup:           (groupId: string) => void
  activeTabId?:        string
  findLayersTrigger?:  number
}

// ─── Component ────────────────────────────────────────────────────────────────

export function Layers({
  onMergeSelected,
  onMergeVisible,
  onMergeDown,
  onFlattenImage,
  onRasterizeLayer,
  onDuplicateLayer,
  onOpenAdjustmentPanel,
  onMergeGroup,
  onGroupSelected,
  onUngroup,
  activeTabId,
  findLayersTrigger,
}: LayerPanelProps): React.JSX.Element {
  const { state, dispatch } = useAppContext()
  const layers = state.layers
  const activeLayerId = state.activeLayerId ?? undefined

  const onActiveLayerChange = (id: string): void => { dispatch({ type: 'SET_ACTIVE_LAYER', payload: id }) }
  const onLayerAdd = (): void => {
    const id = `layer-${Date.now()}`
    dispatch({
      type: 'ADD_LAYER',
      payload: { id, name: `Layer ${layers.length + 1}`, visible: true, opacity: 1, locked: false, blendMode: 'normal' },
    })
  }
  const onLayerDelete = (id: string): void => { dispatch({ type: 'REMOVE_LAYER', payload: id }) }
  const onLayerToggleVisibility = (id: string): void => { dispatch({ type: 'TOGGLE_LAYER_VISIBILITY', payload: id }) }
  const onLayerToggleLock = (id: string): void => { dispatch({ type: 'TOGGLE_LAYER_LOCK', payload: id }) }
  const onLayerOpacityChange = (id: string, opacity: number): void => { dispatch({ type: 'SET_LAYER_OPACITY', payload: { id, opacity } }) }
  const onLayerBlendChange = (id: string, blendMode: BlendMode): void => { dispatch({ type: 'SET_LAYER_BLEND', payload: { id, blendMode } }) }
  const onLayerRename = (id: string, name: string): void => { dispatch({ type: 'RENAME_LAYER', payload: { id, name } }) }
  const onAddMaskLayer = (parentId: string): void => {
    const hasMask = layers.some(l => 'type' in l && l.type === 'mask' && (l as { parentId: string }).parentId === parentId)
    if (hasMask) return
    dispatch({ type: 'ADD_MASK_LAYER', payload: { id: `mask-${Date.now()}`, name: 'Layer Mask', visible: true, type: 'mask', parentId } })
  }

  const [editingId, setEditingId] = useState<string | null>(null)
  const [editingName, setEditingName] = useState('')
  const selectedIds = new Set(state.selectedLayerIds)
  const setSelectedIds = (next: Set<string>): void => { dispatch({ type: 'SET_SELECTED_LAYERS', payload: [...next] }) }
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; flipX: boolean } | null>(null)
  const dragSrcLayerIdRef = useRef<string | null>(null)
  const anchorLayerIdRef  = useRef<string | null>(null)
  const [dropTarget, setDropTarget] = useState<DropTarget | null>(null)
  // Separate drag state for reordering adjustment children within a parent
  const adjDragSrcIdRef = useRef<string | null>(null)
  const [adjDropTarget, setAdjDropTarget] = useState<{ beforeId: string } | { afterId: string } | null>(null)
  // Local-only collapse state for pixel/text/shape layers that own mask/adjustment children
  const [collapsedPixelLayers, setCollapsedPixelLayers] = useState<Set<string>>(new Set())
  const togglePixelLayerCollapse = (id: string): void =>
    setCollapsedPixelLayers(prev => { const next = new Set(prev); next.has(id) ? next.delete(id) : next.add(id); return next })

  // ── Filter bar state ──────────────────────────────────────────────────────────
  const [filterQuery,  setFilterQuery]  = useState<string>('')
  const [isFilterOpen, setIsFilterOpen] = useState<boolean>(false)
  const filterInputRef = useRef<HTMLInputElement>(null)

  // Reset filter when switching tabs
  useEffect(() => {
    setFilterQuery('')
    setIsFilterOpen(false)
  }, [activeTabId])

  // Open and focus filter bar when trigger increments
  useEffect(() => {
    if (!findLayersTrigger) return
    setIsFilterOpen(true)
    requestAnimationFrame(() => { filterInputRef.current?.focus() })
  }, [findLayersTrigger])

  useEffect(() => {
    if (!contextMenu) return
    const onKey = (e: KeyboardEvent): void => { if (e.key === 'Escape') setContextMenu(null) }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [contextMenu])

  // ── Tree rows ────────────────────────────────────────────────────────────────

  const treeRows: TreeRow[] = useMemo(() => {
    const result: TreeRow[] = []
    const layersById = new Map(layers.map(l => [l.id, l]))
    const rootIds = buildRootLayerIds(layers)

    function walk(ids: readonly string[], depth: number, parentCollapsed: boolean): void {
      if (parentCollapsed) return
      for (let i = ids.length - 1; i >= 0; i--) {
        const id = ids[i]
        const layer = layersById.get(id)
        if (!layer) continue
        // Skip per-layer mask/adjustment: yielded after their pixel/composite parent
        if ('type' in layer && (layer.type === 'mask' || layer.type === 'adjustment')) {
          const parent = layersById.get((layer as MaskLayerState | AdjustmentLayerState).parentId)
          if (parent && !isGroupLayer(parent)) continue
        }
        if (isCompositeLayer(layer)) {
          const adjChildren = layers.filter(
            l => 'type' in l && (l.type === 'mask' || l.type === 'adjustment') &&
              (l as MaskLayerState | AdjustmentLayerState).parentId === layer.id
          )
          result.push({ layer, depth, hasChildren: adjChildren.length > 0 || layer.childIds.length > 0 })
          if (!layer.collapsed) {
            for (const child of adjChildren) {
              result.push({ layer: child, depth: depth + 1, hasChildren: false })
            }
            walk(layer.childIds, depth + 1, false)
          }
        } else if (isContainerLayer(layer)) {
          result.push({ layer, depth, hasChildren: false })
          walk(layer.childIds, depth + 1, layer.collapsed)
        } else if (!('type' in layer) || (layer.type !== 'mask' && layer.type !== 'adjustment')) {
          // Pixel/text/shape: collect attached children
          const children = layers.filter(
            l => 'type' in l && (l.type === 'mask' || l.type === 'adjustment') &&
              (l as MaskLayerState | AdjustmentLayerState).parentId === layer.id
          )
          const isCollapsed = collapsedPixelLayers.has(layer.id)
          result.push({ layer, depth, hasChildren: children.length > 0 })
          if (!isCollapsed) {
            for (const child of children) {
              result.push({ layer: child, depth: depth + 1, hasChildren: false })
            }
          }
        } else {
          result.push({ layer, depth, hasChildren: false })
        }
      }
    }

    walk(rootIds, 0, false)
    return result
  }, [layers, collapsedPixelLayers])

  // ── Filtered rows ────────────────────────────────────────────────────────────

  const filteredRows: TreeRow[] = useMemo((): TreeRow[] => {
    if (!filterQuery) return treeRows

    const q = filterQuery.toLowerCase()
    const layerMap = new Map(layers.map(l => [l.id, l]))

    // Pass 1: collect direct name-match IDs
    const nameMatchIds = new Set(
      layers.filter(l => l.name.toLowerCase().includes(q)).map(l => l.id)
    )

    // Pass 2: compute visible IDs
    const visibleIds = new Set<string>()

    function markAllDescendants(group: GroupLayerState | CompositeLayerState): void {
      for (const childId of group.childIds) {
        visibleIds.add(childId)
        const child = layerMap.get(childId)
        if (child && isContainerLayer(child)) markAllDescendants(child)
      }
      if (isCompositeLayer(group)) {
        for (const l of layers) {
          if ('type' in l && (l.type === 'mask' || l.type === 'adjustment') &&
              (l as MaskLayerState | AdjustmentLayerState).parentId === group.id) {
            visibleIds.add(l.id)
          }
        }
      }
    }

    function subtreeHasMatch(group: GroupLayerState | CompositeLayerState): boolean {
      for (const childId of group.childIds) {
        if (nameMatchIds.has(childId)) return true
        const child = layerMap.get(childId)
        if (child && isContainerLayer(child) && subtreeHasMatch(child)) return true
      }
      if (isCompositeLayer(group)) {
        for (const l of layers) {
          if ('type' in l && (l.type === 'mask' || l.type === 'adjustment') &&
              (l as MaskLayerState | AdjustmentLayerState).parentId === group.id &&
              nameMatchIds.has(l.id)) return true
        }
      }
      return false
    }

    for (const layer of layers) {
      if ('type' in layer && (layer.type === 'mask' || layer.type === 'adjustment')) continue

      if (nameMatchIds.has(layer.id)) {
        visibleIds.add(layer.id)
        if (isContainerLayer(layer)) markAllDescendants(layer)
      } else if (isContainerLayer(layer) && subtreeHasMatch(layer)) {
        visibleIds.add(layer.id)
      }
    }

    // Mask / adjustment children shown alongside their visible parent
    for (const layer of layers) {
      if ('type' in layer && (layer.type === 'mask' || layer.type === 'adjustment')) {
        const parentId = (layer as MaskLayerState | AdjustmentLayerState).parentId
        if (visibleIds.has(parentId)) visibleIds.add(layer.id)
      }
    }

    return treeRows.filter(row => visibleIds.has(row.layer.id))
  }, [treeRows, filterQuery, layers])

  // Determine which row to highlight as "active" — if the active layer is hidden
  // inside a collapsed group, highlight the collapsed group row instead.
  const displayActiveId = useMemo((): string | null => {    if (!activeLayerId) return null
    if (treeRows.some(r => r.layer.id === activeLayerId)) return activeLayerId
    // Active layer might be a mask/adjustment whose pixel parent is collapsed
    const activeLayer_ = layers.find(l => l.id === activeLayerId)
    if (activeLayer_ && 'type' in activeLayer_ && (activeLayer_.type === 'mask' || activeLayer_.type === 'adjustment')) {
      const parentId = (activeLayer_ as MaskLayerState | AdjustmentLayerState).parentId
      if (collapsedPixelLayers.has(parentId)) return parentId
    }
    // Active layer is inside a collapsed group — walk up the parent chain
    let current = activeLayerId
    for (;;) {
      const parent = getParentGroup(layers, current)
      if (!parent) return current
      if (treeRows.some(r => r.layer.id === parent.id)) return parent.id
      current = parent.id
    }
  }, [activeLayerId, layers, treeRows, collapsedPixelLayers])

  // ── Interaction ──────────────────────────────────────────────────────────────

  const isMac = window.api.platform === 'darwin'

  const handleLayerClick = (layer: LayerState, e: React.MouseEvent): void => {
    const isMultiKey = isMac ? e.altKey : e.ctrlKey
    if (isMultiKey) {
      const next = new Set(selectedIds)
      if (next.has(layer.id)) next.delete(layer.id)
      else next.add(layer.id)
      setSelectedIds(next)
      anchorLayerIdRef.current = layer.id
    } else if (e.shiftKey && anchorLayerIdRef.current !== null) {
      const anchorIdx = filteredRows.findIndex(r => r.layer.id === anchorLayerIdRef.current)
      const clickIdx  = filteredRows.findIndex(r => r.layer.id === layer.id)
      if (anchorIdx >= 0 && clickIdx >= 0) {
        const [lo, hi] = [Math.min(anchorIdx, clickIdx), Math.max(anchorIdx, clickIdx)]
        setSelectedIds(new Set(filteredRows.slice(lo, hi + 1).map(r => r.layer.id)))
      }
    } else {
      onActiveLayerChange(layer.id)
      setSelectedIds(new Set())
      anchorLayerIdRef.current = layer.id
      if ('type' in layer && layer.type === 'adjustment') {
        onOpenAdjustmentPanel?.(layer.id)
      }
    }
  }

  const MENU_WIDTH = 180
  const handleContextMenu = (e: React.MouseEvent): void => {
    e.preventDefault()
    const flipX = e.clientX + MENU_WIDTH > window.innerWidth
    setContextMenu({ x: e.clientX, y: e.clientY, flipX })
  }

  const closeContextMenu = (): void => setContextMenu(null)

  const execMergeSelected = (): void => {
    closeContextMenu()
    const effective = new Set(selectedIds)
    if (activeLayerId) effective.add(activeLayerId)
    onMergeSelected([...effective])
    setSelectedIds(new Set())
  }

  const execMergeVisible = (): void => {
    closeContextMenu()
    onMergeVisible()
    setSelectedIds(new Set())
  }

  const execMergeDown = (): void => {
    closeContextMenu()
    onMergeDown()
    setSelectedIds(new Set())
  }

  const execFlattenImage = (): void => {
    closeContextMenu()
    onFlattenImage()
    setSelectedIds(new Set())
  }

  // ── Layer panel header state ──────────────────────────────────────────────────

  const activeLayer = layers.find((l) => l.id === activeLayerId)
  const canDelete = layers.length > 1
  const isChildLayer = (l: LayerState): boolean =>
    'type' in l && (l.type === 'mask' || l.type === 'adjustment')

  const isActiveGroup = activeLayer !== undefined && isGroupLayer(activeLayer)
  const isActiveComposite = activeLayer !== undefined && isCompositeLayer(activeLayer)
  const isActiveContainer = isActiveGroup || isActiveComposite

  const canRasterize = !!activeLayerId && !!activeLayer && !isChildLayer(activeLayer) && !isActiveContainer && (
    ('type' in activeLayer && (activeLayer.type === 'text' || activeLayer.type === 'shape')) ||
    (!('type' in activeLayer) && layers.some(
      l => 'type' in l && l.type === 'adjustment' && (l as { parentId: string }).parentId === activeLayerId
    ))
  )

  const isChildActive = activeLayer !== undefined && 'type' in activeLayer &&
    (activeLayer.type === 'mask' || activeLayer.type === 'adjustment')

  const opacityValue = (!isChildActive && activeLayer) ? Math.round((activeLayer as { opacity: number }).opacity * 100) : 100
  const blendValue: BlendMode = (!isChildActive && activeLayer) ? (activeLayer as { blendMode: BlendMode }).blendMode : 'normal'

  const activeBlendModes = isActiveContainer ? BLEND_MODES_GROUP : BLEND_MODES_BASE

  const canAddMask = activeLayerId && !isChildActive && !isActiveContainer &&
    !layers.some(l => 'type' in l && l.type === 'mask' && (l as { parentId: string }).parentId === activeLayerId)

  // ── Editing ──────────────────────────────────────────────────────────────────

  const startEdit = (layer: LayerState, e: React.MouseEvent): void => {
    e.stopPropagation()
    setEditingId(layer.id)
    setEditingName(layer.name)
  }

  const commitEdit = (): void => {
    if (editingId && editingName.trim()) onLayerRename(editingId, editingName.trim())
    setEditingId(null)
  }

  const handleEditKey = (e: React.KeyboardEvent<HTMLInputElement>): void => {
    if (e.key === 'Enter') commitEdit()
    else if (e.key === 'Escape') setEditingId(null)
  }

  // ── Footer group button ───────────────────────────────────────────────────────

  const onAddGroup = (): void => {
    const effective = [...new Set([...selectedIds, ...(activeLayerId ? [activeLayerId] : [])])]
    if (effective.length >= 2) {
      onGroupSelected(effective)
    } else {
      const id = `group-${Date.now()}`
      dispatch({ type: 'ADD_LAYER_GROUP', payload: { id, name: 'Group', aboveLayerId: activeLayerId ?? undefined } })
    }
  }

  // ── Drag and drop ─────────────────────────────────────────────────────────────

  const handleDragStart = (layerId: string, e: React.DragEvent): void => {
    dragSrcLayerIdRef.current = layerId
    e.dataTransfer.effectAllowed = 'move'
  }

  const handleDragEnd = (): void => {
    dragSrcLayerIdRef.current = null
    setDropTarget(null)
  }

  // ── Adjustment-child drag handlers ────────────────────────────────────────

  const handleAdjDragStart = (layerId: string, e: React.DragEvent): void => {
    adjDragSrcIdRef.current = layerId
    e.dataTransfer.effectAllowed = 'move'
    e.stopPropagation()
  }

  const handleAdjDragEnd = (): void => {
    adjDragSrcIdRef.current = null
    setAdjDropTarget(null)
  }

  const handleAdjDragOver = (e: React.DragEvent, layerId: string): void => {
    e.preventDefault()
    e.stopPropagation()
    const srcId = adjDragSrcIdRef.current
    if (!srcId || srcId === layerId) { e.dataTransfer.dropEffect = 'none'; return }
    e.dataTransfer.dropEffect = 'move'
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect()
    const relY = (e.clientY - rect.top) / rect.height
    setAdjDropTarget(relY < 0.5 ? { beforeId: layerId } : { afterId: layerId })
  }

  const handleAdjDrop = (e: React.DragEvent, parentId: string): void => {
    e.preventDefault()
    e.stopPropagation()
    const srcId = adjDragSrcIdRef.current
    adjDragSrcIdRef.current = null
    setAdjDropTarget(null)
    if (!srcId || !adjDropTarget) return
    // Collect all sibling adj/mask children of this parent in current display order
    const siblings = treeRows
      .filter(r => 'type' in r.layer && (r.layer.type === 'adjustment' || r.layer.type === 'mask') &&
        (r.layer as AdjustmentLayerState).parentId === parentId)
      .map(r => r.layer.id)
    if (!siblings.includes(srcId)) return
    const targetId = 'beforeId' in adjDropTarget ? adjDropTarget.beforeId : adjDropTarget.afterId
    if (targetId === srcId) return
    // Build new order
    const without = siblings.filter(id => id !== srcId)
    const targetIdx = without.indexOf(targetId)
    if (targetIdx < 0) return
    const insertIdx = 'beforeId' in adjDropTarget ? targetIdx : targetIdx + 1
    without.splice(insertIdx, 0, srcId)
    dispatch({ type: 'REORDER_ADJUSTMENT_LAYERS', payload: { parentId, orderedChildIds: without } })
  }

  const handleDragOver = (e: React.DragEvent, layerId: string, isGroup: boolean): void => {
    e.preventDefault()
    const srcId = dragSrcLayerIdRef.current
    if (!srcId) return
    if (layerId === srcId) { e.dataTransfer.dropEffect = 'none'; return }
    if (isDescendantOf(layers, layerId, srcId)) { e.dataTransfer.dropEffect = 'none'; return }
    e.dataTransfer.dropEffect = 'move'
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect()
    const relY = (e.clientY - rect.top) / rect.height
    if (isGroup && relY >= 0.25 && relY <= 0.75) {
      setDropTarget({ kind: 'into', groupId: layerId })
    } else if (relY < 0.5) {
      setDropTarget({ kind: 'before', layerId })
    } else {
      setDropTarget({ kind: 'after', layerId })
    }
  }

  const handleDragLeave = (e: React.DragEvent): void => {
    // Only clear if leaving the list entirely
    if (!e.currentTarget.contains(e.relatedTarget as Node)) {
      setDropTarget(null)
    }
  }

  const handleDrop = (e: React.DragEvent): void => {
    e.preventDefault()
    const srcId = dragSrcLayerIdRef.current
    if (!srcId || !dropTarget) { dragSrcLayerIdRef.current = null; setDropTarget(null); return }
    dragSrcLayerIdRef.current = null
    setDropTarget(null)

    // Build the effective selection: selectedIds ∪ activeLayerId (same union used everywhere else).
    const effectiveSelected = new Set([...selectedIds, ...(activeLayerId ? [activeLayerId] : [])])

    // If the dragged layer is part of the effective selection, move all selected layers.
    // If not (user started a drag on an unselected layer), move only that layer.
    const dragSet = effectiveSelected.has(srcId) ? effectiveSelected : new Set([srcId])

    // All layers being moved, in top-to-bottom display order, filtered to moveable layers only.
    const orderedDragIds = treeRows
      .map(r => r.layer.id)
      .filter(id => {
        if (!dragSet.has(id)) return false
        const l = layers.find(x => x.id === id)
        return l !== undefined && !('type' in l && (l.type === 'mask' || l.type === 'adjustment'))
      })

    if (dropTarget.kind === 'into') {
      const gId = dropTarget.groupId
      const validIds = orderedDragIds.filter(id =>
        id !== gId && !isDescendantOf(layers, gId, id)
      )
      if (validIds.length === 0) return
      // Insert at top of group (index 0), incrementing for each so order is preserved.
      validIds.forEach((id, i) => {
        dispatch({ type: 'MOVE_LAYER_INTO_GROUP', payload: { layerId: id, targetGroupId: gId, insertIndex: i } })
      })
      return
    }

    const targetId = dropTarget.layerId
    const validIds = orderedDragIds.filter(id =>
      id !== targetId && !isDescendantOf(layers, targetId, id)
    )
    if (validIds.length === 0) return

    const targetParent = getParentGroup(layers, targetId)

    if (targetParent) {
      const targetIdx = targetParent.childIds.indexOf(targetId)
      const baseIndex = dropTarget.kind === 'before' ? targetIdx : targetIdx + 1
      validIds.forEach((id, i) => {
        dispatch({ type: 'MOVE_LAYER_INTO_GROUP', payload: { layerId: id, targetGroupId: targetParent.id, insertIndex: baseIndex + i } })
      })
    } else {
      // Target is at root.
      if (validIds.some(id => getParentGroup(layers, id))) {
        // At least one layer is coming out of a group — move all out first.
        validIds.forEach(id => {
          if (getParentGroup(layers, id)) {
            dispatch({ type: 'MOVE_LAYER_OUT_OF_GROUP', payload: { layerId: id, targetParentGroupId: null, insertIndex: 0 } })
          }
        })
      } else {
        // All at root — reorder.
        if (validIds.length === 1) {
          const rootDisplayIds = buildRootLayerIds(layers)
            .filter(id => {
              const l = layers.find(x => x.id === id)
              return l !== undefined && !('type' in l && (l.type === 'mask' || l.type === 'adjustment'))
            })
            .reverse()
          const targetDisplayIdx = rootDisplayIds.indexOf(targetId)
          const dstDisplayIdx = dropTarget.kind === 'before' ? targetDisplayIdx : targetDisplayIdx + 1
          const newLayers = reorderRootLayers(layers, validIds[0], dstDisplayIdx)
          dispatch({ type: 'REORDER_LAYERS', payload: newLayers })
        } else {
          // Multi-layer root reorder: move each one in sequence.
          const rootDisplayIds = buildRootLayerIds(layers)
            .filter(id => {
              const l = layers.find(x => x.id === id)
              return l !== undefined && !('type' in l && (l.type === 'mask' || l.type === 'adjustment'))
            })
            .reverse()
          const targetDisplayIdx = rootDisplayIds.indexOf(targetId)
          const dstDisplayIdx = dropTarget.kind === 'before' ? targetDisplayIdx : targetDisplayIdx + 1
          // Reorder one at a time; use the first dragged layer as the anchor.
          const newLayers = reorderRootLayers(layers, validIds[0], dstDisplayIdx)
          dispatch({ type: 'REORDER_LAYERS', payload: newLayers })
        }
      }
    }
  }

  return (
    <div className={[styles.panel, filterQuery !== '' ? styles.panelFiltered : ''].join(' ')}>
      {/* ── Blend mode + Opacity ──────────────────────────────────────── */}
      <div className={styles.blendRow}>
        <select
          className={styles.blendSelect}
          value={blendValue}
          disabled={!activeLayer || !!isChildActive}
          onChange={(e) => activeLayer && onLayerBlendChange(activeLayer.id, e.target.value as BlendMode)}
        >
          {activeBlendModes.map((bm) => (
            <option key={bm.value} value={bm.value}>{bm.label}</option>
          ))}
        </select>
        <label className={styles.numLabel}>Opacity:</label>
        <SliderInput
          key={activeLayerId}
          value={opacityValue}
          min={0}
          max={100}
          step={1}
          inputWidth={34}
          suffix="%"
          disabled={!activeLayer || !!isChildActive}
          onChange={(n) => activeLayer && onLayerOpacityChange(activeLayer.id, n / 100)}
        />
      </div>

      {/* ── Lock row ─────────────────────────────────────────────────── */}
      {!isChildActive && (
        <div className={styles.lockRow}>
          <span className={styles.lockLabel}>Lock:</span>
          <button
            className={`${styles.lockBtn} ${activeLayer && !isChildActive && (activeLayer as { locked?: boolean }).locked ? styles.lockBtnActive : ''}`}
            title={(activeLayer && !isChildActive && (activeLayer as { locked?: boolean }).locked) ? 'Unlock layer' : 'Lock layer'}
            disabled={!activeLayer || !!isChildActive}
            onClick={() => activeLayer && !isChildActive && onLayerToggleLock(activeLayer.id)}
          >
            <LockIcon locked={(!isChildActive && (activeLayer as unknown as { locked?: boolean })?.locked) ?? false} />
          </button>
        </div>
      )}

      {/* ── Filter bar ───────────────────────────────────────────────── */}
      <div
        className={[
          styles.filterBar,
          isFilterOpen                       ? styles.filterBarOpen   : '',
          isFilterOpen && filterQuery !== '' ? styles.filterBarActive : '',
        ].join(' ')}
      >
        <span className={styles.filterIcon} aria-hidden="true">
          <svg viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" width="12" height="12">
            <circle cx="5" cy="5" r="3.5" />
            <line x1="8" y1="8" x2="11" y2="11" />
          </svg>
        </span>
        <input
          ref={filterInputRef}
          type="text"
          className={styles.filterInput}
          placeholder="Filter layers…"
          value={filterQuery}
          onChange={(e) => {
            setFilterQuery(e.target.value)
            if (e.target.value !== '') setIsFilterOpen(true)
          }}
          onFocus={() => setIsFilterOpen(true)}
          onBlur={() => {
            if (filterQuery === '') setIsFilterOpen(false)
          }}
          onKeyDown={(e) => {
            if (e.key === 'Escape') {
              setFilterQuery('')
              setIsFilterOpen(false)
              filterInputRef.current?.blur()
            }
          }}
          aria-label="Filter layers by name"
        />
        {filterQuery !== '' ? (
          <button
            className={styles.filterClearBtn}
            tabIndex={-1}
            aria-label="Clear filter"
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => {
              setFilterQuery('')
              filterInputRef.current?.focus()
            }}
          >×</button>
        ) : (
          <span className={styles.filterClearPlaceholder} aria-hidden="true" />
        )}
      </div>

      {/* ── Layer list ────────────────────────────────────────────────── */}
      <ul
        className={styles.list}
        role="listbox"
        aria-label="Layers"
        onContextMenu={handleContextMenu}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
      >
        {filterQuery !== '' && filteredRows.length === 0 ? (
          <li className={styles.filterEmpty}>
            <span className={styles.filterEmptyText}>No layers match <em>&ldquo;{filterQuery}&rdquo;</em></span>
          </li>
        ) : filteredRows.map(({ layer, depth, hasChildren }) => {
          const isMask = 'type' in layer && layer.type === 'mask'
          const isAdjustment = 'type' in layer && layer.type === 'adjustment'
          const isText = 'type' in layer && layer.type === 'text'
          const isGroup = isContainerLayer(layer)
          const isChild = isMask || isAdjustment
          const isActive = layer.id === displayActiveId
          const isSelected = selectedIds.has(layer.id)
          const isDropBefore = dropTarget?.kind === 'before' && dropTarget.layerId === layer.id
          const isDropAfter  = dropTarget?.kind === 'after'  && dropTarget.layerId === layer.id
          const isDropInto   = dropTarget?.kind === 'into'   && dropTarget.groupId === layer.id

          // Adjustment/mask child reorder indicators
          const isAdjDropBefore = isChild && adjDropTarget && 'beforeId' in adjDropTarget && adjDropTarget.beforeId === layer.id
          const isAdjDropAfter  = isChild && adjDropTarget && 'afterId'  in adjDropTarget && adjDropTarget.afterId  === layer.id

          const isPixelCollapsed = !isGroup && !isChild && hasChildren && collapsedPixelLayers.has(layer.id)

          // Parent id for adjustment reorder drops
          const adjParentId = isChild ? (layer as AdjustmentLayerState).parentId : null

          return (
            <li
              key={layer.id}
              className={[
                styles.item,
                isChild   ? styles.maskItem    : '',
                isActive    ? styles.itemActive   : '',
                isSelected && !isActive ? styles.itemSelected : '',
                isDropBefore || isAdjDropBefore ? styles.dropIndicatorBefore : '',
                isDropAfter  || isAdjDropAfter  ? styles.dropIndicatorAfter  : '',
                isDropInto   ? styles.dropTargetGroup     : '',
              ].join(' ')}
              style={{ paddingLeft: `${5 + depth * 16}px` }}
              role="option"
              aria-selected={isActive}
              draggable={true}
              onDragStart={(e) => isChild ? handleAdjDragStart(layer.id, e) : handleDragStart(layer.id, e)}
              onDragEnd={isChild ? handleAdjDragEnd : handleDragEnd}
              onDragOver={(e) => isChild && adjParentId ? handleAdjDragOver(e, layer.id) : (!isChild && handleDragOver(e, layer.id, isGroup))}
              onDrop={(e) => isChild && adjParentId ? handleAdjDrop(e, adjParentId) : undefined}
              onClick={(e) => handleLayerClick(layer, e)}
            >
              {/* Disclosure triangle for groups and pixel layers with children; spacer otherwise */}
              {isGroup ? (
                <button
                  className={styles.disclosureBtn}
                  onClick={(e) => {
                    e.stopPropagation()
                    dispatch({ type: 'TOGGLE_GROUP_COLLAPSE', payload: layer.id })
                  }}
                  aria-label={(layer as GroupLayerState | CompositeLayerState).collapsed ? 'Expand group' : 'Collapse group'}
                  title={(layer as GroupLayerState | CompositeLayerState).collapsed ? 'Expand group' : 'Collapse group'}
                >
                  {(layer as GroupLayerState | CompositeLayerState).collapsed ? '▶' : '▼'}
                </button>
              ) : !isChild && hasChildren ? (
                <button
                  className={styles.disclosureBtn}
                  onClick={(e) => {
                    e.stopPropagation()
                    togglePixelLayerCollapse(layer.id)
                  }}
                  aria-label={isPixelCollapsed ? 'Show adjustments' : 'Hide adjustments'}
                  title={isPixelCollapsed ? 'Show adjustments' : 'Hide adjustments'}
                >
                  {isPixelCollapsed ? '▶' : '▼'}
                </button>
              ) : (
                !isChild && <div className={styles.disclosureSpacer} />
              )}

              {isChild && <div className={styles.childConnector} />}

              <button
                className={styles.eyeBtn}
                onClick={(e) => { e.stopPropagation(); onLayerToggleVisibility(layer.id) }}
                aria-label={layer.visible ? 'Hide layer' : 'Show layer'}
              >
                {isMask
                  ? <MaskIcon active={layer.visible} />
                  : isAdjustment
                    ? <AdjustmentIcon />
                    : <EyeIcon visible={layer.visible} />
                }
              </button>

              {isAdjustment
                ? <div className={styles.adjThumb} aria-hidden="true"><AdjustmentIcon /></div>
                : isGroup
                  ? <div className={styles.groupThumb} aria-hidden="true">
                      {isCompositeLayer(layer) ? <CompositeIcon /> : <FolderIcon />}
                    </div>
                  : isText
                    ? <div className={styles.textThumb} aria-hidden="true">T</div>
                    : <div className={`${styles.thumb} ${isMask ? styles.maskThumb : ''}`} aria-hidden="true" />
              }

              {editingId === layer.id ? (
                <input
                  autoFocus
                  className={styles.nameInput}
                  value={editingName}
                  onChange={(e) => setEditingName(e.target.value)}
                  onBlur={commitEdit}
                  onKeyDown={handleEditKey}
                  onClick={(e) => e.stopPropagation()}
                />
              ) : (
                <span
                  className={isAdjustment ? styles.adjName : styles.name}
                  onDoubleClick={(e) => startEdit(layer, e)}
                  title="Double-click to rename"
                >
                  {highlightMatch(layer.name, filterQuery)}
                </span>
              )}

              {!isChild && (layer as { locked?: boolean }).locked && (
                <span className={styles.lockIcon}><LockIcon locked /></span>
              )}
            </li>
          )
        })}
      </ul>

      {/* ── Footer toolbar ────────────────────────────────────────────── */}
      <div className={styles.footer}>
        {filterQuery !== '' && (
          <span className={styles.filterCount}>{filteredRows.length} of {layers.length}</span>
        )}
        <button className={styles.footerBtn} onClick={onLayerAdd} aria-label="New layer" title="New layer">
          <AddLayerIcon />
        </button>
        <button className={styles.footerBtn} onClick={onAddGroup} aria-label="New group" title="New layer group">
          <AddGroupIcon />
        </button>
        <button
          className={styles.footerBtn}
          onClick={() => activeLayerId && onLayerDelete(activeLayerId)}
          aria-label="Delete layer"
          title="Delete layer"
          disabled={!canDelete}
        >
          <DeleteLayerIcon />
        </button>
      </div>

      {/* ── Context menu ──────────────────────────────────────────────── */}
      {contextMenu && (
        <>
          <div className={styles.menuBackdrop} onMouseDown={closeContextMenu} />
          <div
            className={styles.contextMenu}
            style={contextMenu.flipX
              ? { right: window.innerWidth - contextMenu.x, top: contextMenu.y }
              : { left: contextMenu.x, top: contextMenu.y }
            }
          >
            <button
              className={styles.menuItem}
              disabled={!canAddMask}
              onMouseDown={() => { closeContextMenu(); if (activeLayerId) onAddMaskLayer(activeLayerId) }}
            >
              Add Layer Mask
            </button>
            <button
              className={styles.menuItem}
              disabled={!canRasterize}
              onMouseDown={() => { closeContextMenu(); if (activeLayerId) onRasterizeLayer(activeLayerId) }}
            >
              Rasterize Layer
            </button>
            <button
              className={styles.menuItem}
              disabled={!activeLayerId}
              onMouseDown={() => { closeContextMenu(); onDuplicateLayer() }}
            >
              Duplicate Layer
            </button>
            <button
              className={styles.menuItem}
              disabled={!canDelete}
              onMouseDown={() => {
                closeContextMenu()
                if (activeLayerId) onLayerDelete(activeLayerId)
              }}
            >
              Delete Layer
            </button>
            <div className={styles.menuDivider} />
            {/* Group operations */}
            {new Set([...selectedIds, ...(activeLayerId ? [activeLayerId] : [])]).size >= 2 && (
              <button
                className={styles.menuItem}
                onMouseDown={() => {
                  closeContextMenu()
                  const effective = [...new Set([...selectedIds, ...(activeLayerId ? [activeLayerId] : [])])]
                  onGroupSelected(effective)
                  setSelectedIds(new Set())
                }}
              >
                New Group from Selection
              </button>
            )}
            {isActiveGroup && (
              <button
                className={styles.menuItem}
                onMouseDown={() => { closeContextMenu(); if (activeLayerId) onUngroup(activeLayerId) }}
              >
                Ungroup
              </button>
            )}
            {isActiveGroup && (
              <button
                className={styles.menuItem}
                onMouseDown={() => { closeContextMenu(); if (activeLayerId) onMergeGroup(activeLayerId) }}
              >
                Merge Group
              </button>
            )}
            {(new Set([...selectedIds, ...(activeLayerId ? [activeLayerId] : [])]).size >= 2 || isActiveGroup) && (
              <div className={styles.menuDivider} />
            )}
            <button
              className={styles.menuItem}
              disabled={new Set([...selectedIds, ...(activeLayerId ? [activeLayerId] : [])]).size < 2}
              onMouseDown={execMergeSelected}
            >
              Merge Selected
            </button>
            <button
              className={styles.menuItem}
              disabled={layers.filter((l) => l.visible && !('type' in l && (l.type === 'mask' || l.type === 'adjustment'))).length < 2}
              onMouseDown={execMergeVisible}
            >
              Merge Visible
            </button>
            <button
              className={styles.menuItem}
              disabled={!activeLayerId || layers.findIndex((l) => l.id === activeLayerId) === 0}
              onMouseDown={execMergeDown}
            >
              Merge Down
            </button>
            <button
              className={styles.menuItem}
              disabled={layers.filter(l => !('type' in l && (l.type === 'mask' || l.type === 'adjustment'))).length < 2}
              onMouseDown={execFlattenImage}
            >
              Flatten Image
            </button>
          </div>
        </>
      )}
    </div>
  )
}
