// ─── Transform store ──────────────────────────────────────────────────────────
// Module-level singleton. The transform tool, Canvas overlay, and TransformToolbar
// all import this directly; useTransform registers onApply/onCancel callbacks.

import type {
  Tool,
  TransformParams,
  TransformInterpolation,
  TransformHandleMode,
} from "@/types";

export interface TransformEnterData {
  layerId: string;
  previousTool: Tool;
  isSelectionMode: boolean;
  originalW: number;
  originalH: number;
  originalRect: { x: number; y: number; w: number; h: number };
  floatBuffer: Uint8Array;
  floatCanvas: OffscreenCanvas;
  savedLayerPixels: Uint8Array | null;
  savedSelectionMask: Uint8Array | null;
  params: TransformParams;
}

type Listener = () => void;

class TransformStore {
  isActive: boolean = false;
  layerId: string = "";
  previousTool: Tool = "pencil";
  isSelectionMode: boolean = false;

  originalW: number = 0;
  originalH: number = 0;
  originalRect: { x: number; y: number; w: number; h: number } = {
    x: 0,
    y: 0,
    w: 0,
    h: 0,
  };

  floatBuffer: Uint8Array | null = null;
  floatCanvas: OffscreenCanvas | null = null;

  savedLayerPixels: Uint8Array | null = null;
  savedSelectionMask: Uint8Array | null = null;

  params: TransformParams = {
    x: 0,
    y: 0,
    w: 0,
    h: 0,
    rotation: 0,
    pivotX: 0,
    pivotY: 0,
    shearX: 0,
    shearY: 0,
    perspectiveCorners: null,
  };

  aspectLocked: boolean = false;
  handleMode: TransformHandleMode = "scale";
  interpolation: TransformInterpolation = "bilinear";

  onApply: (() => void) | null = null;
  onCancel: (() => void) | null = null;

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

  enter(data: TransformEnterData): void {
    this.isActive = true;
    this.layerId = data.layerId;
    this.previousTool = data.previousTool;
    this.isSelectionMode = data.isSelectionMode;
    this.originalW = data.originalW;
    this.originalH = data.originalH;
    this.originalRect = data.originalRect;
    this.floatBuffer = data.floatBuffer;
    this.floatCanvas = data.floatCanvas;
    this.savedLayerPixels = data.savedLayerPixels;
    this.savedSelectionMask = data.savedSelectionMask;
    this.params = data.params;
    this.aspectLocked = false;
    this.handleMode = "scale";
    this.interpolation = "bilinear";
    this.notify();
  }

  updateParams(partial: Partial<TransformParams>): void {
    this.params = { ...this.params, ...partial };
    this.notify();
  }

  clear(): void {
    this.isActive = false;
    this.layerId = "";
    this.floatBuffer = null;
    this.floatCanvas = null;
    this.savedLayerPixels = null;
    this.savedSelectionMask = null;
    this.onApply = null;
    this.onCancel = null;
    this.notify();
  }

  triggerApply(): void {
    this.onApply?.();
  }
  triggerCancel(): void {
    this.onCancel?.();
  }
}

export const transformStore = new TransformStore();
