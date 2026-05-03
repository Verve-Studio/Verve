import { useAppContext } from '@/core/store/AppContext'
import type { RGBAColor, ShapeType, Tool } from '@/types'
import { ColorPickerDialog } from '@/ux/modals/ColorPickerDialog/ColorPickerDialog'
import { IndexedPaletteColorPicker } from '@/ux/widgets/IndexedPaletteColorPicker/IndexedPaletteColorPicker'
import React, { useEffect, useRef, useState } from 'react'
import styles from './Toolbar.module.scss'

// ─── Asset icons ──────────────────────────────────────────────────────────────

import burnIcon from '@/ux/assets/burn.svg?raw'
import brushIcon from '@/ux/assets/brush.svg?raw'
import cloneStampIcon from '@/ux/assets/clone-stamp.svg?raw'
import colorPickerIcon from '@/ux/assets/color-picker.svg?raw'
import cropIcon from '@/ux/assets/crop.svg?raw'
import dodgeIcon from '@/ux/assets/dodge.svg?raw'
import eraserIcon from '@/ux/assets/eraser.svg?raw'
import frameIcon from '@/ux/assets/frame.svg?raw'
import gradientIcon from '@/ux/assets/gradient.svg?raw'
import lassoIcon from '@/ux/assets/lasso.svg?raw'
import magicWandIcon from '@/ux/assets/magic-wand.svg?raw'
import marqueeRectIcon from '@/ux/assets/marquee-rect.svg?raw'
import moveIcon from '@/ux/assets/move.svg?raw'
import objectSelectIcon from '@/ux/assets/object-select.svg?raw'
import paintBucketIcon from '@/ux/assets/paint-bucket.svg?raw'
import pencilIcon from '@/ux/assets/pencil.svg?raw'
import polygonSelectIcon from '@/ux/assets/polygon-select.svg?raw'
import shapeIcon from '@/ux/assets/shape.svg?raw'
import textIcon from '@/ux/assets/text.svg?raw'

function SvgIcon({ src }: { src: string }): React.JSX.Element {
  const svg = src
    .replace(/width="\d+(\.\d+)?"/, 'width="100%"')
    .replace(/height="\d+(\.\d+)?"/, 'height="100%"')
  return <span style={{ display: 'block', width: '100%', height: '100%' }} dangerouslySetInnerHTML={{ __html: svg }} />
}

const Icon = {
  move:             <SvgIcon src={moveIcon} />,
  select:           <SvgIcon src={marqueeRectIcon} />,
  lasso:            <SvgIcon src={lassoIcon} />,
  polygonalLasso:   <SvgIcon src={polygonSelectIcon} />,
  objectSelection:  <SvgIcon src={objectSelectIcon} />,
  magicWand:        <SvgIcon src={magicWandIcon} />,
  crop:             <SvgIcon src={cropIcon} />,
  frame:            <SvgIcon src={frameIcon} />,
  eyedropper:       <SvgIcon src={colorPickerIcon} />,
  pencil:           <SvgIcon src={pencilIcon} />,
  brush:            <SvgIcon src={brushIcon} />,
  eraser:           <SvgIcon src={eraserIcon} />,
  fill:             <SvgIcon src={paintBucketIcon} />,
  gradient:         <SvgIcon src={gradientIcon} />,
  dodge:            <SvgIcon src={dodgeIcon} />,
  burn:             <SvgIcon src={burnIcon} />,
  text:             <SvgIcon src={textIcon} />,
  shape:            <SvgIcon src={shapeIcon} />,
  cloneStamp:       <SvgIcon src={cloneStampIcon} />,
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
  const pixelToolsDisabled = activeLayer == null
    || ('type' in activeLayer && activeLayer.type !== 'mask')
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
  // primaryColor/secondaryColor are float [0,∞). Convert to 0-255 for CSS.
  const fgStyle = `rgb(${Math.round(Math.min(fgColor.r,1)*255)},${Math.round(Math.min(fgColor.g,1)*255)},${Math.round(Math.min(fgColor.b,1)*255)})`
  const bgStyle = `rgb(${Math.round(Math.min(bgColor.r,1)*255)},${Math.round(Math.min(bgColor.g,1)*255)},${Math.round(Math.min(bgColor.b,1)*255)})`
  // ColorPickerDialog now accepts/emits float colors directly

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
    // color is float [0,1] from ColorPickerDialog
    if (dialogIsSwatchAdd) {
      dispatch({ type: 'ADD_SWATCH', payload: { r: Math.round(color.r*255), g: Math.round(color.g*255), b: Math.round(color.b*255), a: Math.round(color.a*255) } })
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
    dispatch({ type: 'SET_PRIMARY_COLOR',   payload: { r: 0, g: 0, b: 0, a: 1 } })
    dispatch({ type: 'SET_SECONDARY_COLOR', payload: { r: 1, g: 1, b: 1, a: 1 } })
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
      onAddSwatch={(c) => dispatch({ type: 'ADD_SWATCH', payload: { r: Math.round(c.r*255), g: Math.round(c.g*255), b: Math.round(c.b*255), a: Math.round(c.a*255) } })}
      pixelFormat={state.pixelFormat}
    />
    {indexedPickerTarget !== null && (
      <IndexedPaletteColorPicker
        palette={state.swatches}
        activeIndex={state.activePaletteIndex}
        anchorPos={indexedPickerAnchor}
        onSelect={(index, color) => {
          dispatch({ type: 'SET_ACTIVE_SWATCH', payload: index })
          // color comes from swatches (0-255); convert to float for AppState.
          dispatch({
            type: indexedPickerTarget === 'fg' ? 'SET_PRIMARY_COLOR' : 'SET_SECONDARY_COLOR',
            payload: { r: color.r/255, g: color.g/255, b: color.b/255, a: color.a/255 },
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

