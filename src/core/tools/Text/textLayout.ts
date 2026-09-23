/**
 * Text layout engine — the single source of truth for where every glyph of a
 * text layer goes. The rasteriser draws from it and the inline editor places
 * its caret / selection / hit-testing on it, so what the user edits is exactly
 * what ends up in the layer (no DOM-vs-Canvas2D drift, no jump on commit).
 *
 * Coordinates:
 *   - **Layout space** is the untransformed text space. Lines are stacked from
 *     `(ls.x, ls.y)`; widths come from Canvas2D `measureText` with the layer's
 *     full font state applied.
 *   - **Canvas space** is layout space mapped through `layout.matrix`
 *     (horizontal / vertical scale + faux-italic shear about `(ls.x, ls.y)`).
 *
 * Every line knows the source range of `ls.text` it covers, so caret indices
 * are plain string offsets — the same offsets a `<textarea>` uses.
 */
import type { TextLayerState } from "@/types";

export interface TextRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Affine `[a, b, c, d, e, f]` in Canvas2D `transform()` order. */
export type TextMatrix = readonly [number, number, number, number, number, number];

export interface TextLine {
  /** Source range of `ls.text` covered by the line: `[start, end)`. Excludes
   *  the paragraph's `\n`; includes trailing spaces the line broke at. */
  readonly start: number;
  readonly end: number;
  /** Cased text of `[start, end)` — caret offsets are measured on it. */
  readonly full: string;
  /** What is drawn: `full` minus the trailing break spaces. */
  readonly draw: string;
  /** Pen position (`textBaseline = "top"`) in layout space. */
  readonly x: number;
  readonly y: number;
  /** Top / bottom of the line's slot in layout space (hit-testing). */
  readonly top: number;
  readonly bottom: number;
  /** Advance width of `draw`. */
  readonly width: number;
  /** Per-space advance on a justified line; null = natural spacing. */
  readonly spaceWidth: number | null;
  readonly isLastOfPara: boolean;
  /** Visual-order direction runs for lines that need bidi reordering (RTL
   *  paragraph or RTL characters); null = plain left-to-right line. */
  readonly segments: readonly BidiSegment[] | null;
  /** Caret x offsets relative to `x`, one per UTF-16 boundary. Lazy. */
  offsets: Float64Array | null;
}

/** A same-direction run of a line, in visual (left-to-right) order. */
export interface BidiSegment {
  /** Source range relative to the line: `[start, end)`. */
  readonly start: number;
  readonly end: number;
  readonly text: string;
  /** Right-to-left run (odd embedding level). */
  readonly rtl: boolean;
  /** A stretched space on a justified line (drawn as a gap). */
  readonly space: boolean;
  /** Left edge in layout space. */
  readonly x: number;
  readonly width: number;
}

export interface TextLayout {
  readonly ls: TextLayerState;
  readonly font: string;
  readonly fontSize: number;
  readonly lines: readonly TextLine[];
  /** Caret extent around a line's pen y (layout space). */
  readonly ascent: number;
  readonly descent: number;
  readonly matrix: TextMatrix;
  readonly identity: boolean;
  /** Editing frame / hit area in canvas space. */
  readonly frame: TextRect;
  /** Area-text clip rect in canvas space (null for point text). */
  readonly clip: TextRect | null;
  /** Conservative integer ink bounds in canvas space (null = nothing drawn). */
  readonly ink: TextRect | null;
  /** Area text whose lines don't fit the box. */
  readonly overflow: boolean;
  /** Width of the justified line box (layout space), 0 for point text. */
  readonly innerWidth: number;
}

// ─── Font state ──────────────────────────────────────────────────────────────

type Ctx2D = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;
type ExtCtx = Ctx2D & {
  letterSpacing?: string;
  fontKerning?: string;
  fontVariantCaps?: string;
  textRendering?: string;
  fontFeatureSettings?: string;
};

const SUPSUB_SCALE = 0.583;

export function effectiveFontSize(ls: TextLayerState): number {
  return ls.superscript || ls.subscript ? ls.fontSize * SUPSUB_SCALE : ls.fontSize;
}

export function textFont(ls: TextLayerState): string {
  return [
    ls.italic ? "italic" : "",
    ls.bold ? "bold" : "",
    `${effectiveFontSize(ls)}px`,
    `"${ls.fontFamily}", sans-serif`,
  ]
    .filter(Boolean)
    .join(" ");
}

/** Apply every font-affecting property. Measuring and drawing both go
 *  through this, so their advances agree exactly. */
