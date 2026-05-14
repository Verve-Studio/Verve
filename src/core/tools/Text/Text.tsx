import { useAppContext } from "@/core/store/AppContext";
import type { RGBAColor, TextAlign, TextLayerState } from "@/types";
import { EmbedColorPicker } from "@/ux/widgets/EmbedColorPicker/EmbedColorPicker";
import { SliderInput } from "@/ux/widgets/SliderInput/SliderInput";
import React, { useEffect, useRef, useState } from "react";
import ReactDOM from "react-dom";

// ─── RGBA swatch with embedded popup picker ──────────────────────────────────
//
// Replaces the modal ColorPickerDialog throughout the text tool. Mirrors the
// pattern in `ColorSwatch`, but keeps full RGBA (255-based) values so it can
// drop into existing text-color/stroke-color flows without conversion churn.
function RgbaColorSwatch({
  value,
  onChange,
  title,
  allowNull = false,
  size = 22,
}: {
  value: RGBAColor | null;
  onChange: (c: RGBAColor) => void;
  title: string;
  allowNull?: boolean;
  size?: number;
}): React.JSX.Element {
  const btnRef = useRef<HTMLButtonElement>(null);
  const popupRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState({ top: 0, left: 0 });

  useEffect(() => {
    if (!open || !btnRef.current) return;
    const r = btnRef.current.getBoundingClientRect();
    const popupW = 220;
    const popupH = 290;
    const top =
      r.top > popupH + 8 ? r.top - popupH - 6 : Math.min(r.bottom + 6, window.innerHeight - popupH - 8);
    const left = Math.max(8, Math.min(r.left, window.innerWidth - popupW - 8));
    setPos({ top, left });
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const handler = (e: PointerEvent): void => {
      if (popupRef.current?.contains(e.target as Node)) return;
      if (btnRef.current?.contains(e.target as Node)) return;
      setOpen(false);
    };
    document.addEventListener("pointerdown", handler, { capture: true });
    return () =>
      document.removeEventListener("pointerdown", handler, { capture: true });
  }, [open]);

  const bg = value
    ? `rgba(${value.r},${value.g},${value.b},${value.a / 255})`
    : "repeating-linear-gradient(45deg,#444 0 3px,#888 3px 6px)";

  return (
    <>
      <button
        ref={btnRef}
        type="button"
        title={title}
        data-text-editor-safe
        data-text-adv-popover={allowNull ? "" : undefined}
        onPointerDown={(e) => e.preventDefault()}
        onClick={() => setOpen((o) => !o)}
        style={{
          width: size,
          height: size,
          background: bg,
          border: "1px solid var(--color-border)",
          borderRadius: 2,
          cursor: "pointer",
          flexShrink: 0,
          padding: 0,
        }}
      />
      {open &&
        ReactDOM.createPortal(
          <div
            ref={popupRef}
            data-text-editor-safe
            data-text-adv-popover={allowNull ? "" : undefined}
            style={{
              position: "fixed",
              top: pos.top,
              left: pos.left,
              background: "var(--color-surface)",
              border: "1px solid var(--color-border)",
              borderRadius: 4,
              boxShadow: "0 4px 16px rgba(0,0,0,0.35)",
              zIndex: 10000,
              padding: 8,
            }}
            onPointerDown={(e) => e.stopPropagation()}
          >
            <EmbedColorPicker
              value={{
                r: (value?.r ?? 255) / 255,
                g: (value?.g ?? 255) / 255,
                b: (value?.b ?? 255) / 255,
                a: (value?.a ?? 255) / 255,
              }}
              onChange={(c) =>
                onChange({
                  r: Math.round(Math.min(c.r, 1) * 255),
                  g: Math.round(Math.min(c.g, 1) * 255),
                  b: Math.round(Math.min(c.b, 1) * 255),
                  a: Math.round(c.a * 255),
                })
              }
            />
          </div>,
          document.body,
        )}
    </>
  );
}
import type {
  ToolContext,
  ToolHandler,
  ToolOptionsStyles,
  ToolPointerPos,
} from "../_shared/types";
import type { ITool } from "../_shared/ITool";
import { ToolGroup } from "../_shared/ITool";
import { SvgIcon } from "../_shared/SvgIcon";
import textIconSvg from "./text.svg?raw";

// ─── Module-level options ─────────────────────────────────────────────────────

export const textOptions = {
  fontFamily: "Arial",
  fontSize: 24,
  bold: false,
  italic: false,
  underline: false,
  strikethrough: false,
  align: "left" as import("@/types").TextAlign,
  letterSpacing: 0, // milliems (UI unit)
  lineHeight: 1.2,
  kerning: "auto" as "auto" | "none",
  color: { r: 255, g: 255, b: 255, a: 255 } as {
    r: number;
    g: number;
    b: number;
    a: number;
  },
  // ── PSD-compatible defaults (carried into new text layers) ────────────
  horizontalScale: 100,
  verticalScale: 100,
  baselineShift: 0,
  fauxBold: false,
  fauxItalic: false,
  allCaps: false,
  smallCaps: false,
  superscript: false,
  subscript: false,
  antiAlias: "smooth" as import("@/types").TextAntiAlias,
  strokeColor: null as import("@/types").RGBAColor | null,
  strokeWidth: 0,
  ligatures: "standard" as import("@/types").TextLigatures,
  firstLineIndent: 0,
  leftIndent: 0,
  rightIndent: 0,
  spaceBefore: 0,
  spaceAfter: 0,
  hyphenate: false,
  noBreak: false,
  direction: "ltr" as "ltr" | "rtl",
};

