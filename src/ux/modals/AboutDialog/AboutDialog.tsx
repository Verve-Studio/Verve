import React from 'react'
import { ModalDialog } from '../ModalDialog/ModalDialog'
import { DialogButton } from '../../widgets/DialogButton/DialogButton'
import styles from './AboutDialog.module.scss'
import appIcon from '../../../../build-resources/icon.png'

// ─── Types ────────────────────────────────────────────────────────────────────

export interface AboutDialogProps {
  open: boolean
  onClose: () => void
}

// ─── Component ────────────────────────────────────────────────────────────────

export function AboutDialog({ open, onClose }: AboutDialogProps): React.JSX.Element | null {
  return (
    <ModalDialog open={open} title="About PixelShop" width={380} onClose={onClose}>
      <div className={styles.body}>
        <div className={styles.logo} aria-hidden="true">
          <img src={appIcon} width={128} height={128} alt="" />
        </div>

        <h1 className={styles.name}>PixelShop</h1>
        <p className={styles.version}>Version 2026</p>

        <p className={styles.desc}>
          An image and pixel-art editor inspired by Photoshop, built for the desktop.
        </p>
      </div>

      <div className={styles.footer}>
        <DialogButton onClick={onClose} primary>Close</DialogButton>
      </div>
    </ModalDialog>
  )
}
