import React, { useEffect, useState } from 'react'
import { useAppContext } from '@/core/store/AppContext'
import { cursorStore } from '@/core/store/cursorStore'
import type { IndexedPixelInfo } from '@/core/store/cursorStore'
import { selectionStore } from '@/core/store/selectionStore'
import styles from './InfoPanel.module.scss'

// ─── Helpers ─────────────────────────────────────────────────────────────────

function toHex2(v: number): string {
  return Math.round(Math.max(0, Math.min(255, v))).toString(16).padStart(2, '0')
}

function getSelectionBounds(): { x: number; y: number; w: number; h: number } | null {
  if (!selectionStore.hasSelection()) return null
  const mask = selectionStore.mask!
  const sw = selectionStore.width
  const sh = selectionStore.height
  let minX = sw, minY = sh, maxX = -1, maxY = -1
  for (let y = 0; y < sh; y++) {
    for (let x = 0; x < sw; x++) {
      if (mask[y * sw + x] !== 0) {
        if (x < minX) minX = x
        if (x > maxX) maxX = x
        if (y < minY) minY = y
        if (y > maxY) maxY = y
      }
    }
  }
  if (maxX < 0) return null
  return { x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 }
}

// ─── InfoPanel ────────────────────────────────────────────────────────────────

interface CursorState {
  x: number
  y: number
  visible: boolean
  pixelInfo: IndexedPixelInfo | null
  pixelValues: number[] | null
  pixelIsFloat: boolean
}

interface SelectionState {
  hasSel: boolean
  bounds: { x: number; y: number; w: number; h: number } | null
}

const FORMAT_LABELS: Record<string, string> = {
  rgba8: 'RGB/8',
  rgba32f: 'RGB/32F',
  indexed8: 'Indexed/8',
}

