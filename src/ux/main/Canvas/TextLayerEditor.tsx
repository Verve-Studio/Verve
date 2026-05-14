import { useCallback, useEffect, useLayoutEffect, useRef } from "react";
import ReactDOM from "react-dom";
import type { LayerState, TextLayerState } from "@/types";
import { getTextBounds } from "@/core/tools/Text/Text";
import styles from "./Canvas.module.scss";

export interface TextLayerEditorProps {
  editingLayerId: string | null;
  layers: LayerState[];
  zoom: number;
  canvasWrapperRef: React.RefObject<HTMLDivElement | null>;
  onCommit: (ls: TextLayerState) => void;
  onClose: () => void;
}

// Handle positions: which edges each handle controls
// dx/dy: -1 = left/top edge, 0 = none, 1 = right/bottom edge
const HANDLES = [
  { id: "nw", dx: -1, dy: -1, cursor: "nw-resize" },
  { id: "n", dx: 0, dy: -1, cursor: "n-resize" },
  { id: "ne", dx: 1, dy: -1, cursor: "ne-resize" },
  { id: "e", dx: 1, dy: 0, cursor: "e-resize" },
  { id: "se", dx: 1, dy: 1, cursor: "se-resize" },
  { id: "s", dx: 0, dy: 1, cursor: "s-resize" },
  { id: "sw", dx: -1, dy: 1, cursor: "sw-resize" },
  { id: "w", dx: -1, dy: 0, cursor: "w-resize" },
] as const;

const MIN_BOX = 40; // minimum box size in canvas pixels

/**
 * Populate a `contenteditable` element with one `<div>` per paragraph,
 * keeping the structure that paragraph-level CSS (margin, indent) depends on.
 * Empty paragraphs get a single `<br>` so the line is still visible.
 */
function buildParagraphDOM(target: HTMLDivElement, text: string): void {
  target.replaceChildren();
  const paragraphs = text === "" ? [""] : text.split("\n");
  for (const para of paragraphs) {
    const p = document.createElement("div");
    if (para.length === 0) {
      p.appendChild(document.createElement("br"));
    } else {
      p.appendChild(document.createTextNode(para));
    }
    target.appendChild(p);
  }
}

/**
 * Read a `contenteditable` element's text back as a plain `\n`-separated
 * string. We walk the immediate child block elements rather than relying on
 * `innerText` (which can collapse whitespace differently across browsers).
 */
function readParagraphText(target: HTMLDivElement): string {
  const blocks = Array.from(target.children);
  if (blocks.length === 0) return target.textContent ?? "";
  return blocks
    .map((b) => {
      // `<br>`-only paragraph → empty string.
      if (
        b.childNodes.length === 1 &&
        (b.firstChild as HTMLElement)?.tagName === "BR"
      ) {
        return "";
      }
      return (b as HTMLElement).innerText ?? b.textContent ?? "";
    })
    .join("\n");
}

