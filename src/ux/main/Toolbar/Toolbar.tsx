import { useAppContext } from '@/core/store/AppContext'
import type { RGBAColor, ShapeType, Tool } from '@/types'
import { ColorPickerDialog } from '@/ux/modals/ColorPickerDialog/ColorPickerDialog'
import { IndexedPaletteColorPicker } from '@/ux/widgets/IndexedPaletteColorPicker/IndexedPaletteColorPicker'
import React, { useEffect, useRef, useState } from 'react'
import styles from './Toolbar.module.scss'

// ─── SVG Icons ────────────────────────────────────────────────────────────────

const Icon = {
  move: (
    <svg viewBox="0 0 16 16" fill="currentColor">
      <path d="M8 1L5.5 4H7v3H4V5.5L1 8l3 2.5V9h3v3H5.5L8 15l2.5-3H9V9h3v1.5L15 8l-3-2.5V7H9V4h1.5z" />
    </svg>
  ),
  select: (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4">
      <rect x="2" y="2" width="12" height="12" strokeDasharray="3 2" />
    </svg>
  ),
  lasso: (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round">
      <path d="M8 2C4.7 2 2 4.5 2 7s2.2 4 6 4c2.8 0 4-1.3 4-2.5 0-1.1-1-2-2.5-2S7 7.5 7 9" strokeDasharray="2.5 1.5" />
      <line x1="7" y1="9" x2="5" y2="14" />
    </svg>
  ),
  polygonalLasso: (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="3,13 3,5 7,2 13,4 13,10 8,13" strokeDasharray="2.5 1.5" />
      <circle cx="3" cy="13" r="1.2" fill="currentColor" />
    </svg>
  ),
  objectSelection: (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3">
      <rect x="1" y="1" width="14" height="14" rx="1" strokeDasharray="3 2" />
      <circle cx="11.5" cy="4.5" r="1" fill="currentColor" stroke="none" />
      <path d="M9 7l1.5 1.5L13 5" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.4" />
    </svg>
  ),
  magicWand: (
    <svg viewBox="0 0 16 16" fill="currentColor">
      <rect x="1.5" y="11.5" width="7" height="2" rx="1" transform="rotate(-45 5 12.5)" />
      <path d="M10.5 1l.8 2.2L13.5 4l-2.2.8L10.5 7l-.8-2.2L7.5 4l2.2-.8z" />
      <circle cx="13.5" cy="8" r="0.9" />
      <circle cx="9.5" cy="4.5" r="0.6" />
    </svg>
  ),
  crop: (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
      <path d="M4 1v10h9" />
      <path d="M1 4h10v9" />
    </svg>
  ),
  frame: (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3">
      <rect x="2" y="2" width="12" height="12" rx="1" />
      <rect x="5" y="5" width="6" height="6" rx="0.5" />
    </svg>
  ),
  eyedropper: (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round">
      <path d="M11.5 2l2.5 2.5-7.5 7.5-1-0.5-1.5 3-2-2 3-1.5-0.5-1z" fill="currentColor" fillOpacity="0.2" />
      <path d="M11.5 2l2.5 2.5-7.5 7.5-3-3z" />
      <circle cx="3" cy="13" r="1.3" fill="currentColor" />
    </svg>
  ),
  pencil: (
    <svg viewBox="0 0 16 16" fill="currentColor">
      <path d="M11.5 1.5l3 3-9 9L3 14.5l.5-2.5z" />
      <path d="M10 3l3 3" stroke="currentColor" strokeWidth="0.8" fill="none" opacity="0.5" />
    </svg>
  ),
  brush: (
    <svg viewBox="0 0 16 16" fill="currentColor">
      <path d="M13.5 1.5l1 1L7 10l-2 .5.5-2z" />
      <path d="M5.5 11C5.5 12.5 4 14 2.5 13.5 2 13 2 11.5 3.5 11 4.5 10.5 5.5 10.5 5.5 11z" />
    </svg>
  ),
  eraser: (
    <svg viewBox="0 0 16 16" fill="currentColor">
      <path d="M3 13L9.5 6.5l4 4-4.5 4.5H3z" opacity="0.35" />
      <path d="M3 13L9.5 6.5l4 4-4.5 4.5H3z" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" />
      <line x1="2" y1="14.5" x2="14" y2="14.5" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
    </svg>
  ),
  fill: (
    <svg viewBox="0 0 16 16" fill="currentColor">
      {/* bucket body */}
      <path d="M3.5 7h9l-1.2 5.5a1 1 0 01-1 .8H5.7a1 1 0 01-1-.8z" />
      {/* bucket top rim */}
      <rect x="3" y="5.5" width="10" height="1.5" rx="0.5" />
      {/* handle */}
      <path d="M6 5.5V4a2 2 0 014 0v1.5" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
      {/* drip */}
      <path d="M13 12a1.2 1.2 0 002.4 0c0-.7-.5-1.4-1.2-2.3-.7.9-1.2 1.6-1.2 2.3z" />
    </svg>
  ),
  gradient: (
    <svg viewBox="0 0 16 16" fill="currentColor">
      <defs>
        <linearGradient id="toolbar-grad" x1="0" y1="0" x2="1" y2="0">
          <stop offset="0%" stopColor="currentColor" stopOpacity="1" />
          <stop offset="100%" stopColor="currentColor" stopOpacity="0.08" />
        </linearGradient>
      </defs>
      <rect x="2" y="6" width="12" height="4" rx="1" fill="url(#toolbar-grad)" />
    </svg>
  ),
  dodge: (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round">
      <ellipse cx="8" cy="11" rx="5" ry="3" />
      <line x1="8" y1="8" x2="8" y2="2" />
    </svg>
  ),
  burn: (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round">
      <path d="M8 2C5.5 5 3.5 6.5 3.5 9.5a4.5 4.5 0 009 0C12.5 6.5 10.5 5 8 2z" />
      <path d="M8 5C8 8 10 8.5 9 11" strokeWidth="1.2" />
    </svg>
  ),
  text: (
    <svg viewBox="0 0 16 16" fill="currentColor">
      <path d="M3 3h10v2H9.5v8h-3V5H3z" />
    </svg>
  ),
  shape: (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round">
      <rect x="1" y="1" width="6" height="6" rx="0.5" />
      <circle cx="12" cy="4" r="3" />
      <polygon points="2,15 14,15 8,9.5" />
    </svg>
  ),
  cloneStamp: (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round">
      <rect x="5" y="7" width="6" height="5" rx="0.5" />
      <line x1="8" y1="2" x2="8" y2="7" />
      <line x1="5.5" y1="2" x2="10.5" y2="2" />
      <line x1="8" y1="0.5" x2="8" y2="3.5" />
    </svg>
  ),
}

