import React, { useRef } from "react";
import ReactDOM from "react-dom";
import type { FloatingWindow, PanelId } from "./types";
import { PANEL_LABELS } from "./types";
import { dockStore } from "./dockStore";
import styles from "./ToolWindow.module.scss";

interface ToolWindowProps {
  win: FloatingWindow;
  renderPanel: (panelId: PanelId) => React.ReactNode;
}

export function ToolWindow({
  win,
  renderPanel,
}: ToolWindowProps): React.ReactPortal {
  const containerRef = useRef<HTMLDivElement>(null);
  const posRef = useRef({ x: win.x, y: win.y });
  const sizeRef = useRef({ w: win.width, h: win.height });

  // ── Title bar drag ─────────────────────────────────────────────────────────

  function handleTitleMouseDown(e: React.MouseEvent) {
    if (e.button !== 0) return;
    e.preventDefault();
    const startMX = e.clientX;
    const startMY = e.clientY;
    const startX = posRef.current.x;
    const startY = posRef.current.y;

    const onMove = (me: MouseEvent) => {
      const x = startX + me.clientX - startMX;
      const y = Math.max(0, startY + me.clientY - startMY);
      posRef.current = { x, y };
      if (containerRef.current) {
        containerRef.current.style.left = `${x}px`;
        containerRef.current.style.top = `${y}px`;
      }
    };

    const onUp = () => {
      dockStore.moveFloatingWindow(win.id, posRef.current.x, posRef.current.y);
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
    };

    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
  }

  // ── Resize handle ──────────────────────────────────────────────────────────

  function handleResizeMouseDown(e: React.MouseEvent) {
    if (e.button !== 0) return;
    e.preventDefault();
    const startMX = e.clientX;
    const startMY = e.clientY;
    const startW = sizeRef.current.w;
    const startH = sizeRef.current.h;

    const onMove = (me: MouseEvent) => {
      const w = Math.max(200, startW + me.clientX - startMX);
      const h = Math.max(120, startH + me.clientY - startMY);
      sizeRef.current = { w, h };
      if (containerRef.current) {
        containerRef.current.style.width = `${w}px`;
        containerRef.current.style.height = `${h}px`;
      }
    };

    const onUp = () => {
      dockStore.resizeFloatingWindow(
        win.id,
        sizeRef.current.w,
        sizeRef.current.h,
      );
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
    };

    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
  }

  const content = (
    <div
      ref={containerRef}
      className={styles.window}
      style={{ left: win.x, top: win.y, width: win.width, height: win.height }}
    >
      <div className={styles.titleBar} onMouseDown={handleTitleMouseDown}>
        <span className={styles.title}>{PANEL_LABELS[win.panelId]}</span>
        <div className={styles.actions}>
          <button
            className={styles.actionBtn}
            title="Dock panel"
            onClick={() => dockStore.dockFloatingWindow(win.id)}
          >
            ⊞
          </button>
          <button
            className={styles.actionBtn}
            title="Close"
            onClick={() => dockStore.closePanel(win.panelId)}
          >
            ×
          </button>
        </div>
      </div>
      <div className={styles.content}>{renderPanel(win.panelId)}</div>
      <div
        className={styles.resizeHandle}
        onMouseDown={handleResizeMouseDown}
      />
    </div>
  );

  return ReactDOM.createPortal(content, document.body);
}
