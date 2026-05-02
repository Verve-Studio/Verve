import { useAppContext } from '@/core/store/AppContext'
import type { TextAlign, TextLayerState } from '@/types'
import { SliderInput } from '@/ux/widgets/SliderInput/SliderInput'
import React, { useEffect, useState } from 'react'
import type { ToolContext, ToolDefinition, ToolHandler, ToolOptionsStyles, ToolPointerPos } from './types'

// ─── Module-level options ─────────────────────────────────────────────────────

export const textOptions = {
  fontFamily: 'Arial',
  fontSize: 24,
  bold: false,
  italic: false,
  underline: false,
  align: 'left' as import('@/types').TextAlign,
}

// ─── System font enumeration ──────────────────────────────────────────────────

const FALLBACK_FONTS = [
  'Arial', 'Arial Black', 'Calibri', 'Cambria', 'Comic Sans MS', 'Consolas',
  'Courier New', 'Franklin Gothic Medium', 'Georgia', 'Impact', 'Palatino Linotype',
  'Segoe UI', 'Tahoma', 'Times New Roman', 'Trebuchet MS', 'Verdana',
]

async function getSystemFonts(): Promise<string[]> {
  // Local Font Access API — available in Chromium / Electron
  if ('queryLocalFonts' in window) {
    try {
      const fonts: { family: string }[] = await (window as unknown as { queryLocalFonts(): Promise<{ family: string }[]> }).queryLocalFonts()
      return [...new Set(fonts.map((f) => f.family))].sort()
    } catch {
      // permission denied or API unavailable — fall through to probe
    }
  }

  // Canvas-metrics probe: compare rendered width against a known baseline font
  const probe = document.createElement('canvas')
  probe.width = 200; probe.height = 30
  const ctx = probe.getContext('2d')!
  const testStr = 'mmmmmmmmmmWWWWWWWWWW'
  ctx.font = '16px monospace'
  const baseWidth = ctx.measureText(testStr).width
  return FALLBACK_FONTS.filter((family) => {
    ctx.font = `16px "${family}", monospace`
    return ctx.measureText(testStr).width !== baseWidth
  })
}

// ─── Text bounds & overlay helpers ───────────────────────────────────────────

const _measureCanvas = document.createElement('canvas')
const _measureCtx    = _measureCanvas.getContext('2d')!

function getTextBounds(ls: TextLayerState): { x: number; y: number; w: number; h: number } {
  if (ls.boxWidth > 0 && ls.boxHeight > 0) {
    return { x: ls.x, y: ls.y, w: ls.boxWidth, h: ls.boxHeight }
  }
  const fontStyle = [
    ls.italic ? 'italic' : '',
    ls.bold   ? 'bold'   : '',
    `${ls.fontSize}px`,
    `"${ls.fontFamily}", sans-serif`,
  ].filter(Boolean).join(' ')
  _measureCtx.font = fontStyle
  const textW = _measureCtx.measureText(ls.text || 'M').width
  const w = ls.boxWidth  > 0 ? ls.boxWidth  : Math.max(ls.fontSize * 2, textW)
  const h = ls.boxHeight > 0 ? ls.boxHeight : Math.ceil(ls.fontSize * 1.2)
  return { x: ls.x, y: ls.y, w, h }
}

function hitTestTextLayer(ls: TextLayerState, x: number, y: number): boolean {
  const b = getTextBounds(ls)
  return x >= b.x && y >= b.y && x <= b.x + b.w && y <= b.y + b.h
}

function drawTextBoundsOverlay(canvas: HTMLCanvasElement, ls: TextLayerState): void {
  const ctx2d = canvas.getContext('2d')
  if (!ctx2d) return
  ctx2d.clearRect(0, 0, canvas.width, canvas.height)
  const { x, y, w, h } = getTextBounds(ls)
  ctx2d.save()
  ctx2d.strokeStyle = '#0078ff'
  ctx2d.lineWidth = 1
  ctx2d.setLineDash([4, 3])
  ctx2d.shadowColor = '#000'
  ctx2d.shadowBlur = 2
  ctx2d.strokeRect(x - 1.5, y - 1.5, w + 3, h + 3)
  ctx2d.restore()
}

function clearOverlay(canvas: HTMLCanvasElement): void {
  const ctx2d = canvas.getContext('2d')
  if (ctx2d) ctx2d.clearRect(0, 0, canvas.width, canvas.height)
}