export function applyTextStyle(ctx: Ctx2D, ls: TextLayerState): void {
  const c = ctx as ExtCtx;
  c.font = textFont(ls);
  c.textBaseline = "top";
  c.textAlign = "left";
  c.direction = "ltr";
  c.letterSpacing = `${ls.letterSpacing ?? 0}px`;
  if ("fontKerning" in c) c.fontKerning = (ls.kerning ?? "auto") === "auto" ? "auto" : "none";
  if ("fontVariantCaps" in c) {
    c.fontVariantCaps = ls.smallCaps && !ls.allCaps ? "small-caps" : "normal";
  }
  if ("fontFeatureSettings" in c) {
    const lig = ls.ligatures ?? "standard";
    c.fontFeatureSettings =
      lig === "none" ? '"liga" 0, "dlig" 0' : lig === "all" ? '"liga" 1, "dlig" 1' : '"liga" 1, "dlig" 0';
  }
  if ("textRendering" in c) {
    const aa = ls.antiAlias ?? "smooth";
    c.textRendering =
      aa === "none" ? "optimizeSpeed" : aa === "sharp" || aa === "crisp" ? "geometricPrecision" : "optimizeLegibility";
  }
}

const measureCtx: Ctx2D = (() => {
  if (typeof OffscreenCanvas !== "undefined") {
    const c = new OffscreenCanvas(1, 1).getContext("2d");
    if (c) return c;
  }
  return document.createElement("canvas").getContext("2d")!;
})();

/** Upper-case without changing the UTF-16 length, so caret offsets into the
 *  source string stay valid (e.g. `ß` stays `ß` rather than becoming `SS`). */
function upperSameLength(s: string): string {
  const u = s.toUpperCase();
  if (u.length === s.length) return u;
  let out = "";
  for (const ch of s) {
    const cu = ch.toUpperCase();
    out += cu.length === ch.length ? cu : ch;
  }
  return out;
}

function countSpaces(s: string): number {
  let n = 0;
  for (let i = 0; i < s.length; i++) if (s.charCodeAt(i) === 32) n++;
  return n;
}

// ─── Line breaking ───────────────────────────────────────────────────────────

/**
 * Greedy line breaking matching CSS `white-space: pre-wrap;
 * overflow-wrap: break-word`: break after space runs, and break words that
 * don't fit on a line of their own at the character level. Returns
 * `[start, end)` ranges relative to `para`.
 */
function breakParagraph(
  para: string,
  maxWidth: (lineIdx: number) => number,
): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  const measure = (a: number, b: number): number =>
    measureCtx.measureText(para.slice(a, b)).width;
  const n = para.length;
  let lineStart = 0;
  let i = 0;
  while (i < n) {
    // Token: a word [ws, we) followed by the spaces that hang after it.
    const ws = i;
    while (i < n && para.charCodeAt(i) !== 32) i++;
    const we = i;
    while (i < n && para.charCodeAt(i) === 32) i++;
    const maxW = maxWidth(out.length);
    if (we === ws || measure(lineStart, we) <= maxW) continue; // fits (spaces hang)
    // Doesn't fit: break before the word if the line already has content.
    if (ws > lineStart) {
      out.push([lineStart, ws]);
      lineStart = ws;
      if (measure(lineStart, we) <= maxWidth(out.length)) continue;
    }
    // The word alone is too wide: break it at the character level.
    while (lineStart < we && measure(lineStart, we) > maxWidth(out.length)) {
      const w = maxWidth(out.length);
      let lo = 1;
      let hi = we - lineStart;
      while (lo < hi) {
        const mid = (lo + hi + 1) >> 1;
        if (measure(lineStart, lineStart + mid) <= w) lo = mid;
        else hi = mid - 1;
      }
      let cut = lineStart + lo;
      // Never split a surrogate pair.
      if (cut < we && (para.charCodeAt(cut) & 0xfc00) === 0xdc00 && lo > 1) cut--;
      out.push([lineStart, cut]);
      lineStart = cut;
    }
  }
  out.push([lineStart, n]);
  return out;
}

// ─── Bidi ────────────────────────────────────────────────────────────────────
//
// A compact form of the Unicode Bidirectional Algorithm (UAX #9) for one
// line without explicit embeddings: strong L / R, numbers, neutrals and
// non-spacing marks, levels 0–2, rules W7 / N1 / N2 / L1 / L2. Enough for
// RTL paragraphs with embedded Latin words and numbers, and LTR paragraphs
// with RTL phrases — with caret positions that match what is drawn.

const RTL_CHAR =
  /[֐-ࣿיִ-﷿ﹰ-﻿\u{10800}-\u{10FFF}\u{1E800}-\u{1EFFF}]/u;