// ─── System font enumeration ──────────────────────────────────────────────────

const FALLBACK_FONTS = [
  "Arial",
  "Arial Black",
  "Calibri",
  "Cambria",
  "Comic Sans MS",
  "Consolas",
  "Courier New",
  "Franklin Gothic Medium",
  "Georgia",
  "Impact",
  "Palatino Linotype",
  "Segoe UI",
  "Tahoma",
  "Times New Roman",
  "Trebuchet MS",
  "Verdana",
];

async function getSystemFonts(): Promise<string[]> {
  // Local Font Access API — available in Chromium / Electron
  if ("queryLocalFonts" in window) {
    try {
      const fonts: { family: string }[] = await (
        window as unknown as {
          queryLocalFonts(): Promise<{ family: string }[]>;
        }
      ).queryLocalFonts();
      return [...new Set(fonts.map((f) => f.family))].sort();
    } catch {
      // permission denied or API unavailable — fall through to probe
    }
  }

  // Canvas-metrics probe: compare rendered width against a known baseline font
  const probe = document.createElement("canvas");
  probe.width = 200;
  probe.height = 30;
  const ctx = probe.getContext("2d")!;
  const testStr = "mmmmmmmmmmWWWWWWWWWW";
  ctx.font = "16px monospace";
  const baseWidth = ctx.measureText(testStr).width;
  return FALLBACK_FONTS.filter((family) => {
    ctx.font = `16px "${family}", monospace`;
    return ctx.measureText(testStr).width !== baseWidth;
  });
}

// ─── Text bounds & overlay helpers ───────────────────────────────────────────

const _measureCanvas = document.createElement("canvas");
const _measureCtx = _measureCanvas.getContext("2d")!;

export function getTextBounds(ls: TextLayerState): {
  x: number;
  y: number;
  w: number;
  h: number;
} {
  if (ls.boxWidth > 0 && ls.boxHeight > 0) {
    return { x: ls.x, y: ls.y, w: ls.boxWidth, h: ls.boxHeight };
  }
  const fontStyle = [
    ls.italic ? "italic" : "",
    ls.bold ? "bold" : "",
    `${ls.fontSize}px`,
    `"${ls.fontFamily}", sans-serif`,
  ]
    .filter(Boolean)
    .join(" ");
  _measureCtx.font = fontStyle;
  const upperIfNeeded = (s: string): string =>
    ls.allCaps ? s.toUpperCase() : s;
  const lines = (ls.text || "M").split("\n").map(upperIfNeeded);
  const textW = Math.max(
    ...lines.map((line) => _measureCtx.measureText(line || "M").width),
  );
  const lineH = ls.fontSize * (ls.lineHeight ?? 1.2);
  const hScale = (ls.horizontalScale ?? 100) / 100;
  const vScale = (ls.verticalScale ?? 100) / 100;
  const w = Math.max(ls.fontSize * 2, textW) * hScale;
  // Account for paragraph spacing between paragraphs.
  const paraGapTotal =
    Math.max(0, lines.length - 1) *
    ((ls.spaceBefore ?? 0) + (ls.spaceAfter ?? 0));
  const h = (Math.max(lineH, lines.length * lineH) + paraGapTotal) * vScale;
  return { x: ls.x, y: ls.y, w, h };
}

function hitTestTextLayer(ls: TextLayerState, x: number, y: number): boolean {
  const b = getTextBounds(ls);
  return x >= b.x && y >= b.y && x <= b.x + b.w && y <= b.y + b.h;
}

function drawTextBoundsOverlay(
  canvas: HTMLCanvasElement,
  ls: TextLayerState,
): void {
  const ctx2d = canvas.getContext("2d");
  if (!ctx2d) return;
  ctx2d.clearRect(0, 0, canvas.width, canvas.height);
  const { x, y, w, h } = getTextBounds(ls);
  ctx2d.save();
  ctx2d.strokeStyle = "#0078ff";
  ctx2d.lineWidth = 1;
  ctx2d.setLineDash([4, 3]);
  ctx2d.shadowColor = "#000";
  ctx2d.shadowBlur = 2;
  ctx2d.strokeRect(x - 1.5, y - 1.5, w + 3, h + 3);
  ctx2d.restore();
}

function drawDragRect(
  canvas: HTMLCanvasElement,
  sx: number,
  sy: number,
  ex: number,
  ey: number,
): void {
  const ctx2d = canvas.getContext("2d");
  if (!ctx2d) return;
  ctx2d.clearRect(0, 0, canvas.width, canvas.height);
  const x = Math.min(sx, ex);
  const y = Math.min(sy, ey);
  const w = Math.abs(ex - sx);
  const h = Math.abs(ey - sy);
  ctx2d.save();
  ctx2d.strokeStyle = "#0078ff";
  ctx2d.lineWidth = 1;
  ctx2d.setLineDash([4, 3]);
  ctx2d.shadowColor = "#000";
  ctx2d.shadowBlur = 2;
  ctx2d.strokeRect(x - 0.5, y - 0.5, w + 1, h + 1);
  ctx2d.restore();
}

function clearOverlay(canvas: HTMLCanvasElement): void {
  const ctx2d = canvas.getContext("2d");
  if (ctx2d) ctx2d.clearRect(0, 0, canvas.width, canvas.height);
}

// ─── Handler ─────────────────────────────────────────────────────────────────

