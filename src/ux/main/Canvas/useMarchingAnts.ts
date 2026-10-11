import { useEffect } from "react";

import { measureStore } from "@/core/tools/Measure/measureStore";
import { activeScope } from "@/core/store/scope";

/** Dash length of the selection ants, physical px. */
const ANT_DASH = 4;

/**
 * 2-colour stripe pattern (ANT_DASH black, ANT_DASH white) along x
 * (`horizontal`) or y. Equivalent to the black dash stroke plus the white
 * dash stroke offset by ANT_DASH that the ants used to draw per segment.
 */
function makeAntPattern(
  ctx: OffscreenCanvasRenderingContext2D,
  horizontal: boolean,
): CanvasPattern | null {
  const n = ANT_DASH * 2;
  const c = new OffscreenCanvas(horizontal ? n : 1, horizontal ? 1 : n);
  const g = c.getContext("2d");
  if (!g) return null;
  g.fillStyle = "#000000";
  g.fillRect(0, 0, horizontal ? ANT_DASH : 1, horizontal ? 1 : ANT_DASH);
  g.fillStyle = "#ffffff";
  if (horizontal) g.fillRect(ANT_DASH, 0, ANT_DASH, 1);
  else g.fillRect(0, ANT_DASH, 1, ANT_DASH);
  return ctx.createPattern(c, "repeat");
}

/** Split border segments into a horizontal and a vertical Path2D in
 *  image-pixel space. */
function buildAntPaths(segs: Float32Array): { h: Path2D; v: Path2D } {
  const h = new Path2D();
  const v = new Path2D();
  for (let i = 0; i < segs.length; i += 4) {
    const x1 = segs[i];
    const y1 = segs[i + 1];
    const x2 = segs[i + 2];
    const y2 = segs[i + 3];
    const p = y1 === y2 ? h : v;
    p.moveTo(x1, y1);
    p.lineTo(x2, y2);
  }
  return { h, v };
}

/**
 * Selection-ants renderer whose per-frame cost doesn't depend on the number
 * of border segments (a noisy selection has millions).
 *
 * The segments become two Path2Ds (horizontal / vertical, image space), built
 * once per mask. Whenever the view changes (zoom, scroll, overlay size) they
 * are stroked once, solid, into two viewport-sized alpha masks. Each frame
 * only colourises those masks with a screen-anchored stripe pattern shifted
 * by the animation phase — x stripes for horizontal edges, y stripes for
 * vertical ones — which reproduces the old per-segment dashes anchored to
 * each segment's physical start coordinate.
 */
class AntsRenderer {
  private segs: Float32Array | null = null;
  private paths: { h: Path2D; v: Path2D } | null = null;
  private hMask: OffscreenCanvas | null = null;
  private vMask: OffscreenCanvas | null = null;
  private scratch: OffscreenCanvas | null = null;
  private hPattern: CanvasPattern | null = null;
  private vPattern: CanvasPattern | null = null;
  private keyZoom = NaN;
  private keyX = NaN;
  private keyY = NaN;

