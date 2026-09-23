import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import ReactDOM from "react-dom";
import type { LayerState, TextLayerState } from "@/types";
import {
  caretGeometry,
  caretX,
  hitTestText,
  indexAtX,
  layoutText,
  lineBoundary,
  lineIndexOf,
  paragraphRangeAt,
  selectionRects,
  textFrame,
  wordRangeAt,
} from "@/core/tools/Text/textLayout";
import styles from "./Canvas.module.scss";

export interface TextLayerEditorProps {
  editingLayerId: string | null;
  /** Canvas-space point the editor was opened at (caret placement). Read
   *  once when a session starts; null → caret at the end of the text. */
  openAt: { x: number; y: number } | null;
  /** False when the canvas tab is backgrounded — commits and closes. */
  active: boolean;
  layers: LayerState[];
  zoom: number;
  canvasWrapperRef: React.RefObject<HTMLDivElement | null>;
  /** Rasterise the live draft into the layer and re-render (no store update). */
  renderDraft: (ls: TextLayerState) => void;
  /** Write the draft to the store (no history entry). */
  commitDraft: (ls: TextLayerState) => void;
  /** End the session. `initial` is the layer as it was when editing began. */
  onClose: (final: TextLayerState, initial: TextLayerState) => void;
  /** The edited layer vanished from the store (deleted, undone). */
  onLost: () => void;
}

/**
 * Inline text editing, Photoshop style: the text is rendered by the real
 * layer (effects, blend mode, masks and stacking all live), and the editor
 * only draws the frame, caret and selection on top — all positioned from
 * the same layout the rasteriser uses, so they sit exactly on the glyphs.
 *
 * Keyboard input goes through an invisible `<textarea>` that holds the plain
 * text: native typing, IME, clipboard, word-wise movement and undo come for
 * free, while vertical movement and Home / End follow the visual lines.
 */
export function TextLayerEditor(
  props: TextLayerEditorProps,
): React.JSX.Element | null {
  const { editingLayerId, layers, onLost } = props;
  const layer = editingLayerId
    ? (layers.find(
        (l): l is TextLayerState =>
          "type" in l && l.type === "text" && l.id === editingLayerId,
      ) ?? null)
    : null;

  useEffect(() => {
    if (editingLayerId && !layer) onLost();
  }, [editingLayerId, layer, onLost]);

  const container = props.canvasWrapperRef.current;
  if (!layer || !container) return null;
  return ReactDOM.createPortal(
    <TextEditSession
      key={layer.id}
      {...props}
      layer={layer}
      container={container}
    />,
    container,
  );
}

// ─── Session ─────────────────────────────────────────────────────────────────

type Geometry = Pick<TextLayerState, "x" | "y" | "boxWidth" | "boxHeight">;

// dx/dy: -1 = left/top edge, 0 = none, 1 = right/bottom edge
const HANDLES = [
  { id: "nw", dx: -1, dy: -1, cursor: "nwse-resize" },
  { id: "n", dx: 0, dy: -1, cursor: "ns-resize" },
  { id: "ne", dx: 1, dy: -1, cursor: "nesw-resize" },
  { id: "e", dx: 1, dy: 0, cursor: "ew-resize" },
  { id: "se", dx: 1, dy: 1, cursor: "nwse-resize" },
  { id: "s", dx: 0, dy: 1, cursor: "ns-resize" },
  { id: "sw", dx: -1, dy: 1, cursor: "nesw-resize" },
  { id: "w", dx: -1, dy: 0, cursor: "ew-resize" },
] as const;
type Handle = (typeof HANDLES)[number];

const MIN_BOX = 8; // minimum box size in canvas pixels
const MOVE_RING = 7; // CSS px band around the frame that drags the text
const HANDLE = 8; // CSS px
const DEBOUNCE_COMMIT_MS = 400;

type Drag =
  | {
      kind: "select";
      unit: 1 | 2 | 3;
      anchor: [number, number];
    }
  | { kind: "move"; sx: number; sy: number; from: Geometry; moved: boolean }
  | {
      kind: "resize";
      handle: Handle;
      sx: number;
      sy: number;
      from: Geometry;
      moved: boolean;
    };

interface Sel {
  start: number;
  end: number;
  backward: boolean;
}