// ─── Shape picker definitions ─────────────────────────────────────────────────

interface ShapeDef {
  id: ShapeType
  label: string
  icon: React.JSX.Element
}

const SHAPE_DEFS: ShapeDef[] = [
  {
    id: 'rectangle',
    label: 'Rectangle',
    icon: (
      <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
        <rect x="1.5" y="3.5" width="13" height="9" rx="0.5" />
      </svg>
    ),
  },
  {
    id: 'ellipse',
    label: 'Ellipse',
    icon: (
      <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
        <ellipse cx="8" cy="8" rx="6.5" ry="4.5" />
      </svg>
    ),
  },
  {
    id: 'triangle',
    label: 'Triangle',
    icon: (
      <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round">
        <polygon points="8,1.5 14.5,14.5 1.5,14.5" />
      </svg>
    ),
  },
  {
    id: 'line',
    label: 'Line',
    icon: (
      <svg viewBox="0 0 16 16" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
        <line x1="2.5" y1="13.5" x2="13.5" y2="2.5" />
      </svg>
    ),
  },
  {
    id: 'diamond',
    label: 'Diamond',
    icon: (
      <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round">
        <polygon points="8,1.5 14.5,8 8,14.5 1.5,8" />
      </svg>
    ),
  },
  {
    id: 'star',
    label: 'Star',
    icon: (
      <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round">
        <polygon points="8,1.5 9.47,5.98 13.23,6.3 10.38,8.77 11.23,12.45 8,10.5 4.77,12.45 5.62,8.77 2.77,6.3 6.53,5.98" />
      </svg>
    ),
  },
]

function getShapeIcon(shape: ShapeType): React.JSX.Element {
  return SHAPE_DEFS.find(s => s.id === shape)?.icon ?? SHAPE_DEFS[0].icon
}



interface ToolDef {
  id: Tool
  label: string
  shortcut: string
  icon: React.JSX.Element
}