export function TextLayerEditor({
  editingLayerId,
  layers,
  zoom,
  canvasWrapperRef,
  onCommit,
  onClose,
}: TextLayerEditorProps): React.JSX.Element | null {
  const editorRef = useRef<HTMLDivElement>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  // The active layer snapshot — kept in a ref so the input handler can
  // build the next dispatch without re-binding on every parent render.
  const lsRef = useRef<TextLayerState | null>(null);

  // Derive ls early (before hooks) so hooks can safely reference it.
  const ls = editingLayerId
    ? (layers.find(
        (l): l is TextLayerState =>
          "type" in l && l.type === "text" && l.id === editingLayerId,
      ) ?? null)
    : null;
  lsRef.current = ls;

  // Populate the editable DOM once per `editingLayerId` change. We
  // intentionally do NOT re-populate on every text change — that would wipe
  // the user's caret. The browser is the source of truth between mount and
  // unmount; React just owns the wrapper and styling.
  useLayoutEffect(() => {
    if (!editorRef.current || !ls) return;
    buildParagraphDOM(editorRef.current, ls.text);
  }, [editingLayerId]); // eslint-disable-line react-hooks/exhaustive-deps

  // Focus on mount / layer-id change, deferred a frame so the canvas's
  // pointer capture from the opening click has released.
  useEffect(() => {
    if (!editingLayerId) return;
    const rafId = requestAnimationFrame(() => {
      const el = editorRef.current;
      if (!el) return;
      el.focus();
      // Place caret at end of text so the user can type immediately.
      const sel = window.getSelection();
      if (sel) {
        const range = document.createRange();
        range.selectNodeContents(el);
        range.collapse(false);
        sel.removeAllRanges();
        sel.addRange(range);
      }
    });
    return () => cancelAnimationFrame(rafId);
  }, [editingLayerId]);

  // Close when the user clicks outside the editor box.
  useEffect(() => {
    if (!editingLayerId) return;
    const close = (e: PointerEvent): void => {
      const target = e.target as Element;
      if (target.closest?.("[data-text-editor-root]")) return;
      if (target.closest?.("[data-text-editor-safe]")) return;
      onCloseRef.current();
    };
    document.addEventListener("pointerdown", close, { capture: true });
    return () =>
      document.removeEventListener("pointerdown", close, { capture: true });
  }, [editingLayerId]);

  // ── Resize handle drag logic ───────────────────────────────────────────────
  const resizeDragRef = useRef<{
    handle: (typeof HANDLES)[number];
    startClientX: number;
    startClientY: number;
    startX: number;
    startY: number;
    startBoxW: number;
    startBoxH: number;
    ls: TextLayerState;
  } | null>(null);

  const onHandlePointerDown = useCallback(
    (
      e: React.PointerEvent,
      handle: (typeof HANDLES)[number],
      ls: TextLayerState,
    ) => {
      e.preventDefault();
      e.stopPropagation();
      (e.target as HTMLElement).setPointerCapture(e.pointerId);
      const dpr = window.devicePixelRatio || 1;
      const cssZoom = zoom / dpr;
      const actualBounds = getTextBounds(ls);
      resizeDragRef.current = {
        handle,
        startClientX: e.clientX,
        startClientY: e.clientY,
        startX: ls.x,
        startY: ls.y,
        startBoxW: Math.max(MIN_BOX, Math.round(actualBounds.w)),
        startBoxH: Math.max(MIN_BOX, Math.round(actualBounds.h)),
        ls,
      };
      (resizeDragRef.current as { cssZoom?: number }).cssZoom = cssZoom;
    },
    [zoom],
  );

  const onHandlePointerMove = useCallback(
    (e: React.PointerEvent) => {
      const drag = resizeDragRef.current;
      if (!drag) return;
      const cssZoom = (drag as { cssZoom?: number }).cssZoom ?? 1;
      const ddx = (e.clientX - drag.startClientX) / cssZoom;
      const ddy = (e.clientY - drag.startClientY) / cssZoom;
      const { handle, startX, startY, startBoxW, startBoxH, ls } = drag;

      let newX = startX;
      let newY = startY;
      let newW = startBoxW;
      let newH = startBoxH;

      if (handle.dx === 1) {
        newW = Math.max(MIN_BOX, Math.round(startBoxW + ddx));
      } else if (handle.dx === -1) {
        const delta = Math.round(ddx);
        newW = Math.max(MIN_BOX, startBoxW - delta);
        newX = startX + (startBoxW - newW);
      }
      if (handle.dy === 1) {
        newH = Math.max(MIN_BOX, Math.round(startBoxH + ddy));
      } else if (handle.dy === -1) {
        const delta = Math.round(ddy);
        newH = Math.max(MIN_BOX, startBoxH - delta);
        newY = startY + (startBoxH - newH);
      }

      onCommit({ ...ls, x: newX, y: newY, boxWidth: newW, boxHeight: newH });
    },
    [onCommit],
  );

  const onHandlePointerUp = useCallback(() => {
    resizeDragRef.current = null;
  }, []);

  // ── Editable input → dispatch UPDATE_TEXT_LAYER ────────────────────────────
  const onEditableInput = useCallback(
    (e: React.FormEvent<HTMLDivElement>) => {
      const current = lsRef.current;
      if (!current) return;
      const text = readParagraphText(e.currentTarget);
      if (text === current.text) return;
      onCommit({ ...current, text });
    },
    [onCommit],
  );

  // Sanitise paste: insert plain text only so rich-text paste can't sneak
  // markup into the contenteditable structure.
  const onEditablePaste = useCallback(
    (e: React.ClipboardEvent<HTMLDivElement>) => {
      e.preventDefault();
      const text = e.clipboardData.getData("text/plain");
      document.execCommand("insertText", false, text);
    },
    [],
  );

  if (!editingLayerId) return null;
  if (!ls) return null;

  const dpr = window.devicePixelRatio || 1;
  const cssZoom = zoom / dpr;
  const fontSizePx = ls.fontSize * cssZoom;

  const BORDER = 2;
  const bounds = getTextBounds(ls);
  const boxWpx = bounds.w * cssZoom;
  const boxHpx = ls.boxHeight > 0 ? bounds.h * cssZoom : undefined;

  const posX = ls.x * cssZoom - BORDER;
  const posY = ls.y * cssZoom - BORDER;

  const fontStyle = [
    ls.italic ? "italic" : "",
    ls.bold ? "bold" : "",
    `${fontSizePx}px`,
    `"${ls.fontFamily}", sans-serif`,
  ]
    .filter(Boolean)
    .join(" ");

  // ── PSD-compatible attributes mirrored as CSS. Per-paragraph attributes
  //    go through CSS variables that the `.textEditor > div` rule reads.
  const hScale = (ls.horizontalScale ?? 100) / 100;
  const vScale = (ls.verticalScale ?? 100) / 100;
  const supSubScale = ls.superscript || ls.subscript ? 0.583 : 1;
  const supSubBaselinePx = ls.superscript
    ? ls.fontSize * 0.33 * cssZoom
    : ls.subscript
      ? -ls.fontSize * 0.33 * cssZoom
      : 0;
  const baselineShiftPx =
    (ls.baselineShift ?? 0) * cssZoom + supSubBaselinePx;
  const fauxItalicShearDeg = ls.fauxItalic ? -12 : 0;
  const totalHScale = hScale * supSubScale;
  const totalVScale = vScale * supSubScale;
  const needsTransform =
    totalHScale !== 1 ||
    totalVScale !== 1 ||
    fauxItalicShearDeg !== 0 ||
    baselineShiftPx !== 0;
  const editorTransform = needsTransform
    ? `translateY(${-baselineShiftPx}px) scale(${totalHScale}, ${totalVScale}) skewX(${fauxItalicShearDeg}deg)`
    : undefined;

  const textTransformCss: "uppercase" | "none" = ls.allCaps
    ? "uppercase"
    : "none";
  const fontVariantCapsCss: "small-caps" | "normal" =
    ls.smallCaps && !ls.allCaps ? "small-caps" : "normal";
  const fontVariantLigaturesCss =
    ls.ligatures === "none"
      ? "no-common-ligatures no-discretionary-ligatures"
      : ls.ligatures === "all"
        ? "common-ligatures discretionary-ligatures"
        : "common-ligatures no-discretionary-ligatures";
  const dirAttr: "ltr" | "rtl" = ls.direction === "rtl" ? "rtl" : "ltr";

  const strokePx = (ls.strokeWidth ?? 0) * cssZoom;
  const strokeCss =
    ls.strokeColor && strokePx > 0
      ? `${strokePx}px rgba(${ls.strokeColor.r},${ls.strokeColor.g},${ls.strokeColor.b},${ls.strokeColor.a / 255})`
      : undefined;

  const fauxBoldShadow =
    ls.fauxBold && ls.color
      ? `0 0 0.4px rgba(${ls.color.r},${ls.color.g},${ls.color.b},${ls.color.a / 255}), 0.4px 0 0.4px rgba(${ls.color.r},${ls.color.g},${ls.color.b},${ls.color.a / 255})`
      : undefined;

  // Per-paragraph CSS values exposed via CSS variables.
  const spaceBeforePx = (ls.spaceBefore ?? 0) * cssZoom;
  const spaceAfterPx = (ls.spaceAfter ?? 0) * cssZoom;
  const firstLineIndentPx = (ls.firstLineIndent ?? 0) * cssZoom;
  const leftIndentPx = (ls.leftIndent ?? 0) * cssZoom;
  const rightIndentPx = (ls.rightIndent ?? 0) * cssZoom;

  const editor = (
    <div
      data-text-editor-root
      className={styles.textEditorRoot}
      style={{
        position: "absolute",
        left: posX,
        top: posY,
        width: boxWpx,
        height: boxHpx,
      }}
      onPointerMove={onHandlePointerMove}
      onPointerUp={onHandlePointerUp}
    >
      <div
        ref={editorRef}
        key={editingLayerId}
        // `plaintext-only` keeps the browser from injecting rich HTML on
        // paste/typing while still allowing the per-paragraph block
        // structure we set up via `buildParagraphDOM`.
        contentEditable="plaintext-only"
        suppressContentEditableWarning
        className={styles.textEditor}
        style={{
          font: fontStyle,
          color: ls.color
            ? `rgba(${ls.color.r},${ls.color.g},${ls.color.b},${ls.color.a / 255})`
            : "#ffffff",
          caretColor: ls.color
            ? `rgb(${ls.color.r},${ls.color.g},${ls.color.b})`
            : "#ffffff",
          background: "transparent",
          WebkitTextFillColor: ls.color
            ? `rgba(${ls.color.r},${ls.color.g},${ls.color.b},${ls.color.a / 255})`
            : "#ffffff",
          textDecoration: "none",
          textAlign: ls.align === "justify" ? "justify" : ls.align,
          letterSpacing: `${(ls.letterSpacing ?? 0) * cssZoom}px`,
          lineHeight: String(ls.lineHeight ?? 1.2),
          width: "100%",
          height: ls.boxHeight > 0 ? "100%" : "auto",
          minHeight: `${fontSizePx * (ls.lineHeight ?? 1.2)}px`,
          overflow: "hidden",
          outline: "none",
          border: "none",
          padding: 0,
          paddingLeft: `${leftIndentPx}px`,
          paddingRight: `${rightIndentPx}px`,
          textTransform: textTransformCss,
          fontVariantCaps: fontVariantCapsCss,
          fontVariantLigatures: fontVariantLigaturesCss,
          direction: dirAttr,
          whiteSpace: "pre-wrap",
          overflowWrap: "break-word",
          // Per-paragraph CSS variables consumed by `.textEditor > div`
          // (rule defined in Canvas.module.scss).
          ["--text-space-before" as never]: `${spaceBeforePx}px`,
          ["--text-space-after" as never]: `${spaceAfterPx}px`,
          ["--text-first-line-indent" as never]: `${firstLineIndentPx}px`,
          ...(editorTransform
            ? { transform: editorTransform, transformOrigin: "top left" }
            : {}),
          ...(strokeCss ? { WebkitTextStroke: strokeCss } : {}),
          ...(fauxBoldShadow ? { textShadow: fauxBoldShadow } : {}),
        }}
        dir={dirAttr}
        onInput={onEditableInput}
        onPaste={onEditablePaste}
        onKeyDown={(e) => {
          if (e.key === "Escape") onCloseRef.current();
          e.stopPropagation();
        }}
        onPointerDown={(e) => e.stopPropagation()}
      />
      {/* 8 resize handles */}
      {HANDLES.map((h) => (
        <div
          key={h.id}
          className={`${styles.resizeHandle} ${styles[`handle-${h.id}`]}`}
          style={{ cursor: h.cursor }}
          onPointerDown={(e) => onHandlePointerDown(e, h, ls)}
        />
      ))}
    </div>
  );

  const container = canvasWrapperRef.current;
  if (!container) return null;
  return ReactDOM.createPortal(editor, container);
}