const DIGIT = /\p{Nd}/u;
const MARK = /\p{M}/u;
const LETTER = /\p{L}/u;

/** Whether a line needs the bidi path. */
function needsBidi(s: string, rtlBase: boolean): boolean {
  return rtlBase || RTL_CHAR.test(s);
}

type BidiClass = "L" | "R" | "N" | "W"; // strong L, strong R, number, neutral

/** Resolved embedding level per UTF-16 unit (0 / 1 / 2). */
function bidiLevels(s: string, rtlBase: boolean): Uint8Array {
  const n = s.length;
  const cls: BidiClass[] = new Array(n);
  for (let i = 0; i < n; i++) {
    const code = s.charCodeAt(i);
    if ((code & 0xfc00) === 0xdc00 && i > 0) {
      cls[i] = cls[i - 1]; // low surrogate: same as its lead
      continue;
    }
    const ch = String.fromCodePoint(s.codePointAt(i)!);
    if (DIGIT.test(ch)) cls[i] = "N";
    else if (MARK.test(ch)) cls[i] = i > 0 ? cls[i - 1] : "W";
    else if (RTL_CHAR.test(ch)) cls[i] = "R";
    else if (LETTER.test(ch)) cls[i] = "L";
    else cls[i] = "W";
  }
  const base = rtlBase ? "R" : "L";
  const levels = new Uint8Array(n);
  // Direction a non-neutral exerts on adjacent neutrals (numbers act as R,
  // except after a strong L — W7).
  const eff: Array<"L" | "R"> = new Array(n);
  let prevStrong: "L" | "R" = base;
  for (let i = 0; i < n; i++) {
    const c = cls[i];
    if (c === "L") {
      prevStrong = "L";
      eff[i] = "L";
      levels[i] = rtlBase ? 2 : 0;
    } else if (c === "R") {
      prevStrong = "R";
      eff[i] = "R";
      levels[i] = 1;
    } else if (c === "N") {
      eff[i] = prevStrong === "L" ? "L" : "R";
      levels[i] = rtlBase || prevStrong === "R" ? 2 : 0;
    }
  }
  // Neutrals take the direction of their surroundings when both sides
  // agree, else the paragraph direction (N1 / N2).
  for (let i = 0; i < n; ) {
    if (cls[i] !== "W") {
      i++;
      continue;
    }
    let j = i;
    while (j < n && cls[j] === "W") j++;
    const before = i > 0 ? eff[i - 1] : base;
    const after = j < n ? eff[j] : base;
    const d = before === after ? before : base;
    const lvl = d === "R" ? 1 : rtlBase ? 2 : 0;
    for (let k = i; k < j; k++) levels[k] = lvl;
    i = j;
  }
  // Trailing whitespace takes the paragraph level (L1).
  for (let i = n - 1; i >= 0 && (s[i] === " " || s[i] === "\t"); i--) {
    levels[i] = rtlBase ? 1 : 0;
  }
  return levels;
}

/**
 * Split a line into direction runs in visual order (L2), measured and
 * positioned from `x0`. On justified lines (`spaceWidth` set) every space
 * before `drawLen` becomes its own stretched segment.
 */
function bidiSegments(
  full: string,
  drawLen: number,
  rtlBase: boolean,
  spaceWidth: number | null,
): Array<Omit<BidiSegment, "x">> {
  const levels = bidiLevels(full, rtlBase);
  const runs: Array<{ start: number; end: number; level: number; space: boolean }> = [];
  for (let i = 0; i < full.length; ) {
    const level = levels[i];
    const space = spaceWidth !== null && i < drawLen && full[i] === " ";
    let j = i + 1;
    if (!space) {
      // Runs also split where the hanging trailing spaces begin, so those
      // can be placed at the paragraph's visual end.
      while (
        j < full.length &&
        levels[j] === level &&
        j !== drawLen &&
        !(spaceWidth !== null && j < drawLen && full[j] === " ")
      )
        j++;
    }
    runs.push({ start: i, end: j, level, space });
    i = j;
  }
  if (runs.length > 1) {
    let maxL = 0;
    let minL = 255;
    for (const r of runs) {
      maxL = Math.max(maxL, r.level);
      minL = Math.min(minL, r.level);
    }
    const lowestOdd = minL % 2 === 1 ? minL : minL + 1;
    for (let lvl = maxL; lvl >= lowestOdd; lvl--) {
      for (let i = 0; i < runs.length; ) {
        if (runs[i].level < lvl) {
          i++;
          continue;
        }
        let j = i;
        while (j < runs.length && runs[j].level >= lvl) j++;
        const rev = runs.slice(i, j).reverse();
        runs.splice(i, j - i, ...rev);
        i = j;
      }
    }
  }
  return runs.map((r) => {
    const text = full.slice(r.start, r.end);
    return {
      start: r.start,
      end: r.end,
      text,
      rtl: r.level % 2 === 1,
      space: r.space,
      width: r.space ? spaceWidth! : measureCtx.measureText(text).width,
    };
  });
}

