import type { TextLayerState } from "@/types";
import type { GpuLayer } from "@/graphics/webgpu/rendering/WebGPURenderer";

/** Break a single paragraph into lines that fit within maxWidth canvas pixels.
 *  Matches CSS `white-space: pre-wrap; overflow-wrap: break-word` behaviour:
 *  words break at spaces where possible; words wider than maxWidth are broken
 *  at the character level. */
function wrapLine(
  ctx2d: CanvasRenderingContext2D,
  text: string,
  maxWidth: number,
): string[] {
  if (maxWidth <= 0) return [text];

  const lines: string[] = [];
  const words = text.split(" ");
  let current = "";

  for (const word of words) {
    const candidate = current.length > 0 ? `${current} ${word}` : word;

    if (ctx2d.measureText(candidate).width <= maxWidth) {
      // Whole candidate fits — keep accumulating
      current = candidate;
      continue;
    }

    // Candidate overflows — flush current line first
    if (current.length > 0) lines.push(current);
    current = "";

    // Does the word fit alone on a fresh line?
    if (word.length === 0 || ctx2d.measureText(word).width <= maxWidth) {
      current = word;
      continue;
    }

    // Word is wider than maxWidth — break it character by character
    // (mirrors overflow-wrap: break-word)
    let rem = word;
    while (rem.length > 0) {
      // Find the longest prefix that fits
      let n = 0;
      while (
        n < rem.length &&
        ctx2d.measureText(rem.slice(0, n + 1)).width <= maxWidth
      )
        n++;
      if (n === 0) n = 1; // always advance at least one character
      if (n >= rem.length) {
        current = rem;
        rem = "";
      } else {
        lines.push(rem.slice(0, n));
        rem = rem.slice(n);
      }
    }
  }

  if (current.length > 0) lines.push(current);
  return lines.length > 0 ? lines : [""];
}

/** Apply per-character casing transforms (allCaps wins over smallCaps when
 *  both are set, matching PSD precedence). Returns the line as it should be
 *  measured & drawn. smallCaps is handled via the browser's `fontVariantCaps`
 *  property so the underlying glyph substitution is OS-native. */
function applyCasing(text: string, allCaps: boolean): string {
  return allCaps ? text.toUpperCase() : text;
}

/** Float RGBA → CSS `rgba(r,g,b,a)` with r/g/b clamped + scaled to 0–255 and
 *  alpha in 0..1. HDR text colours (>1) visibly clip at the Canvas2D
 *  boundary; the stored layer value preserves the float for PSD round-trip. */
function floatRgbaToCss(c: { r: number; g: number; b: number; a: number }): string {
  const r = Math.max(0, Math.min(255, Math.round(c.r * 255)));
  const g = Math.max(0, Math.min(255, Math.round(c.g * 255)));
  const b = Math.max(0, Math.min(255, Math.round(c.b * 255)));
  const a = Math.max(0, Math.min(1, c.a));
  return `rgba(${r}, ${g}, ${b}, ${a})`;
}

/**
 * Draw a TextLayerState onto an arbitrary 2D context at its `ls.x / ls.y`
 * canvas-space position. Shared by both `rasterizeTextToLayer` (GPU upload
 * path) and the overlay-canvas live-preview path used during drag, so the
 * two are guaranteed to render identically.
 *
 * Honours the full PSD-compatible TextLayerState surface: faux bold/italic,
 * horizontal/vertical scale, baseline shift, all-caps / small-caps,
 * super/subscript, stroke (outline), ligature mode, paragraph indents and
 * before/after spacing. Anti-alias preset is applied via the canvas
 * `textRendering` hint; for round-trip purposes the field value is preserved
 * on the layer even when the OS can only approximate the visual difference.
 */
