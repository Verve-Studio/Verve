// ─── Selection store ──────────────────────────────────────────────────────────
// Module-level singleton. Tools and the canvas overlay both import this directly.

export type SelectionMode = "set" | "add" | "subtract" | "intersect";

/**
 * PendingSelection represents a live drag preview that hasn't been committed
 * to the mask yet. Stored as lightweight geometry so we don't allocate a fresh
 * Uint8Array on every pointer-move event.
 */
export type PendingSelection =
  | { type: "rect"; x1: number; y1: number; x2: number; y2: number }
  | { type: "path"; points: { x: number; y: number }[] };

type Listener = () => void;

export class SelectionStore {
  /** Committed mask: 1 = selected, 0 = not selected. null = nothing selected. */
  mask: Uint8Array | null = null;
  /** In-progress drag — drawn as a preview outline by the overlay. */
  pending: PendingSelection | null = null;
  /**
   * Pre-computed border segments in pixel-space coords [x0,y0,x1,y1,...].
   * Cached so the RAF loop doesn't recompute every frame.
   */
  borderSegments: Float32Array | null = null;

  width = 0;
  height = 0;

  private listeners = new Set<Listener>();

  // ── Lifecycle ───────────────────────────────────────────────────────────────

  setDimensions(w: number, h: number): void {
    this.width = w;
    this.height = h;
    this.mask = null;
    this.pending = null;
    this.borderSegments = null;
  }

  subscribe(fn: Listener): void {
    this.listeners.add(fn);
  }
  unsubscribe(fn: Listener): void {
    this.listeners.delete(fn);
  }
  private notify(): void {
    for (const fn of this.listeners) fn();
  }

  /** Restore a previously saved mask buffer (used by transform cancel). */
  restoreMask(mask: Uint8Array): void {
    this.mask = mask;
    this.pending = null;
    this.borderSegments = null;
    this.notify();
  }

  clear(): void {
    this.mask = null;
    this.pending = null;
    this.borderSegments = null;
    this.notify();
  }

  hasSelection(): boolean {
    return this.mask !== null;
  }

  isPixelSelected(x: number, y: number): boolean {
    if (!this.mask) return true; // no selection ↔ everything is selected
    return this.mask[y * this.width + x] !== 0;
  }

  // ── Pending (live drag preview) ─────────────────────────────────────────────

  setPending(p: PendingSelection | null): void {
    this.pending = p;
    this.notify();
  }

  // ── Commit operations ───────────────────────────────────────────────────────

  setRect(
    x1: number,
    y1: number,
    x2: number,
    y2: number,
    mode: SelectionMode = "set",
    feather = 0,
  ): void {
    const { width: w, height: h } = this;
    const lx = Math.max(0, Math.min(x1, x2));
    const ly = Math.max(0, Math.min(y1, y2));
    const rx = Math.min(w - 1, Math.max(x1, x2));
    const ry = Math.min(h - 1, Math.max(y1, y2));

    this.pending = null;

    if (lx > rx || ly > ry) {
      if (mode === "set") {
        this.mask = null;
        this.borderSegments = null;
      }
      this.notify();
      return;
    }

    const m = new Uint8Array(w * h);
    for (let y = ly; y <= ry; y++) {
      m.fill(255, y * w + lx, y * w + rx + 1);
    }
    if (feather > 0) this.applyFeather(m, feather);

    this.applyMask(m, mode);
    this.notify();
  }

