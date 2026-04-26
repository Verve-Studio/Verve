import React, { useEffect, useRef, useState } from 'react'
import type { PixelBrush } from '@/types'
import styles from './PixelBrushGallery.module.scss'

// ─── Thumbnail rendering ──────────────────────────────────────────────────────

const THUMB_SIZE = 48  // px — gallery cell inner size

/**
 * Decode a brush's raw RGBA bytes (base64) and draw it into a canvas element,
 * scaled to fill THUMB_SIZE while preserving pixel-perfect rendering.
 */
function drawBrushThumb(canvas: HTMLCanvasElement, brush: PixelBrush): void {
  const ctx = canvas.getContext('2d')
  if (!ctx) return
  const scale = Math.min(THUMB_SIZE / brush.width, THUMB_SIZE / brush.height)
  const dw = Math.round(brush.width  * scale)
  const dh = Math.round(brush.height * scale)
  const dx = Math.round((THUMB_SIZE - dw) / 2)
  const dy = Math.round((THUMB_SIZE - dh) / 2)

  ctx.clearRect(0, 0, THUMB_SIZE, THUMB_SIZE)

  try {
    const bin = atob(brush.rgba)
    const bytes = new Uint8ClampedArray(bin.length)
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
    const imgData = new ImageData(bytes, brush.width, brush.height)

    // Draw at native size first, then scale up
    const tmp = document.createElement('canvas')
    tmp.width  = brush.width
    tmp.height = brush.height
    tmp.getContext('2d')!.putImageData(imgData, 0, 0)

    ctx.imageSmoothingEnabled = false
    ctx.drawImage(tmp, dx, dy, dw, dh)
  } catch {
    // Corrupt brush data — show a placeholder
    ctx.fillStyle = '#555'
    ctx.fillRect(dx, dy, dw, dh)
  }
}

// ─── Thumbnail cell ───────────────────────────────────────────────────────────

interface BrushThumbProps {
  brush: PixelBrush
  selected: boolean
  onSelect: () => void
  onDelete?: () => void
  onRename?: (name: string) => void
}

function BrushThumb({ brush, selected, onSelect, onDelete, onRename }: BrushThumbProps): React.JSX.Element {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const [editing, setEditing] = useState(false)
  const [draftName, setDraftName] = useState(brush.name)

  useEffect(() => {
    if (canvasRef.current) drawBrushThumb(canvasRef.current, brush)
  }, [brush])

  const commitRename = (): void => {
    const trimmed = draftName.trim()
    if (trimmed && trimmed !== brush.name) onRename?.(trimmed)
    setEditing(false)
  }

  return (
    <div
      className={`${styles.cell} ${selected ? styles.cellSelected : ''}`}
      onClick={onSelect}
      title={brush.name}
    >
      <canvas
        ref={canvasRef}
        width={THUMB_SIZE}
        height={THUMB_SIZE}
        className={styles.thumb}
      />
      {editing ? (
        <input
          className={styles.nameInput}
          value={draftName}
          autoFocus
          onChange={e => setDraftName(e.target.value)}
          onBlur={commitRename}
          onKeyDown={e => {
            if (e.key === 'Enter') commitRename()
            if (e.key === 'Escape') { setDraftName(brush.name); setEditing(false) }
            e.stopPropagation()
          }}
          onClick={e => e.stopPropagation()}
        />
      ) : (
        <span
          className={styles.name}
          onDoubleClick={e => { if (onRename) { setDraftName(brush.name); setEditing(true); e.stopPropagation() } }}
        >
          {brush.name}
        </span>
      )}
      {onDelete && (
        <button
          className={styles.deleteBtn}
          title="Delete brush"
          onClick={e => { e.stopPropagation(); onDelete() }}
        >
          ×
        </button>
      )}
    </div>
  )
}

// ─── Gallery ─────────────────────────────────────────────────────────────────

export interface PixelBrushGalleryProps {
  brushes: PixelBrush[]
  selectedId: string | null
  /** Called when the user clicks a brush thumbnail. */
  onSelect: (id: string) => void
  /** If provided, shows a delete button on each cell. */
  onDelete?: (id: string) => void
  /** If provided, enables double-click rename on name labels. */
  onRename?: (id: string, name: string) => void
  /** Optional empty-state message */
  emptyMessage?: string
}

export function PixelBrushGallery({
  brushes,
  selectedId,
  onSelect,
  onDelete,
  onRename,
  emptyMessage = 'No brushes yet',
}: PixelBrushGalleryProps): React.JSX.Element {
  return (
    <div className={styles.gallery}>
      {brushes.length === 0 ? (
        <p className={styles.empty}>{emptyMessage}</p>
      ) : (
        brushes.map(brush => (
          <BrushThumb
            key={brush.id}
            brush={brush}
            selected={brush.id === selectedId}
            onSelect={() => onSelect(brush.id)}
            onDelete={onDelete ? () => onDelete(brush.id) : undefined}
            onRename={onRename ? (name) => onRename(brush.id, name) : undefined}
          />
        ))
      )}
    </div>
  )
}