function createTextHandler(): ToolHandler {
  let dragStart: { x: number; y: number } | null = null;
  let dragging = false;

  return {
    onPointerDown({ x, y }: ToolPointerPos, ctx: ToolContext): void {
      const hit = ctx.textLayers.find((ls) => hitTestTextLayer(ls, x, y));
      if (hit) {
        ctx.openTextLayerEditor(hit.id);
        return;
      }
      dragStart = { x: Math.round(x), y: Math.round(y) };
      dragging = false;
    },
    onPointerMove({ x, y }: ToolPointerPos, ctx: ToolContext): void {
      if (!dragStart) return;
      const dx = Math.abs(x - dragStart.x);
      const dy = Math.abs(y - dragStart.y);
      if (dx > 4 || dy > 4) dragging = true;
      if (dragging && ctx.overlayCanvas) {
        drawDragRect(ctx.overlayCanvas, dragStart.x, dragStart.y, x, y);
      }
    },
    onPointerUp({ x, y }: ToolPointerPos, ctx: ToolContext): void {
      if (!dragStart) return;
      const sx = dragStart.x;
      const sy = dragStart.y;
      const ex = Math.round(x);
      const ey = Math.round(y);
      dragStart = null;
      if (ctx.overlayCanvas) clearOverlay(ctx.overlayCanvas);

      const id = `text-${Date.now()}`;
      const layer: TextLayerState = {
        id,
        name: "Text",
        visible: true,
        opacity: 1,
        locked: false,
        blendMode: "normal",
        type: "text",
        text: "",
        x: dragging ? Math.min(sx, ex) : sx,
        y: dragging ? Math.min(sy, ey) : sy,
        boxWidth: dragging ? Math.max(20, Math.abs(ex - sx)) : 0,
        boxHeight: dragging ? Math.max(20, Math.abs(ey - sy)) : 0,
        fontFamily: textOptions.fontFamily,
        fontSize: textOptions.fontSize,
        bold: textOptions.bold,
        italic: textOptions.italic,
        underline: textOptions.underline,
        strikethrough: textOptions.strikethrough,
        align: textOptions.align,
        letterSpacing:
          (textOptions.letterSpacing / 1000) * textOptions.fontSize,
        lineHeight: textOptions.lineHeight,
        kerning: textOptions.kerning,
        color: {
          r: Math.round(Math.min(ctx.primaryColor.r, 1) * 255),
          g: Math.round(Math.min(ctx.primaryColor.g, 1) * 255),
          b: Math.round(Math.min(ctx.primaryColor.b, 1) * 255),
          a: Math.round(ctx.primaryColor.a * 255),
        },
        // PSD-compatible character/paragraph attributes.
        horizontalScale: textOptions.horizontalScale,
        verticalScale: textOptions.verticalScale,
        baselineShift: textOptions.baselineShift,
        fauxBold: textOptions.fauxBold,
        fauxItalic: textOptions.fauxItalic,
        allCaps: textOptions.allCaps,
        smallCaps: textOptions.smallCaps,
        superscript: textOptions.superscript,
        subscript: textOptions.subscript,
        antiAlias: textOptions.antiAlias,
        strokeColor: textOptions.strokeColor,
        strokeWidth: textOptions.strokeWidth,
        ligatures: textOptions.ligatures,
        firstLineIndent: textOptions.firstLineIndent,
        leftIndent: textOptions.leftIndent,
        rightIndent: textOptions.rightIndent,
        spaceBefore: textOptions.spaceBefore,
        spaceAfter: textOptions.spaceAfter,
        hyphenate: textOptions.hyphenate,
        noBreak: textOptions.noBreak,
        direction: textOptions.direction,
      };
      dragging = false;
      ctx.addTextLayer(layer);
    },
    onHover({ x, y }: ToolPointerPos, ctx: ToolContext): void {
      if (!ctx.overlayCanvas) return;
      const hit = ctx.textLayers.find((ls) => hitTestTextLayer(ls, x, y));
      if (hit) {
        drawTextBoundsOverlay(ctx.overlayCanvas, hit);
      } else {
        clearOverlay(ctx.overlayCanvas);
      }
    },
    onLeave(ctx: ToolContext): void {
      if (ctx.overlayCanvas) clearOverlay(ctx.overlayCanvas);
    },
  };
}

// ─── FontPicker ──────────────────────────────────────────────────────────────

