import React, { useEffect } from "react";
import { createPortal } from "react-dom";
import styles from "./ModalDialog.module.scss";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface ModalDialogProps {
  /** Controls visibility — when false the component renders nothing. */
  open: boolean;
  /** Text shown in the title bar. */
  title: string;
  /**
   * CSS width of the dialog shell.
   * Accepts any valid CSS value, e.g. `560`, `'440px'`, `'auto'`.
   * Defaults to `'auto'`.
   */
  width?: number | string;
  /**
   * Called when the user presses Escape or clicks the backdrop.
   * The parent is responsible for setting `open` to false.
   */
  onClose: () => void;
  /** Dialog content — include body *and* footer as children. */
  children: React.ReactNode;
  /** Optional extra className(s) applied to the dialog shell. */
  className?: string;
}

// ─── Component ────────────────────────────────────────────────────────────────

export function ModalDialog({
  open,
  title,
  width = "auto",
  onClose,
  children,
  className,
}: ModalDialogProps): React.JSX.Element | null {
  // Keyboard: Escape closes
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
      }
    };
    document.addEventListener("keydown", onKey, true);
    return () => document.removeEventListener("keydown", onKey, true);
  }, [open, onClose]);

  if (!open) return null;

  const widthValue = typeof width === "number" ? `${width}px` : width;

  return createPortal(
    <div
      className={styles.backdrop}
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
      role="presentation"
    >
      <div
        className={`${styles.dialog}${className ? ` ${className}` : ""}`}
        style={{ width: widthValue }}
        role="dialog"
        aria-modal="true"
        aria-label={title}
      >
        <div className={styles.titleBar}>{title}</div>
        {children}
      </div>
    </div>,
    document.body,
  );
}