// ─── Layout ──────────────────────────────────────────────────────────────────

const layoutCache = new WeakMap<TextLayerState, TextLayout>();

function mapPoint(m: TextMatrix, x: number, y: number): [number, number] {
  return [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
}

/** Lay out a text layer. Cached per (immutable) layer-state object. */
export function layoutText(ls: TextLayerState): TextLayout {
  const cached = layoutCache.get(ls);
  if (cached) return cached;
  const layout = computeLayout(ls);
  layoutCache.set(ls, layout);
  return layout;
}

function computeLayout(ls: TextLayerState): TextLayout {
  applyTextStyle(measureCtx, ls);
  const fs = ls.fontSize;
  const effFs = effectiveFontSize(ls);
  const hScale = (ls.horizontalScale ?? 100) / 100 || 1;
  const vScale = (ls.verticalScale ?? 100) / 100 || 1;
  const shear = ls.fauxItalic ? -0.2126 : 0; // ≈ 12°, PSD faux italic
  const supSubBaseline = ls.superscript ? fs * 0.33 : ls.subscript ? -fs * 0.33 : 0;
  const baselineShift = (ls.baselineShift ?? 0) + supSubBaseline;
  const lineHeight = fs * (ls.lineHeight ?? 1.2);
  const firstIndent = ls.firstLineIndent ?? 0;
  const leftIndent = ls.leftIndent ?? 0;
  const rightIndent = ls.rightIndent ?? 0;
  const spaceBefore = ls.spaceBefore ?? 0;
  const spaceAfter = ls.spaceAfter ?? 0;
  const align = ls.align ?? "left";
  const isArea = ls.boxWidth > 0 && ls.boxHeight > 0;
  // The box is in canvas space; wrap in layout space so horizontal scale
  // doesn't push text out of the box.
  const boxW = isArea ? ls.boxWidth / hScale : 0;
  const wrapW = isArea ? Math.max(1, boxW - leftIndent - rightIndent) : 0;
  const wrap = isArea && !ls.noBreak;

  const m0 = measureCtx.measureText("Hg");
  const ascent = Number.isFinite(m0.fontBoundingBoxAscent) ? m0.fontBoundingBoxAscent : 0;
  const descent = Number.isFinite(m0.fontBoundingBoxDescent) ? m0.fontBoundingBoxDescent : effFs * 1.2;

  // ── Break into lines ──
  type Proto = {
    start: number;
    end: number;
    full: string;
    draw: string;
    width: number;
    firstOfPara: boolean;
    lastOfPara: boolean;
    paraIdx: number;
  };
  const protos: Proto[] = [];
  const text = ls.text;
  const cased = ls.allCaps ? upperSameLength(text) : text;
  let paraStart = 0;
  let paraIdx = 0;
  for (;;) {
    const nl = cased.indexOf("\n", paraStart);
    const paraEnd = nl === -1 ? cased.length : nl;
    const para = cased.slice(paraStart, paraEnd);
    const ranges = wrap
      ? breakParagraph(para, (li) => Math.max(1, wrapW - (li === 0 ? firstIndent : 0)))
      : [[0, para.length] as [number, number]];
    ranges.forEach(([a, b], k) => {
      const full = para.slice(a, b);
      const isLast = k === ranges.length - 1;
      // Trailing break spaces hang past the line end (CSS pre-wrap).
      const draw = isLast ? full : full.replace(/ +$/, "");
      protos.push({
        start: paraStart + a,
        end: paraStart + b,
        full,
        draw,
        width: draw ? measureCtx.measureText(draw).width : 0,
        firstOfPara: k === 0,
        lastOfPara: isLast,
        paraIdx,
      });
    });
    if (nl === -1) break;
    paraStart = nl + 1;
    paraIdx++;
  }

  // Point text aligns lines against the widest one (the block's left edge
  // stays anchored at ls.x).
  let blockW = 0;
  if (!isArea) {
    for (const p of protos) {
      blockW = Math.max(blockW, p.width + (p.firstOfPara ? firstIndent : 0));
    }
  }

  // ── Position lines ──
  // Indents are start / end relative: in a right-to-left paragraph the
  // "left" (start) and first-line indents sit on the right.
  const rtl = ls.direction === "rtl";
  const lines: TextLine[] = [];
  let cursorY = ls.y;
  protos.forEach((p, i) => {
    if (p.firstOfPara && i > 0) cursorY += spaceBefore;
    const indent = p.firstOfPara ? firstIndent : 0;
    let left: number;
    let inner: number;
    if (isArea) {
      left = ls.x + (rtl ? rightIndent : leftIndent + indent);
      inner = boxW - leftIndent - rightIndent - indent;
    } else {
      left = rtl ? ls.x : ls.x + leftIndent + indent;
      inner = blockW - indent;
    }
    // A justified paragraph's last line aligns to the start side.
    const lineAlign =
      align === "justify" && (!isArea || p.lastOfPara)
        ? rtl
          ? "right"
          : "left"
        : align;
    let x = left;
    let spaceWidth: number | null = null;
    if (inner > 0) {
      if (lineAlign === "center") x = left + (inner - p.width) / 2;
      else if (lineAlign === "right") x = left + inner - p.width;
      else if (lineAlign === "justify") {
        const spaces = countSpaces(p.draw);
        if (spaces > 0) {
          const inkW = measureCtx.measureText(p.draw.replace(/ /g, "")).width;
          spaceWidth = (inner - inkW) / spaces;
        }
      }
    }
    let segments: BidiSegment[] | null = null;
    if (needsBidi(p.full, rtl)) {
      const raw = bidiSegments(p.full, p.draw.length, rtl, spaceWidth);
      // Hanging trailing spaces sit at the paragraph's visual end — left of
      // the content in a right-to-left paragraph.
      let sx = x;
      if (rtl) {
        for (const s of raw) if (s.start >= p.draw.length) sx -= s.width;
      }
      segments = raw.map((s) => {
        const seg: BidiSegment = {
          start: s.start,
          end: s.end,
          text: s.text,
          rtl: s.rtl,
          space: s.space,
          x: sx,
          width: s.width,
        };
        sx += s.width;
        return seg;
      });
    }
    lines.push({
      start: p.start,
      end: p.end,
      full: p.full,
      draw: p.draw,
      x,
      y: cursorY - baselineShift,
      top: cursorY,
      bottom: cursorY + lineHeight,
      width: spaceWidth !== null ? inner : p.width,
      spaceWidth,
      isLastOfPara: p.lastOfPara,
      segments,
      offsets: null,
    });
    cursorY += lineHeight;
    if (p.lastOfPara) cursorY += spaceAfter;
  });
  const contentH = cursorY - ls.y;

  // ── Transform ──
  const ox = ls.x;
  const oy = ls.y;
  const matrix: TextMatrix = [
    hScale,
    0,
    shear,
    vScale,
    ox - hScale * ox - shear * oy,
    oy - vScale * oy,
  ];
  const identity = hScale === 1 && vScale === 1 && shear === 0;

  // ── Frame ──
  let contentW = 0;
  for (const l of lines) contentW = Math.max(contentW, l.x - ls.x + l.width);
  const frame: TextRect = isArea
    ? { x: ls.x, y: ls.y, w: ls.boxWidth, h: ls.boxHeight }
    : {
        x: ls.x,
        y: ls.y,
        w: Math.max(contentW, effFs * 0.5) * hScale,
        h: Math.max(contentH, lineHeight) * vScale,
      };
  const clip = isArea ? { ...frame } : null;

  // ── Ink bounds (conservative) ──
  const strokeW = ls.strokeColor ? (ls.strokeWidth ?? 0) : 0;
  const pad = strokeW / 2 + (ls.fauxBold ? fs / 30 : 0) + effFs * 0.3 + 2;
  const decoBottom = fs + 2 + Math.max(1, Math.round(fs / 14));
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  if (text) {
    for (const l of lines) {
      if (!l.draw) continue;
      const lx0 = l.x - pad;
      const lx1 = l.x + l.width + pad;
      const ly0 = l.y - Math.max(ascent, 0) - pad;
      const ly1 = l.y + Math.max(descent, decoBottom) + pad;
      for (const [cx, cy] of [
        mapPoint(matrix, lx0, ly0),
        mapPoint(matrix, lx1, ly0),
        mapPoint(matrix, lx0, ly1),
        mapPoint(matrix, lx1, ly1),
      ]) {
        if (cx < x0) x0 = cx;
        if (cx > x1) x1 = cx;
        if (cy < y0) y0 = cy;
        if (cy > y1) y1 = cy;
      }
    }
  }
  if (clip && x0 < x1) {
    x0 = Math.max(x0, clip.x);
    y0 = Math.max(y0, clip.y);
    x1 = Math.min(x1, clip.x + clip.w);
    y1 = Math.min(y1, clip.y + clip.h);
  }
  const ink =
    x0 < x1 && y0 < y1
      ? {
          x: Math.floor(x0),
          y: Math.floor(y0),
          w: Math.ceil(x1) - Math.floor(x0),
          h: Math.ceil(y1) - Math.floor(y0),
        }
      : null;

  return {
    ls,
    font: textFont(ls),
    fontSize: effFs,
    lines,
    ascent,
    descent,
    matrix,
    identity,
    frame,
    clip,
    ink,
    overflow: isArea && contentH * vScale > ls.boxHeight + 0.5,
    innerWidth: isArea ? boxW - leftIndent - rightIndent : 0,
  };
}

/** Editing frame / hit area of a text layer, in canvas space. */
export function textFrame(ls: TextLayerState): TextRect {
  return layoutText(ls).frame;
}

// ─── Caret geometry ──────────────────────────────────────────────────────────

/** Exact prefix measurement up to this line length; longer lines measure
 *  exactly every CHUNK characters and add per-character advances between. */
const EXACT_LIMIT = 300;
const CHUNK = 64;

/** Layout-space x of the boundary `k` characters (logical) into a segment:
 *  measured from the left edge of an LTR run, from the right of an RTL run. */
function segmentEdge(seg: BidiSegment, k: number): number {
  const w = seg.space
    ? (k / Math.max(1, seg.end - seg.start)) * seg.width
    : k === 0
      ? 0
      : k >= seg.text.length
        ? seg.width
        : measureCtx.measureText(seg.text.slice(0, k)).width;
  return seg.rtl ? seg.x + seg.width - w : seg.x + w;
}

function segmentAt(segs: readonly BidiSegment[], i: number): BidiSegment {
  for (const seg of segs) if (i >= seg.start && i < seg.end) return seg;
  return segs[segs.length - 1];
}

function lineOffsets(layout: TextLayout, line: TextLine): Float64Array {
  if (line.offsets) return line.offsets;
  applyTextStyle(measureCtx, layout.ls);
  const s = line.full;
  const n = s.length;
  const out = new Float64Array(n + 1);
  const sw = line.spaceWidth;
  if (line.segments && n > 0) {
    // Bidi: a caret stands at the leading edge of the character after it,
    // or at the trailing edge of the last character at the line end.
    for (let i = 0; i <= n; i++) {
      const seg = segmentAt(line.segments, i < n ? i : n - 1);
      out[i] = segmentEdge(seg, i - seg.start) - line.x;
    }
  } else if (sw !== null) {
    let noSpace = "";
    let spaces = 0;
    for (let i = 1; i <= n; i++) {
      const ch = s[i - 1];
      if (ch === " ") spaces++;
      else noSpace += ch;
      out[i] = measureCtx.measureText(noSpace).width + spaces * sw;
    }
  } else if (n <= EXACT_LIMIT) {
    for (let i = 1; i <= n; i++) out[i] = measureCtx.measureText(s.slice(0, i)).width;
  } else {
    let base = 0;
    for (let i = 1; i <= n; i++) {
      if (i % CHUNK === 0) {
        base = measureCtx.measureText(s.slice(0, i)).width;
        out[i] = base;
      } else {
        const from = i - (i % CHUNK);
        out[i] = (from === 0 ? 0 : base) + measureCtx.measureText(s.slice(from, i)).width;
      }
    }
  }
  line.offsets = out;
  return out;
}

/** Line index holding caret `index`. A caret at a soft-wrap boundary belongs
 *  to the following line. */
export function lineIndexOf(layout: TextLayout, index: number): number {
  const lines = layout.lines;
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (index < l.end || (index === l.end && l.isLastOfPara)) {
      if (index >= l.start) return i;
    }
  }
  return lines.length - 1;
}