export function drawTextToCtx2d(
  ctx2d: CanvasRenderingContext2D,
  ls: TextLayerState,
): void {
  if (!ls.text) return;

  // ── Resolve PSD-compatible character attributes ────────────────────────
  const hScale = (ls.horizontalScale ?? 100) / 100;
  const vScale = (ls.verticalScale ?? 100) / 100;
  const baselineShift = ls.baselineShift ?? 0;
  const fauxBold = ls.fauxBold ?? false;
  const fauxItalic = ls.fauxItalic ?? false;
  const allCaps = ls.allCaps ?? false;
  const smallCaps = ls.smallCaps ?? false;
  const isSuper = ls.superscript ?? false;
  const isSub = ls.subscript ?? false;
  const stroke = ls.strokeColor ?? null;
  const strokeW = ls.strokeWidth ?? 0;
  const ligatures: "none" | "standard" | "all" = ls.ligatures ?? "standard";
  const antiAlias = ls.antiAlias ?? "smooth";

  // Super/subscript shrink the glyphs to ~58% and shift the baseline.
  // (Same factor PSD uses by default; the user can layer baselineShift on
  // top to fine-tune.)
  const supSubScale = isSuper || isSub ? 0.583 : 1;
  const supSubBaseline = isSuper
    ? ls.fontSize * 0.33
    : isSub
      ? -ls.fontSize * 0.33
      : 0;
  const effectiveFontSize = ls.fontSize * supSubScale;

  const fontStyle = [
    ls.italic ? "italic" : "",
    ls.bold ? "bold" : "",
    `${effectiveFontSize}px`,
    `"${ls.fontFamily}", sans-serif`,
  ]
    .filter(Boolean)
    .join(" ");

  ctx2d.font = fontStyle;
  ctx2d.textBaseline = "top";
  ctx2d.fillStyle = floatRgbaToCss(ls.color);
  (
    ctx2d as CanvasRenderingContext2D & { letterSpacing?: string }
  ).letterSpacing = `${ls.letterSpacing ?? 0}px`;
  if ("fontKerning" in ctx2d) {
    (ctx2d as CanvasRenderingContext2D & { fontKerning?: string }).fontKerning =
      (ls.kerning ?? "auto") === "auto" ? "auto" : "none";
  }
  // Browser-native small-caps substitution.
  if ("fontVariantCaps" in ctx2d) {
    (
      ctx2d as CanvasRenderingContext2D & { fontVariantCaps?: string }
    ).fontVariantCaps = smallCaps && !allCaps ? "small-caps" : "normal";
  }
  // OpenType ligature controls — Canvas2D supports these via
  // `fontFeatureSettings` on most modern engines (Chromium/Electron).
  if ("fontFeatureSettings" in ctx2d) {
    const ff =
      ligatures === "none"
        ? '"liga" 0, "dlig" 0'
        : ligatures === "all"
          ? '"liga" 1, "dlig" 1'
          : '"liga" 1, "dlig" 0';
    (
      ctx2d as CanvasRenderingContext2D & { fontFeatureSettings?: string }
    ).fontFeatureSettings = ff;
  }
  // Anti-alias hint — best-effort. The Canvas2D spec accepts the
  // `textRendering` property and Chromium honours it for font hinting.
  if ("textRendering" in ctx2d) {
    const tr =
      antiAlias === "none"
        ? "optimizeSpeed"
        : antiAlias === "sharp" || antiAlias === "crisp"
          ? "geometricPrecision"
          : "optimizeLegibility";
    (
      ctx2d as CanvasRenderingContext2D & { textRendering?: string }
    ).textRendering = tr;
  }
  if (antiAlias === "none") {
    ctx2d.imageSmoothingEnabled = false;
  }

  const lineHeight = ls.fontSize * (ls.lineHeight ?? 1.2);
  const underlineThick = Math.max(1, Math.round(ls.fontSize / 14));
  const strikeThick = Math.max(1, Math.round(ls.fontSize / 14));
  const boxW = ls.boxWidth > 0 ? ls.boxWidth : 0;
  const boxH = ls.boxHeight > 0 ? ls.boxHeight : 0;
  const align = ls.align ?? "left";

  const firstLineIndent = ls.firstLineIndent ?? 0;
  const leftIndent = ls.leftIndent ?? 0;
  const rightIndent = ls.rightIndent ?? 0;
  const spaceBefore = ls.spaceBefore ?? 0;
  const spaceAfter = ls.spaceAfter ?? 0;
  const noBreak = ls.noBreak ?? false;

  // Effective wrapping width: bounding box minus left/right indents.
  const wrapW = boxW > 0 ? Math.max(0, boxW - leftIndent - rightIndent) : 0;

  // For area text, clip rendering to the bounding box so overflow is pixel-
  // clipped rather than whole-line-skipped.
  if (boxW > 0 && boxH > 0) {
    ctx2d.save();
    ctx2d.beginPath();
    ctx2d.rect(ls.x, ls.y, boxW, boxH);
    ctx2d.clip();
  }

  // Apply horizontal/vertical scale + faux italic via a transform so glyph
  // metrics, stroke widths, and underlines all scale uniformly. The origin
  // is `(ls.x, ls.y)` so subsequent coords stay in the layer's own space.
  const needsTransform =
    hScale !== 1 || vScale !== 1 || fauxItalic || smallCaps; // smallCaps doesn't need transform; kept benign
  if (needsTransform || fauxItalic) {
    ctx2d.save();
    ctx2d.translate(ls.x, ls.y);
    // PSD faux italic ≈ 12° shear (tan(12°) ≈ 0.2126).
    const shear = fauxItalic ? -0.2126 : 0;
    ctx2d.transform(hScale, 0, shear, vScale, 0, 0);
    ctx2d.translate(-ls.x, -ls.y);
  }

  // Build final wrapped line list. We track which wrapped lines are the FIRST
  // line of a paragraph (for first-line-indent and space-before/after) and
  // which are LAST lines (so justified text doesn't justify the final line).
  type WrappedLine = {
    text: string;
    isFirstOfPara: boolean;
    isLastOfPara: boolean;
  };
  const wrappedLines: WrappedLine[] = [];
  const paragraphs = ls.text.split("\n");
  paragraphs.forEach((para) => {
    // First wrap line of a paragraph uses (wrapW - firstLineIndent) as max.
    const firstWrapW = Math.max(0, wrapW - firstLineIndent);
    const cased = applyCasing(para, allCaps);
    let pieces: string[];
    if (noBreak || wrapW <= 0) {
      pieces = [cased];
    } else {
      // Wrap with two widths: first line shorter (indented), rest normal.
      // Approximate by wrapping with the narrower width across the whole
      // paragraph if firstLineIndent > 0 (PSD uses a per-line composer; this
      // is a conservative approximation that prevents overflow).
      const effWrap =
        firstLineIndent > 0 ? Math.min(firstWrapW, wrapW) : wrapW;
      pieces = wrapLine(ctx2d, cased, effWrap);
    }
    pieces.forEach((p, idx) =>
      wrappedLines.push({
        text: p,
        isFirstOfPara: idx === 0,
        isLastOfPara: idx === pieces.length - 1,
      }),
    );
  });

  // Cursor Y advances by lineHeight per line, plus spaceBefore at the start
  // of each paragraph and spaceAfter at the end.
  let cursorY = ls.y;

  wrappedLines.forEach((wl, i) => {
    if (wl.isFirstOfPara && i > 0) cursorY += spaceBefore;
    const line = wl.text;
    const lineY = cursorY - baselineShift - supSubBaseline;

    const indent = wl.isFirstOfPara ? firstLineIndent : 0;
    const lineBoxLeft = ls.x + leftIndent + indent;
    const lineBoxRight = ls.x + (boxW > 0 ? boxW - rightIndent : 0);
    const innerW = boxW > 0 ? lineBoxRight - lineBoxLeft : 0;

    let drawX = lineBoxLeft;
    const textW = ctx2d.measureText(line).width;

    if (innerW > 0) {
      if (align === "center") {
        drawX = lineBoxLeft + (innerW - textW) / 2;
      } else if (align === "right") {
        drawX = lineBoxLeft + innerW - textW;
      } else if (align === "justify" && !wl.isLastOfPara) {
        const words = line.split(" ");
        if (words.length > 1) {
          const spaceW =
            (innerW - ctx2d.measureText(line.replace(/ /g, "")).width) /
            (words.length - 1);
          let cx = lineBoxLeft;
          words.forEach((word) => {
            if (stroke && strokeW > 0) {
              ctx2d.save();
              ctx2d.strokeStyle = floatRgbaToCss(stroke);
              ctx2d.lineWidth = strokeW;
              ctx2d.lineJoin = "round";
              ctx2d.strokeText(word, cx, lineY);
              ctx2d.restore();
            }
            ctx2d.fillText(word, cx, lineY);
            if (fauxBold) {
              ctx2d.save();
              ctx2d.strokeStyle = ctx2d.fillStyle as string;
              ctx2d.lineWidth = Math.max(1, ls.fontSize / 30);
              ctx2d.strokeText(word, cx, lineY);
              ctx2d.restore();
            }
            const ww = ctx2d.measureText(word).width;
            if (ls.underline && word.length > 0) {
              ctx2d.fillRect(cx, lineY + ls.fontSize + 2, ww, underlineThick);
            }
            if ((ls.strikethrough ?? false) && word.length > 0) {
              ctx2d.fillRect(cx, lineY + ls.fontSize * 0.35, ww, strikeThick);
            }
            cx += ww + spaceW;
          });
          cursorY += lineHeight;
          if (wl.isLastOfPara) cursorY += spaceAfter;
          return;
        }
      }
    }

    if (stroke && strokeW > 0) {
      ctx2d.save();
      ctx2d.strokeStyle = `rgba(${stroke.r}, ${stroke.g}, ${stroke.b}, ${stroke.a / 255})`;
      ctx2d.lineWidth = strokeW;
      ctx2d.lineJoin = "round";
      ctx2d.strokeText(line, drawX, lineY);
      ctx2d.restore();
    }
    ctx2d.fillText(line, drawX, lineY);
    if (fauxBold) {
      ctx2d.save();
      ctx2d.strokeStyle = ctx2d.fillStyle as string;
      ctx2d.lineWidth = Math.max(1, ls.fontSize / 30);
      ctx2d.strokeText(line, drawX, lineY);
      ctx2d.restore();
    }
    if (ls.underline && line.length > 0) {
      ctx2d.fillRect(drawX, lineY + ls.fontSize + 2, textW, underlineThick);
    }
    if ((ls.strikethrough ?? false) && line.length > 0) {
      ctx2d.fillRect(drawX, lineY + ls.fontSize * 0.35, textW, strikeThick);
    }
    cursorY += lineHeight;
    if (wl.isLastOfPara) cursorY += spaceAfter;
  });

  if (needsTransform || fauxItalic) ctx2d.restore();
  if (boxW > 0 && boxH > 0) ctx2d.restore();
}

