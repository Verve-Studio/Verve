import React, { useEffect, useRef, useMemo, useState, useCallback } from 'react'
import ReactDOM from 'react-dom'
import { useAppContext } from '@/core/store/AppContext'
import { usePaletteFileOps } from '@/core/services/usePaletteFileOps'
import { sortSwatchesByHue } from '@/utils/swatchSort'
import { ModalDialog } from '@/ux/modals/ModalDialog/ModalDialog'
import { DialogButton } from '@/ux/widgets/DialogButton/DialogButton'
import { showOperationError } from '@/utils/userFeedback'
import styles from './SwatchPanel.module.scss'

interface SwatchPanelProps {
  activeTabId: string
  onGeneratePalette?: () => void
}

export function SwatchPanel({ activeTabId, onGeneratePalette }: SwatchPanelProps): React.JSX.Element {
  const { state, dispatch } = useAppContext()
  const { handleSavePalette, handleSavePaletteAs, handleOpenPalette, paletteError, clearPaletteError } =
    usePaletteFileOps({ swatches: state.swatches, dispatch })

  // ── Selection state (transient, not persisted) ────────────────────
  const [selectedIndices, setSelectedIndices] = useState<number[]>([])
  const anchorIndexRef = useRef<number | null>(null)

  // ── Active group highlight (transient, not persisted) ─────────────
  const [activeGroupId, setActiveGroupId] = useState<string | null>(null)

  // ── Indexed8 swatch removal confirmation ─────────────────────────
  const [pendingSwatchRemoval, setPendingSwatchRemoval] = useState<number | null>(null)

  // ── Context menu ──────────────────────────────────────────────────
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; canonicalIndex: number } | null>(null)
  const contextMenuRef = useRef<HTMLDivElement>(null)

  // ── Group name prompt ─────────────────────────────────────────────
  const [groupPromptOpen, setGroupPromptOpen] = useState(false)
  const [groupPromptName, setGroupPromptName] = useState('')
  const [groupPromptError, setGroupPromptError] = useState<string | null>(null)
  const [groupPromptMode, setGroupPromptMode] = useState<'create' | 'rename'>('create')
  // Indices to use when confirming a create prompt
  const groupPromptIndicesRef = useRef<number[]>([])

  // ── Hamburger menu ────────────────────────────────────────────────
  const [menuOpen, setMenuOpen] = useState(false)
  const [dropdownPos, setDropdownPos] = useState<{ top: number; right: number }>({ top: 0, right: 0 })
  const menuBtnRef = useRef<HTMLButtonElement>(null)
  const dropdownRef = useRef<HTMLDivElement>(null)

  // Reset transient UI state when the tab changes
  useEffect(() => {
    setSelectedIndices([])
    anchorIndexRef.current = null
    setActiveGroupId(null)
    setContextMenu(null)
  }, [activeTabId])

  // Guard: if the active group was deleted, reset
  if (activeGroupId !== null && !state.swatchGroups.some(g => g.id === activeGroupId)) {
    setActiveGroupId(null)
  }

  // Dismiss hamburger menu on outside click
  useEffect(() => {
    if (!menuOpen) return
    function handleClick(e: MouseEvent) {
      const target = e.target as Node
      const inBtn = menuBtnRef.current?.contains(target) ?? false
      const inDrop = dropdownRef.current?.contains(target) ?? false
      if (!inBtn && !inDrop) setMenuOpen(false)
    }
    document.addEventListener('mousedown', handleClick)
    return () => document.removeEventListener('mousedown', handleClick)
  }, [menuOpen])

  // Dismiss context menu on outside click or Escape
  useEffect(() => {
    if (contextMenu === null) return
    function handleMouseDown(e: MouseEvent) {
      if (contextMenuRef.current && !contextMenuRef.current.contains(e.target as Node)) {
        setContextMenu(null)
      }
    }
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') setContextMenu(null)
    }
    document.addEventListener('mousedown', handleMouseDown)
    document.addEventListener('keydown', handleKeyDown)
    return () => {
      document.removeEventListener('mousedown', handleMouseDown)
      document.removeEventListener('keydown', handleKeyDown)
    }
  }, [contextMenu])

  function openMenu() {
    if (!menuBtnRef.current) return
    const rect = menuBtnRef.current.getBoundingClientRect()
    setDropdownPos({ top: rect.bottom + 3, right: window.innerWidth - rect.right })
    setMenuOpen(o => !o)
  }

  const displayEntries = useMemo(
    () => sortSwatchesByHue(state.swatches),
    [state.swatches],
  )

  const highlightedCanonicalIndices = useMemo<Set<number>>(() => {
    if (activeGroupId === null) return new Set()
    const group = state.swatchGroups.find(g => g.id === activeGroupId)
    return new Set(group?.swatchIndices ?? [])
  }, [activeGroupId, state.swatchGroups])

  const handleSwatchClick = useCallback((
    e: React.MouseEvent,
    canonicalIndex: number,
    displayIndex: number,
  ) => {
    if (e.shiftKey && anchorIndexRef.current !== null) {
      const anchorDisplayIdx = displayEntries.findIndex(
        entry => entry.canonicalIndex === anchorIndexRef.current,
      )
      const [lo, hi] = [
        Math.min(anchorDisplayIdx, displayIndex),
        Math.max(anchorDisplayIdx, displayIndex),
      ]
      setSelectedIndices(displayEntries.slice(lo, hi + 1).map(entry => entry.canonicalIndex))
      return
    }
    if (e.ctrlKey || e.metaKey) {
      e.preventDefault()
      setSelectedIndices(prev =>
        prev.includes(canonicalIndex)
          ? prev.filter(i => i !== canonicalIndex)
          : [...prev, canonicalIndex]
      )
      return
    }
    const sw = state.swatches[canonicalIndex]
    dispatch({ type: 'SET_PRIMARY_COLOR', payload: { r: sw.r/255, g: sw.g/255, b: sw.b/255, a: sw.a/255 } })
    setSelectedIndices([canonicalIndex])
    anchorIndexRef.current = canonicalIndex
  }, [dispatch, displayEntries, state.swatches])

  const handleContextMenu = useCallback((e: React.MouseEvent, canonicalIndex: number) => {
    e.preventDefault()
    // On macOS, Ctrl+click is routed to contextmenu at the OS level — onClick never fires.
    // Handle it as a multi-select toggle here instead of opening the context menu.
    if (e.ctrlKey) {
      setSelectedIndices(prev =>
        prev.includes(canonicalIndex)
          ? prev.filter(i => i !== canonicalIndex)
          : [...prev, canonicalIndex]
      )
      return
    }
    const menuWidth = 180
    const x = e.clientX + menuWidth > window.innerWidth
      ? e.clientX - menuWidth
      : e.clientX
    setContextMenu({ x, y: e.clientY, canonicalIndex })
  }, [])

  function openCreateGroupPrompt(indices: number[]) {
    groupPromptIndicesRef.current = indices
    setGroupPromptMode('create')
    setGroupPromptName('')
    setGroupPromptError(null)
    setGroupPromptOpen(true)
    setContextMenu(null)
  }

  function openRenameGroupPrompt() {
    if (activeGroupId === null) return
    const group = state.swatchGroups.find(g => g.id === activeGroupId)
    if (!group) return
    setGroupPromptMode('rename')
    setGroupPromptName(group.name)
    setGroupPromptError(null)
    setGroupPromptOpen(true)
    setContextMenu(null)
  }

  function handleGroupPromptConfirm() {
    const name = groupPromptName.trim()
    if (!name) {
      setGroupPromptError('Name cannot be empty.')
      return
    }
    if (groupPromptMode === 'rename') {
      const conflict = state.swatchGroups.find(g => g.name === name && g.id !== activeGroupId)
      if (conflict) {
        setGroupPromptError('A group with that name already exists.')
        return
      }
      dispatch({ type: 'RENAME_SWATCH_GROUP', payload: { id: activeGroupId!, name } })
    } else {
      dispatch({ type: 'ADD_SWATCH_GROUP', payload: { name, swatchIndices: groupPromptIndicesRef.current } })
    }
    setGroupPromptOpen(false)
    setGroupPromptName('')
    setGroupPromptError(null)
  }

  const activeGroupMemberSet = useMemo(() => {
    if (activeGroupId === null) return new Set<number>()
    const group = state.swatchGroups.find(g => g.id === activeGroupId)
    return new Set(group?.swatchIndices ?? [])
  }, [activeGroupId, state.swatchGroups])

  return (
    <div
      className={styles.panelBody}
      onClick={(e) => {
        if (e.target === e.currentTarget) setSelectedIndices([])
      }}
    >
      <div className={styles.actions}>
        <select
          value={activeGroupId ?? ''}
          onChange={e => setActiveGroupId(e.target.value || null)}
          className={styles.groupSelect}
          aria-label="Highlight group"
          title={activeGroupId !== null ? (state.swatchGroups.find(g => g.id === activeGroupId)?.name ?? '') : 'All swatches'}
        >
          <option value="">All swatches</option>
          {state.swatchGroups.map(g => (
            <option key={g.id} value={g.id}>{g.name}</option>
          ))}
        </select>
        <button
          type="button"
          className={styles.removeGroupBtn}
          disabled={activeGroupId === null}
          aria-label="Remove group"
          onClick={() => {
            if (activeGroupId === null) return
            dispatch({ type: 'REMOVE_SWATCH_GROUP', payload: activeGroupId })
            setActiveGroupId(null)
          }}
        >
          ×
        </button>
        <div className={styles.menuWrap}>
          <button
            ref={menuBtnRef}
            type="button"
            className={styles.menuBtn}
            aria-label="Palette file options"
            aria-expanded={menuOpen}
            onClick={openMenu}
          >
            ≡
          </button>
          {menuOpen && ReactDOM.createPortal(
            <div
              ref={dropdownRef}
              className={styles.dropdown}
              style={{ position: 'fixed', top: dropdownPos.top, right: dropdownPos.right }}
            >
              <button
                type="button"
                className={styles.dropdownItem}
                onClick={() => { setMenuOpen(false); onGeneratePalette?.() }}
              >
                Generate Palette…
              </button>
              <div className={styles.dropdownSeparator} />
              <button
                type="button"
                className={styles.dropdownItem}
                onClick={() => { setMenuOpen(false); void handleSavePalette() }}
              >
                Save Palette
              </button>
              <button
                type="button"
                className={styles.dropdownItem}
                onClick={() => { setMenuOpen(false); void handleSavePaletteAs() }}
              >
                Save Palette As…
              </button>
              <div className={styles.dropdownSeparator} />
              <button
                type="button"
                className={styles.dropdownItem}
                onClick={() => { setMenuOpen(false); void handleOpenPalette() }}
              >
                Open Palette…
              </button>
              <div className={styles.dropdownSeparator} />
              <button
                type="button"
                className={styles.dropdownItem}
                onClick={() => { setMenuOpen(false); dispatch({ type: 'SET_SWATCHES', payload: [] }) }}
              >
                Clear Palette
              </button>
            </div>,
            document.body
          )}
        </div>
      </div>
      {paletteError != null && (
        <div className={styles.errorBanner}>
          <span className={styles.errorText}>{paletteError}</span>
          <button
            type="button"
            className={styles.errorDismiss}
            aria-label="Dismiss error"
            onClick={() => clearPaletteError()}
          >
            ×
          </button>
        </div>
      )}
      <div className={styles.swatchGrid}>
        {displayEntries.map((entry, displayIndex) => {
          const { color, canonicalIndex } = entry
          const hex = `#${[color.r, color.g, color.b].map((v) => v.toString(16).padStart(2, '0')).join('')}`
          // Swatches are 0-255; primaryColor is float [0,1]. Compare in 0-255 space.
          const isActive =
            color.r === Math.round(state.primaryColor.r * 255) &&
            color.g === Math.round(state.primaryColor.g * 255) &&
            color.b === Math.round(state.primaryColor.b * 255) &&
            color.a === Math.round(state.primaryColor.a * 255)
          const isSelected = selectedIndices.includes(canonicalIndex)
          const isGroupHighlighted = highlightedCanonicalIndices.has(canonicalIndex)
          const cellClass = [
            styles.swatchCell,
            isActive           ? styles.swatchActive           : '',
            isSelected         ? styles.swatchSelected         : '',
            isGroupHighlighted ? styles.swatchGroupHighlight   : '',
          ].filter(Boolean).join(' ')
          return (
            <button
              key={`${canonicalIndex}-${color.r}-${color.g}-${color.b}-${color.a}`}
              className={cellClass}
              style={{ background: hex }}
              title={hex.toUpperCase()}
              aria-label={`Swatch ${hex.toUpperCase()}`}
              onClick={(e) => handleSwatchClick(e, canonicalIndex, displayIndex)}
              onContextMenu={(e) => handleContextMenu(e, canonicalIndex)}
            />
          )
        })}
        {state.swatches.length === 0 && (
          <span className={styles.swatchesEmpty}>No swatches yet. Add colors from the Color Picker.</span>
        )}
      </div>

      {/* ── Context menu portal ──────────────────────────────────────── */}
      {contextMenu !== null && ReactDOM.createPortal(
        <div
          ref={contextMenuRef}
          className={styles.contextMenu}
          style={{ position: 'fixed', top: contextMenu.y, left: contextMenu.x }}
        >
          <button
            type="button"
            className={styles.contextMenuItem}
            onClick={() => {
              if (state.pixelFormat === 'indexed8' && state.swatches.length <= 1) {
                showOperationError(
                  'Cannot remove all swatches while in Indexed/8 mode.',
                  'At least one palette entry is required.',
                )
                setContextMenu(null)
                return
              }
              if (state.pixelFormat === 'indexed8') {
                setPendingSwatchRemoval(contextMenu.canonicalIndex)
                setContextMenu(null)
                return
              }
              dispatch({ type: 'REMOVE_SWATCH', payload: contextMenu.canonicalIndex })
              setContextMenu(null)
            }}
          >
            Delete
          </button>
          <button
            type="button"
            className={styles.contextMenuItem}
            onClick={() => {
              const indices = selectedIndices.length > 0 ? selectedIndices : [contextMenu.canonicalIndex]
              openCreateGroupPrompt(indices)
            }}
          >
            Group Selected Entries…
          </button>
          {activeGroupId !== null && (
            <button
              type="button"
              className={styles.contextMenuItem}
              onClick={() => {
                const indices = selectedIndices.length > 0 ? selectedIndices : [contextMenu.canonicalIndex]
                dispatch({ type: 'ADD_SWATCHES_TO_GROUP', payload: { id: activeGroupId, swatchIndices: indices } })
                setContextMenu(null)
              }}
            >
              Add to &ldquo;{state.swatchGroups.find(g => g.id === activeGroupId)?.name}&rdquo;
            </button>
          )}
          {activeGroupId !== null && activeGroupMemberSet.has(contextMenu.canonicalIndex) && (
            <button
              type="button"
              className={styles.contextMenuItem}
              onClick={openRenameGroupPrompt}
            >
              Rename Group…
            </button>
          )}
        </div>,
        document.body
      )}

      {/* ── Group name prompt ────────────────────────────────────────── */}
      <ModalDialog
        title={groupPromptMode === 'create' ? 'Create / Join Group' : 'Rename Group'}
        open={groupPromptOpen}
        onClose={() => { setGroupPromptOpen(false); setGroupPromptError(null) }}
        width={300}
      >
        <div className={styles.promptBody}>
          <input
            type="text"
            className={styles.promptInput}
            value={groupPromptName}
            onChange={e => { setGroupPromptName(e.target.value); setGroupPromptError(null) }}
            onKeyDown={e => { if (e.key === 'Enter') handleGroupPromptConfirm() }}
            autoFocus
            placeholder="Group name"
          />
          {groupPromptError && <p className={styles.promptError}>{groupPromptError}</p>}
          <div className={styles.promptButtons}>
            <DialogButton primary onClick={handleGroupPromptConfirm}>OK</DialogButton>
            <DialogButton onClick={() => { setGroupPromptOpen(false); setGroupPromptError(null) }}>Cancel</DialogButton>
          </div>
        </div>
      </ModalDialog>
      {/* ── Indexed8 swatch removal confirmation ──────────────────── */}
      <ModalDialog
        title="Remove Palette Entry"
        open={pendingSwatchRemoval !== null}
        onClose={() => setPendingSwatchRemoval(null)}
        width={360}
      >
        <div className={styles.promptBody}>
          <p style={{ margin: '0 0 12px', fontSize: 13, color: '#ccc', lineHeight: 1.5 }}>
            Removing this swatch will shift palette indices in all pixel layers. This operation can be undone.
          </p>
          <div className={styles.promptButtons}>
            <DialogButton primary onClick={() => {
              if (pendingSwatchRemoval !== null) {
                dispatch({ type: 'REMOVE_SWATCH', payload: pendingSwatchRemoval })
              }
              setPendingSwatchRemoval(null)
            }}>Remove</DialogButton>
            <DialogButton onClick={() => setPendingSwatchRemoval(null)}>Cancel</DialogButton>
          </div>
        </div>
      </ModalDialog>
    </div>
  )
}
