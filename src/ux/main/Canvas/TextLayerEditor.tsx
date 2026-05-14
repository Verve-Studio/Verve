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

export function TextLayerEditor({
  editingLayerId,
  layers,
  zoom,
  canvasWrapperRef,
  onCommit,
  onClose,
}: TextLayerEditorProps): React.JSX.Element | null {
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  // Derive ls early (before hooks) so hooks can safely reference it.
  const ls = editingLayerId
    ? (layers.find(
        (l): l is TextLayerState =>
          "type" in l && l.type === "text" && l.id === editingLayerId,
      ) ?? null)
    : null;

  // For point text: imperatively sync the textarea height to its scrollHeight after
  // every render so the container (height:auto) grows vertically with the content.
  useLayoutEffect(() => {
    if (!textareaRef.current || (ls?.boxHeight ?? 0) !== 0) return;
    const ta = textareaRef.current;
    ta.style.height = "0";
    ta.style.height = ta.scrollHeight + "px";
  });

  // Focus the textarea as soon as it mounts or editingLayerId changes.
  // Use requestAnimationFrame so the focus call fires AFTER the pointerup
  // event settles — without this, pointer capture on the canvas steals focus
  // back before the user can type.
  useEffect(() => {
    if (!editingLayerId) return;
    const rafId = requestAnimationFrame(() => {
      textareaRef.current?.focus();
    });
    return () => cancelAnimationFrame(rafId);
  }, [editingLayerId]);

  // Close when the user clicks OUTSIDE the editor box, but NOT inside the tool options bar.
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
      // Use the actual rendered bounds as the drag baseline (not MIN_BOX),
      // so resizing point text doesn't snap to 40px on first move.
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
      // Capture zoom at drag-start so it's stable
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

  if (!editingLayerId) return null;
  if (!ls) return null;

  const dpr = window.devicePixelRatio || 1;
  const cssZoom = zoom / dpr;
  const fontSizePx = ls.fontSize * cssZoom;

  // Box dimensions in canvas-px, converted to CSS px via cssZoom
  const BORDER = 2;
  const bounds = getTextBounds(ls);
  const boxWpx = bounds.w * cssZoom;
  // Area text has a fixed height; point text grows with its content (height: auto).
  const boxHpx = ls.boxHeight > 0 ? bounds.h * cssZoom : undefined;

  // Position relative to canvasWrapper (position:absolute parent), not viewport
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

  // Browsers center each glyph vertically inside its line-box, so the first
  // line's glyph top sits half a line's worth of leading below the textarea
  // top. The Canvas2D rasteriser (textBaseline:"top") puts the glyph top
  // exactly at `ls.y`. Without compensation, entering edit mode shifts the
  // visible text downward by that half-leading. Pull the textarea up by it.
  const lineHeightFactor = ls.lineHeight ?? 1.2;
  const halfLeadingPx = ((lineHeightFactor - 1) / 2) * fontSizePx;

  // ── PSD-compatible attributes: mirror what the rasteriser will draw so
  //    the user sees an accurate preview while typing AND when re-entering
  //    edit mode on an already-styled layer. Per-paragraph before/after
  //    spacing is the only thing we can't reproduce inside a flat textarea;
  //    it appears the moment the editor closes and the layer re-rasterises.
  const hScale = (ls.horizontalScale ?? 100) / 100;
  const vScale = (ls.verticalScale ?? 100) / 100;
  // Super/subscript: matches the rasteriser's 0.583 scale + ±0.33em baseline
  // shift. Applied uniformly to all glyphs via the textarea transform.
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
  const taTransform = needsTransform
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

  // Synthetic outline matches `-webkit-text-stroke`. Width is in CSS px so
  // we scale by cssZoom to stay in lock-step with the rasteriser, which
  // works in canvas-space.
  const strokePx = (ls.strokeWidth ?? 0) * cssZoom;
  const strokeCss =
    ls.strokeColor && strokePx > 0
      ? `${strokePx}px rgba(${ls.strokeColor.r},${ls.strokeColor.g},${ls.strokeColor.b},${ls.strokeColor.a / 255})`
      : undefined;

  // Faux-bold approximation while typing: a 1-px text-shadow in the fill
  // colour. The rasteriser uses strokeText for the same effect at output.
  const fauxBoldShadow =
    ls.fauxBold && ls.color
      ? `0 0 0.4px rgba(${ls.color.r},${ls.color.g},${ls.color.b},${ls.color.a / 255}), 0.4px 0 0.4px rgba(${ls.color.r},${ls.color.g},${ls.color.b},${ls.color.a / 255})`
      : undefined;

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
      {/* Textarea filling the box */}
      <textarea
        ref={textareaRef}
        key={editingLayerId}
        autoFocus
        className={styles.textEditor}
        style={{
          // The GpuLayer is hidden during edit (Canvas.tsx toggles
          // visibility), so the textarea must render the text itself —
          // hence the explicit colour + visible WebkitTextFillColor. Any
          // layer-level effects (drop shadow, etc.) are intentionally not
          // applied during edit; they come back when the editor closes.
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
          overflow: "hidden",
          resize: "none",
          outline: "none",
          border: "none",
          padding: 0,
          marginTop: -halfLeadingPx,
          textTransform: textTransformCss,
          fontVariantCaps: fontVariantCapsCss,
          fontVariantLigatures: fontVariantLigaturesCss,
          direction: dirAttr,
          // Paragraph indents — best-effort within a single-block textarea.
          // `textIndent` only applies to the first visible line, so it
          // matches `firstLineIndent` for the topmost paragraph but not for
          // mid-text paragraphs (where the rasterised result is the truth
          // shown on close). `paddingLeft`/`Right` simulate left/right
          // indent for every line.
          paddingLeft: `${(ls.leftIndent ?? 0) * cssZoom}px`,
          paddingRight: `${(ls.rightIndent ?? 0) * cssZoom}px`,
          textIndent: `${(ls.firstLineIndent ?? 0) * cssZoom}px`,
          ...(taTransform ? { transform: taTransform, transformOrigin: "top left" } : {}),
          ...(strokeCss ? { WebkitTextStroke: strokeCss } : {}),
          ...(fauxBoldShadow ? { textShadow: fauxBoldShadow } : {}),
        }}
        dir={dirAttr}
        value={ls.text}
        onChange={(e) => onCommit({ ...ls, text: e.target.value })}
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