function FontPicker({
  value,
  fonts,
  onChange,
}: {
  value: string;
  fonts: string[];
  onChange: (font: string) => void;
}): React.JSX.Element {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const buttonRef = useRef<HTMLButtonElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const [dropPos, setDropPos] = useState({ top: 0, left: 0 });

  const filtered = query.trim()
    ? fonts.filter((f) => f.toLowerCase().includes(query.toLowerCase()))
    : fonts;

  // Close when clicking outside the font picker
  useEffect(() => {
    if (!open) return;
    const handler = (e: PointerEvent): void => {
      if ((e.target as Element).closest?.("[data-font-picker]")) return;
      setOpen(false);
    };
    document.addEventListener("pointerdown", handler, { capture: true });
    return () =>
      document.removeEventListener("pointerdown", handler, { capture: true });
  }, [open]);

  // Scroll selected item into view when list opens
  useEffect(() => {
    if (!open || !listRef.current) return;
    const el = listRef.current.querySelector(
      "[data-selected]",
    ) as HTMLElement | null;
    el?.scrollIntoView({ block: "center" });
  }, [open]);

  const handleToggle = (): void => {
    if (!open && buttonRef.current) {
      const r = buttonRef.current.getBoundingClientRect();
      setDropPos({ top: r.bottom + 2, left: r.left });
      setQuery("");
    }
    setOpen((v) => !v);
  };

  const btnStyle: React.CSSProperties = {
    fontFamily: `"${value}", sans-serif`,
    fontSize: 12,
    background: "var(--color-surface)",
    color: "var(--color-text)",
    border: "1px solid var(--color-border)",
    borderRadius: 3,
    padding: "0 6px",
    width: 150,
    height: 24,
    cursor: "pointer",
    textAlign: "left",
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    flexShrink: 0,
  };

  return (
    <>
      <button
        ref={buttonRef}
        type="button"
        data-font-picker
        data-text-editor-safe
        style={btnStyle}
        onPointerDown={(e) => e.stopPropagation()}
        onClick={handleToggle}
      >
        {value}
      </button>
      {open &&
        ReactDOM.createPortal(
          <div
            ref={listRef}
            data-font-picker
            data-text-editor-safe
            style={{
              position: "fixed",
              top: dropPos.top,
              left: dropPos.left,
              width: 220,
              maxHeight: 300,
              background: "var(--color-surface)",
              border: "1px solid var(--color-border)",
              borderRadius: 4,
              zIndex: 9999,
              display: "flex",
              flexDirection: "column",
              boxShadow: "0 4px 16px rgba(0,0,0,0.35)",
              overflow: "hidden",
            }}
          >
            <input
              autoFocus
              type="text"
              placeholder="Search fonts…"
              value={query}
              data-font-picker
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Escape") setOpen(false);
                e.stopPropagation();
              }}
              style={{
                background: "var(--color-bg)",
                color: "var(--color-text)",
                border: "none",
                borderBottom: "1px solid var(--color-border-light)",
                padding: "5px 8px",
                fontSize: 12,
                outline: "none",
                flexShrink: 0,
              }}
            />
            <div style={{ overflowY: "auto", flex: 1 }}>
              {filtered.map((f) => (
                <div
                  key={f}
                  data-font-picker
                  {...(f === value ? { "data-selected": "" } : {})}
                  style={{
                    fontFamily: `"${f}", sans-serif`,
                    fontSize: 14,
                    padding: "4px 8px",
                    cursor: "pointer",
                    color: "var(--color-text)",
                    background:
                      f === value
                        ? "var(--color-surface-selected)"
                        : "transparent",
                    whiteSpace: "nowrap",
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                  }}
                  onMouseEnter={(e) => {
                    (e.currentTarget as HTMLElement).style.background =
                      f === value
                        ? "var(--color-surface-selected)"
                        : "var(--color-surface-hover)";
                  }}
                  onMouseLeave={(e) => {
                    (e.currentTarget as HTMLElement).style.background =
                      f === value
                        ? "var(--color-surface-selected)"
                        : "transparent";
                  }}
                  onPointerDown={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    onChange(f);
                    setOpen(false);
                  }}
                >
                  {f}
                </div>
              ))}
              {filtered.length === 0 && (
                <div
                  style={{
                    padding: "8px",
                    color: "var(--color-text-muted)",
                    fontSize: 12,
                  }}
                >
                  No fonts found
                </div>
              )}
            </div>
          </div>,
          document.body,
        )}
    </>
  );
}

