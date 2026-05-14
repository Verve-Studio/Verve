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

/**
 * Draw a TextLayerState onto an arbitrary 2D context at its `ls.x / ls.y`
 * canvas-space position. Shared by both `rasterizeTextToLayer` (GPU upload
 * path) and the overlay-canvas live-preview path used during drag, so the
 * two are guaranteed to render identically.
 */
export function drawTextToCtx2d(
  ctx2d: CanvasRenderingContext2D,
  ls: TextLayerState,
): void {
  if (!ls.text) return;

  const fontStyle = [
    ls.italic ? "italic" : "",
    ls.bold ? "bold" : "",
    `${ls.fontSize}px`,
    `"${ls.fontFamily}", sans-serif`,
  ]
    .filter(Boolean)
    .join(" ");

  ctx2d.font = fontStyle;
  ctx2d.textBaseline = "top";
  ctx2d.fillStyle = `rgba(${ls.color.r}, ${ls.color.g}, ${ls.color.b}, ${ls.color.a / 255})`;
  (
    ctx2d as CanvasRenderingContext2D & { letterSpacing?: string }
  ).letterSpacing = `${ls.letterSpacing ?? 0}px`;
  if ("fontKerning" in ctx2d) {
    (ctx2d as CanvasRenderingContext2D & { fontKerning?: string }).fontKerning =
      (ls.kerning ?? "auto") === "auto" ? "auto" : "none";
  }

  const lineHeight = ls.fontSize * (ls.lineHeight ?? 1.2);
  const underlineThick = Math.max(1, Math.round(ls.fontSize / 14));
  const strikeThick = Math.max(1, Math.round(ls.fontSize / 14));
  const boxW = ls.boxWidth > 0 ? ls.boxWidth : 0;
  const boxH = ls.boxHeight > 0 ? ls.boxHeight : 0;
  const align = ls.align ?? "left";

  // For area text, clip rendering to the bounding box so overflow is pixel-clipped
  // rather than whole-line-skipped (which would hide the first line if box is slightly too small).
  if (boxW > 0 && boxH > 0) {
    ctx2d.save();
    ctx2d.beginPath();
    ctx2d.rect(ls.x, ls.y, boxW, boxH);
    ctx2d.clip();
  }

  // Build final wrapped line list
  const wrappedLines: string[] = [];
  for (const para of ls.text.split("\n")) {
    const wrapped = wrapLine(ctx2d, para, boxW);
    wrappedLines.push(...wrapped);
  }

  wrappedLines.forEach((line, i) => {
    const lineY = ls.y + i * lineHeight;

    let drawX = ls.x;
    const textW = ctx2d.measureText(line).width;

    if (boxW > 0) {
      if (align === "center") {
        drawX = ls.x + (boxW - textW) / 2;
      } else if (align === "right") {
        drawX = ls.x + boxW - textW;
      } else if (align === "justify" && i < wrappedLines.length - 1) {
        // Justified: stretch spaces between words
        const words = line.split(" ");
        if (words.length > 1) {
          const spaceW =
            (boxW - ctx2d.measureText(line.replace(/ /g, "")).width) /
            (words.length - 1);
          let cx = ls.x;
          words.forEach((word, _wi) => {
            ctx2d.fillText(word, cx, lineY);
            const ww = ctx2d.measureText(word).width;
            if (ls.underline && word.length > 0) {
              ctx2d.fillRect(cx, lineY + ls.fontSize + 2, ww, underlineThick);
            }
            if ((ls.strikethrough ?? false) && word.length > 0) {
              ctx2d.fillRect(cx, lineY + ls.fontSize * 0.35, ww, strikeThick);
            }
            cx += ww + spaceW;
          });
          return;
        }
      }
    }

    ctx2d.fillText(line, drawX, lineY);
    if (ls.underline && line.length > 0) {
      ctx2d.fillRect(drawX, lineY + ls.fontSize + 2, textW, underlineThick);
    }
    if ((ls.strikethrough ?? false) && line.length > 0) {
      ctx2d.fillRect(drawX, lineY + ls.fontSize * 0.35, textW, strikeThick);
    }
  });

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