/** Caret x (layout space) of `index` on line `li`. */
export function caretX(layout: TextLayout, li: number, index: number): number {
  const line = layout.lines[li];
  const k = Math.max(0, Math.min(line.full.length, index - line.start));
  return line.x + lineOffsets(layout, line)[k];
}

/** Caret segment in layout space. */
export function caretGeometry(
  layout: TextLayout,
  index: number,
): { x: number; top: number; bottom: number; line: number } {
  const li = lineIndexOf(layout, index);
  const line = layout.lines[li];
  return {
    x: caretX(layout, li, index),
    top: line.y - layout.ascent,
    bottom: line.y + layout.descent,
    line: li,
  };
}

/** Nearest caret index on line `li` to layout-space x. */
export function indexAtX(layout: TextLayout, li: number, x: number): number {
  const line = layout.lines[li];
  const off = lineOffsets(layout, line);
  const rel = x - line.x;
  // The trailing break space of a wrapped line isn't a caret stop: its end
  // is the next line's start.
  let maxK = line.full.length;
  if (!line.isLastOfPara && maxK > 0 && line.full.charCodeAt(maxK - 1) === 32) maxK--;
  // Offsets only increase with k on plain lines; bidi lines need a full scan.
  const monotonic = !line.segments;
  let best = 0;
  let bestD = Infinity;
  for (let k = 0; k <= maxK; k++) {
    const d = Math.abs(off[k] - rel);
    if (d < bestD) {
      bestD = d;
      best = k;
    } else if (monotonic && off[k] > rel) break;
  }
  let idx = line.start + best;
  const code = layout.ls.text.charCodeAt(idx);
  if ((code & 0xfc00) === 0xdc00) idx--; // inside a surrogate pair
  return idx;
}