function memoryEstimate(w: number, h: number, format: string): string {
  const bytesPerPx = format === 'rgba32f' ? 16 : format === 'indexed8' ? 1 : 4
  const bytes = w * h * bytesPerPx
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`
}

export function InfoPanel(): React.JSX.Element {
  const { state } = useAppContext()
  const { width, height } = state.canvas
  const format = state.pixelFormat ?? 'rgba8'
  const isFloat = format === 'rgba32f'
  const isIndexed = format === 'indexed8'

  const [cursor, setCursor] = useState<CursorState>({
    x: cursorStore.x, y: cursorStore.y, visible: cursorStore.visible,
    pixelInfo: cursorStore.pixelInfo, pixelValues: cursorStore.pixelValues, pixelIsFloat: cursorStore.pixelIsFloat,
  })

  const [sel, setSel] = useState<SelectionState>({
    hasSel: selectionStore.hasSelection(),
    bounds: getSelectionBounds(),
  })

  useEffect(() => {
    const onCursor = (): void => setCursor({
      x: cursorStore.x, y: cursorStore.y, visible: cursorStore.visible,
      pixelInfo: cursorStore.pixelInfo, pixelValues: cursorStore.pixelValues, pixelIsFloat: cursorStore.pixelIsFloat,
    })
    cursorStore.subscribe(onCursor)
    return () => cursorStore.unsubscribe(onCursor)
  }, [])

  useEffect(() => {
    const onSel = (): void => setSel({
      hasSel: selectionStore.hasSelection(),
      bounds: getSelectionBounds(),
    })
    selectionStore.subscribe(onSel)
    return () => selectionStore.unsubscribe(onSel)
  }, [])

  // ── Color readout ────────────────────────────────────────────────────────────

  let colorRows: React.ReactNode = null

  if (cursor.visible) {
    if (isFloat && cursor.pixelIsFloat && cursor.pixelValues) {
      const [r, g, b, a] = cursor.pixelValues
      colorRows = (
        <>
          <tr>
            <td className={styles.ch}>R</td>
            <td className={styles.val}>{r.toFixed(4)}</td>
            <td className={styles.ch}>G</td>
            <td className={styles.val}>{g.toFixed(4)}</td>
          </tr>
          <tr>
            <td className={styles.ch}>B</td>
            <td className={styles.val}>{b.toFixed(4)}</td>
            <td className={styles.ch}>A</td>
            <td className={styles.val}>{a.toFixed(4)}</td>
          </tr>
        </>
      )
    } else if (isIndexed && cursor.pixelInfo !== null) {
      const { index, color } = cursor.pixelInfo
      colorRows = (
        <>
          <tr>
            <td className={styles.ch}>Idx</td>
            <td className={styles.val} colSpan={3}>
              {index < 255 ? index : '—'}
              {color !== null && (
                <span className={styles.hex}> #{toHex2(color.r)}{toHex2(color.g)}{toHex2(color.b)}</span>
              )}
            </td>
          </tr>
          {color !== null && (
            <tr>
              <td className={styles.ch}>R</td>
              <td className={styles.val}>{color.r}</td>
              <td className={styles.ch}>G</td>
              <td className={styles.val}>{color.g}</td>
            </tr>
          )}
          {color !== null && (
            <tr>
              <td className={styles.ch}>B</td>
              <td className={styles.val}>{color.b}</td>
              <td className={styles.ch}>A</td>
              <td className={styles.val}>{color.a}</td>
            </tr>
          )}
        </>
      )
    } else if (cursor.pixelValues) {
      const [r, g, b, a] = cursor.pixelValues
      const ri = Math.round(r), gi = Math.round(g), bi = Math.round(b), ai = Math.round(a)
      colorRows = (
        <>
          <tr>
            <td className={styles.ch}>R</td>
            <td className={styles.val}>{ri}</td>
            <td className={styles.ch}>G</td>
            <td className={styles.val}>{gi}</td>
          </tr>
          <tr>
            <td className={styles.ch}>B</td>
            <td className={styles.val}>{bi}</td>
            <td className={styles.ch}>A</td>
            <td className={styles.val}>{ai}</td>
          </tr>
          <tr>
            <td className={styles.ch}>Hex</td>
            <td className={styles.hex} colSpan={3}>
              #{toHex2(ri)}{toHex2(gi)}{toHex2(bi)}
            </td>
          </tr>
        </>
      )
    }
  }

  return (
    <div className={styles.panel}>

      {/* ── Cursor ─────────────────────────────────────────────────────────── */}
      <div className={styles.section}>
        <div className={styles.sectionTitle}>Cursor</div>
        <table className={styles.grid}>
          <tbody>
            <tr>
              <td className={styles.ch}>X</td>
              <td className={styles.val}>{cursor.visible ? cursor.x : '—'}</td>
              <td className={styles.ch}>Y</td>
              <td className={styles.val}>{cursor.visible ? cursor.y : '—'}</td>
            </tr>
            {colorRows}
          </tbody>
        </table>
      </div>

      {/* ── Document ───────────────────────────────────────────────────────── */}
      <div className={styles.section}>
        <div className={styles.sectionTitle}>Document</div>
        <table className={styles.grid}>
          <tbody>
            <tr>
              <td className={styles.ch}>W</td>
              <td className={styles.val}>{width} px</td>
              <td className={styles.ch}>H</td>
              <td className={styles.val}>{height} px</td>
            </tr>
            <tr>
              <td className={styles.ch}>Mode</td>
              <td className={styles.val} colSpan={3}>{FORMAT_LABELS[format] ?? format}</td>
            </tr>
            <tr>
              <td className={styles.ch}>Size</td>
              <td className={styles.val} colSpan={3}>{memoryEstimate(width, height, format)}</td>
            </tr>
          </tbody>
        </table>
      </div>

      {/* ── Selection ──────────────────────────────────────────────────────── */}
      <div className={styles.section}>
        <div className={styles.sectionTitle}>Selection</div>
        {!sel.hasSel || !sel.bounds ? (
          <div className={styles.none}>None</div>
        ) : (
          <table className={styles.grid}>
            <tbody>
              <tr>
                <td className={styles.ch}>X</td>
                <td className={styles.val}>{sel.bounds.x}</td>
                <td className={styles.ch}>Y</td>
                <td className={styles.val}>{sel.bounds.y}</td>
              </tr>
              <tr>
                <td className={styles.ch}>W</td>
                <td className={styles.val}>{sel.bounds.w} px</td>
                <td className={styles.ch}>H</td>
                <td className={styles.val}>{sel.bounds.h} px</td>
              </tr>
            </tbody>
          </table>
        )}
      </div>

    </div>
  )
}