// ─── Handler ─────────────────────────────────────────────────────────────────

function createTextHandler(): ToolHandler {
  return {
    onPointerDown({ x, y }: ToolPointerPos, ctx: ToolContext): void {
      const hit = ctx.textLayers.find((ls) => hitTestTextLayer(ls, x, y))
      if (hit) {
        ctx.openTextLayerEditor(hit.id)
        return
      }

      const id = `text-${Date.now()}`
      const layer: TextLayerState = {
        id,
        name: 'Text',
        visible: true,
        opacity: 1,
        locked: false,
        blendMode: 'normal',
        type: 'text',
        text: '',
        x: Math.round(x),
        y: Math.round(y),
        boxWidth: 0,
        boxHeight: 0,
        fontFamily: textOptions.fontFamily,
        fontSize: textOptions.fontSize,
        bold: textOptions.bold,
        italic: textOptions.italic,
        underline: textOptions.underline,
        align: textOptions.align,
        color: {
          r: Math.round(Math.min(ctx.primaryColor.r, 1) * 255),
          g: Math.round(Math.min(ctx.primaryColor.g, 1) * 255),
          b: Math.round(Math.min(ctx.primaryColor.b, 1) * 255),
          a: Math.round(ctx.primaryColor.a * 255),
        },
      }
      ctx.addTextLayer(layer)
    },
    onPointerMove(): void {},
    onPointerUp(): void {},
    onHover({ x, y }: ToolPointerPos, ctx: ToolContext): void {
      if (!ctx.overlayCanvas) return
      const hit = ctx.textLayers.find((ls) => hitTestTextLayer(ls, x, y))
      if (hit) {
        drawTextBoundsOverlay(ctx.overlayCanvas, hit)
      } else {
        clearOverlay(ctx.overlayCanvas)
      }
    },
    onLeave(ctx: ToolContext): void {
      if (ctx.overlayCanvas) clearOverlay(ctx.overlayCanvas)
    },
  }
}

// ─── Options UI ───────────────────────────────────────────────────────────────

