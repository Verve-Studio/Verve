import React, { useCallback, useEffect, useState } from 'react'
import { ModalDialog } from '../ModalDialog/ModalDialog'
import { DialogButton } from '../../widgets/DialogButton/DialogButton'
import { preferencesStore, usePreferences } from '@/core/store/preferencesStore'
import { historyStore } from '@/core/store/historyStore'
import { useTrackedMemory } from '@/core/store/memoryStore'
import styles from './PreferencesDialog.module.scss'

// ─── Types ─────────────────────────────────────────────────────────────────────

export interface PreferencesDialogProps {
  open: boolean
  onClose: () => void
}

type SectionId = 'fileAssoc' | 'memory'

const SECTIONS: Array<{ id: SectionId; label: string }> = [
  { id: 'fileAssoc', label: 'File Associations' },
  { id: 'memory', label: 'Memory' },
]

// Mirrors SUPPORTED_FILE_TYPES in fileAssociations.ts.
// Kept in sync manually — the IPC call is the source of truth for the registered list.
const ALL_FILE_TYPES = [
  { ext: 'verve', label: 'Verve Document (.verve)' },
  { ext: 'png', label: 'PNG Image (.png)' },
  { ext: 'jpg', label: 'JPEG Image (.jpg)' },
  { ext: 'jpeg', label: 'JPEG Image (.jpeg)' },
  { ext: 'webp', label: 'WebP Image (.webp)' },
  { ext: 'gif', label: 'GIF Image (.gif)' },
  { ext: 'bmp', label: 'BMP Image (.bmp)' },
  { ext: 'tga', label: 'TGA Image (.tga)' },
  { ext: 'tif', label: 'TIFF Image (.tif)' },
  { ext: 'tiff', label: 'TIFF Image (.tiff)' },
  { ext: 'exr', label: 'OpenEXR Image (.exr)' },
  { ext: 'hdr', label: 'Radiance HDR Image (.hdr)' },
]

// ─── Memory section ──────────────────────────────────────────────────────────

const GB = 1024 * 1024 * 1024
const MIN_HISTORY_GB = 0.5
const MAX_HISTORY_GB = 64
const STEP_GB = 0.5