  setPolygon(
    points: { x: number; y: number }[],
    mode: SelectionMode = "set",
    feather = 0,
    antiAlias = false,
  ): void {
    const { width: w, height: h } = this;
    this.pending = null;

    if (points.length < 3) {
      if (mode === "set") {
        this.mask = null;
        this.borderSegments = null;
      }
      this.notify();
      return;
    }

    const m = new Uint8Array(w * h);
    const minY = Math.max(0, Math.floor(Math.min(...points.map((p) => p.y))));
    const maxY = Math.min(
      h - 1,
      Math.floor(Math.max(...points.map((p) => p.y))),
    );
    const n = points.length;

    for (let y = minY; y <= maxY; y++) {
      const xs: number[] = [];
      for (let i = 0; i < n; i++) {
        const j = (i + 1) % n;
        const { x: ax, y: ay } = points[i];
        const { x: bx, y: by } = points[j];
        if ((ay <= y && by > y) || (by <= y && ay > y)) {
          xs.push(ax + ((y - ay) / (by - ay)) * (bx - ax));
        }
      }
      xs.sort((a, b) => a - b);
      for (let k = 0; k + 1 < xs.length; k += 2) {
        if (antiAlias) {
          const xL = xs[k];
          const xR = xs[k + 1];
          const iL = Math.max(0, Math.floor(xL));
          const iR = Math.min(w - 1, Math.floor(xR));
          for (let x = iL; x <= iR; x++) {
            const covL = Math.max(x, xL);
            const covR = Math.min(x + 1, xR);
            const alpha = Math.round(Math.max(0, covR - covL) * 255);
            const idx = y * w + x;
            if (alpha > m[idx]) m[idx] = alpha;
          }
        } else {
          const lx2 = Math.max(0, Math.floor(xs[k]));
          const rx2 = Math.min(w - 1, Math.ceil(xs[k + 1]));
          if (lx2 <= rx2) m.fill(255, y * w + lx2, y * w + rx2 + 1);
        }
      }
    }
    if (feather > 0) this.applyFeather(m, feather);

    this.applyMask(m, mode);
    this.notify();
  }

  floodFillSelect(
    sx: number,
    sy: number,
    layerData: Uint8Array,
    tolerance: number,
    contiguous: boolean,
    mode: SelectionMode = "set",
    feather = 0,
    dilation = 0,
    antiAlias = false,
  ): void {
    const { width: w, height: h } = this;
    if (sx < 0 || sx >= w || sy < 0 || sy >= h) return;

    const m = new Uint8Array(w * h);
    const bi = (sy * w + sx) * 4;
    const [br, bg, bb, ba] = [
      layerData[bi],
      layerData[bi + 1],
      layerData[bi + 2],
      layerData[bi + 3],
    ];

    const diff = (pi: number): number => {
      const i = pi * 4;
      return (
        (Math.abs(layerData[i] - br) +
          Math.abs(layerData[i + 1] - bg) +
          Math.abs(layerData[i + 2] - bb) +
          Math.abs(layerData[i + 3] - ba)) /
        4
      );
    };

    if (contiguous) {
      // BFS flood fill from clicked point
      const visited = new Uint8Array(w * h);
      const base = sy * w + sx;
      visited[base] = 1;
      const stack: number[] = [base];

      if (antiAlias) {
        const AA_ZONE = 32;
        while (stack.length > 0) {
          const idx = stack.pop()!;
          const d = diff(idx);
          if (d > tolerance + AA_ZONE) continue;
          if (d > tolerance) {
            m[idx] = Math.round((1 - (d - tolerance) / AA_ZONE) * 255);
            continue;
          }
          m[idx] = 255;
          const x = idx % w;
          const y = (idx / w) | 0;
          if (x > 0 && !visited[idx - 1]) {
            visited[idx - 1] = 1;
            stack.push(idx - 1);
          }
          if (x < w - 1 && !visited[idx + 1]) {
            visited[idx + 1] = 1;
            stack.push(idx + 1);
          }
          if (y > 0 && !visited[idx - w]) {
            visited[idx - w] = 1;
            stack.push(idx - w);
          }
          if (y < h - 1 && !visited[idx + w]) {
            visited[idx + w] = 1;
            stack.push(idx + w);
          }
        }
      } else {
        while (stack.length > 0) {
          const idx = stack.pop()!;
          if (diff(idx) > tolerance) continue;
          m[idx] = 255;
          const x = idx % w;
          const y = (idx / w) | 0;
          if (x > 0 && !visited[idx - 1]) {
            visited[idx - 1] = 1;
            stack.push(idx - 1);
          }
          if (x < w - 1 && !visited[idx + 1]) {
            visited[idx + 1] = 1;
            stack.push(idx + 1);
          }
          if (y > 0 && !visited[idx - w]) {
            visited[idx - w] = 1;
            stack.push(idx - w);
          }
          if (y < h - 1 && !visited[idx + w]) {
            visited[idx + w] = 1;
            stack.push(idx + w);
          }
        }
      }
    } else {
      // Non-contiguous: select all pixels within tolerance anywhere on the layer
      if (antiAlias) {
        const AA_ZONE = 32;
        for (let i = 0; i < w * h; i++) {
          const d = diff(i);
          if (d <= tolerance) {
            m[i] = 255;
          } else if (d <= tolerance + AA_ZONE) {
            m[i] = Math.round((1 - (d - tolerance) / AA_ZONE) * 255);
          }
        }
      } else {
        for (let i = 0; i < w * h; i++) {
          if (diff(i) <= tolerance) m[i] = 255;
        }
      }
    }

    this.pending = null;
    if (dilation > 0) this.applyDilate(m, dilation);
    if (feather > 0) this.applyFeather(m, feather);
    this.applyMask(m, mode);
    this.notify();
  }