function TextEditSession({
  layer,
  container,
  openAt,
  active,
  layers,
  zoom,
  renderDraft,
  commitDraft,
  onClose,
}: TextLayerEditorProps & {
  layer: TextLayerState;
  container: HTMLDivElement;
}): React.JSX.Element {
  const taRef = useRef<HTMLTextAreaElement>(null);
  const initialRef = useRef(layer);
  const [text, setText] = useState(layer.text);
  const [geom, setGeom] = useState<Geometry | null>(null);
  const [focused, setFocused] = useState(false);
  const [sel, setSel] = useState<Sel>(() => {
    const i = openAt
      ? hitTestText(layoutText(layer), openAt.x, openAt.y)
      : layer.text.length;
    return { start: i, end: i, backward: false };
  });

  const draft = useMemo<TextLayerState>(
    () => ({ ...layer, ...geom, text }),
    [layer, geom, text],
  );
  const layout = layoutText(draft);

  // Live refs for event handlers.
  const draftRef = useRef(draft);
  draftRef.current = draft;
  const layoutRef = useRef(layout);
  layoutRef.current = layout;
  const geomRef = useRef(geom);
  geomRef.current = geom;
  const layersRef = useRef(layers);
  layersRef.current = layers;
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  const dragRef = useRef<Drag | null>(null);
  const goalXRef = useRef<number | null>(null);
  // Multi-click tracking. When opened by a click on existing text, that
  // click counts as the first, so a double-click selects a word right away.
  const clickRef = useRef(
    openAt
      ? { t: performance.now(), x: NaN, y: NaN, n: 1 }
      : { t: 0, x: 0, y: 0, n: 0 },
  );

  const dpr = window.devicePixelRatio || 1;
  const cssZoom = zoom / dpr;
  const cssZoomRef = useRef(cssZoom);
  cssZoomRef.current = cssZoom;

  // ── Live raster: the layer itself shows the draft ─────────────────────────
  const renderedSigRef = useRef("");
  useLayoutEffect(() => {
    const sig = JSON.stringify(draft);
    if (sig === renderedSigRef.current) return;
    renderedSigRef.current = sig;
    renderDraft(draft);
  }, [draft, renderDraft]);

  // ── Store sync: on typing pauses (and on close), never per keystroke ──────
  useEffect(() => {
    if (text === layer.text) return;
    const t = setTimeout(
      () => commitDraft(draftRef.current),
      DEBOUNCE_COMMIT_MS,
    );
    return () => clearTimeout(t);
  }, [text, layer.text, commitDraft]);

  // ── Close ─────────────────────────────────────────────────────────────────
  const closedRef = useRef(false);
  const close = useCallback((): void => {
    if (closedRef.current) return;
    closedRef.current = true;
    onCloseRef.current(draftRef.current, initialRef.current);
  }, []);

  useEffect(() => {
    if (!active) close();
  }, [active, close]);

  // Focus + initial caret, deferred a frame so the pointer capture of the
  // click that opened the editor has released.
  useEffect(() => {
    const raf = requestAnimationFrame(() => {
      const ta = taRef.current;
      if (!ta) return;
      ta.focus({ preventScroll: true });
      ta.setSelectionRange(sel.start, sel.end);
      setFocused(document.activeElement === ta);
    });
    return () => cancelAnimationFrame(raf);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const toCanvas = useCallback(
    (clientX: number, clientY: number): { x: number; y: number } => {
      const r = container.getBoundingClientRect();
      const z = cssZoomRef.current;
      return { x: (clientX - r.left) / z, y: (clientY - r.top) / z };
    },
    [container],
  );

  // Click outside commits. A click on the canvas only commits — it must not
  // also start a new text layer — unless it lands on another text layer, in
  // which case the tool opens that one.
  useEffect(() => {
    const onDown = (e: PointerEvent): void => {
      const t = e.target as Element | null;
      if (!t?.closest) return;
      if (
        t.closest(
          "[data-text-editor-root], [data-text-editor-safe], [data-slider-popup]",
        )
      )
        return;
      const vp = t.closest("[data-canvas-viewport]") as HTMLElement | null;
      // Viewport scrollbars scroll; they don't end editing.
      if (
        vp === t &&
        (e.offsetX >= vp.clientWidth || e.offsetY >= vp.clientHeight)
      )
        return;
      close();
      if (!vp || e.button !== 0 || t.tagName !== "CANVAS") return;
      const p = toCanvas(e.clientX, e.clientY);
      const editingId = draftRef.current.id;
      const hitsOther = layersRef.current.some((l) => {
        if (!("type" in l) || l.type !== "text") return false;
        if (l.id === editingId || !l.visible || l.locked) return false;
        const f = textFrame(l);
        return p.x >= f.x && p.y >= f.y && p.x <= f.x + f.w && p.y <= f.y + f.h;
      });
      if (hitsOther) return;
      e.stopPropagation();
      e.preventDefault();
      // The release of that click must not reach the tool either.
      const done = (): void => {
        window.removeEventListener("pointerup", swallowUp, true);
        window.removeEventListener("pointerdown", done, true);
      };
      const swallowUp = (ev: PointerEvent): void => {
        if (ev.pointerId !== e.pointerId) return;
        ev.stopPropagation();
        done();
      };
      window.addEventListener("pointerup", swallowUp, true);
      window.addEventListener("pointerdown", done, true);
    };
    document.addEventListener("pointerdown", onDown, { capture: true });
    return () =>
      document.removeEventListener("pointerdown", onDown, { capture: true });
  }, [close, toCanvas]);

  // ── Selection helpers ─────────────────────────────────────────────────────
  const syncSel = useCallback((): void => {
    const ta = taRef.current;
    if (!ta) return;
    const next: Sel = {
      start: ta.selectionStart,
      end: ta.selectionEnd,
      backward: ta.selectionDirection === "backward",
    };
    setSel((prev) =>
      prev.start === next.start &&
      prev.end === next.end &&
      prev.backward === next.backward
        ? prev
        : next,
    );
  }, []);

  /** Select from `anchor` to `focus` (collapsed when equal). */
  const select = useCallback(
    (anchor: number, focus: number): void => {
      const ta = taRef.current;
      if (!ta) return;
      if (focus < anchor) ta.setSelectionRange(focus, anchor, "backward");
      else ta.setSelectionRange(anchor, focus, "forward");
      syncSel();
    },
    [syncSel],
  );

  // ── Keyboard ──────────────────────────────────────────────────────────────
  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>): void => {
    // Everything typed here belongs to the text — keep app shortcuts out.
    e.stopPropagation();
    if (e.nativeEvent.isComposing) return;
    const ta = e.currentTarget;
    if (
      e.key === "Escape" ||
      e.code === "NumpadEnter" ||
      (e.key === "Enter" && (e.ctrlKey || e.metaKey))
    ) {
      e.preventDefault();
      close();
      return;
    }
    if (e.key === "Tab" && !e.ctrlKey && !e.altKey && !e.metaKey) {
      e.preventDefault();
      document.execCommand("insertText", false, "\t");
      return;
    }
    const plain = !e.ctrlKey && !e.metaKey && !e.altKey;
    const vertical = plain && (e.key === "ArrowUp" || e.key === "ArrowDown");
    if (!vertical) goalXRef.current = null;
    const lay = layoutRef.current;
    const backward = ta.selectionDirection === "backward";
    const anchor = backward ? ta.selectionEnd : ta.selectionStart;
    const focus = backward ? ta.selectionStart : ta.selectionEnd;
    if (vertical) {
      e.preventDefault();
      const li = lineIndexOf(lay, focus);
      const x = goalXRef.current ?? caretX(lay, li, focus);
      goalXRef.current = x;
      const tl = li + (e.key === "ArrowUp" ? -1 : 1);
      const target =
        tl < 0 ? 0 : tl >= lay.lines.length ? ta.value.length : indexAtX(lay, tl, x);
      select(e.shiftKey ? anchor : target, target);
      return;
    }
    if (plain && (e.key === "Home" || e.key === "End")) {
      e.preventDefault();
      const target = lineBoundary(lay, focus, e.key === "End");
      select(e.shiftKey ? anchor : target, target);
    }
  };

  // ── Pointer: caret placement, selection, move, resize ─────────────────────
  const onFramePointerDown = (e: React.PointerEvent<HTMLDivElement>): void => {
    if (e.button !== 0) return;
    e.preventDefault(); // keeps focus on the textarea
    e.stopPropagation();
    e.currentTarget.setPointerCapture(e.pointerId);
    goalXRef.current = null;
    const ta = taRef.current;
    if (!ta) return;
    ta.focus({ preventScroll: true });
    const p = toCanvas(e.clientX, e.clientY);
    if (e.ctrlKey || e.metaKey) {
      startMove(p);
      return;
    }
    const c = clickRef.current;
    const n =
      e.timeStamp - c.t < 450 &&
      !(Math.hypot(e.clientX - c.x, e.clientY - c.y) >= 5) // NaN: seeded
        ? ((c.n % 3) + 1)
        : 1;
    clickRef.current = { t: e.timeStamp, x: e.clientX, y: e.clientY, n };
    const idx = hitTestText(layoutRef.current, p.x, p.y);
    if (n === 1 && e.shiftKey) {
      const backward = ta.selectionDirection === "backward";
      const anchor = backward ? ta.selectionEnd : ta.selectionStart;
      dragRef.current = { kind: "select", unit: 1, anchor: [anchor, anchor] };
      select(anchor, idx);
      return;
    }
    const range: [number, number] =
      n === 2
        ? wordRangeAt(ta.value, idx)
        : n === 3
          ? paragraphRangeAt(ta.value, idx)
          : [idx, idx];
    dragRef.current = { kind: "select", unit: n as 1 | 2 | 3, anchor: range };
    select(range[0], range[1]);
  };

  const startMove = (p: { x: number; y: number }): void => {
    const d = draftRef.current;
    dragRef.current = {
      kind: "move",
      sx: p.x,
      sy: p.y,
      from: { x: d.x, y: d.y, boxWidth: d.boxWidth, boxHeight: d.boxHeight },
      moved: false,
    };
  };

  const onRingPointerDown = (e: React.PointerEvent<HTMLDivElement>): void => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    e.currentTarget.setPointerCapture(e.pointerId);
    taRef.current?.focus({ preventScroll: true });
    startMove(toCanvas(e.clientX, e.clientY));
  };

  const onHandlePointerDown = (
    e: React.PointerEvent<HTMLDivElement>,
    handle: Handle,
  ): void => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    e.currentTarget.setPointerCapture(e.pointerId);
    taRef.current?.focus({ preventScroll: true });
    const p = toCanvas(e.clientX, e.clientY);
    const d = draftRef.current;
    const f = layoutRef.current.frame;
    dragRef.current = {
      kind: "resize",
      handle,
      sx: p.x,
      sy: p.y,
      from: {
        x: d.x,
        y: d.y,
        boxWidth: Math.max(MIN_BOX, Math.round(f.w)),
        boxHeight: Math.max(MIN_BOX, Math.round(f.h)),
      },
      moved: false,
    };
  };

  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>): void => {
    const drag = dragRef.current;
    if (!drag) return;
    const p = toCanvas(e.clientX, e.clientY);
    if (drag.kind === "select") {
      const lay = layoutRef.current;
      const idx = hitTestText(lay, p.x, p.y);
      const t = draftRef.current.text;
      const r: [number, number] =
        drag.unit === 2
          ? wordRangeAt(t, idx)
          : drag.unit === 3
            ? paragraphRangeAt(t, idx)
            : [idx, idx];
      const [a0, a1] = drag.anchor;
      if (r[0] < a0) select(a1, r[0]);
      else select(a0, Math.max(a1, r[1]));
      return;
    }
    const dx = p.x - drag.sx;
    const dy = p.y - drag.sy;
    if (!drag.moved && Math.hypot(dx, dy) * cssZoomRef.current < 2) return;
    drag.moved = true;
    const { from } = drag;
    if (drag.kind === "move") {
      setGeom({
        ...from,
        x: Math.round(from.x + dx),
        y: Math.round(from.y + dy),
      });
      return;
    }
    const { handle } = drag;
    let { x, y, boxWidth: w, boxHeight: h } = from;
    if (handle.dx === 1) w = Math.max(MIN_BOX, Math.round(from.boxWidth + dx));
    else if (handle.dx === -1) {
      w = Math.max(MIN_BOX, from.boxWidth - Math.round(dx));
      x = from.x + (from.boxWidth - w);
    }
    if (handle.dy === 1) h = Math.max(MIN_BOX, Math.round(from.boxHeight + dy));
    else if (handle.dy === -1) {
      h = Math.max(MIN_BOX, from.boxHeight - Math.round(dy));
      y = from.y + (from.boxHeight - h);
    }
    setGeom({ x, y, boxWidth: w, boxHeight: h });
  };

  const onPointerUp = (): void => {
    const drag = dragRef.current;
    dragRef.current = null;
    if (!drag || drag.kind === "select" || !drag.moved) return;
    commitDraft({ ...draftRef.current, ...geomRef.current });
    setGeom(null);
  };

  const onFrameHover = (e: React.PointerEvent<HTMLDivElement>): void => {
    if (dragRef.current) return;
    e.currentTarget.style.cursor = e.ctrlKey || e.metaKey ? "move" : "text";
  };

  // ── Geometry (CSS px inside the canvas wrapper) ───────────────────────────
  const z = cssZoom;
  const f = layout.frame;
  const fx = f.x * z;
  const fy = f.y * z;
  const fw = Math.max(1, f.w * z);
  const fh = Math.max(1, f.h * z);
  const [ma, mb, mc, md, me, mf] = layout.matrix;
  const glyphTransform = layout.identity
    ? undefined
    : `matrix(${ma}, ${mb}, ${mc}, ${md}, ${me * z}, ${mf * z})`;

  const collapsed = sel.start === sel.end;
  const focusIdx = sel.backward ? sel.start : sel.end;
  const caret = caretGeometry(layout, Math.min(focusIdx, text.length));
  const rects = collapsed ? [] : selectionRects(layout, sel.start, sel.end);
  // Where the (invisible) textarea sits, so IME candidate windows open at
  // the caret: the caret's top in canvas space.
  const caretCanvasX = ma * caret.x + mc * caret.top + me;
  const caretCanvasY = mb * caret.x + md * caret.top + mf;
  const caretH = (caret.bottom - caret.top) * z;
  const isArea = draft.boxWidth > 0 && draft.boxHeight > 0;

  return (
    <div
      data-text-editor-root
      className={styles.textEditLayer}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
    >
      <div
        className={styles.textEditMoveRing}
        style={{
          left: fx - MOVE_RING,
          top: fy - MOVE_RING,
          width: fw + 2 * MOVE_RING,
          height: fh + 2 * MOVE_RING,
        }}
        onPointerDown={onRingPointerDown}
      />
      <div
        className={`${styles.textEditFrame}${isArea ? "" : ` ${styles.textEditFramePoint}`}`}
        style={{ left: fx, top: fy, width: fw, height: fh }}
        onPointerDown={onFramePointerDown}
        onPointerMove={onFrameHover}
      />
      <div
        className={styles.textEditGlyphs}
        style={glyphTransform ? { transform: glyphTransform } : undefined}
      >
        {rects.map((r, i) => (
          <div
            key={i}
            className={`${styles.textEditSelection}${focused ? "" : ` ${styles.textEditSelectionBlurred}`}`}
            style={{ left: r.x * z, top: r.y * z, width: r.w * z, height: r.h * z }}
          />
        ))}
        {collapsed && focused && (
          <div
            // Re-keyed on every move so the blink restarts solid.
            key={`${focusIdx}:${text.length}`}
            className={styles.textEditCaret}
            style={{
              left: caret.x * z,
              top: caret.top * z,
              // ~2 screen px, undoing the glyph layer's horizontal scale.
              width: 2 / Math.abs(ma),
              marginLeft: -1 / Math.abs(ma),
              height: caretH,
            }}
          />
        )}
      </div>
      {HANDLES.map((h) => (
        <div
          key={h.id}
          className={`${styles.textEditHandle}${h.id === "se" && layout.overflow ? ` ${styles.textEditHandleOverflow}` : ""}`}
          title={h.id === "se" && layout.overflow ? "Text overflows the box" : undefined}
          style={{
            left: fx + ((h.dx + 1) / 2) * fw - HANDLE / 2,
            top: fy + ((h.dy + 1) / 2) * fh - HANDLE / 2,
            cursor: h.cursor,
          }}
          onPointerDown={(e) => onHandlePointerDown(e, h)}
        />
      ))}
      <textarea
        ref={taRef}
        className={styles.textEditInput}
        defaultValue={layer.text}
        wrap="off"
        dir={draft.direction === "rtl" ? "rtl" : "ltr"}
        spellCheck={false}
        autoComplete="off"
        autoCorrect="off"
        autoCapitalize="off"
        aria-label="Text layer content"
        style={{
          left: caretCanvasX * z,
          top: caretCanvasY * z,
          height: Math.max(8, caretH),
          fontSize: Math.max(8, layout.fontSize * z),
        }}
        onInput={(e) => {
          setText(e.currentTarget.value);
          syncSel();
        }}
        onSelect={syncSel}
        onKeyDown={onKeyDown}
        onKeyUp={(e) => {
          e.stopPropagation();
          syncSel();
        }}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
      />
    </div>
  );
}