function TextOptions({ styles }: { styles: ToolOptionsStyles }): React.JSX.Element {
  const { state, dispatch } = useAppContext()

  const activeTextLayer = state.layers.find(
    (l): l is TextLayerState => 'type' in l && l.type === 'text' && l.id === state.activeLayerId
  )

  const [fontFamily, setFontFamily] = useState(activeTextLayer?.fontFamily ?? textOptions.fontFamily)
  const [fontSize, setFontSize]     = useState(activeTextLayer?.fontSize   ?? textOptions.fontSize)
  const [bold, setBold]             = useState(activeTextLayer?.bold        ?? textOptions.bold)
  const [italic, setItalic]         = useState(activeTextLayer?.italic      ?? textOptions.italic)
  const [underline, setUnderline]   = useState(activeTextLayer?.underline   ?? textOptions.underline)
  const [align, setAlign]           = useState<TextAlign>(activeTextLayer?.align ?? textOptions.align)
  const [fonts, setFonts]           = useState<string[]>([textOptions.fontFamily])

  // Sync toolbar UI when the active text layer changes
  const activeId = activeTextLayer?.id
  useEffect(() => {
    if (activeTextLayer) {
      setFontFamily(activeTextLayer.fontFamily)
      setFontSize(activeTextLayer.fontSize)
      setBold(activeTextLayer.bold)
      setItalic(activeTextLayer.italic)
      setUnderline(activeTextLayer.underline)
      setAlign(activeTextLayer.align ?? 'left')
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeId])

  useEffect(() => {
    getSystemFonts().then((list) => {
      setFonts(list.length > 0 ? list : FALLBACK_FONTS)
    })
  }, [])

  const applyChange = (patch: Partial<Pick<TextLayerState, 'fontFamily' | 'fontSize' | 'bold' | 'italic' | 'underline' | 'align'>>): void => {
    if (activeTextLayer) {
      dispatch({ type: 'UPDATE_TEXT_LAYER', payload: { ...activeTextLayer, ...patch } })
    }
    if (patch.fontFamily !== undefined) textOptions.fontFamily = patch.fontFamily
    if (patch.fontSize   !== undefined) textOptions.fontSize   = patch.fontSize
    if (patch.bold       !== undefined) textOptions.bold       = patch.bold
    if (patch.italic     !== undefined) textOptions.italic     = patch.italic
    if (patch.underline  !== undefined) textOptions.underline  = patch.underline
    if (patch.align      !== undefined) textOptions.align      = patch.align
  }

  const handleFont      = (f: string):     void => { setFontFamily(f); applyChange({ fontFamily: f }) }
  const handleSize      = (v: number):     void => { setFontSize(v);   applyChange({ fontSize: v }) }
  const handleBold      = (v: boolean):    void => { setBold(v);       applyChange({ bold: v }) }
  const handleItalic    = (v: boolean):    void => { setItalic(v);     applyChange({ italic: v }) }
  const handleUnderline = (v: boolean):    void => { setUnderline(v);  applyChange({ underline: v }) }
  const handleAlign     = (a: TextAlign):  void => { setAlign(a);      applyChange({ align: a }) }

  const ALIGN_BUTTONS: { value: TextAlign; title: string; icon: React.JSX.Element }[] = [
    { value: 'left', title: 'Align Left', icon: (
      <svg width="14" height="12" viewBox="0 0 14 12" fill="currentColor">
        <rect x="0" y="0"  width="14" height="2"/>
        <rect x="0" y="5"  width="9"  height="2"/>
        <rect x="0" y="10" width="14" height="2"/>
      </svg>
    )},
    { value: 'center', title: 'Align Center', icon: (
      <svg width="14" height="12" viewBox="0 0 14 12" fill="currentColor">
        <rect x="0" y="0"  width="14" height="2"/>
        <rect x="2.5" y="5" width="9" height="2"/>
        <rect x="0" y="10" width="14" height="2"/>
      </svg>
    )},
    { value: 'right', title: 'Align Right', icon: (
      <svg width="14" height="12" viewBox="0 0 14 12" fill="currentColor">
        <rect x="0" y="0"  width="14" height="2"/>
        <rect x="5" y="5"  width="9"  height="2"/>
        <rect x="0" y="10" width="14" height="2"/>
      </svg>
    )},
    { value: 'justify', title: 'Justify', icon: (
      <svg width="14" height="12" viewBox="0 0 14 12" fill="currentColor">
        <rect x="0" y="0"  width="14" height="2"/>
        <rect x="0" y="5"  width="14" height="2"/>
        <rect x="0" y="10" width="14" height="2"/>
      </svg>
    )},
  ]

  return (
    <>
      <label className={styles.optLabel}>Font:</label>
      <select
        className={styles.optSelect}
        value={fontFamily}
        onChange={(e) => handleFont(e.target.value)}
        style={{ maxWidth: 160 }}
      >
        {fonts.map((f) => (
          <option key={f} value={f}>{f}</option>
        ))}
      </select>
      <span className={styles.optSep} />
      <label className={styles.optLabel}>Size:</label>
      <SliderInput value={fontSize} min={6} max={400} inputWidth={46} onChange={handleSize} />
      <span className={styles.optSep} />
      <label className={styles.optCheckLabel} title="Bold">
        <input
          type="checkbox"
          checked={bold}
          onChange={(e) => handleBold(e.target.checked)}
        />
        <strong>B</strong>
      </label>
      <label className={styles.optCheckLabel} title="Italic">
        <input
          type="checkbox"
          checked={italic}
          onChange={(e) => handleItalic(e.target.checked)}
        />
        <em>I</em>
      </label>
      <label className={styles.optCheckLabel} title="Underline">
        <input
          type="checkbox"
          checked={underline}
          onChange={(e) => handleUnderline(e.target.checked)}
        />
        <span style={{ textDecoration: 'underline' }}>U</span>
      </label>
      <span className={styles.optSep} />
      {ALIGN_BUTTONS.map(({ value, title, icon }) => (
        <button
          key={value}
          className={styles.optBtn}
          title={title}
          style={{
            padding: '1px 6px',
            fontWeight: align === value ? 'bold' : 'normal',
            outline: align === value ? '2px solid #0078ff' : 'none',
            outlineOffset: '-2px',
          }}
          onPointerDown={(e) => e.preventDefault()}
          onClick={() => handleAlign(value)}
        >{icon}</button>
      ))}
    </>
  )
}

// ─── Tool export ─────────────────────────────────────────────────────────────

export const textTool: ToolDefinition = {
  createHandler: createTextHandler,
  Options: TextOptions,
  modifiesPixels: false,
  skipAutoHistory: true,
}