function formatBytes(bytes: number): string {
  if (bytes >= GB) return `${(bytes / GB).toFixed(2)} GB`
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${bytes} B`
}

function MemorySection(): React.JSX.Element {
  const prefs = usePreferences()
  // Subscribe to historyStore so the "currently used" readout updates live as
  // the user paints / undoes / redoes while the dialog is open.
  const [bytesUsed, setBytesUsed] = useState(() => historyStore.getCurrentBytes())
  useEffect(() => {
    const update = (): void => setBytesUsed(historyStore.getCurrentBytes())
    update()
    return historyStore.subscribe(update)
  }, [])

  const valueGB = prefs.historyMemoryBytes / GB
  const handleChange = (e: React.ChangeEvent<HTMLInputElement>): void => {
    const gb = Number(e.target.value)
    if (!Number.isFinite(gb)) return
    preferencesStore.set({ historyMemoryBytes: Math.round(gb * GB) })
  }

  const pctUsed = Math.min(100, (bytesUsed / prefs.historyMemoryBytes) * 100)

  // ── Buffer-memory cap (layer data + GPU textures + caches) ─────────
  const [systemRamBytes, setSystemRamBytes] = useState<number | null>(null)
  useEffect(() => {
    void window.api.getSystemTotalMemoryBytes().then(setSystemRamBytes)
  }, [])
  const { cpu: cpuBytesUsed, gpu: gpuBytesUsed } = useTrackedMemory()
  // Capped total: cpu+gpu when unified, else cpu only.
  const cappedBytesUsed = prefs.unifiedMemory ? cpuBytesUsed + gpuBytesUsed : cpuBytesUsed
  const bufferValueGB = prefs.bufferMemoryBytes / GB
  // Cap the slider at installed system RAM (rounded down to the nearest
  // 0.5 GB step) so the user can't set a value that physically can't fit.
  const bufferMaxGB = systemRamBytes != null
    ? Math.max(MIN_HISTORY_GB, Math.floor((systemRamBytes / GB) * 2) / 2)
    : 64
  const handleBufferChange = (e: React.ChangeEvent<HTMLInputElement>): void => {
    const gb = Number(e.target.value)
    if (!Number.isFinite(gb)) return
    preferencesStore.set({ bufferMemoryBytes: Math.round(gb * GB) })
  }
  const handleBufferMaxOutChange = (e: React.ChangeEvent<HTMLInputElement>): void => {
    preferencesStore.set({ bufferMemoryMaxOut: e.target.checked })
  }
  const handleUnifiedChange = (e: React.ChangeEvent<HTMLInputElement>): void => {
    preferencesStore.set({ unifiedMemory: e.target.checked })
  }
  const bufferPctUsed = prefs.bufferMemoryMaxOut
    ? 0
    : Math.min(100, (cappedBytesUsed / prefs.bufferMemoryBytes) * 100)

  return (
    <div className={styles.sectionBody}>
      <div className={styles.field}>
        <label className={styles.fieldLabel} htmlFor="history-memory">
          History memory limit
        </label>
        <div className={styles.fieldRow}>
          <input
            id="history-memory"
            type="range"
            min={MIN_HISTORY_GB}
            max={MAX_HISTORY_GB}
            step={STEP_GB}
            value={valueGB}
            onChange={handleChange}
            className={styles.slider}
          />
          <input
            type="number"
            min={MIN_HISTORY_GB}
            max={MAX_HISTORY_GB}
            step={STEP_GB}
            value={valueGB}
            onChange={handleChange}
            className={styles.numberInput}
          />
          <span className={styles.unit}>GB</span>
        </div>
        <p className={styles.hint}>
          Maximum RAM the undo / redo history is allowed to use. When this
          limit is reached, the oldest entries are discarded to make room for
          new ones. Lower values keep memory usage in check on large
          documents; higher values give you more undo steps to work with.
        </p>
      </div>

      <div className={styles.field}>
        <span className={styles.fieldLabel}>Current usage</span>
        <div className={styles.usageBar}>
          <div className={styles.usageFill} style={{ width: `${pctUsed}%` }} />
        </div>
        <span className={styles.hint}>
          {formatBytes(bytesUsed)} of {formatBytes(prefs.historyMemoryBytes)} used
          {' · '}
          {historyStore.entries.length} {historyStore.entries.length === 1 ? 'entry' : 'entries'}
        </span>
      </div>

      <div className={styles.field}>
        <label className={styles.fieldLabel} htmlFor="buffer-memory">
          Buffer memory limit
        </label>
        <div className={styles.fieldRow}>
          <input
            id="buffer-memory"
            type="range"
            min={MIN_HISTORY_GB}
            max={bufferMaxGB}
            step={STEP_GB}
            value={Math.min(bufferValueGB, bufferMaxGB)}
            onChange={handleBufferChange}
            disabled={prefs.bufferMemoryMaxOut}
            className={styles.slider}
          />
          <input
            type="number"
            min={MIN_HISTORY_GB}
            max={bufferMaxGB}
            step={STEP_GB}
            value={bufferValueGB}
            onChange={handleBufferChange}
            disabled={prefs.bufferMemoryMaxOut}
            className={styles.numberInput}
          />
          <span className={styles.unit}>GB</span>
          <label className={styles.checkboxLabel}>
            <input
              type="checkbox"
              checked={prefs.bufferMemoryMaxOut}
              onChange={handleBufferMaxOutChange}
            />
            Max Out
          </label>
        </div>
        <p className={styles.hint}>
          Soft cap on memory used by all open documents — layer pixel data,
          GPU textures, and compositing buffers. Operations that would push
          usage past this limit are aborted with an error so the app stays
          responsive instead of crashing the OS. Enable
          <strong> Max Out</strong> to disable the cap and let allocations
          run until the operating system itself fails (
          {systemRamBytes != null ? `installed RAM: ${formatBytes(systemRamBytes)}` : 'detecting installed RAM…'}).
          {' '}
          {prefs.unifiedMemory
            ? 'On this system the cap covers CPU buffers and GPU textures combined (unified memory).'
            : 'On this system the cap covers CPU buffers only — GPU textures live in dedicated VRAM and are tracked but not capped.'}
        </p>
      </div>

      <div className={styles.field}>
        <label className={styles.checkboxLabel} style={{ marginLeft: 0 }}>
          <input
            type="checkbox"
            checked={prefs.unifiedMemory}
            onChange={handleUnifiedChange}
          />
          Treat GPU memory as part of system RAM (unified memory)
        </label>
        <p className={styles.hint}>
          Auto-detected from your platform on first launch — leave this on
          for Apple Silicon and other systems with integrated graphics, off
          for machines with a dedicated GPU and separate VRAM.
        </p>
      </div>

      <div className={styles.field}>
        <span className={styles.fieldLabel}>
          CPU memory usage
          {!prefs.bufferMemoryMaxOut && (
            <> — {formatBytes(cpuBytesUsed)} of {formatBytes(prefs.bufferMemoryBytes)}</>
          )}
          {prefs.bufferMemoryMaxOut && <> — {formatBytes(cpuBytesUsed)} (uncapped)</>}
        </span>
        <div className={styles.usageBar}>
          <div
            className={styles.usageFill}
            style={{
              width: `${prefs.bufferMemoryMaxOut ? 0 : Math.min(100, (cpuBytesUsed / prefs.bufferMemoryBytes) * 100)}%`,
            }}
          />
        </div>
        <span className={styles.hint}>
          Layer pixel data, history snapshots, and other JS-heap buffers we
          allocate via <code>allocUint8</code> / <code>allocFloat32</code>.
        </span>
      </div>

      <div className={styles.field}>
        <span className={styles.fieldLabel}>
          GPU memory usage
          {prefs.unifiedMemory && !prefs.bufferMemoryMaxOut && (
            <> — {formatBytes(gpuBytesUsed)} of {formatBytes(prefs.bufferMemoryBytes)}</>
          )}
          {(!prefs.unifiedMemory || prefs.bufferMemoryMaxOut) && (
            <> — {formatBytes(gpuBytesUsed)} {prefs.unifiedMemory ? '(uncapped)' : '(VRAM, uncapped)'}</>
          )}
        </span>
        <div className={styles.usageBar}>
          <div
            className={styles.usageFill}
            style={{
              width: `${prefs.bufferMemoryMaxOut
                  ? 0
                  : prefs.unifiedMemory
                    ? Math.min(100, (gpuBytesUsed / prefs.bufferMemoryBytes) * 100)
                    // Discrete: scale against the largest GPU footprint we've
                    // ever observed so the bar still moves visibly.
                    : Math.min(100, (gpuBytesUsed / Math.max(gpuBytesUsed, prefs.bufferMemoryBytes)) * 100)
                }%`,
            }}
          />
        </div>
        <span className={styles.hint}>
          GPU textures owned by our renderer (layer textures, ping-pong,
          adjustment / filter caches). On dedicated-VRAM systems these
          live in VRAM and aren't capped by the buffer-memory limit.
        </span>
      </div>

      <div className={styles.field}>
        <span className={styles.fieldLabel}>
          Total tracked memory — {formatBytes(cpuBytesUsed + gpuBytesUsed)}
          {!prefs.bufferMemoryMaxOut && prefs.unifiedMemory && (
            <> of {formatBytes(prefs.bufferMemoryBytes)} ({Math.round(bufferPctUsed)}% of cap)</>
          )}
        </span>
        <div className={styles.usageBar}>
          <div
            className={styles.usageFill}
            style={{ width: `${bufferPctUsed}%` }}
          />
        </div>
        <span className={styles.hint}>
          CPU ({formatBytes(cpuBytesUsed)}) + GPU ({formatBytes(gpuBytesUsed)}).
          {' '}
          {prefs.unifiedMemory
            ? 'Both buckets count against the cap on this system.'
            : 'Only CPU counts against the cap on this system.'}
        </span>
      </div>
    </div>
  )
}

// ─── File Associations section ────────────────────────────────────────────────

function FileAssocSection(): React.JSX.Element {
  // available = supported types NOT currently registered
  const [available, setAvailable] = useState<string[]>([])
  const [registered, setRegistered] = useState<string[]>([])
  const [selLeft, setSelLeft] = useState<Set<string>>(new Set())
  const [selRight, setSelRight] = useState<Set<string>>(new Set())
  const [applying, setApplying] = useState(false)
  const [status, setStatus] = useState<{ ok: boolean; msg: string } | null>(null)
  const [platform, setPlatform] = useState('')

  // Load current state whenever the section mounts / re-mounts
  useEffect(() => {
    void window.api.getFileAssocState().then(state => {
      setPlatform(state.platform)
      const allExts = (state.supported ?? ALL_FILE_TYPES).map(t => t.ext)
      const reg = state.registered ?? []
      setRegistered(reg)
      setAvailable(allExts.filter(e => !reg.includes(e)))
      setSelLeft(new Set())
      setSelRight(new Set())
      if (state.error) setStatus({ ok: false, msg: state.error })
    })
  }, [])

  // ── Selection helpers ─────────────────────────────────────────────

  const toggleLeft = useCallback((ext: string, e: React.MouseEvent) => {
    setSelLeft(prev => {
      const next = new Set(prev)
      if (e.ctrlKey || e.metaKey) {
        next.has(ext) ? next.delete(ext) : next.add(ext)
      } else if (e.shiftKey) {
        // range select from last clicked
        const list = available
        const anchor = [...prev][prev.size - 1]
        const ai = list.indexOf(anchor ?? '')
        const bi = list.indexOf(ext)
        const lo = Math.min(ai, bi)
        const hi = Math.max(ai, bi)
        list.slice(lo < 0 ? bi : lo, hi + 1).forEach(e => next.add(e))
      } else {
        next.clear()
        next.add(ext)
      }
      return next
    })
    setSelRight(new Set())
  }, [available])

  const toggleRight = useCallback((ext: string, e: React.MouseEvent) => {
    setSelRight(prev => {
      const next = new Set(prev)
      if (e.ctrlKey || e.metaKey) {
        next.has(ext) ? next.delete(ext) : next.add(ext)
      } else if (e.shiftKey) {
        const list = registered
        const anchor = [...prev][prev.size - 1]
        const ai = list.indexOf(anchor ?? '')
        const bi = list.indexOf(ext)
        const lo = Math.min(ai, bi)
        const hi = Math.max(ai, bi)
        list.slice(lo < 0 ? bi : lo, hi + 1).forEach(e => next.add(e))
      } else {
        next.clear()
        next.add(ext)
      }
      return next
    })
    setSelLeft(new Set())
  }, [registered])

  // ── Move actions ──────────────────────────────────────────────────

  const moveRight = useCallback(() => {
    if (selLeft.size === 0) return
    setRegistered(r => [...r, ...available.filter(e => selLeft.has(e))])
    setAvailable(a => a.filter(e => !selLeft.has(e)))
    setSelLeft(new Set())
    setStatus(null)
  }, [available, selLeft])

  const moveLeft = useCallback(() => {
    if (selRight.size === 0) return
    setAvailable(a => [...a, ...registered.filter(e => selRight.has(e))])
    setRegistered(r => r.filter(e => !selRight.has(e)))
    setSelRight(new Set())
    setStatus(null)
  }, [registered, selRight])

  const moveAllRight = useCallback(() => {
    if (available.length === 0) return
    setRegistered(r => [...r, ...available])
    setAvailable([])
    setSelLeft(new Set())
    setSelRight(new Set())
    setStatus(null)
  }, [available])

  const moveAllLeft = useCallback(() => {
    if (registered.length === 0) return
    setAvailable(a => [...a, ...registered])
    setRegistered([])
    setSelLeft(new Set())
    setSelRight(new Set())
    setStatus(null)
  }, [registered])

  // ── Apply ─────────────────────────────────────────────────────────

  const handleApply = useCallback(async () => {
    setApplying(true)
    setStatus(null)
    try {
      const result = await window.api.applyFileAssoc(registered)
      if (result.success) {
        setStatus({ ok: true, msg: 'File associations updated successfully.' })
      } else {
        setStatus({ ok: false, msg: result.error ?? 'Registration failed.' })
      }
    } catch (e) {
      setStatus({ ok: false, msg: e instanceof Error ? e.message : String(e) })
    } finally {
      setApplying(false)
    }
  }, [registered])

  // ── Platform-specific hint & layout ──────────────────────────────

  // On macOS, file type registration is bundle-level (Info.plist / Launch Services).
  // Individual extension selection is not meaningful — the OS registers whatever
  // the bundle declares. We still show the list as informational, and "Apply"
  // calls lsregister to re-register the bundle.
  const isMac = platform === 'darwin'
  const platformHint = isMac
    ? 'On macOS, Verve registers all supported types at once via Launch Services. ' +
    'To set Verve as the default for a type, right-click a file in Finder → Get Info → Open With → Change All.'
    : null

  return (
    <div className={styles.sectionBody}>
      <div className={styles.transferRow}>
        {/* Left: available */}
        <div className={styles.transferColumn}>
          <span className={styles.columnLabel}>Supported</span>
          <div className={styles.listBox}>
            {available.map(ext => {
              const entry = ALL_FILE_TYPES.find(t => t.ext === ext)
              return (
                <div
                  key={ext}
                  className={`${styles.listItem} ${selLeft.has(ext) ? styles.selected : ''}`}
                  onMouseDown={e => toggleLeft(ext, e)}
                  onDoubleClick={() => {
                    setSelLeft(new Set([ext]))
                    moveRight()
                  }}
                >
                  {entry?.label ?? `.${ext}`}
                </div>
              )
            })}
          </div>
        </div>

        {/* Move buttons — hidden on macOS (bundle-level registration only) */}
        {!isMac && <div className={styles.moveButtons}>
          <button
            className={styles.moveBtn}
            onClick={moveRight}
            disabled={selLeft.size === 0}
            title="Add selected"
            aria-label="Add selected to registered"
          >›</button>
          <button
            className={styles.moveBtn}
            onClick={moveAllRight}
            disabled={available.length === 0}
            title="Add all"
            aria-label="Add all to registered"
          >»</button>
          <button
            className={styles.moveBtn}
            onClick={moveLeft}
            disabled={selRight.size === 0}
            title="Remove selected"
            aria-label="Remove selected from registered"
          >‹</button>
          <button
            className={styles.moveBtn}
            onClick={moveAllLeft}
            disabled={registered.length === 0}
            title="Remove all"
            aria-label="Remove all from registered"
          >«</button>
        </div>}

        {/* Right: registered */}
        <div className={styles.transferColumn}>
          <span className={styles.columnLabel}>Registered</span>
          <div className={styles.listBox}>
            {registered.map(ext => {
              const entry = ALL_FILE_TYPES.find(t => t.ext === ext)
              return (
                <div
                  key={ext}
                  className={`${styles.listItem} ${selRight.has(ext) ? styles.selected : ''}`}
                  onMouseDown={e => toggleRight(ext, e)}
                  onDoubleClick={() => {
                    setSelRight(new Set([ext]))
                    moveLeft()
                  }}
                >
                  {entry?.label ?? `.${ext}`}
                </div>
              )
            })}
          </div>
        </div>
      </div>

      {platformHint && <p className={styles.hint}>{platformHint}</p>}

      <div className={styles.statusRow}>
        {status && (
          <span className={status.ok ? styles.statusOk : styles.statusError}>
            {status.msg}
          </span>
        )}
      </div>

      <div className={styles.footer} style={{ padding: 0, borderTop: 'none' }}>
        <DialogButton width='196px' onClick={() => { void handleApply() }} primary disabled={applying}>
          {applying ? 'Applying…' : 'Apply'}
        </DialogButton>
      </div>
    </div>
  )
}

// ─── Component ────────────────────────────────────────────────────────────────

export function PreferencesDialog({ open, onClose }: PreferencesDialogProps): React.JSX.Element | null {
  const [activeSection, setActiveSection] = useState<SectionId>('fileAssoc')

  return (
    <ModalDialog open={open} title="Preferences" width={620} onClose={onClose}>
      <div className={styles.layout}>
        {/* Sidebar */}
        <nav className={styles.sidebar} aria-label="Preferences sections">
          {SECTIONS.map(s => (
            <button
              key={s.id}
              className={`${styles.sidebarItem} ${activeSection === s.id ? styles.active : ''}`}
              onClick={() => setActiveSection(s.id)}
            >
              {s.label}
            </button>
          ))}
        </nav>

        {/* Content */}
        <div className={styles.content}>
          <div className={styles.sectionHeader}>
            {SECTIONS.find(s => s.id === activeSection)?.label}
          </div>
          {activeSection === 'fileAssoc' && <FileAssocSection key={open ? 'open' : 'closed'} />}
          {activeSection === 'memory' && <MemorySection />}
        </div>
      </div>

      <div className={styles.footer}>
        <DialogButton width='196px' onClick={onClose}>Close</DialogButton>
      </div>
    </ModalDialog>
  )
}
