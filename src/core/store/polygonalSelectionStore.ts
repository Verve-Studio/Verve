import type { Point } from "@/types";
import { activeScope } from "./scope";
import type { SelectionMode } from "./selectionStore";

type Listener = () => void;

const listeners = new Set<Listener>();

export class PolygonalSelectionStore {
  vertices: Point[] = [];
  cursor: Point = { x: 0, y: 0 };
  nearClose = false;
  lockedMode: SelectionMode = "set";

  get isActive(): boolean {
    return this.vertices.length > 0;
  }

  subscribe(fn: Listener): void {
    listeners.add(fn);
  }
  unsubscribe(fn: Listener): void {
    listeners.delete(fn);
  }
  notify(): void {
    for (const fn of listeners) fn();
  }

  start(origin: Point, mode: SelectionMode): void {
    this.vertices = [origin];
    this.lockedMode = mode;
    this.nearClose = false;
    this.notify();
  }

  addVertex(p: Point): void {
    this.vertices = [...this.vertices, p];
    this.notify();
  }

  setCursor(p: Point, nearClose: boolean): void {
    this.cursor = p;
    this.nearClose = nearClose;
    this.notify();
  }

  commit(feather = 0, antiAlias = false): void {
    if (this.vertices.length >= 3) {
      activeScope().selection.setPolygon(
        this.vertices,
        this.lockedMode,
        feather,
        antiAlias,
      );
    }
    this.reset();
  }

  cancel(): void {
    this.reset();
    activeScope().selection.setPending(null);
  }

  removeLastVertex(): void {
    if (this.vertices.length <= 1) {
      this.cancel();
      return;
    }
    this.vertices = this.vertices.slice(0, -1);
    this.notify();
  }

  private reset(): void {
    this.vertices = [];
    this.nearClose = false;
    this.notify();
  }
}
