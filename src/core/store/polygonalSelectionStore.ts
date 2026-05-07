import type { Point } from "@/types";
import { selectionStore } from "./selectionStore";
import type { SelectionMode } from "./selectionStore";

type Listener = () => void;

class PolygonalSelectionStore {
  vertices: Point[] = [];
  cursor: Point = { x: 0, y: 0 };
  nearClose = false;
  lockedMode: SelectionMode = "set";

  private listeners = new Set<Listener>();

  get isActive(): boolean {
    return this.vertices.length > 0;
  }

  subscribe(fn: Listener): void {
    this.listeners.add(fn);
  }
  unsubscribe(fn: Listener): void {
    this.listeners.delete(fn);
  }
  notify(): void {
    for (const fn of this.listeners) fn();
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
      selectionStore.setPolygon(
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
    selectionStore.setPending(null);
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

export const polygonalSelectionStore = new PolygonalSelectionStore();
