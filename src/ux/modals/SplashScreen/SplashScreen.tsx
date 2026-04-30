import React, { useEffect } from 'react'
import { createPortal } from 'react-dom'
import styles from './SplashScreen.module.scss'
import appIcon from '../../../../build-resources/icon.png'

export interface SplashScreenProps {
  open: boolean
  onClose: () => void
  onNew: () => void
  onOpen: () => void
}

export function SplashScreen({ open, onClose, onNew, onOpen }: SplashScreenProps): React.JSX.Element | null {
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') { e.stopPropagation(); onClose() }
    }
    document.addEventListener('keydown', onKey, true)
    return () => document.removeEventListener('keydown', onKey, true)
  }, [open, onClose])

  if (!open) return null

  return createPortal(
    <div
      className={styles.backdrop}
      onMouseDown={(e) => { if (e.target === e.currentTarget) onClose() }}
      role="presentation"
    >
      <div className={styles.dialog} role="dialog" aria-modal="true" aria-label="Welcome to Verve">

        {/* ── Hero ── */}
        <div className={styles.hero} aria-hidden="true">
          <div className={styles.heroPattern} />
          <img src={appIcon} className={styles.heroIcon} width={72} height={72} alt="" />
          <h1 className={styles.heroName}>Verve</h1>
          <p className={styles.heroTagline}>A liberated image editor</p>
        </div>

        {/* ── Actions ── */}
        <div className={styles.actions}>
          <div className={styles.actionGroup}>
            <button className={styles.actionBtn} onClick={onNew}>
              <svg className={styles.actionIcon} viewBox="0 0 16 16" fill="currentColor" width="16" height="16" aria-hidden="true">
                <rect x="2" y="2" width="9" height="11" rx="1" opacity="0.25"/>
                <rect x="3" y="1" width="9" height="11" rx="1" fill="currentColor" opacity="0.9" stroke="currentColor" strokeWidth="0.5"/>
                <line x1="6" y1="6.5" x2="10" y2="6.5" stroke="currentColor" strokeWidth="1" strokeLinecap="round"/>
                <line x1="6" y1="8.5" x2="10" y2="8.5" stroke="currentColor" strokeWidth="1" strokeLinecap="round"/>
                <line x1="6" y1="10.5" x2="9" y2="10.5" stroke="currentColor" strokeWidth="1" strokeLinecap="round"/>
              </svg>
              <span className={styles.actionLabel}>New File</span>
              <span className={styles.actionHint}>Ctrl+N</span>
            </button>

            <button className={styles.actionBtn} onClick={onOpen}>
              <svg className={styles.actionIcon} viewBox="0 0 16 16" fill="currentColor" width="16" height="16" aria-hidden="true">
                <path d="M2 4.5A1.5 1.5 0 013.5 3H6l1.5 2H13a1.5 1.5 0 011.5 1.5v5A1.5 1.5 0 0113 13H3.5A1.5 1.5 0 012 11.5v-7z" opacity="0.9"/>
              </svg>
              <span className={styles.actionLabel}>Open File</span>
              <span className={styles.actionHint}>Ctrl+O</span>
            </button>
          </div>

          <button className={styles.dismissBtn} onClick={onClose}>
            Skip
          </button>
        </div>

      </div>
    </div>,
    document.body
  )
}