// ─── Advanced (PSD-compatible) text options popover ─────────────────────────
//
// Exposes all character/paragraph attributes that aren't on the inline
// Options bar: faux bold/italic, all-caps, small-caps, super/sub, h/v scale,
// baseline shift, anti-alias preset, stroke colour/width, ligature mode,
// paragraph indents, paragraph spacing, direction. All PSD-compatible.
function AdvancedTextPopover({
  activeTextLayer,
  apply,
}: {
  activeTextLayer: TextLayerState | undefined;
  apply: (patch: Partial<TextLayerState>) => void;
}): React.JSX.Element {
  const buttonRef = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const [dropPos, setDropPos] = useState({ top: 0, left: 0 });

  // Source of truth for current values: active layer ?? module defaults.
  const src = activeTextLayer;
  const v = {
    horizontalScale: src?.horizontalScale ?? textOptions.horizontalScale,
    verticalScale: src?.verticalScale ?? textOptions.verticalScale,
    baselineShift: src?.baselineShift ?? textOptions.baselineShift,
    fauxBold: src?.fauxBold ?? textOptions.fauxBold,
    fauxItalic: src?.fauxItalic ?? textOptions.fauxItalic,
    allCaps: src?.allCaps ?? textOptions.allCaps,
    smallCaps: src?.smallCaps ?? textOptions.smallCaps,
    superscript: src?.superscript ?? textOptions.superscript,
    subscript: src?.subscript ?? textOptions.subscript,
    antiAlias: src?.antiAlias ?? textOptions.antiAlias,
    strokeColor: src?.strokeColor ?? textOptions.strokeColor,
    strokeWidth: src?.strokeWidth ?? textOptions.strokeWidth,
    ligatures: src?.ligatures ?? textOptions.ligatures,
    firstLineIndent: src?.firstLineIndent ?? textOptions.firstLineIndent,
    leftIndent: src?.leftIndent ?? textOptions.leftIndent,
    rightIndent: src?.rightIndent ?? textOptions.rightIndent,
    spaceBefore: src?.spaceBefore ?? textOptions.spaceBefore,
    spaceAfter: src?.spaceAfter ?? textOptions.spaceAfter,
    direction: src?.direction ?? textOptions.direction,
    hyphenate: src?.hyphenate ?? textOptions.hyphenate,
    noBreak: src?.noBreak ?? textOptions.noBreak,
  };

  // Bidirectional mirror: write to module options so the next created layer
  // inherits, AND write to the active layer via apply().
  const setField = <K extends keyof TextLayerState>(
    key: K,
    val: TextLayerState[K],
  ): void => {
    apply({ [key]: val } as Partial<TextLayerState>);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (textOptions as any)[key] = val;
  };
  /** Apply multiple keys atomically — needed when one toggle must clear
   *  another (super/sub are mutually exclusive). Two sequential `setField`
   *  calls would dispatch twice with the SAME stale `activeTextLayer`
   *  snapshot, so the second dispatch would overwrite the first key. */
  const setFields = (patch: Partial<TextLayerState>): void => {
    apply(patch);
    for (const [k, val] of Object.entries(patch)) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (textOptions as any)[k] = val;
    }
  };

  useEffect(() => {
    if (!open) return;
    const handler = (e: PointerEvent): void => {
      const target = e.target as Element;
      // Keep the popover open when the click lands on:
      //  - one of our own elements (the popover root + slider wrappers carry
      //    `data-text-adv-popover`),
      //  - a `SliderInput` portal-spawned popup (`data-slider-popup`), or
      //  - an embedded color picker portal popup (`data-text-editor-safe` —
      //    we re-use the existing marker already wired up for the color
      //    swatch + its portal popup body).
      if (
        target.closest?.(
          "[data-text-adv-popover], [data-slider-popup], [data-text-editor-safe]",
        )
      )
        return;
      setOpen(false);
    };
    document.addEventListener("pointerdown", handler, { capture: true });
    return () =>
      document.removeEventListener("pointerdown", handler, { capture: true });
  }, [open]);

  const handleToggle = (): void => {
    if (!open && buttonRef.current) {
      const r = buttonRef.current.getBoundingClientRect();
      setDropPos({ top: r.bottom + 2, left: r.left });
    }
    setOpen((o) => !o);
  };

  const row: React.CSSProperties = {
    display: "flex",
    alignItems: "center",
    gap: 6,
    padding: "4px 8px",
    fontSize: 12,
    color: "var(--color-text)",
  };
  const groupTitle: React.CSSProperties = {
    fontSize: 11,
    fontWeight: "bold",
    color: "var(--color-text-muted)",
    padding: "6px 8px 2px",
    textTransform: "uppercase",
    letterSpacing: "0.5px",
  };
  const labelW: React.CSSProperties = { width: 90, flexShrink: 0 };
  const slider = (
    val: number,
    setVal: (n: number) => void,
    opts: { min: number; max: number; step?: number; width?: number } = {
      min: -1000,
      max: 1000,
    },
  ): React.JSX.Element => (
    <span data-text-adv-popover data-text-editor-safe>
      <SliderInput
        value={Number.isFinite(val) ? val : 0}
        min={opts.min}
        max={opts.max}
        step={opts.step ?? 1}
        inputWidth={opts.width ?? 56}
        onChange={setVal}
      />
    </span>
  );
  const toggleBtn = (
    label: string,
    active: boolean,
    title: string,
    onClick: () => void,
  ): React.JSX.Element => (
    <button
      type="button"
      title={title}
      data-text-adv-popover
      data-text-editor-safe
      onPointerDown={(e) => e.preventDefault()}
      onClick={onClick}
      style={{
        height: 22,
        minWidth: 28,
        padding: "0 6px",
        background: active ? "var(--color-surface-selected)" : "var(--color-surface)",
        color: "var(--color-text)",
        border: "1px solid var(--color-border)",
        borderRadius: 3,
        cursor: "pointer",
        fontSize: 12,
        outline: active ? "2px solid #0078ff" : "none",
        outlineOffset: "-2px",
      }}
    >
      {label}
    </button>
  );

  return (
    <>
      <button
        ref={buttonRef}
        type="button"
        title="Advanced text options"
        data-text-adv-popover
        data-text-editor-safe
        onPointerDown={(e) => e.preventDefault()}
        onClick={handleToggle}
        style={{
          height: 22,
          padding: "0 8px",
          background: "var(--color-surface)",
          color: "var(--color-text)",
          border: "1px solid var(--color-border)",
          borderRadius: 3,
          cursor: "pointer",
          fontSize: 12,
        }}
      >
        ⋯
      </button>
      {open &&
        ReactDOM.createPortal(
          <div
            data-text-adv-popover
            data-text-editor-safe
            style={{
              position: "fixed",
              top: dropPos.top,
              left: dropPos.left,
              minWidth: 260,
              background: "var(--color-surface)",
              border: "1px solid var(--color-border)",
              borderRadius: 4,
              zIndex: 9999,
              boxShadow: "0 4px 16px rgba(0,0,0,0.35)",
              padding: "4px 0 8px",
            }}
          >
            <div style={groupTitle}>Character</div>
            <div style={row}>
              {toggleBtn("B", v.fauxBold, "Faux Bold", () =>
                setField("fauxBold", !v.fauxBold),
              )}
              {toggleBtn("I", v.fauxItalic, "Faux Italic", () =>
                setField("fauxItalic", !v.fauxItalic),
              )}
              {toggleBtn("TT", v.allCaps, "All Caps", () =>
                setField("allCaps", !v.allCaps),
              )}
              {toggleBtn("Tt", v.smallCaps, "Small Caps", () =>
                setField("smallCaps", !v.smallCaps),
              )}
              {toggleBtn("T¹", v.superscript, "Superscript", () => {
                const next = !v.superscript;
                setFields({
                  superscript: next,
                  subscript: next ? false : v.subscript,
                });
              })}
              {toggleBtn("T₁", v.subscript, "Subscript", () => {
                const next = !v.subscript;
                setFields({
                  subscript: next,
                  superscript: next ? false : v.superscript,
                });
              })}
            </div>
            <div style={row}>
              <span style={labelW}>H Scale (%)</span>
              {slider(v.horizontalScale, (n) => setField("horizontalScale", n), {
                min: 1,
                max: 1000,
                step: 1,
              })}
              <span style={{ width: 12 }} />
              <span style={{ width: 60 }}>V Scale (%)</span>
              {slider(v.verticalScale, (n) => setField("verticalScale", n), {
                min: 1,
                max: 1000,
                step: 1,
              })}
            </div>
            <div style={row}>
              <span style={labelW}>Baseline shift</span>
              {slider(v.baselineShift, (n) => setField("baselineShift", n), {
                min: -1000,
                max: 1000,
                step: 1,
              })}
            </div>
            <div style={row}>
              <span style={labelW}>Anti-alias</span>
              <select
                value={v.antiAlias}
                onChange={(e) =>
                  setField(
                    "antiAlias",
                    e.target.value as import("@/types").TextAntiAlias,
                  )
                }
                style={{
                  height: 22,
                  background: "var(--color-bg)",
                  color: "var(--color-text)",
                  border: "1px solid var(--color-border)",
                  borderRadius: 3,
                  padding: "0 4px",
                  fontSize: 12,
                }}
              >
                <option value="none">None</option>
                <option value="sharp">Sharp</option>
                <option value="crisp">Crisp</option>
                <option value="strong">Strong</option>
                <option value="smooth">Smooth</option>
              </select>
            </div>
            <div style={row}>
              <span style={labelW}>Ligatures</span>
              <select
                value={v.ligatures}
                onChange={(e) =>
                  setField(
                    "ligatures",
                    e.target.value as import("@/types").TextLigatures,
                  )
                }
                style={{
                  height: 22,
                  background: "var(--color-bg)",
                  color: "var(--color-text)",
                  border: "1px solid var(--color-border)",
                  borderRadius: 3,
                  padding: "0 4px",
                  fontSize: 12,
                }}
              >
                <option value="none">None</option>
                <option value="standard">Standard</option>
                <option value="all">All</option>
              </select>
            </div>
            <div style={row}>
              <span style={labelW}>Stroke</span>
              <RgbaColorSwatch
                title="Stroke colour"
                value={v.strokeColor}
                allowNull
                onChange={(c) => {
                  setField("strokeColor", c);
                  if (v.strokeWidth === 0) setField("strokeWidth", 1);
                }}
              />
              {slider(v.strokeWidth, (n) => setField("strokeWidth", n), {
                min: 0,
                max: 200,
                step: 0.5,
              })}
              {v.strokeColor && (
                <button
                  type="button"
                  data-text-adv-popover
                  data-text-editor-safe
                  onPointerDown={(e) => e.preventDefault()}
                  onClick={() => {
                    setField("strokeColor", null);
                    setField("strokeWidth", 0);
                  }}
                  style={{
                    height: 22,
                    padding: "0 6px",
                    background: "var(--color-surface)",
                    color: "var(--color-text)",
                    border: "1px solid var(--color-border)",
                    borderRadius: 3,
                    cursor: "pointer",
                    fontSize: 11,
                  }}
                >
                  Clear
                </button>
              )}
            </div>

            <div style={groupTitle}>Paragraph</div>
            <div style={row}>
              <span style={labelW}>First-line indent</span>
              {slider(v.firstLineIndent, (n) => setField("firstLineIndent", n), {
                min: -2000,
                max: 2000,
                step: 1,
              })}
            </div>
            <div style={row}>
              <span style={labelW}>Left indent</span>
              {slider(v.leftIndent, (n) => setField("leftIndent", n), {
                min: 0,
                max: 2000,
                step: 1,
              })}
              <span style={{ width: 12 }} />
              <span style={{ width: 50 }}>Right</span>
              {slider(v.rightIndent, (n) => setField("rightIndent", n), {
                min: 0,
                max: 2000,
                step: 1,
              })}
            </div>
            <div style={row}>
              <span style={labelW}>Space before</span>
              {slider(v.spaceBefore, (n) => setField("spaceBefore", n), {
                min: 0,
                max: 2000,
                step: 1,
              })}
              <span style={{ width: 12 }} />
              <span style={{ width: 50 }}>After</span>
              {slider(v.spaceAfter, (n) => setField("spaceAfter", n), {
                min: 0,
                max: 2000,
                step: 1,
              })}
            </div>
            <div style={row}>
              <span style={labelW}>Direction</span>
              <select
                value={v.direction}
                onChange={(e) =>
                  setField("direction", e.target.value as "ltr" | "rtl")
                }
                style={{
                  height: 22,
                  background: "var(--color-bg)",
                  color: "var(--color-text)",
                  border: "1px solid var(--color-border)",
                  borderRadius: 3,
                  padding: "0 4px",
                  fontSize: 12,
                }}
              >
                <option value="ltr">Left to Right</option>
                <option value="rtl">Right to Left</option>
              </select>
            </div>
            <div style={row}>
              {toggleBtn("Hyphenate", v.hyphenate, "Auto hyphenation", () =>
                setField("hyphenate", !v.hyphenate),
              )}
              {toggleBtn(
                "No Break",
                v.noBreak,
                "Suppress automatic line breaks",
                () => setField("noBreak", !v.noBreak),
              )}
            </div>

          </div>,
          document.body,
        )}
    </>
  );
}

