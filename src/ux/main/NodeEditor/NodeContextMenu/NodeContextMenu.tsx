import React, { useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import styles from "./NodeContextMenu.module.scss";

export type ContextMenuItem =
  | {
      label: string;
      /** Shown right-aligned, e.g. "Ctrl+C". */
      shortcut?: string;
      disabled?: boolean;
      action: () => void;
    }
  | "separator";

interface NodeContextMenuProps {
  /** Screen (client) position. The menu is portalled to the document body
   *  so the editor panel can't clip it. */
  x: number;
  y: number;
  items: readonly ContextMenuItem[];
  onClose: () => void;
}

/** Right-click menu of the node canvas. Arrow keys move, Enter runs,
 *  Escape or a click elsewhere closes. React events still bubble to the
 *  canvas through the portal, so they are stopped here. */
export function NodeContextMenu({ x, y, items, onClose }: NodeContextMenuProps): React.JSX.Element {
  const rootRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ left: x, top: y });
  const [active, setActive] = useState(-1);
  const enabled = items.flatMap((it, i) => (it !== "separator" && !it.disabled ? [i] : []));

  // Keep the menu inside the window and take keyboard focus.
  useLayoutEffect(() => {
    const el = rootRef.current;
    if (!el) return;
    setPos({
      left: Math.max(4, Math.min(x, window.innerWidth - el.offsetWidth - 4)),
      top: Math.max(4, Math.min(y, window.innerHeight - el.offsetHeight - 4)),
    });
    el.focus({ preventScroll: true });
  }, [x, y]);

  const run = (i: number): void => {
    const item = items[i];
    if (item === "separator" || item.disabled) return;
    onClose();
    item.action();
  };

  const step = (dir: 1 | -1): void => {
    if (enabled.length === 0) return;
    const at = enabled.indexOf(active);
    const next = at < 0 ? (dir > 0 ? 0 : enabled.length - 1) : (at + dir + enabled.length) % enabled.length;
    setActive(enabled[next]);
  };

  return createPortal(
    <div
      ref={rootRef}
      className={styles.menu}
      style={pos}
      role="menu"
      tabIndex={-1}
      data-nodrag
      onPointerDown={(e) => e.stopPropagation()}
      onContextMenu={(e) => e.preventDefault()}
      onBlur={(e) => {
        if (!rootRef.current?.contains(e.relatedTarget as Node | null)) onClose();
      }}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === "ArrowDown") step(1);
        else if (e.key === "ArrowUp") step(-1);
        else if (e.key === "Enter" && active >= 0) run(active);
        else if (e.key === "Escape") onClose();
        else return;
        e.preventDefault();
      }}
    >
      {items.map((it, i) =>
        it === "separator" ? (
          <div key={`sep${i}`} className={styles.separator} role="separator" />
        ) : (
          <button
            key={it.label}
            type="button"
            role="menuitem"
            className={`${styles.item}${i === active ? ` ${styles.active}` : ""}`}
            disabled={it.disabled}
            // Keep focus on the menu so its blur doesn't close it first.
            onMouseDown={(e) => e.preventDefault()}
            onMouseEnter={() => setActive(it.disabled ? -1 : i)}
            onClick={() => run(i)}
          >
            <span>{it.label}</span>
            {it.shortcut && <span className={styles.shortcut}>{it.shortcut}</span>}
          </button>
        ),
      )}
    </div>,
    document.body,
  );
}
