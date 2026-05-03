import React from 'react'
import styles from './DialogButton.module.scss'

export interface DialogButtonProps {
  onClick?: () => void
  primary?: boolean
  title?: string
  className?: string
  disabled?: boolean
  width?: number | string
  align?: 'left' | 'center' | 'right'
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
  width,
  align,
  type = 'button',
  'aria-pressed': ariaPressed,
  'aria-label': ariaLabel,
  children,
}: DialogButtonProps): React.JSX.Element {
  const cls = [primary ? `${styles.btn} ${styles.btnPrimary}` : styles.btn, className]
    .filter(Boolean)
    .join(' ')
  const marginStyle: React.CSSProperties =
    align === 'center' ? { marginLeft: 'auto', marginRight: 'auto' } :
    align === 'right'  ? { marginLeft: 'auto', marginRight: 0 } :
    align === 'left'   ? { marginLeft: 0, marginRight: 'auto' } : {}
  const style: React.CSSProperties | undefined =
    (width !== undefined || align !== undefined)
      ? { ...(width !== undefined ? { width } : {}), display: 'block', ...marginStyle }
      : undefined
  return (
    <button
      className={cls}
      style={style}
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