/**
 * Rasterize a TextLayerState's text into the WebGL layer's pixel buffer.
 * The layer must already be canvas-sized (offsetX=0, offsetY=0).
 * Call renderer.flushLayer() after this to upload to GPU.
 */
export function rasterizeTextToLayer(ls: TextLayerState, gl: GpuLayer): void {
  const w = gl.layerWidth;
  const h = gl.layerHeight;
  gl.data.fill(0); // clear existing pixels
  if (!ls.text) return;

  const tmp = document.createElement("canvas");
  tmp.width = w;
  tmp.height = h;
  const ctx2d = tmp.getContext("2d")!;
  drawTextToCtx2d(ctx2d, ls);
  gl.data.set(new Uint8Array(ctx2d.getImageData(0, 0, w, h).data.buffer));
}

/**
 * Draw a TextLayerState onto the tool overlay canvas at its current
 * `ls.x / ls.y` position. Used during live drag so the GPU layer can be
 * hidden (skipping rasterization, GPU upload, and per-frame effect
 * re-encoding) while the user sees the text move in real time.
 */
export function drawTextEditOverlay(
  oc: HTMLCanvasElement,
  ls: TextLayerState,
): void {
  const c = oc.getContext("2d");
  if (!c) return;
  c.clearRect(0, 0, oc.width, oc.height);
  drawTextToCtx2d(c, ls);
}