  draw(
    target: CanvasRenderingContext2D,
    segs: Float32Array,
    zoom: number,
    originX: number,
    originY: number,
    phase: number,
  ): void {
    const w = target.canvas.width;
    const h = target.canvas.height;
    if (w === 0 || h === 0) return;
    if (segs !== this.segs) {
      this.segs = segs;
      this.paths = buildAntPaths(segs);
      this.keyZoom = NaN;
    }
    if (!this.scratch || this.scratch.width !== w || this.scratch.height !== h) {
      this.hMask = new OffscreenCanvas(w, h);
      this.vMask = new OffscreenCanvas(w, h);
      this.scratch = new OffscreenCanvas(w, h);
      this.hPattern = null;
      this.vPattern = null;
      this.keyZoom = NaN;
    }
    const sctx = this.scratch.getContext("2d");
    if (!sctx) return;
    if (!this.hPattern) this.hPattern = makeAntPattern(sctx, true);
    if (!this.vPattern) this.vPattern = makeAntPattern(sctx, false);

    if (
      zoom !== this.keyZoom ||
      originX !== this.keyX ||
      originY !== this.keyY
    ) {
      this.keyZoom = zoom;
      this.keyX = originX;
      this.keyY = originY;
      for (const [mask, path] of [
        [this.hMask!, this.paths!.h],
        [this.vMask!, this.paths!.v],
      ] as [OffscreenCanvas, Path2D][]) {
        const m = mask.getContext("2d");
        if (!m) continue;
        m.setTransform(1, 0, 0, 1, 0, 0);
        m.clearRect(0, 0, w, h);
        // Image space → physical px; 1 physical px line width.
        m.setTransform(zoom, 0, 0, zoom, originX, originY);
        m.lineWidth = 1 / zoom;
        m.strokeStyle = "#ffffff";
        m.stroke(path);
      }
    }

    for (const [mask, pattern, horizontal] of [
      [this.hMask!, this.hPattern, true],
      [this.vMask!, this.vPattern, false],
    ] as [OffscreenCanvas, CanvasPattern | null, boolean][]) {
      if (!pattern) continue;
      sctx.globalCompositeOperation = "copy";
      sctx.drawImage(mask, 0, 0);
      sctx.globalCompositeOperation = "source-in";
      // Stripe colour at physical p = pattern[(p + phase) mod 2·DASH].
      pattern.setTransform(
        horizontal
          ? new DOMMatrix([1, 0, 0, 1, -phase, 0])
          : new DOMMatrix([1, 0, 0, 1, 0, -phase]),
      );
      sctx.fillStyle = pattern;
      sctx.fillRect(0, 0, w, h);
      sctx.globalCompositeOperation = "source-over";
      target.drawImage(this.scratch, 0, 0);
    }
  }
}

/**
 * Drives the marching-ants / crop-overlay / polygonal-selection RAF animation
 * loop on a single viewport-level canvas.
 *
 * The overlay canvas lives at viewport level (not inside the image canvas
 * wrapper), so it is always sized to the viewport in physical pixels.
 * Coordinates are transformed from image-pixel space to physical-pixel space
 * using getBoundingClientRect(), giving Photoshop-style fixed-width lines
 * that stay exactly 1 physical pixel wide regardless of zoom.
 */
