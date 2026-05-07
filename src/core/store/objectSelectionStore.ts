import type { PromptPoint, SAMBoundingBox } from "@/types";

// ─── Types ────────────────────────────────────────────────────────────────────

export type ModelStatus = "unknown" | "checking" | "ready" | "error";
export type MattingModelStatus =
  | "unknown"
  | "checking"
  | "downloading"
  | "ready"
  | "error";
export type PromptMode = "rect" | "point";
export type InferenceStatus = "idle" | "running" | "error";

type Listener = () => void;

// ─── Store ────────────────────────────────────────────────────────────────────

class ObjectSelectionStore {
  // ── Model status ────────────────────────────────────────────────────────────
  modelStatus: ModelStatus = "unknown";
  modelError: string | null = null;

  // ── Refine Edge (alpha matting) status ──────────────────────────────────────
  mattingModelStatus: MattingModelStatus = "unknown";
  mattingDownloadProgress: {
    progress: number;
    loaded: number;
    total: number;
  } | null = null;
  mattingModelError: string | null = null;
  refineStatus: InferenceStatus = "idle";

  // ── Session state ────────────────────────────────────────────────────────────
  promptMode: PromptMode = "rect";
  points: PromptPoint[] = [];
  dragRect: SAMBoundingBox | null = null;
  isDragging = false;

  // ── Inference state ──────────────────────────────────────────────────────────
  inferenceStatus: InferenceStatus = "idle";
  /** Upsampled canvas-sized soft mask from the last successful decode. */
  pendingMask: Uint8Array | null = null;
  /**
   * When true the pendingMask has already been through Refine Edge and its
   * alpha values should be committed as-is (no extra feather/antiAlias pass).
   */
  pendingMaskRefined = false;

  // ── Cache version (bumped to force re-encode on next inference) ──────────────
  cacheVersion = 0;

  private listeners = new Set<Listener>();

  subscribe(fn: Listener): void {
    this.listeners.add(fn);
  }
  unsubscribe(fn: Listener): void {
    this.listeners.delete(fn);
  }
  notify(): void {
    for (const fn of this.listeners) fn();
  }

  reset(): void {
    this.points = [];
    this.dragRect = null;
    this.isDragging = false;
    this.inferenceStatus = "idle";
    this.pendingMask = null;
    this.pendingMaskRefined = false;
    this.notify();
  }

  setDragRect(x1: number, y1: number, x2: number, y2: number): void {
    this.dragRect = { x1, y1, x2, y2 };
    this.isDragging = true;
    this.notify();
  }

  endDrag(): void {
    this.isDragging = false;
    this.notify();
  }

  addPoint(p: PromptPoint): void {
    this.points = [...this.points, p];
    this.notify();
  }

  removeLastPoint(): void {
    this.points = this.points.slice(0, -1);
    this.notify();
  }

  invalidateCache(): void {
    this.cacheVersion++;
    this.pendingMask = null;
  }
}

export const objectSelectionStore = new ObjectSelectionStore();