type ToolGrid = (ToolDef | null)[][]

const TOOL_GRID: ToolGrid = [
  // group 1
  [
    { id: 'move',       label: 'Move',          shortcut: 'V', icon: Icon.move },
    null
  ],
  // group 2 – selection
  [
    { id: 'select',              label: 'Marquee',          shortcut: 'M', icon: Icon.select },
    { id: 'lasso',               label: 'Lasso',            shortcut: 'L', icon: Icon.lasso }
  ],
  [
    { id: 'polygonal-selection', label: 'Polygonal Lasso',  shortcut: 'L', icon: Icon.polygonalLasso },
    { id: 'object-selection',    label: 'Object Selection', shortcut: 'W', icon: Icon.objectSelection }
  ],
  [
    { id: 'magic-wand',          label: 'Magic Wand',       shortcut: 'W', icon: Icon.magicWand },
    null,
  ],
  [
    { id: 'crop',                label: 'Crop',             shortcut: 'C', icon: Icon.crop },
    null
  ],
  // group 3 – sampling
  [
    { id: 'eyedropper', label: 'Eyedropper',    shortcut: 'I', icon: Icon.eyedropper },
    { id: 'frame',      label: 'Frame',         shortcut: 'K', icon: Icon.frame }
  ],
  // group 4 – painting
  [
    { id: 'brush',      label: 'Brush',         shortcut: 'B', icon: Icon.brush },
    { id: 'pencil',     label: 'Pencil',        shortcut: 'N', icon: Icon.pencil }
  ],
  [
    { id: 'eraser',     label: 'Eraser',        shortcut: 'E', icon: Icon.eraser },
    null
  ],
  [
    { id: 'clone-stamp', label: 'Clone Stamp',  shortcut: 'S', icon: Icon.cloneStamp },
    null
  ],
  // group 5 – fills
  [
    { id: 'fill',       label: 'Paint Bucket',  shortcut: 'G', icon: Icon.fill },
    { id: 'gradient',   label: 'Gradient',      shortcut: 'G', icon: Icon.gradient }
  ],
  // group 6 – toning
  [
    { id: 'dodge',      label: 'Dodge',         shortcut: 'O', icon: Icon.dodge },
    { id: 'burn',       label: 'Burn',          shortcut: 'O', icon: Icon.burn }
  ],
  // group 7 – vector
  [
    { id: 'text',       label: 'Type',          shortcut: 'T', icon: Icon.text },
    { id: 'shape',      label: 'Shape',         shortcut: 'U', icon: Icon.shape }
  ]
]

/** Tools that can only operate on a pixel layer. */
const PIXEL_ONLY_TOOLS = new Set<Tool>(['brush', 'pencil', 'eraser', 'clone-stamp', 'fill', 'gradient', 'dodge', 'burn'])

/** Tools that have no indexed8 implementation. */
const INDEXED8_UNSUPPORTED_TOOLS = new Set<Tool>(['brush', 'gradient', 'dodge', 'burn', 'clone-stamp', 'text', 'shape', 'frame'])

// ─── Component ────────────────────────────────────────────────────────────────

interface ToolbarProps {
  activeTool?: Tool
  onToolChange?: (tool: Tool) => void
}

