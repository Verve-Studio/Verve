import React, { useState } from 'react'
import { createPortal } from 'react-dom'
import { DialogButton } from '@/ux/widgets/DialogButton/DialogButton'
import styles from './ColorDitheringSetupModal.module.scss'

export interface ColorDitheringSetupModalProps {
  open: boolean
  onProceed: (addReduceColors: boolean) => void
  onOpenGeneratePalette: () => void
  onCancel: () => void
}

export function ColorDitheringSetupModal({
  open,
  onProceed,
  onCancel,
}: ColorDitheringSetupModalProps): React.JSX.Element | null {
  const [addReduceColors, setAddReduceColors] = useState(false)

  if (!open) return null

  const handleProceed = (): void => {
    onProceed(addReduceColors)
    setAddReduceColors(false)
  }

  const handleCancel = (): void => {
    setAddReduceColors(false)
    onCancel()
  }

  return createPortal(
    <div
      className={styles.backdrop}
      onMouseDown={(e) => { if (e.target === e.currentTarget) handleCancel() }}
    >
      <div className={styles.dialog} role="dialog" aria-modal="true" aria-label="Color Dithering Setup">
        <div className={styles.titleBar}>
          <span>Color Dithering Setup</span>
          <button className={styles.closeBtn} onClick={handleCancel} aria-label="Close">✕</button>
        </div>
        <div className={styles.body}>
          <p className={styles.intro}>
            Color Dithering works best when the document palette is configured. Both steps below are optional but
            recommended for the most accurate retro look.
          </p>

          <div className={styles.step}>
            <div className={styles.stepHeader}>
              <span className={styles.stepNum}>1</span>
              <span className={styles.stepTitle}>Configure Palette</span>
              <span className={styles.badge}>Optional</span>
            </div>
            <p className={styles.stepDesc}>Set up the target palette that dithering will map colors to.</p>
          </div>
        </div>
        <div className={styles.footer}>
          <DialogButton onClick={handleCancel}>Cancel</DialogButton>
          <DialogButton primary onClick={handleProceed}>
            Apply Dithering
          </DialogButton>
        </div>
      </div>
    </div>,
    document.body,
  )
}