/** Canvas-space point → layout-space point. */
export function toLayoutSpace(layout: TextLayout, cx: number, cy: number): [number, number] {
  const [a, b, c, d, e, f] = layout.matrix;
  const det = a * d - b * c || 1;
  const x = cx - e;
  const y = cy - f;
  return [(d * x - c * y) / det, (a * y - b * x) / det];
}

/** Caret index nearest to a canvas-space point. */
export function hitTestText(layout: TextLayout, cx: number, cy: number): number {
  const [x, y] = toLayoutSpace(layout, cx, cy);
  const lines = layout.lines;
  let li = lines.length - 1;
  for (let i = 0; i < lines.length; i++) {
    if (y < lines[i].bottom) {
      li = i;
      break;
    }
  }
  return indexAtX(layout, li, x);
}

/** Selection highlight rectangles in layout space. */
export function selectionRects(layout: TextLayout, from: number, to: number): TextRect[] {
  const a = Math.min(from, to);
  const b = Math.max(from, to);
  if (a === b) return [];
  const rects: TextRect[] = [];
  layout.lines.forEach((line, li) => {
    // A line's selectable span includes its terminating newline.
    const lineEnd = line.isLastOfPara ? line.end + 1 : line.end;
    if (b <= line.start || a >= lineEnd) return;
    const s = Math.max(a, line.start);
    const e = Math.min(b, line.end);
    const y = line.y - layout.ascent;
    const h = layout.ascent + layout.descent;
    if (line.segments) {
      // Bidi: a logical range is one piece per direction run it touches.
      applyTextStyle(measureCtx, layout.ls);
      let minX = Infinity;
      let maxX = -Infinity;
      for (const seg of line.segments) {
        const k0 = Math.max(s - line.start, seg.start);
        const k1 = Math.min(e - line.start, seg.end);
        if (k0 >= k1) continue;
        const x0 = segmentEdge(seg, k0 - seg.start);
        const x1 = segmentEdge(seg, k1 - seg.start);
        const l = Math.min(x0, x1);
        const w = Math.abs(x1 - x0);
        const prev = rects[rects.length - 1];
        if (prev && prev.y === y && Math.abs(prev.x + prev.w - l) < 0.5) prev.w += w;
        else rects.push({ x: l, y, w, h });
        minX = Math.min(minX, l);
        maxX = Math.max(maxX, l + w);
      }
      if (b > line.end && line.isLastOfPara) {
        // Newline marker at the paragraph's visual end.
        const nlW = layout.fontSize * 0.3;
        const rtlPara = layout.ls.direction === "rtl";
        const edge = Number.isFinite(minX)
          ? rtlPara
            ? minX
            : maxX
          : line.x + lineOffsets(layout, line)[line.full.length];
        rects.push({ x: rtlPara ? edge - nlW : edge, y, w: nlW, h });
      }
      return;
    }
    const xs = caretX(layout, li, s);
    let xe = caretX(layout, li, e);
    if (b > line.end && line.isLastOfPara) xe += layout.fontSize * 0.3; // newline
    if (xe > xs) {
      rects.push({ x: xs, y, w: xe - xs, h });
    }
  });
  return rects;
}

