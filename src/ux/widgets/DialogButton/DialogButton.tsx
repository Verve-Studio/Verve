import React from 'react'
import styles from './DialogButton.module.scss'

export interface DialogButtonProps {
  onClick?: () => void
  primary?: boolean
  title?: string
  className?: string
  disabled?: boolean
  type?: 'button' | 'submit' | 'reset'
  'aria-pressed'?: boolean
  'aria-label'?: string
  children: React.ReactNode
}

export function DialogButton({
  onClick,
  primary,
  title,
  className,
  disabled,
  type = 'button',
  'aria-pressed': ariaPressed,
  'aria-label': ariaLabel,
  children,
}: DialogButtonProps): React.JSX.Element {
  const cls = [primary ? `${styles.btn} ${styles.btnPrimary}` : styles.btn, className]
    .filter(Boolean)
    .join(' ')
  return (
    <button
      className={cls}
      title={title}
      disabled={disabled}
      type={type}
      aria-pressed={ariaPressed}
      aria-label={ariaLabel}
      onClick={onClick}
    >
      {children}
    </button>
  )
}