export function Toolbar({ activeTool = 'pencil', onToolChange }: ToolbarProps): React.JSX.Element {
  const { state, dispatch } = useAppContext()
  const [dialogOpen, setDialogOpen]         = useState(false)
  const [dialogTarget, setDialogTarget]     = useState<'fg' | 'bg'>('fg')
  const [dialogIsSwatchAdd, setDialogIsSwatchAdd] = useState(false)
  const [indexedPickerTarget, setIndexedPickerTarget] = useState<'fg' | 'bg' | null>(null)
  const [indexedPickerAnchor, setIndexedPickerAnchor] = useState<{ x: number; y: number }>({ x: 0, y: 0 })
  const [shapePickerOpen, setShapePickerOpen] = useState(false)
  const [flyoutY, setFlyoutY]               = useState(0)
  const shapePickerOpenRef                  = useRef(false)
  const shapeButtonRef                      = useRef<HTMLDivElement>(null)
  const flyoutRef                           = useRef<HTMLDivElement>(null)

  const activeLayer = state.layers.find(l => l.id === state.activeLayerId) ?? null
  const pixelToolsDisabled = activeLayer == null || 'type' in activeLayer
  const indexedModeActive  = state.pixelFormat === 'indexed8'

  // Single always-mounted listener — no mount/unmount race on each toggle
  useEffect(() => {
    const close = (e: MouseEvent) => {
      if (!shapePickerOpenRef.current) return
      const target = e.target as Node
      if (flyoutRef.current?.contains(target) || shapeButtonRef.current?.contains(target)) return
      shapePickerOpenRef.current = false
      setShapePickerOpen(false)
    }
    document.addEventListener('mousedown', close)
    return () => document.removeEventListener('mousedown', close)
  }, [])

  const openShapePicker = () => {
    if (shapeButtonRef.current) {
      const rect = shapeButtonRef.current.getBoundingClientRect()
      setFlyoutY(rect.top)
    }
    const next = !shapePickerOpenRef.current
    shapePickerOpenRef.current = next
    setShapePickerOpen(next)
  }

  const selectShape = (shape: ShapeType) => {
    dispatch({ type: 'SET_SHAPE', payload: shape })
    onToolChange?.('shape')
    shapePickerOpenRef.current = false
    setShapePickerOpen(false)
  }

  const fgColor = state.primaryColor
  const bgColor = state.secondaryColor
  const fgStyle = `rgb(${fgColor.r},${fgColor.g},${fgColor.b})`
  const bgStyle = `rgb(${bgColor.r},${bgColor.g},${bgColor.b})`

  const openPicker = (target: 'fg' | 'bg', e: React.MouseEvent): void => {
    if (state.pixelFormat === 'indexed8') {
      const rect = (e.currentTarget as HTMLElement).getBoundingClientRect()
      setIndexedPickerAnchor({ x: rect.right + 8, y: rect.top })
      setIndexedPickerTarget(target)
      return
    }
    setDialogTarget(target)
    setDialogOpen(true)
  }

  const handleConfirm = (color: RGBAColor): void => {
    if (dialogIsSwatchAdd) {
      dispatch({ type: 'ADD_SWATCH', payload: color })
    } else {
      dispatch({
        type: dialogTarget === 'fg' ? 'SET_PRIMARY_COLOR' : 'SET_SECONDARY_COLOR',
        payload: color,
      })
    }
    setDialogIsSwatchAdd(false)
    setDialogOpen(false)
  }

  const handleSwap = (): void => {
    dispatch({ type: 'SET_PRIMARY_COLOR',   payload: bgColor })
    dispatch({ type: 'SET_SECONDARY_COLOR', payload: fgColor })
  }

  const handleReset = (): void => {
    dispatch({ type: 'SET_PRIMARY_COLOR',   payload: { r: 0,   g: 0,   b: 0,   a: 255 } })
    dispatch({ type: 'SET_SECONDARY_COLOR', payload: { r: 255, g: 255, b: 255, a: 255 } })
  }

  return (
    <>
    <nav className={styles.toolbar} aria-label="Drawing tools">
      <ul className={styles.grid} role="list">
        {TOOL_GRID.map((row, rowIdx) => {
          const isFirstInGroup =
            rowIdx === 0 ||
            (rowIdx === 1) || (rowIdx === 4) || (rowIdx === 5) || (rowIdx === 8) || (rowIdx === 9) || (rowIdx === 10)

          return (
            <React.Fragment key={rowIdx}>
              {isFirstInGroup && rowIdx !== 0 && (
                <li className={styles.separator} aria-hidden="true" />
              )}
              <li className={styles.row}>
                {row.map((tool, colIdx) =>
                  tool ? (
                    tool.id === 'shape' ? (
                      <div key="shape-cell" className={styles.shapeCell} ref={shapeButtonRef}>
                        <button
                          className={`${styles.toolBtn} ${activeTool === 'shape' ? styles.active : ''}`}
                          onClick={() => { if (!indexedModeActive) onToolChange?.('shape') }}
                          disabled={indexedModeActive}
                          aria-label="Shape (U)"
                          aria-pressed={activeTool === 'shape'}
                          title="Shape  U"
                        >
                          {getShapeIcon(state.activeShape)}
                        </button>
                        <button
                          className={styles.shapeCaret}
                          onClick={openShapePicker}
                          disabled={indexedModeActive}
                          tabIndex={-1}
                          aria-label="Pick shape"
                          title="Choose shape"
                        >
                          <svg viewBox="0 0 5 3" fill="currentColor" width="5" height="3">
                            <polygon points="0,0 5,0 2.5,3" />
                          </svg>
                        </button>
                      </div>
                    ) : (
                      <button
                        key={tool.id}
                        className={`${styles.toolBtn} ${activeTool === tool.id ? styles.active : ''}`}
                        onClick={() => {
                          if (PIXEL_ONLY_TOOLS.has(tool.id as Tool) && pixelToolsDisabled) return
                          if (INDEXED8_UNSUPPORTED_TOOLS.has(tool.id as Tool) && indexedModeActive) return
                          onToolChange?.(tool.id)
                        }}
                        disabled={
                          (PIXEL_ONLY_TOOLS.has(tool.id as Tool) && pixelToolsDisabled) ||
                          (INDEXED8_UNSUPPORTED_TOOLS.has(tool.id as Tool) && indexedModeActive)
                        }
                        aria-label={`${tool.label}  (${tool.shortcut})`}
                        aria-pressed={activeTool === tool.id}
                        title={`${tool.label}  ${tool.shortcut}`}
                      >
                        {tool.icon}
                      </button>
                    )
                  ) : (
                    <div key={`empty-${colIdx}`} className={styles.emptyCell} aria-hidden="true" />
                  )
                )}
              </li>
            </React.Fragment>
          )
        })}
      </ul>

      {/* ── Foreground / Background color swatches ───────────────────── */}
      <div className={styles.swatches}>
        <button
          className={styles.swatchBg}
          style={{ background: bgStyle }}
          title="Background color (click to edit)"
          aria-label="Background color"
          onClick={(e) => openPicker('bg', e)}
        />
        <button
          className={styles.swatchFg}
          style={{ background: fgStyle }}
          title="Foreground color (click to edit)"
          aria-label="Foreground color"
          onClick={(e) => openPicker('fg', e)}
        />
        <button className={styles.swatchReset} title="Reset to Default (D)" aria-label="Reset colors to default" onClick={handleReset} />
        <button className={styles.swatchSwap} title="Swap Colors (X)" aria-label="Swap foreground/background" onClick={handleSwap}>
          <svg viewBox="0 0 10 10" fill="currentColor" width="9" height="9">
            <path d="M6.5 1L9 3.5 6.5 6V4.5H2V3h4.5zM3.5 9L1 6.5 3.5 4v1.5H8V7H3.5z" />
          </svg>
        </button>
      </div>
    </nav>

    {shapePickerOpen && (
      <div
        ref={flyoutRef}
        className={styles.shapeFlyout}
        style={{ top: flyoutY }}
      >
        {SHAPE_DEFS.map(shape => (
          <button
            key={shape.id}
            className={`${styles.shapeFlyoutBtn} ${state.activeShape === shape.id ? styles.active : ''}`}
            onClick={() => selectShape(shape.id)}
            title={shape.label}
            aria-label={shape.label}
          >
            {shape.icon}
          </button>
        ))}
      </div>
    )}

    <ColorPickerDialog
      open={dialogOpen}
      title={dialogIsSwatchAdd ? 'Add Color to Palette' : `Color Picker (${dialogTarget === 'fg' ? 'Foreground' : 'Background'} Color)`}
      initialColor={dialogTarget === 'fg' ? fgColor : bgColor}
      onConfirm={handleConfirm}
      onCancel={() => { setDialogIsSwatchAdd(false); setDialogOpen(false) }}
      onAddSwatch={(c) => dispatch({ type: 'ADD_SWATCH', payload: c })}
    />
    {indexedPickerTarget !== null && (
      <IndexedPaletteColorPicker
        palette={state.swatches}
        activeIndex={state.activePaletteIndex}
        anchorPos={indexedPickerAnchor}
        onSelect={(index, color) => {
          dispatch({ type: 'SET_ACTIVE_SWATCH', payload: index })
          dispatch({
            type: indexedPickerTarget === 'fg' ? 'SET_PRIMARY_COLOR' : 'SET_SECONDARY_COLOR',
            payload: color,
          })
        }}
        onClose={() => setIndexedPickerTarget(null)}
        onAddColor={() => {
          setDialogIsSwatchAdd(true)
          setDialogOpen(true)
        }}
      />
    )}
    </>
  )
}