/** Visual-line start / end caret index for Home / End. */
export function lineBoundary(layout: TextLayout, index: number, end: boolean): number {
  const line = layout.lines[lineIndexOf(layout, index)];
  if (!end) return line.start;
  if (!line.isLastOfPara && line.full.endsWith(" ")) return line.end - 1;
  return line.end;
}

/** Word range around `index` (double-click selection). */
export function wordRangeAt(text: string, index: number): [number, number] {
  const Seg = (Intl as unknown as { Segmenter?: typeof Intl.Segmenter }).Segmenter;
  if (Seg) {
    const seg = new Seg(undefined, { granularity: "word" });
    for (const s of seg.segment(text)) {
      const end = s.index + s.segment.length;
      if (index >= s.index && index < end) return [s.index, end];
      if (index === end && end === text.length) return [s.index, end];
    }
    return [index, index];
  }
  const isWord = (c: string): boolean => /[\p{L}\p{N}_]/u.test(c);
  let a = index;
  let b = index;
  while (a > 0 && isWord(text[a - 1])) a--;
  while (b < text.length && isWord(text[b])) b++;
  return [a, b];
}

/** Paragraph range around `index` (triple-click selection). */
export function paragraphRangeAt(text: string, index: number): [number, number] {
  const a = text.lastIndexOf("\n", index - 1) + 1;
  const nl = text.indexOf("\n", index);
  return [a, nl === -1 ? text.length : nl];
}

