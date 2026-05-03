import React, { useCallback, useEffect, useState } from 'react'
import { ModalDialog } from '../ModalDialog/ModalDialog'
import { DialogButton } from '../../widgets/DialogButton/DialogButton'
import styles from './PreferencesDialog.module.scss'

// ─── Types ────────────────────────────────────────────────────────────────────

export interface PreferencesDialogProps {
  open: boolean
  onClose: () => void
}

type SectionId = 'fileAssoc'

const SECTIONS: Array<{ id: SectionId; label: string }> = [
  { id: 'fileAssoc', label: 'File Associations' },
]

// Mirrors SUPPORTED_FILE_TYPES in fileAssociations.ts.
// Kept in sync manually — the IPC call is the source of truth for the registered list.
const ALL_FILE_TYPES = [
  { ext: 'verve', label: 'Verve Document (.verve)' },
  { ext: 'png',   label: 'PNG Image (.png)' },
  { ext: 'jpg',   label: 'JPEG Image (.jpg)' },
  { ext: 'jpeg',  label: 'JPEG Image (.jpeg)' },
  { ext: 'webp',  label: 'WebP Image (.webp)' },
  { ext: 'gif',   label: 'GIF Image (.gif)' },
  { ext: 'bmp',   label: 'BMP Image (.bmp)' },
  { ext: 'tga',   label: 'TGA Image (.tga)' },
  { ext: 'tif',   label: 'TIFF Image (.tif)' },
  { ext: 'tiff',  label: 'TIFF Image (.tiff)' },
  { ext: 'exr',   label: 'OpenEXR Image (.exr)' },
  { ext: 'hdr',   label: 'Radiance HDR Image (.hdr)' },
]

// ─── File Associations section ────────────────────────────────────────────────

function FileAssocSection(): React.JSX.Element {
  // available = supported types NOT currently registered
  const [available, setAvailable]     = useState<string[]>([])
  const [registered, setRegistered]   = useState<string[]>([])
  const [selLeft, setSelLeft]         = useState<Set<string>>(new Set())
  const [selRight, setSelRight]       = useState<Set<string>>(new Set())
  const [applying, setApplying]       = useState(false)
  const [status, setStatus]           = useState<{ ok: boolean; msg: string } | null>(null)
  const [platform, setPlatform]       = useState('')

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
        </div>
      </div>

      <div className={styles.footer}>
        <DialogButton width='196px' onClick={onClose}>Close</DialogButton>
      </div>
    </ModalDialog>
  )
}
