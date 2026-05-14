import { useAppContext } from "@/core/store/AppContext";
import type { TextAlign, TextLayerState } from "@/types";
import { ColorPickerDialog } from "@/ux/modals/ColorPickerDialog/ColorPickerDialog";
import { SliderInput } from "@/ux/widgets/SliderInput/SliderInput";
import React, { useEffect, useRef, useState } from "react";
import ReactDOM from "react-dom";
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
  const lines = (ls.text || "M").split("\n");
  const textW = Math.max(
    ...lines.map((line) => _measureCtx.measureText(line || "M").width),
  );
  const lineH = ls.fontSize * (ls.lineHeight ?? 1.2);
  const w = Math.max(ls.fontSize * 2, textW);
  const h = Math.max(lineH, lines.length * lineH);
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
  const [showColorPicker, setShowColorPicker] = useState(false);
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
      <div
        title="Text Color"
        data-text-editor-safe
        style={{
          width: 22,
          height: 22,
          background: `rgb(${color.r},${color.g},${color.b})`,
          border: "1px solid var(--color-border)",
          cursor: "pointer",
          borderRadius: 2,
          flexShrink: 0,
        }}
        onClick={() => setShowColorPicker(true)}
      />
      {showColorPicker && (
        <ColorPickerDialog
          open={showColorPicker}
          title="Text Color"
          initialColor={{
            r: color.r / 255,
            g: color.g / 255,
            b: color.b / 255,
            a: color.a / 255,
          }}
          onConfirm={(c) => {
            const newColor = {
              r: Math.round(c.r * 255),
              g: Math.round(c.g * 255),
              b: Math.round(c.b * 255),
              a: Math.round(c.a * 255),
            };
            setColor(newColor);
            setShowColorPicker(false);
            applyChange({ color: newColor });
          }}
          onCancel={() => setShowColorPicker(false)}
        />
      )}
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
