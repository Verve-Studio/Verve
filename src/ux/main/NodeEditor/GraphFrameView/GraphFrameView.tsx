import React, { memo, useEffect, useRef } from "react";
import type { GraphFrame } from "@/core/nodes/graphTypes";
import styles from "./GraphFrameView.module.scss";

/** Colours the header dot cycles through. */
export const FRAME_COLORS = ["#6b7c8f", "#5f8a4f", "#9a7440", "#7d5a96", "#9a4f5c", "#3f8a8f"];

/** A frame's drawn rectangle in graph space (fitted around its members). */
export interface FrameRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

interface GraphFrameViewProps {
  frame: GraphFrame;
  rect: FrameRect;
  selected: boolean;
  editing: boolean;
  onCommitText: (frameId: string, text: string) => void;
  onCancelEdit: () => void;
  onColor: (frameId: string, color: string) => void;
  /** Reports the header's height (graph units) so the frame fits its
   *  members below a comment of any length. */
  onHeaderHeight: (frameId: string, height: number) => void;
}

/**
 * A comment frame. Only the header (select / drag / double-click to edit)
 * and the resize handle take pointer input — the area inside lets clicks
 * through to the canvas so nodes can be marquee-selected within it.
 * `NodeCanvas` handles the dragging via `data-frame-*` attributes.
 */
export const GraphFrameView = memo(function GraphFrameView({
  frame,
  rect,
  selected,
  editing,
  onCommitText,
  onCancelEdit,
  onColor,
  onHeaderHeight,
}: GraphFrameViewProps): React.JSX.Element {
  const textRef = useRef<HTMLTextAreaElement>(null);
  const headerRef = useRef<HTMLDivElement>(null);
  /** Esc was pressed: the blur that follows must not save. */
  const cancelled = useRef(false);

  // Focus a frame later: when editing starts from a double press, the
  // press's own default focus handling runs after this mounts and would
  // blur (and so close) the field.
  useEffect(() => {
    if (!editing) return;
    cancelled.current = false;
    const raf = requestAnimationFrame(() => textRef.current?.select());
    return () => cancelAnimationFrame(raf);
  }, [editing]);

  // offsetHeight is in layout pixels, i.e. graph units (the zoom transform
  // doesn't affect it).
  useEffect(() => {
    const el = headerRef.current;
    if (!el) return;
    const report = (): void => onHeaderHeight(frame.id, el.offsetHeight);
    report();
    const ro = new ResizeObserver(report);
    ro.observe(el);
    return () => ro.disconnect();
  }, [frame.id, onHeaderHeight]);

  const nextColor = (): string => {
    const i = FRAME_COLORS.indexOf(frame.color);
    return FRAME_COLORS[(i + 1) % FRAME_COLORS.length];
  };

  return (
    <div
      className={`${styles.frame}${selected ? ` ${styles.selected}` : ""}`}
      style={
        {
          left: rect.x,
          top: rect.y,
          width: rect.width,
          height: rect.height,
          "--frame": frame.color,
        } as React.CSSProperties
      }
    >
      <div ref={headerRef} className={styles.header} data-frame-header={frame.id}>
        <button
          type="button"
          className={styles.dot}
          data-nodrag
          title="Change colour"
          aria-label="Change frame colour"
          onClick={() => onColor(frame.id, nextColor())}
        />
        {editing ? (
          <textarea
            ref={textRef}
            className={styles.input}
            data-nodrag
            defaultValue={frame.text}
            rows={Math.max(1, frame.text.split("\n").length)}
            placeholder="Describe what these nodes do"
            spellCheck={false}
            onBlur={(e) => {
              if (!cancelled.current) onCommitText(frame.id, e.currentTarget.value);
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                e.currentTarget.blur();
              } else if (e.key === "Escape") {
                e.preventDefault();
                e.stopPropagation();
                cancelled.current = true;
                onCancelEdit();
              }
            }}
            onInput={(e) => {
              e.currentTarget.rows = Math.max(1, e.currentTarget.value.split("\n").length);
            }}
          />
        ) : (
          <div className={styles.text} title="Double-click to edit">
            {frame.text || <span className={styles.placeholder}>Double-click to add a comment</span>}
          </div>
        )}
      </div>
      <div className={styles.handle} data-frame-handle={frame.id} title="Resize" />
    </div>
  );
});
