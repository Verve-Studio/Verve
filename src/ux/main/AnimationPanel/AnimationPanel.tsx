import React, { useRef, useState } from 'react'
import { useAppContext } from '@/core/store/AppContext'
import { SliderInput } from '@/ux/widgets/SliderInput/SliderInput'
import type { AnimationPlaybackMode } from '@/types'
import styles from './AnimationPanel.module.scss'

// ─── Constants ────────────────────────────────────────────────────────────────

const MIN_WIDTH = 220
const MAX_WIDTH = 480
const DEFAULT_WIDTH = 260
const STORAGE_KEY = 'verve-animation-panel-width'

// ─── Props ────────────────────────────────────────────────────────────────────

export interface AnimationPanelProps {
  onCopyPrevFrame: (animationId: string, frameId: string) => void
  onCopyNextFrame: (animationId: string, frameId: string) => void
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function newId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`
}

// ─── Sub-components ───────────────────────────────────────────────────────────

interface ToggleProps {
  checked: boolean
  onChange: (v: boolean) => void
  disabled?: boolean
}

function Toggle({ checked, onChange, disabled }: ToggleProps): React.JSX.Element {
  return (
    <label className={`${styles.toggle} ${disabled ? styles.toggleDisabled : ''}`}>
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={e => onChange(e.target.checked)}
      />
      <span className={styles.toggleTrack} />
    </label>
  )
}

// ─── AnimationPanel ───────────────────────────────────────────────────────────

export function AnimationPanel({ onCopyPrevFrame, onCopyNextFrame }: AnimationPanelProps): React.JSX.Element {
  const { state, dispatch } = useAppContext()
  const ss = state.spritesheet
  const canvasW = state.canvas.width
  const canvasH = state.canvas.height

  const selectedAnim = ss.animations.find(a => a.id === ss.selectedAnimationId) ?? null

  // Compute global frame start index per animation (sequential in spritesheet order)
  const animStartIdx = new Map<string, number>()
  let gIdx = 0
  for (const anim of ss.animations) {
    animStartIdx.set(anim.id, gIdx)
    gIdx += anim.frames.length
  }

  const cols = ss.cellWidth > 0 && canvasW > 0 ? Math.max(1, Math.floor(canvasW / ss.cellWidth)) : 1

  const cellW = Math.max(1, ss.cellWidth)
  const cellH = Math.max(1, ss.cellHeight)
  const maxCells = Math.floor(Math.max(1, canvasW) / cellW) * Math.floor(Math.max(1, canvasH) / cellH)
  const totalFrames = ss.animations.reduce((acc, a) => acc + a.frames.length, 0)
  const atCapacity = totalFrames >= maxCells

  function sourceRectPx(frameIndex: number): { x: number; y: number; w: number; h: number } {
    const col = frameIndex % cols
    const row = Math.floor(frameIndex / cols)
    return { x: col * ss.cellWidth, y: row * ss.cellHeight, w: ss.cellWidth, h: ss.cellHeight }
  }

  function sourceRectUV(px: { x: number; y: number; w: number; h: number }): { u: number; v: number; uw: number; vh: number } {
    return {
      u:  canvasW > 0 ? px.x / canvasW : 0,
      v:  canvasH > 0 ? px.y / canvasH : 0,
      uw: canvasW > 0 ? px.w / canvasW : 0,
      vh: canvasH > 0 ? px.h / canvasH : 0,
    }
  }

  // ── Panel resize ─────────────────────────────────────────────────
  const [width, setWidth] = useState<number>(() => {
    const stored = localStorage.getItem(STORAGE_KEY)
    const n = stored ? parseInt(stored, 10) : NaN
    return isNaN(n) ? DEFAULT_WIDTH : Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, n))
  })
  const dragStartX = useRef<number | null>(null)
  const dragStartW = useRef(width)

  const onHandlePointerDown = (e: React.PointerEvent): void => {
    e.preventDefault()
    dragStartX.current = e.clientX
    dragStartW.current = width
    ;(e.target as HTMLElement).setPointerCapture(e.pointerId)
  }
  const onHandlePointerMove = (e: React.PointerEvent): void => {
    if (dragStartX.current === null) return
    const delta = dragStartX.current - e.clientX
    setWidth(Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, dragStartW.current + delta)))
  }
  const onHandlePointerUp = (e: React.PointerEvent): void => {
    if (dragStartX.current === null) return
    const delta = dragStartX.current - e.clientX
    const final = Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, dragStartW.current + delta))
    setWidth(final)
    localStorage.setItem(STORAGE_KEY, String(final))
    dragStartX.current = null
  }

  // ── Render ───────────────────────────────────────────────────────
  return (
    <aside className={styles.panel} style={{ width }}>
      <div
        className={styles.resizeHandle}
        onPointerDown={onHandlePointerDown}
        onPointerMove={onHandlePointerMove}
        onPointerUp={onHandlePointerUp}
      />

      <div className={styles.content}>

        {/* ── General ───────────────────────────────────────── */}
        <div className={styles.section}>
          <div className={styles.sectionTitle}>General</div>

          <div className={styles.row}>
            <span className={styles.label}>Sprite Sheet</span>
            <Toggle checked={ss.enabled} onChange={v => dispatch({ type: 'SET_SPRITESHEET', payload: { enabled: v } })} />
          </div>

          <div className={`${styles.row} ${!ss.enabled ? styles.rowDisabled : ''}`}>
            <span className={styles.label}>Cell W</span>
            <SliderInput
              value={ss.cellWidth}
              min={1}
              max={Math.max(1, canvasW)}
              step={1}
              inputWidth={42}
              suffix="px"
              disabled={!ss.enabled}
              onChange={v => dispatch({ type: 'SET_SPRITESHEET', payload: { cellWidth: v } })}
            />
          </div>

          <div className={`${styles.row} ${!ss.enabled ? styles.rowDisabled : ''}`}>
            <span className={styles.label}>Cell H</span>
            <SliderInput
              value={ss.cellHeight}
              min={1}
              max={Math.max(1, canvasH)}
              step={1}
              inputWidth={42}
              suffix="px"
              disabled={!ss.enabled}
              onChange={v => dispatch({ type: 'SET_SPRITESHEET', payload: { cellHeight: v } })}
            />
          </div>
        </div>

        {/* ── Animations ────────────────────────────────────── */}
        {ss.enabled && <div className={styles.section}>
          <div className={styles.sectionTitle}>
            <span>Animations</span>
            <button
              className={styles.addBtn}
              title={atCapacity ? 'No space left on canvas' : 'Add animation'}
              disabled={atCapacity}
              onClick={() => dispatch({
                type: 'ADD_ANIMATION',
                payload: { id: newId(), name: 'New Animation', fps: 12, playbackMode: 'loop', frames: [] },
              })}
            >+</button>
          </div>

          {ss.animations.length === 0 && (
            <div className={styles.empty}>No animations yet</div>
          )}

          {ss.animations.map(anim => (
            <div
              key={anim.id}
              className={`${styles.animItem} ${ss.selectedAnimationId === anim.id ? styles.animSelected : ''}`}
              onClick={() => dispatch({ type: 'SET_SELECTED_ANIMATION', payload: anim.id })}
            >
              <div className={styles.animRow}>
                <input
                  className={styles.nameInput}
                  value={anim.name}
                  onChange={e => dispatch({ type: 'UPDATE_ANIMATION', payload: { ...anim, name: e.target.value } })}
                />
                <button
                  className={styles.removeBtn}
                  title="Delete animation"
                  onClick={e => { e.stopPropagation(); dispatch({ type: 'DELETE_ANIMATION', payload: anim.id }) }}
                >×</button>
              </div>
              <div className={styles.animMeta}>
                <span className={styles.metaLabel}>FPS</span>
                <SliderInput
                  value={anim.fps}
                  min={1}
                  max={60}
                  step={1}
                  inputWidth={32}
                  onChange={v => dispatch({ type: 'UPDATE_ANIMATION', payload: { ...anim, fps: v } })}
                />
                <span className={styles.metaLabel}>{anim.frames.length} fr</span>
              </div>
              <div className={styles.animMeta}>
                <span className={styles.metaLabel}>Playback Mode</span>
                <select
                  className={styles.modeSelect}
                  value={anim.playbackMode}
                  onChange={e => dispatch({ type: 'UPDATE_ANIMATION', payload: { ...anim, playbackMode: e.target.value as AnimationPlaybackMode } })}
                >
                  <option value="one-shot">One Shot</option>
                  <option value="loop">Loop</option>
                  <option value="ping-pong">Ping-Pong</option>
                </select>
              </div>
            </div>
          ))}
        </div>}

        {/* ── Frames (shown when animation selected) ────────── */}
        {ss.enabled && selectedAnim && (
          <div className={styles.section}>
            <div className={styles.sectionTitle}>
              <span>Frames</span>
              <button
                className={styles.addBtn}
                title={atCapacity ? 'No space left on canvas' : 'Add frame'}
                disabled={atCapacity}
                onClick={() => dispatch({
                  type: 'ADD_FRAME',
                  payload: { animationId: selectedAnim.id, frame: { id: newId(), duration: 1 } },
                })}
              >+</button>
            </div>

            {selectedAnim.frames.length === 0 && (
              <div className={styles.empty}>No frames yet</div>
            )}

            {selectedAnim.frames.map((frame, fi) => {
              const globalIdx = (animStartIdx.get(selectedAnim.id) ?? 0) + fi
              const px = sourceRectPx(globalIdx)
              const uv = sourceRectUV(px)
              const hasPrev = fi > 0
              const hasNext = fi < selectedAnim.frames.length - 1

              return (
                <div
                  key={frame.id}
                  className={`${styles.frameItem} ${ss.selectedFrameId === frame.id ? styles.frameSelected : ''}`}
                  onClick={() => dispatch({ type: 'SET_SELECTED_FRAME', payload: frame.id })}
                >
                  <div className={styles.frameHeader}>
                    <span className={styles.frameIndex}>Frame {fi + 1}</span>
                    <div className={styles.frameActions} onClick={e => e.stopPropagation()}>
                      <button
                        className={styles.frameActionBtn}
                        title="Copy pixels from previous frame"
                        disabled={!hasPrev}
                        onClick={() => onCopyPrevFrame(selectedAnim.id, frame.id)}
                      >← Prev</button>
                      <button
                        className={styles.frameActionBtn}
                        title="Copy pixels from next frame"
                        disabled={!hasNext}
                        onClick={() => onCopyNextFrame(selectedAnim.id, frame.id)}
                      >Next →</button>
                      <button
                        className={styles.removeBtn}
                        title="Remove frame"
                        onClick={() => dispatch({
                          type: 'DELETE_FRAME',
                          payload: { animationId: selectedAnim.id, frameId: frame.id },
                        })}
                      >×</button>
                    </div>
                  </div>

                  <div className={styles.frameRow}>
                    <span className={styles.frameLabel}>Duration</span>
                    <SliderInput
                      value={frame.duration}
                      min={1}
                      max={60}
                      step={1}
                      inputWidth={32}
                      onChange={v => dispatch({
                        type: 'UPDATE_FRAME',
                        payload: { animationId: selectedAnim.id, frame: { ...frame, duration: v } },
                      })}
                    />
                    <span className={styles.frameSuffix}>fr</span>
                  </div>

                  <div className={styles.frameRow}>
                    <span className={styles.frameLabel}>Src px</span>
                    <span className={styles.readonlyVal}>{px.x}, {px.y} · {px.w}×{px.h}</span>
                  </div>

                  <div className={styles.frameRow}>
                    <span className={styles.frameLabel}>Src UV</span>
                    <span className={styles.readonlyVal}>
                      {uv.u.toFixed(3)}, {uv.v.toFixed(3)} · {uv.uw.toFixed(3)}×{uv.vh.toFixed(3)}
                    </span>
                  </div>
                </div>
              )
            })}
          </div>
        )}

      </div>
    </aside>
  )
}