export function useMarchingAnts(
  isActive: boolean,
  overlayRef: React.RefObject<HTMLCanvasElement | null>,
  viewportRef: React.RefObject<HTMLElement | null>,
  canvasWrapperRef: React.RefObject<HTMLElement | null>,
  zoomRef: React.RefObject<number>,
  activeToolRef: React.RefObject<string>,
): void {
  useEffect(() => {
    if (!isActive) return;
    let rafId: number;
    let dashOffset = 0;
    // True once the overlay has been cleared with nothing to draw: idle
    // frames then skip all DOM / canvas work until something appears.
    let idleCleared = false;
    const ants = new AntsRenderer();

    const tick = (): void => {
      rafId = requestAnimationFrame(tick);

      const { mask, pending, borderSegments } = activeScope().selection;
      const hasCrop = !!(activeScope().crop.pendingRect || activeScope().crop.rect);
      const isPolyTool = activeToolRef.current === "polygonal-selection";
      const hasPolyVerts =
        isPolyTool && activeScope().polygonalSelection.vertices.length > 0;
      const hasMeasure = !!(measureStore.start && measureStore.end);
      const hasContent =
        !!mask || !!pending || hasCrop || hasPolyVerts || hasMeasure;
      if (!hasContent && idleCleared) return;

      const overlay = overlayRef.current;
      const viewport = viewportRef.current;
      const wrapper = canvasWrapperRef.current;
      if (!overlay || !viewport || !wrapper) return;
      const ctx2d = overlay.getContext("2d");
      if (!ctx2d) return;

      // Resize the overlay to match the viewport's physical-pixel dimensions.
      const dpr = window.devicePixelRatio;
      const vw = Math.round(viewport.clientWidth * dpr);
      const vh = Math.round(viewport.clientHeight * dpr);
      if (overlay.width !== vw || overlay.height !== vh) {
        overlay.width = vw;
        overlay.height = vh;
      }

      // The overlay is an absolute child of the scrolling viewport, so it
      // scrolls along with the canvas content by default. Counteract that by
      // translating it back by the current scroll offset every frame — this
      // pins the overlay to the viewport in screen space, while keeping its
      // buffer viewport-sized (no clipping when zoomed-in content extends
      // past the visible area).
      const sx = viewport.scrollLeft;
      const sy = viewport.scrollTop;
      overlay.style.transform = `translate(${sx}px, ${sy}px)`;

      ctx2d.clearRect(0, 0, overlay.width, overlay.height);
      idleCleared = !hasContent;
      if (!hasContent) return;

      // Map from image-pixel coordinates to overlay physical-pixel coordinates.
      // getBoundingClientRect returns CSS pixels; multiply by dpr for physical px.
      // zoom = physical pixels per image pixel (zoom factor in Verve).
      // The overlay is translated above to compensate for scroll, so the
      // viewport-relative offset (wRect.left - vRect.left) is the correct
      // origin in overlay-local pixel space.
      const vRect = viewport.getBoundingClientRect();
      const wRect = wrapper.getBoundingClientRect();
      const originX = (wRect.left - vRect.left) * dpr;
      const originY = (wRect.top - vRect.top) * dpr;
      const zoom = zoomRef.current; // physical px per image px

      const toX = (ix: number): number => originX + ix * zoom;
      const toY = (iy: number): number => originY + iy * zoom;

      // All sizes below are in physical pixels (canvas is physical-pixel-sized).
      const DASH = ANT_DASH; // dash length, physical px

      // ── Selection marching ants ──────────────────────────────────────────
      // The ant pattern is anchored to a single global screen-space grid
      // (horizontal edges by x, vertical edges by y). Ant size is constant
      // (DASH px) regardless of zoom — fewer ants when zoomed out, more when
      // zoomed in. See AntsRenderer: cost per frame is independent of the
      // segment count.
      if (borderSegments && borderSegments.length > 0) {
        dashOffset = (dashOffset + 0.5) % (DASH * 2);
        ants.draw(ctx2d, borderSegments, zoom, originX, originY, dashOffset);
      }

      // ── Pending drag preview ─────────────────────────────────────────────
      if (pending) {
        ctx2d.strokeStyle = "#00aaff";
        ctx2d.lineWidth = 1;
        ctx2d.setLineDash([4, 2]);
        ctx2d.lineDashOffset = 0;
        ctx2d.beginPath();
        if (pending.type === "rect") {
          const { x1, y1, x2, y2 } = pending;
          ctx2d.rect(
            toX(Math.min(x1, x2)),
            toY(Math.min(y1, y2)),
            Math.abs(x2 - x1) * zoom,
            Math.abs(y2 - y1) * zoom,
          );
        } else {
          const pts = pending.points;
          if (pts.length > 1) {
            ctx2d.moveTo(toX(pts[0].x), toY(pts[0].y));
            for (let i = 1; i < pts.length; i++)
              ctx2d.lineTo(toX(pts[i].x), toY(pts[i].y));
          }
        }
        ctx2d.stroke();
      }

      // ── Crop overlay ─────────────────────────────────────────────────────
      const cp = activeScope().crop.pendingRect;
      const cr = activeScope().crop.rect;
      if (cp) {
        ctx2d.strokeStyle = "#ff9900";
        ctx2d.lineWidth = 1;
        ctx2d.setLineDash([4, 2]);
        ctx2d.lineDashOffset = 0;
        ctx2d.strokeRect(
          toX(Math.min(cp.x1, cp.x2)),
          toY(Math.min(cp.y1, cp.y2)),
          Math.abs(cp.x2 - cp.x1) * zoom,
          Math.abs(cp.y2 - cp.y1) * zoom,
        );
      } else if (cr) {
        dashOffset = (dashOffset + 0.5) % (DASH * 2);
        ctx2d.lineWidth = 1;
        ctx2d.setLineDash([DASH, DASH]);
        for (const [color, extra] of [
          ["#000000", 0],
          ["#ff9900", DASH],
        ] as [string, number][]) {
          ctx2d.strokeStyle = color;
          ctx2d.lineDashOffset = dashOffset + extra;
          ctx2d.strokeRect(toX(cr.x), toY(cr.y), cr.w * zoom, cr.h * zoom);
        }
      }

      // ── Measure tool overlay ─────────────────────────────────────────────
      if (hasMeasure) {
        const { start, end, protractorEnd } = measureStore;
        if (start && end) {
          const dpr2 = dpr;
          const handleR = Math.max(3, (3.5 * dpr2));
          const drawLine = (a: typeof start, b: typeof start): void => {
            // Black under-stroke for legibility on light backgrounds.
            ctx2d.lineWidth = 3;
            ctx2d.strokeStyle = "rgba(0,0,0,0.7)";
            ctx2d.setLineDash([]);
            ctx2d.beginPath();
            ctx2d.moveTo(toX(a.x), toY(a.y));
            ctx2d.lineTo(toX(b.x), toY(b.y));
            ctx2d.stroke();
            // White top stroke.
            ctx2d.lineWidth = 1;
            ctx2d.strokeStyle = "#ffffff";
            ctx2d.beginPath();
            ctx2d.moveTo(toX(a.x), toY(a.y));
            ctx2d.lineTo(toX(b.x), toY(b.y));
            ctx2d.stroke();
          };
          const drawHandle = (p: typeof start): void => {
            ctx2d.beginPath();
            ctx2d.arc(toX(p.x), toY(p.y), handleR, 0, Math.PI * 2);
            ctx2d.fillStyle = "#ffffff";
            ctx2d.fill();
            ctx2d.lineWidth = 1;
            ctx2d.strokeStyle = "#000000";
            ctx2d.stroke();
          };
          drawLine(start, end);
          if (protractorEnd) drawLine(start, protractorEnd);
          drawHandle(start);
          drawHandle(end);
          if (protractorEnd) drawHandle(protractorEnd);
        }
      }

      // ── Polygonal selection tool overlay ─────────────────────────────────
      if (hasPolyVerts) {
        const { vertices, cursor, nearClose } = activeScope().polygonalSelection;

        // 1. Black backing stroke on committed segments
        if (vertices.length >= 2) {
          ctx2d.strokeStyle = "rgba(0,0,0,0.8)";
          ctx2d.lineWidth = 3;
          ctx2d.setLineDash([]);
          ctx2d.beginPath();
          ctx2d.moveTo(toX(vertices[0].x), toY(vertices[0].y));
          for (let i = 1; i < vertices.length; i++)
            ctx2d.lineTo(toX(vertices[i].x), toY(vertices[i].y));
          ctx2d.stroke();

          // 2. White top stroke
          ctx2d.strokeStyle = "white";
          ctx2d.lineWidth = 1.5;
          ctx2d.setLineDash([]);
          ctx2d.beginPath();
          ctx2d.moveTo(toX(vertices[0].x), toY(vertices[0].y));
          for (let i = 1; i < vertices.length; i++)
            ctx2d.lineTo(toX(vertices[i].x), toY(vertices[i].y));
          ctx2d.stroke();
        }

        // 3. Rubber-band from last vertex to cursor
        ctx2d.strokeStyle = "rgba(42, 113, 255, 0.8)";
        ctx2d.lineWidth = 1;
        ctx2d.setLineDash([4, 3]);
        ctx2d.lineDashOffset = 0;
        ctx2d.beginPath();
        ctx2d.moveTo(
          toX(vertices[vertices.length - 1].x),
          toY(vertices[vertices.length - 1].y),
        );
        ctx2d.lineTo(toX(cursor.x), toY(cursor.y));
        ctx2d.stroke();
        ctx2d.setLineDash([]);

        // 4. Vertex dots
        for (const v of vertices) {
          ctx2d.beginPath();
          ctx2d.arc(toX(v.x), toY(v.y), 4, 0, Math.PI * 2);
          ctx2d.fillStyle = "white";
          ctx2d.fill();
          ctx2d.strokeStyle = "rgba(0,0,0,0.8)";
          ctx2d.lineWidth = 1.5;
          ctx2d.setLineDash([]);
          ctx2d.stroke();
        }

        // 5. Close-snap ring on origin vertex
        if (nearClose) {
          ctx2d.lineWidth = 2;
          ctx2d.strokeStyle = "#ffffff";
          ctx2d.beginPath();
          ctx2d.arc(toX(vertices[0].x), toY(vertices[0].y), 7, 0, Math.PI * 2);
          ctx2d.stroke();
        }
      }
    };

    rafId = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(rafId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isActive]);
}
