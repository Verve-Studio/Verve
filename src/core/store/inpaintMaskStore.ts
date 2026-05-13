type Listener = () => void;

const listeners = new Set<Listener>();

/**
 * Per-document inpainting mask. The ObjectRemoval tool paints into this store
 * as the user strokes over the canvas; the overlay renderer subscribes for
 * redraws, and `useObjectRemoval` reads `mask` when the user clicks Apply.
 *
 * The mask is canvas-sized — same width × height as the document — with a
 * single byte per pixel (0 = leave alone, > 0 = inpaint). Brushes stamp
 * `255` into the mask; the overlay turns any non-zero pixel translucent red.
 */
export class InpaintMaskStore {
  mask: Uint8Array | null = null;
  width = 0;
  height = 0;

  subscribe(fn: Listener): void {
    listeners.add(fn);
  }
  unsubscribe(fn: Listener): void {
    listeners.delete(fn);
  }
  notify(): void {
    for (const fn of listeners) fn();
  }

  /** Allocate (or reallocate) the mask to match a canvas of the given size.
   *  No-op if dimensions already match. */
  ensureSize(width: number, height: number): void {
    if (this.mask && this.width === width && this.height === height) return;
    this.mask = new Uint8Array(width * height);
    this.width = width;
    this.height = height;
  }

  /** Returns true if any pixel is set. */
  hasMaskedPixels(): boolean {
    if (!this.mask) return false;
    for (let i = 0; i < this.mask.length; i++) {
      if (this.mask[i] > 0) return true;
    }
    return false;
  }

  /** Stamp a filled circle of value 255 centered at (cx, cy) with radius r,
   *  clipping at canvas bounds. Used by the brush handler on each pointer
   *  sample. Notifies once at the end. */
  stampCircle(cx: number, cy: number, r: number): void {
    if (!this.mask) return;
    const w = this.width;
    const h = this.height;
    const r2 = r * r;
    const x0 = Math.max(0, Math.floor(cx - r));
    const x1 = Math.min(w - 1, Math.ceil(cx + r));
    const y0 = Math.max(0, Math.floor(cy - r));
    const y1 = Math.min(h - 1, Math.ceil(cy + r));
    for (let y = y0; y <= y1; y++) {
      const dy = y - cy;
      const dy2 = dy * dy;
      for (let x = x0; x <= x1; x++) {
        const dx = x - cx;
        if (dx * dx + dy2 <= r2) {
          this.mask[y * w + x] = 255;
        }
      }
    }
    this.notify();
  }

  /** Stamp a thick line segment by stamping circles along it. Used to fill
   *  gaps between coalesced pointer samples that arrive far apart. */
  stampLine(x0: number, y0: number, x1: number, y1: number, r: number): void {
    if (!this.mask) return;
    const dx = x1 - x0;
    const dy = y1 - y0;
    const dist = Math.hypot(dx, dy);
    const step = Math.max(0.5, r * 0.5);
    const steps = Math.max(1, Math.ceil(dist / step));
    for (let i = 0; i <= steps; i++) {
      const t = i / steps;
      this.stampCircleSilent(x0 + dx * t, y0 + dy * t, r);
    }
    this.notify();
  }

  /** Internal helper used by `stampLine` so we don't notify per circle. */
  private stampCircleSilent(cx: number, cy: number, r: number): void {
    if (!this.mask) return;
    const w = this.width;
    const h = this.height;
    const r2 = r * r;
    const x0 = Math.max(0, Math.floor(cx - r));
    const x1 = Math.min(w - 1, Math.ceil(cx + r));
    const y0 = Math.max(0, Math.floor(cy - r));
    const y1 = Math.min(h - 1, Math.ceil(cy + r));
    for (let y = y0; y <= y1; y++) {
      const dy = y - cy;
      const dy2 = dy * dy;
      for (let x = x0; x <= x1; x++) {
        const dx = x - cx;
        if (dx * dx + dy2 <= r2) {
          this.mask[y * w + x] = 255;
        }
      }
    }
  }

  /** Erase the entire mask. Called on tool switch and after a successful
   *  inpainting commit. */
  clear(): void {
    if (this.mask) this.mask.fill(0);
    this.notify();
  }
}
