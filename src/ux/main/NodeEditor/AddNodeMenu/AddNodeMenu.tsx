import React, { useLayoutEffect, useMemo, useRef, useState } from "react";
import type { INode } from "@/core/nodes/INode";
import { categoryColor } from "../nodeLayout";
import styles from "./AddNodeMenu.module.scss";

interface AddNodeMenuProps {
  /** Position relative to the offset parent (the node canvas). */
  x: number;
  y: number;
  /** Candidate definitions, already filtered by domain / pending link. */
  defs: readonly INode[];
  /** Shown above the list, e.g. "Connect to Color". */
  subtitle?: string;
  onPick: (def: INode) => void;
  onClose: () => void;
}

/** Searchable node picker. Arrow keys move, Enter adds, Escape closes. */
export function AddNodeMenu({
  x,
  y,
  defs,
  subtitle,
  onPick,
  onClose,
}: AddNodeMenuProps): React.JSX.Element {
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const [pos, setPos] = useState({ left: x, top: y });
  const rootRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  /** Category-ordered when browsing, rank-ordered when searching. */
  const items = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) {
      const order: string[] = [];
      for (const d of defs) if (!order.includes(d.category)) order.push(d.category);
      return [...defs].sort(
        (a, b) => order.indexOf(a.category) - order.indexOf(b.category),
      );
    }
    const rank = (d: INode): number => {
      const label = d.label.toLowerCase();
      if (label.startsWith(q)) return 0;
      if (label.includes(q)) return 1;
      if (d.category.toLowerCase().includes(q)) return 2;
      if (d.description?.toLowerCase().includes(q)) return 3;
      return -1;
    };
    return defs
      .map((d) => ({ d, r: rank(d) }))
      .filter((e) => e.r >= 0)
      .sort((a, b) => a.r - b.r)
      .map((e) => e.d);
  }, [defs, query]);

  const searching = query.trim() !== "";
  const activeIdx = Math.min(active, Math.max(0, items.length - 1));

  // Keep the menu inside the canvas.
  useLayoutEffect(() => {
    const el = rootRef.current;
    const parent = el?.offsetParent as HTMLElement | null;
    if (!el || !parent) return;
    setPos({
      left: Math.max(4, Math.min(x, parent.clientWidth - el.offsetWidth - 4)),
      top: Math.max(4, Math.min(y, parent.clientHeight - el.offsetHeight - 4)),
    });
  }, [x, y]);

  useLayoutEffect(() => {
    listRef.current
      ?.querySelector(`[data-idx="${activeIdx}"]`)
      ?.scrollIntoView({ block: "nearest" });
  }, [activeIdx]);

  let lastCategory = "";
  return (
    <div
      ref={rootRef}
      className={styles.menu}
      style={pos}
      data-nodrag
      onPointerDown={(e) => e.stopPropagation()}
      onContextMenu={(e) => e.preventDefault()}
    >
      {subtitle && <div className={styles.subtitle}>{subtitle}</div>}
      <input
        className={styles.search}
        autoFocus
        placeholder="Search nodes…"
        spellCheck={false}
        value={query}
        onChange={(e) => {
          setQuery(e.target.value);
          setActive(0);
        }}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown") {
            e.preventDefault();
            setActive((i) => Math.min(items.length - 1, i + 1));
          } else if (e.key === "ArrowUp") {
            e.preventDefault();
            setActive((i) => Math.max(0, i - 1));
          } else if (e.key === "Enter") {
            e.preventDefault();
            const d = items[activeIdx];
            if (d) onPick(d);
          } else if (e.key === "Escape") {
            e.preventDefault();
            onClose();
          }
        }}
        onBlur={(e) => {
          if (!rootRef.current?.contains(e.relatedTarget as Node | null)) onClose();
        }}
      />
      <div ref={listRef} className={styles.list}>
        {items.length === 0 && <div className={styles.empty}>No matching nodes</div>}
        {items.map((d, i) => {
          const header =
            !searching && d.category !== lastCategory ? d.category : null;
          lastCategory = d.category;
          return (
            <React.Fragment key={d.type}>
              {header && <div className={styles.category}>{header}</div>}
              <button
                type="button"
                data-idx={i}
                className={`${styles.item}${i === activeIdx ? ` ${styles.active}` : ""}`}
                title={d.description}
                // Keep focus in the search box so its blur doesn't close the menu.
                onMouseDown={(e) => e.preventDefault()}
                onMouseEnter={() => setActive(i)}
                onClick={() => onPick(d)}
              >
                <span
                  className={styles.swatch}
                  style={{ background: categoryColor(d.category) }}
                />
                {d.label}
                {searching && <span className={styles.itemCategory}>{d.category}</span>}
              </button>
            </React.Fragment>
          );
        })}
      </div>
    </div>
  );
}
