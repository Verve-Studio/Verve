import React, { useState, useRef } from "react";
import styles from "./ToolWindow.module.scss";

// ─── Props ────────────────────────────────────────────────────────────────────

interface ToolWindowProps {
  title: string;
  icon?: React.ReactNode;
  onClose: () => void;
  children: React.ReactNode;
  width?: number;
  defaultPosition?: { x: number; y: number };
}

// ─── Close icon ───────────────────────────────────────────────────────────────

const CloseIcon = (): React.JSX.Element => (
  <svg
    viewBox="0 0 12 12"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.5"
    strokeLinecap="round"
    width="10"
    height="10"
    aria-hidden="true"
  >
    <line x1="1" y1="1" x2="11" y2="11" />
    <line x1="11" y1="1" x2="1" y2="11" />
  </svg>
);

// ─── Component ────────────────────────────────────────────────────────────────

export function ToolWindow({
  title,
  icon,
  onClose,
  children,
  width,
  defaultPosition,
}: ToolWindowProps): React.JSX.Element {
  const [pos, setPos] = useState<{ x: number; y: number }>(() => {
    if (defaultPosition) return defaultPosition;
    const screenW = typeof window !== "undefined" ? window.innerWidth : 1440;
    if (width == undefined) width = 284;
    return { x: Math.max(80, screenW - width - 290), y: 80 };
  });

  const dragRef = useRef<{
    startX: number;
    startY: number;
    originX: number;
    originY: number;
  } | null>(null);

  const onHeaderPointerDown = (e: React.PointerEvent<HTMLDivElement>): void => {
    if (e.button !== 0) return;
    // Don't initiate drag if the click is on the close button
    if ((e.target as HTMLElement).closest("button")) return;
    dragRef.current = {
      startX: e.clientX,
      startY: e.clientY,
      originX: pos.x,
      originY: pos.y,
    };
    e.currentTarget.setPointerCapture(e.pointerId);
  };

  const onHeaderPointerMove = (e: React.PointerEvent<HTMLDivElement>): void => {
    if (!dragRef.current) return;
    setPos({
      x: dragRef.current.originX + e.clientX - dragRef.current.startX,
      y: dragRef.current.originY + e.clientY - dragRef.current.startY,
    });
  };

  const onHeaderPointerUp = (e: React.PointerEvent<HTMLDivElement>): void => {
    if (!dragRef.current) return;
    dragRef.current = null;
    e.currentTarget.releasePointerCapture(e.pointerId);
  };

  return (
    <div
      className={styles.window}
      style={{ left: pos.x, top: pos.y, width }}
      role="dialog"
      aria-label={title}
    >
      <div
        className={styles.header}
        onPointerDown={onHeaderPointerDown}
        onPointerMove={onHeaderPointerMove}
        onPointerUp={onHeaderPointerUp}
      >
        {icon != null && <span className={styles.icon}>{icon}</span>}
        <span className={styles.title}>{title}</span>
        <button
          className={styles.closeBtn}
          onClick={onClose}
          aria-label="Close"
          title="Close"
        >
          <CloseIcon />
        </button>
      </div>
      {children}
    </div>
  );
}
