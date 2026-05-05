import React, { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { RGBAColor } from "@/types";
import styles from "./IndexedPaletteColorPicker.module.scss";

export interface IndexedPaletteColorPickerProps {
  palette: readonly RGBAColor[];
  activeIndex: number;
  anchorPos?: { x: number; y: number };
  onSelect: (index: number, color: RGBAColor) => void;
  onClose: () => void;
  onAddColor?: () => void;
}

function toHex(c: RGBAColor): string {
  return (
    "#" + [c.r, c.g, c.b].map((v) => v.toString(16).padStart(2, "0")).join("")
  );
}

export function IndexedPaletteColorPicker({
  palette,
  activeIndex,
  anchorPos,
  onSelect,
  onClose,
  onAddColor,
}: IndexedPaletteColorPickerProps): React.JSX.Element {
  const popupRef = useRef<HTMLDivElement>(null);
  const [hovered, setHovered] = useState<number | null>(null);
  const [clampedPos, setClampedPos] = useState<{ x: number; y: number } | null>(
    anchorPos ?? null,
  );

  // After the popup renders, clamp so it stays inside the viewport
  useLayoutEffect(() => {
    if (!anchorPos || !popupRef.current) return;
    const rect = popupRef.current.getBoundingClientRect();
    const margin = 8;
    const x = Math.min(anchorPos.x, window.innerWidth - rect.width - margin);
    const y = Math.min(anchorPos.y, window.innerHeight - rect.height - margin);
    setClampedPos({ x: Math.max(margin, x), y: Math.max(margin, y) });
  }, [anchorPos]);

  // Close on outside click
  useEffect(() => {
    const handler = (e: PointerEvent): void => {
      if (popupRef.current?.contains(e.target as Node)) return;
      onClose();
    };
    document.addEventListener("pointerdown", handler, { capture: true });
    return () =>
      document.removeEventListener("pointerdown", handler, { capture: true });
  }, [onClose]);

  // Close on Escape
  useEffect(() => {
    const handler = (e: KeyboardEvent): void => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [onClose]);

  const footerIdx = hovered ?? (activeIndex >= 0 ? activeIndex : null);
  const footerColor = footerIdx !== null ? (palette[footerIdx] ?? null) : null;

  return createPortal(
    <div
      ref={popupRef}
      className={styles.picker}
      style={clampedPos ? { left: clampedPos.x, top: clampedPos.y } : undefined}
      onPointerDown={(e) => e.stopPropagation()}
    >
      <div className={styles.header}>
        <span className={styles.title}>Color Palette</span>
        <span className={styles.badge}>Indexed/8</span>
      </div>
      <div className={styles.grid}>
        {palette.map((color, idx) => {
          const bg = `rgba(${color.r},${color.g},${color.b},${color.a / 255})`;
          return (
            <div
              key={idx}
              className={[
                styles.cell,
                idx === activeIndex ? styles.active : "",
              ].join(" ")}
              style={{ background: bg }}
              title={`idx ${idx}  ${toHex(color)}`}
              onPointerEnter={() => setHovered(idx)}
              onPointerLeave={() => setHovered(null)}
              onClick={() => {
                onSelect(idx, color);
                onClose();
              }}
            />
          );
        })}
      </div>
      <div className={styles.footer}>
        {footerColor !== null && footerIdx !== null ? (
          <>
            <div
              className={styles.footerSwatch}
              style={{
                background: `rgba(${footerColor.r},${footerColor.g},${footerColor.b},${footerColor.a / 255})`,
              }}
            />
            <span className={styles.footerText}>
              idx {footerIdx} &nbsp; {toHex(footerColor).toUpperCase()}
            </span>
          </>
        ) : (
          <span className={styles.footerText}>—</span>
        )}
        {onAddColor && (
          <button
            className={styles.addBtn}
            title="Add new color to palette"
            onClick={() => {
              onClose();
              onAddColor();
            }}
          >
            +
          </button>
        )}
      </div>
    </div>,
    document.body,
  );
}