  setFromSAMMask(
    rawMask: Uint8Array,
    mode: SelectionMode = "set",
    feather = 0,
    antiAlias = true,
  ): void {
    this.pending = null;
    const m = new Uint8Array(rawMask);
    if (antiAlias && feather === 0) this.applyFeather(m, 1);
    if (feather > 0) this.applyFeather(m, feather);
    this.applyMask(m, mode);
    this.notify();
  }

  // ── Internals ───────────────────────────────────────────────────────────────

  /**
   * Morphological dilation: expand selected region by `radius` pixels (square kernel).
   * Each pixel takes the maximum value within the kernel neighborhood.
   */
  private applyDilate(mask: Uint8Array, radius: number): void {
    if (radius <= 0) return;
    const { width: w, height: h } = this;
    const r = Math.round(radius);
    const tmp = new Uint8Array(w * h);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        let maxV = 0;
        for (let dy = -r; dy <= r; dy++) {
          const ny = Math.max(0, Math.min(h - 1, y + dy));
          for (let dx = -r; dx <= r; dx++) {
            const nx = Math.max(0, Math.min(w - 1, x + dx));
            const v = mask[ny * w + nx];
            if (v > maxV) maxV = v;
          }
        }
        tmp[y * w + x] = maxV;
      }
    }
    mask.set(tmp);
  }

  /**
   * In-place separable Gaussian blur on a 0–255 mask.
   * Feather radius is in pixels; produces soft selection edges.
   */
  private applyFeather(mask: Uint8Array, radius: number): void {
    if (radius <= 0) return;
    const { width: w, height: h } = this;
    const r = Math.round(radius);
    const kSize = 2 * r + 1;
    const sigma = radius / 3 + 1;
    const twoSigSq = 2 * sigma * sigma;
    const k = new Float32Array(kSize);
    let kSum = 0;
    for (let i = 0; i < kSize; i++) {
      const d = i - r;
      k[i] = Math.exp(-(d * d) / twoSigSq);
      kSum += k[i];
    }
    for (let i = 0; i < kSize; i++) k[i] /= kSum;
    const tmp = new Float32Array(w * h);
    // Horizontal pass: mask → tmp
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        let v = 0;
        for (let ki = 0; ki < kSize; ki++) {
          const sx = Math.max(0, Math.min(w - 1, x + ki - r));
          v += mask[y * w + sx] * k[ki];
        }
        tmp[y * w + x] = v;
      }
    }
    // Vertical pass: tmp → mask
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        let v = 0;
        for (let ki = 0; ki < kSize; ki++) {
          const sy = Math.max(0, Math.min(h - 1, y + ki - r));
          v += tmp[sy * w + x] * k[ki];
        }
        mask[y * w + x] = Math.round(Math.min(255, Math.max(0, v)));
      }
    }
  }

  private applyMask(newMask: Uint8Array, mode: SelectionMode): void {
    if (mode === "set" || !this.mask) {
      this.mask = newMask;
    } else if (mode === "add") {
      // Union: take the stronger selection value
      for (let i = 0; i < newMask.length; i++) {
        if (newMask[i] > this.mask[i]) this.mask[i] = newMask[i];
      }
    } else if (mode === "intersect") {
      // Intersection: retain only pixels selected in both masks.
      // When there is no existing mask, intersect with "everything selected" → keep the new mask as-is.
      for (let i = 0; i < newMask.length; i++) {
        this.mask[i] = Math.min(this.mask[i], newMask[i]);
      }
      // If the result is entirely zero, treat as no selection.
      let any = false;
      for (let i = 0; i < this.mask.length; i++)
        if (this.mask[i]) {
          any = true;
          break;
        }
      if (!any) {
        this.mask = null;
        this.borderSegments = null;
        return;
      }
    } else {
      // Subtract: reduce by the subtracted strength
      for (let i = 0; i < this.mask.length; i++) {
        if (newMask[i]) this.mask[i] = Math.max(0, this.mask[i] - newMask[i]);
      }
      // If the entire mask is now zero, treat as no selection
      let any = false;
      for (let i = 0; i < this.mask.length; i++)
        if (this.mask[i]) {
          any = true;
          break;
        }
      if (!any) {
        this.mask = null;
        this.borderSegments = null;
        return;
      }
    }
    this.borderSegments = this.computeBorderSegments();
  }

  /**
   * Invert the current selection. Each mask byte becomes (255 - value).
   * When no selection exists (mask is null, meaning all selected), invert
   * results in nothing selected — equivalent to clearing. When the inverted
   * result is all-zero, the mask is also cleared.
   */
  invert(): void {
    const { width: w, height: h } = this;
    if (w === 0 || h === 0) return;
    if (this.mask === null) {
      // No active selection = implicitly all selected. Invert → nothing selected = clear.
      this.mask = null;
      this.borderSegments = null;
      this.notify();
      return;
    }
    for (let i = 0; i < this.mask.length; i++) {
      this.mask[i] = 255 - this.mask[i];
    }
    // Collapse all-zero result to null (nothing selected)
    let any = false;
    for (let i = 0; i < this.mask.length; i++)
      if (this.mask[i]) {
        any = true;
        break;
      }
    if (!any) {
      this.mask = null;
      this.borderSegments = null;
    } else {
      this.borderSegments = this.computeBorderSegments();
    }
    this.notify();
  }

  /**
   * Replace the current mask with a new one (e.g. after a move operation).
   * Recomputes border segments and notifies listeners.
   */
  replaceMask(newMask: Uint8Array | null): void {
    this.mask = newMask;
    this.borderSegments = newMask ? this.computeBorderSegments() : null;
    this.pending = null;
    this.notify();
  }

  /**
   * Translate the current mask by (dx, dy) pixels.
   * Pixels shifted outside canvas bounds are dropped.
   */
  translateMask(dx: number, dy: number): void {
    if (!this.mask) return;
    const { width: w, height: h } = this;
    const shifted = new Uint8Array(w * h);
    for (let sy = 0; sy < h; sy++) {
      const dy2 = sy + dy;
      if (dy2 < 0 || dy2 >= h) continue;
      for (let sx = 0; sx < w; sx++) {
        const dx2 = sx + dx;
        if (dx2 < 0 || dx2 >= w) continue;
        shifted[dy2 * w + dx2] = this.mask[sy * w + sx];
      }
    }
    this.mask = shifted;
    this.borderSegments = this.computeBorderSegments();
    this.notify();
  }

  private computeBorderSegments(): Float32Array {
    const { mask, width: w, height: h } = this;
    if (!mask) return new Float32Array(0);

    const segs: number[] = [];

    // Horizontal boundary runs: scan each boundary row y (between row y-1 and y)
    for (let y = 0; y <= h; y++) {
      let runStart = -1;
      for (let x = 0; x <= w; x++) {
        const above =
          y > 0 && x < w ? (mask[(y - 1) * w + x] > 127 ? 1 : 0) : 0;
        const below = y < h && x < w ? (mask[y * w + x] > 127 ? 1 : 0) : 0;
        const boundary = above !== below;
        if (boundary && runStart < 0) {
          runStart = x;
        } else if (!boundary && runStart >= 0) {
          segs.push(runStart, y, x, y);
          runStart = -1;
        }
      }
    }

    // Vertical boundary runs: scan each boundary column x (between col x-1 and x)
    for (let x = 0; x <= w; x++) {
      let runStart = -1;
      for (let y = 0; y <= h; y++) {
        const left = x > 0 && y < h ? (mask[y * w + x - 1] > 127 ? 1 : 0) : 0;
        const right = x < w && y < h ? (mask[y * w + x] > 127 ? 1 : 0) : 0;
        const boundary = left !== right;
        if (boundary && runStart < 0) {
          runStart = y;
        } else if (!boundary && runStart >= 0) {
          segs.push(x, runStart, x, y);
          runStart = -1;
        }
      }
    }

    return new Float32Array(segs);
  }
}

export const selectionStore = new SelectionStore();
