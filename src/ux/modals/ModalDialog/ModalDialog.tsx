import React, { useEffect, useLayoutEffect, useRef, useState } from "react";
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
  /**
   * Called when the user presses Enter (the dialog's default action). It runs
   * after the focused field has handled the same Enter and its state update
   * has rendered, so a value typed into a field and committed by Enter is
   * included. Enter on a button, textarea, link or contenteditable element
   * keeps its own meaning, and a field can opt out by calling
   * `preventDefault()` on the keydown.
   */
  onSubmit?: () => void;
}

/** Elements whose own Enter behaviour wins over the dialog's default action. */
function ownsEnter(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return (
    target instanceof HTMLButtonElement ||
    target instanceof HTMLTextAreaElement ||
    target instanceof HTMLAnchorElement ||
    target.isContentEditable
  );
}

// ─── Component ────────────────────────────────────────────────────────────────

export function ModalDialog({
  open,
  title,
  width = "auto",
  onClose,
  children,
  className,
  onSubmit,
}: ModalDialogProps): React.JSX.Element | null {
  // Enter → submit. The request is recorded as state and the submit runs in
  // an effect, i.e. after the render that includes whatever the focused field
  // committed on the same keydown (a document-level listener that submitted
  // directly would see the old values, or swallow the field's Enter).
  const [submitRequest, setSubmitRequest] = useState(0);
  const onSubmitRef = useRef(onSubmit);
  useLayoutEffect(() => {
    onSubmitRef.current = onSubmit;
  });
  useEffect(() => {
    if (submitRequest > 0) onSubmitRef.current?.();
  }, [submitRequest]);
  const dialogRef = useRef<HTMLDivElement>(null);

  // Keyboard: Escape closes; Enter with focus outside the dialog submits
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
      } else if (
        e.key === "Enter" &&
        onSubmitRef.current &&
        !(e.target instanceof Node && dialogRef.current?.contains(e.target))
      ) {
        // Focus is outside the dialog (e.g. on the body): nothing in the
        // dialog will see this Enter, so submit here and keep it from the
        // app's own shortcuts. Enter inside the dialog is handled by the
        // dialog's onKeyDown, after the focused field.
        e.stopPropagation();
        if (!e.isComposing) setSubmitRequest((n) => n + 1);
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
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        onKeyDown={(e) => {
          // Bubble phase: the focused field has already handled the key.
          if (e.key !== "Enter" || !onSubmit) return;
          if (!e.defaultPrevented && !e.nativeEvent.isComposing && !ownsEnter(e.target)) {
            setSubmitRequest((n) => n + 1);
          }
          // Keep the dialog's Enter away from app-level shortcuts.
          e.stopPropagation();
        }}
      >
        <div className={styles.titleBar}>{title}</div>
        {children}
      </div>
    </div>,
    document.body,
  );
}
