// ─── Measure store ────────────────────────────────────────────────────────────
// Module-level singleton holding the live + committed measurement line(s) for
// the Measure tool. The marching-ants overlay reads this directly to draw the
// line on screen, and the tool's options bar subscribes to display X/Y/W/H/A
// readouts. Mirrors the activeScope().crop pattern.
//
// A measurement consists of:
//   • a primary line (start → end), always present once a measurement has
//     been drawn;
//   • an optional second segment (start → protractorEnd) that turns the
//     measurement into a "protractor" — measuring the angle between the two
//     segments. Activated by alt-dragging from the existing start endpoint.

export interface Point {
  x: number;
  y: number;
}

type Listener = () => void;

class MeasureStore {
  start: Point | null = null;
  end: Point | null = null;
  /** When non-null the measurement is in protractor mode and this point is
   *  the far end of the second segment (the segment shares the `start`
   *  vertex with the primary line). */
  protractorEnd: Point | null = null;

  private listeners = new Set<Listener>();

  subscribe(fn: Listener): void {
    this.listeners.add(fn);
  }
  unsubscribe(fn: Listener): void {
    this.listeners.delete(fn);
  }
  private notify(): void {
    for (const fn of this.listeners) fn();
  }

  setLine(start: Point, end: Point): void {
    this.start = start;
    this.end = end;
    this.protractorEnd = null;
    this.notify();
  }

  setProtractorEnd(p: Point | null): void {
    this.protractorEnd = p;
    this.notify();
  }

  clear(): void {
    this.start = null;
    this.end = null;
    this.protractorEnd = null;
    this.notify();
  }

  hasMeasurement(): boolean {
    return this.start !== null && this.end !== null;
  }
}

export const measureStore = new MeasureStore();