// ─── Options UI ───────────────────────────────────────────────────────────────

function TextOptions({
  styles,
}: {
  styles: ToolOptionsStyles;
}): React.JSX.Element {
  const { state, dispatch } = useAppContext();

  const activeTextLayer = state.layers.find(
    (l): l is TextLayerState =>
      "type" in l && l.type === "text" && l.id === state.activeLayerId,
  );

  const [fontFamily, setFontFamily] = useState(
    activeTextLayer?.fontFamily ?? textOptions.fontFamily,
  );
  const [fontSize, setFontSize] = useState(
    activeTextLayer?.fontSize ?? textOptions.fontSize,
  );
  const [bold, setBold] = useState(activeTextLayer?.bold ?? textOptions.bold);
  const [italic, setItalic] = useState(
    activeTextLayer?.italic ?? textOptions.italic,
  );
  const [underline, setUnderline] = useState(
    activeTextLayer?.underline ?? textOptions.underline,
  );
  const [strikethrough, setStrikethrough] = useState(
    activeTextLayer?.strikethrough ?? textOptions.strikethrough,
  );
  const [align, setAlign] = useState<TextAlign>(
    activeTextLayer?.align ?? textOptions.align,
  );
  const [letterSpacingMilliems, setLetterSpacingMilliems] = useState(0);
  const [lineHeight, setLineHeight] = useState(
    activeTextLayer?.lineHeight ?? textOptions.lineHeight,
  );
  const [kerning, setKerning] = useState<"auto" | "none">(
    activeTextLayer?.kerning ?? textOptions.kerning,
  );
  const [color, setColor] = useState<{
    r: number;
    g: number;
    b: number;
    a: number;
  }>(activeTextLayer?.color ?? textOptions.color);
  const [fonts, setFonts] = useState<string[]>([textOptions.fontFamily]);

  const activeId = activeTextLayer?.id;
  useEffect(() => {
    if (activeTextLayer) {
      setFontFamily(activeTextLayer.fontFamily);
      setFontSize(activeTextLayer.fontSize);
      setBold(activeTextLayer.bold);
      setItalic(activeTextLayer.italic);
      setUnderline(activeTextLayer.underline);
      setStrikethrough(activeTextLayer.strikethrough ?? false);
      setAlign(activeTextLayer.align ?? "left");
      const milliems =
        activeTextLayer.fontSize > 0
          ? Math.round(
              ((activeTextLayer.letterSpacing ?? 0) /
                activeTextLayer.fontSize) *
                1000,
            )
          : 0;
      setLetterSpacingMilliems(milliems);
      setLineHeight(activeTextLayer.lineHeight ?? 1.2);
      setKerning(activeTextLayer.kerning ?? "auto");
      setColor(activeTextLayer.color);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeId]);

  useEffect(() => {
    getSystemFonts().then((list) => {
      setFonts(list.length > 0 ? list : FALLBACK_FONTS);
    });
  }, []);

  const applyChange = (patch: Partial<TextLayerState>): void => {
    if (activeTextLayer) {
      dispatch({
        type: "UPDATE_TEXT_LAYER",
        payload: { ...activeTextLayer, ...patch },
      });
    }
    if (patch.fontFamily !== undefined)
      textOptions.fontFamily = patch.fontFamily;
    if (patch.fontSize !== undefined) textOptions.fontSize = patch.fontSize;
    if (patch.bold !== undefined) textOptions.bold = patch.bold;
    if (patch.italic !== undefined) textOptions.italic = patch.italic;
    if (patch.underline !== undefined) textOptions.underline = patch.underline;
    if (patch.strikethrough !== undefined)
      textOptions.strikethrough = patch.strikethrough;
    if (patch.align !== undefined) textOptions.align = patch.align;
    if (patch.lineHeight !== undefined)
      textOptions.lineHeight = patch.lineHeight;
    if (patch.kerning !== undefined) textOptions.kerning = patch.kerning;
    if (patch.color !== undefined) textOptions.color = patch.color;
  };

  const handleFont = (f: string): void => {
    setFontFamily(f);
    applyChange({ fontFamily: f });
  };
  const handleSize = (v: number): void => {
    setFontSize(v);
    const lsPx = (letterSpacingMilliems / 1000) * v;
    applyChange({ fontSize: v, letterSpacing: lsPx });
  };
  const handleBold = (v: boolean): void => {
    setBold(v);
    applyChange({ bold: v });
  };
  const handleItalic = (v: boolean): void => {
    setItalic(v);
    applyChange({ italic: v });
  };
  const handleUnderline = (v: boolean): void => {
    setUnderline(v);
    applyChange({ underline: v });
  };
  const handleStrikethrough = (v: boolean): void => {
    setStrikethrough(v);
    applyChange({ strikethrough: v });
  };
  const handleAlign = (a: TextAlign): void => {
    setAlign(a);
    applyChange({ align: a });
  };
  const handleLetterSpacing = (v: number): void => {
    setLetterSpacingMilliems(v);
    const lsPx =
      (v / 1000) * (activeTextLayer?.fontSize ?? textOptions.fontSize);
    applyChange({ letterSpacing: lsPx });
    textOptions.letterSpacing = v;
  };
  const handleLineHeight = (v: number): void => {
    setLineHeight(v);
    applyChange({ lineHeight: v });
  };
  const handleKerning = (v: "auto" | "none"): void => {
    setKerning(v);
    applyChange({ kerning: v });
  };

  const ALIGN_BUTTONS: {
    value: TextAlign;
    title: string;
    icon: React.JSX.Element;
  }[] = [
    {
      value: "left",
      title: "Align Left",
      icon: (
        <svg
          width="14"
          height="12"
          viewBox="0 0 14 12"
          fill="currentColor"
          style={{ display: "block" }}
        >
          <rect x="0" y="0" width="14" height="1" />
          <rect x="0" y="5" width="9" height="1" />
          <rect x="0" y="10" width="14" height="1" />
        </svg>
      ),
    },
    {
      value: "center",
      title: "Align Center",
      icon: (
        <svg
          width="14"
          height="12"
          viewBox="0 0 14 12"
          fill="currentColor"
          style={{ display: "block" }}
        >
          <rect x="0" y="0" width="14" height="1" />
          <rect x="2.5" y="5" width="9" height="1" />
          <rect x="0" y="10" width="14" height="1" />
        </svg>
      ),
    },
    {
      value: "right",
      title: "Align Right",
      icon: (
        <svg
          width="14"
          height="12"
          viewBox="0 0 14 12"
          fill="currentColor"
          style={{ display: "block" }}
        >
          <rect x="0" y="0" width="14" height="1" />
          <rect x="5" y="5" width="9" height="1" />
          <rect x="0" y="10" width="14" height="1" />
        </svg>
      ),
    },
    {
      value: "justify",
      title: "Justify",
      icon: (
        <svg
          width="14"
          height="12"
          viewBox="0 0 14 12"
          fill="currentColor"
          style={{ display: "block" }}
        >
          <rect x="0" y="0" width="14" height="1" />
          <rect x="0" y="5" width="14" height="1" />
          <rect x="0" y="10" width="14" height="1" />
        </svg>
      ),
    },
  ];

  return (
    <>
      <FontPicker value={fontFamily} fonts={fonts} onChange={handleFont} />
      <span className={styles.optSep} data-text-editor-safe />
      <label className={styles.optLabel} data-text-editor-safe>
        Size:
      </label>
      <span data-text-editor-safe>
        <SliderInput
          value={fontSize}
          min={6}
          max={400}
          inputWidth={46}
          onChange={handleSize}
        />
      </span>
      <span className={styles.optSep} data-text-editor-safe />
      {(
        [
          {
            label: "B",
            active: bold,
            title: "Bold",
            style: { fontWeight: "bold" as const },
            onToggle: handleBold,
          },
          {
            label: "I",
            active: italic,
            title: "Italic",
            style: { fontStyle: "italic" as const },
            onToggle: handleItalic,
          },
          {
            label: "U",
            active: underline,
            title: "Underline",
            style: { textDecoration: "underline" as const },
            onToggle: handleUnderline,
          },
          {
            label: "S",
            active: strikethrough,
            title: "Strikethrough",
            style: { textDecoration: "line-through" as const },
            onToggle: handleStrikethrough,
          },
        ] as const
      ).map(({ label, active, title, style, onToggle }) => (
        <button
          key={label}
          className={styles.optBtn}
          title={title}
          data-text-editor-safe
          style={{
            padding: "1px 6px",
            outline: active ? "2px solid #0078ff" : "none",
            outlineOffset: "-2px",
            ...style,
          }}
          onPointerDown={(e) => e.preventDefault()}
          onClick={() => onToggle(!active)}
        >
          {label}
        </button>
      ))}
      <span className={styles.optSep} data-text-editor-safe />
      {ALIGN_BUTTONS.map(({ value, title, icon }) => (
        <button
          key={value}
          className={styles.optBtn}
          title={title}
          data-text-editor-safe
          style={{
            padding: "1px 6px",
            fontWeight: align === value ? "bold" : "normal",
            outline: align === value ? "2px solid #0078ff" : "none",
            outlineOffset: "-2px",
          }}
          onPointerDown={(e) => e.preventDefault()}
          onClick={() => handleAlign(value)}
        >
          {icon}
        </button>
      ))}
      <span className={styles.optSep} data-text-editor-safe />
      <label className={styles.optLabel} data-text-editor-safe>
        Spacing:
      </label>
      <span data-text-editor-safe>
        <SliderInput
          value={letterSpacingMilliems}
          min={-200}
          max={1000}
          inputWidth={46}
          onChange={handleLetterSpacing}
        />
      </span>
      <span className={styles.optSep} data-text-editor-safe />
      <label className={styles.optLabel} data-text-editor-safe>
        Line Height:
      </label>
      <span data-text-editor-safe>
        <SliderInput
          value={lineHeight}
          min={0.5}
          max={4}
          step={0.05}
          inputWidth={46}
          onChange={handleLineHeight}
        />
      </span>
      <span className={styles.optSep} data-text-editor-safe />
      <label className={styles.optLabel} data-text-editor-safe>
        Kern:
      </label>
      <select
        className={styles.optSelect}
        data-text-editor-safe
        value={kerning}
        onChange={(e) => handleKerning(e.target.value as "auto" | "none")}
        style={{ maxWidth: 70 }}
      >
        <option value="auto">Auto</option>
        <option value="none">None</option>
      </select>
      <span className={styles.optSep} data-text-editor-safe />
      <RgbaColorSwatch
        title="Text Color"
        value={color}
        onChange={(c) => {
          setColor(c);
          applyChange({ color: c });
        }}
      />
      <span className={styles.optSep} data-text-editor-safe />
      <AdvancedTextPopover activeTextLayer={activeTextLayer} apply={applyChange} />
    </>
  );
}

// ─── Tool export ─────────────────────────────────────────────────────────────

class TextTool implements ITool {
  readonly id = "text";
  readonly label = "Type";
  readonly shortcut = "T";
  readonly icon = <SvgIcon src={textIconSvg} />;
  readonly placement = { group: ToolGroup.Type, row: 0, column: 0 } as const;
  readonly modifiesPixels = false;
  readonly skipAutoHistory = true;
  readonly indexed8Unsupported = true;
  createHandler(): ToolHandler {
    return createTextHandler();
  }
  readonly Options = TextOptions;
}

export const textTool: ITool = new TextTool();