// ─── Drawing ─────────────────────────────────────────────────────────────────

/** Float RGBA → CSS colour, HDR clamped at the Canvas2D boundary. */
export function floatRgbaToCss(c: { r: number; g: number; b: number; a: number }): string {
  const r = Math.max(0, Math.min(255, Math.round(c.r * 255)));
  const g = Math.max(0, Math.min(255, Math.round(c.g * 255)));
  const b = Math.max(0, Math.min(255, Math.round(c.b * 255)));
  const a = Math.max(0, Math.min(1, c.a));
  return `rgba(${r}, ${g}, ${b}, ${a})`;
}

/**
 * Draw a laid-out text layer onto a 2D context whose current transform maps
 * canvas space to the target (identity for a canvas-sized target; a
 * translation for a region scratch).
 */
export function drawTextLayout(ctx: Ctx2D, layout: TextLayout): void {
  const ls = layout.ls;
  if (!ls.text || !layout.ink) return;
  ctx.save();
  if (layout.clip) {
    const c = layout.clip;
    ctx.beginPath();
    ctx.rect(c.x, c.y, c.w, c.h);
    ctx.clip();
  }
  if (!layout.identity) ctx.transform(...layout.matrix);
  applyTextStyle(ctx, ls);
  const fill = floatRgbaToCss(ls.color);
  ctx.fillStyle = fill;
  const stroke = ls.strokeColor && (ls.strokeWidth ?? 0) > 0 ? ls.strokeColor : null;
  const strokeCss = stroke ? floatRgbaToCss(stroke) : "";
  const fs = ls.fontSize;
  const decoThick = Math.max(1, Math.round(fs / 14));

  const run = (s: string, x: number, y: number): void => {
    if (stroke) {
      ctx.strokeStyle = strokeCss;
      ctx.lineWidth = ls.strokeWidth ?? 0;
      ctx.lineJoin = "round";
      ctx.strokeText(s, x, y);
    }
    ctx.fillText(s, x, y);
    if (ls.fauxBold) {
      ctx.strokeStyle = fill;
      ctx.lineWidth = Math.max(1, fs / 30);
      ctx.lineJoin = "round";
      ctx.strokeText(s, x, y);
    }
  };

  for (const line of layout.lines) {
    if (!line.draw) continue;
    if (line.segments) {
      // Bidi: each direction run is drawn on its own at its visual position,
      // exactly where the caret geometry puts it.
      for (const seg of line.segments) {
        if (seg.space || seg.start >= line.draw.length) continue;
        ctx.direction = seg.rtl ? "rtl" : "ltr";
        run(seg.text, seg.x, line.y);
      }
      ctx.direction = "ltr";
    } else if (line.spaceWidth === null) {
      run(line.draw, line.x, line.y);
    } else {
      // Justified: draw each non-space run at its stretched position.
      const sw = line.spaceWidth;
      let noSpace = "";
      let spaces = 0;
      let i = 0;
      const s = line.draw;
      while (i < s.length) {
        if (s[i] === " ") {
          spaces++;
          i++;
          continue;
        }
        let j = i;
        while (j < s.length && s[j] !== " ") j++;
        const word = s.slice(i, j);
        run(word, line.x + ctx.measureText(noSpace).width + spaces * sw, line.y);
        noSpace += word;
        i = j;
      }
    }
    if (ls.underline) ctx.fillRect(line.x, line.y + fs + 2, line.width, decoThick);
    if (ls.strikethrough) ctx.fillRect(line.x, line.y + fs * 0.35, line.width, decoThick);
  }
  ctx.restore();
}
