import type { AppAction } from "@/core/store/AppContext";
import type { AppState } from "@/types";
import type { GpuLayer } from "@/graphics/webgpu/rendering/WebGPURenderer";
import type { CanvasHandle } from "@/ux/main/Canvas/Canvas";
import { buildClusters, buildRootLayerIds } from "@/utils/layerTree";
import type { Dispatch, MutableRefObject } from "react";
import { useCallback } from "react";

// ─── Types ────────────────────────────────────────────────────────────────────

export type AlignEdge =
  | "left"
  | "centerV"
  | "right"
  | "top"
  | "centerH"
  | "bottom";
export type DistributeAxis = "horizontal" | "vertical";
export type OrderOp = "front" | "back" | "forward" | "backward" | "reverse";

export interface UseLayerArrangeReturn {
  handleAlign: (edge: AlignEdge) => void;
  handleDistribute: (axis: DistributeAxis) => void;
  handleOrder: (op: OrderOp) => void;
}

interface UseLayerArrangeOptions {
  canvasHandleRef: { readonly current: CanvasHandle | null };
  stateRef: MutableRefObject<AppState>;
  captureHistory: (label: string) => void;
  dispatch: Dispatch<AppAction>;
}

// ─── Bbox helper ─────────────────────────────────────────────────────────────

/** Canvas-space non-transparent bounding box for a GpuLayer. Returns null if fully transparent. */
function computeCanvasBbox(
  layer: GpuLayer,
): { l: number; t: number; r: number; b: number } | null {
  const {
    data,
    format,
    layerWidth: lw,
    layerHeight: lh,
    offsetX: ox,
    offsetY: oy,
  } = layer;
  let minX = lw,
    minY = lh,
    maxX = -1,
    maxY = -1;

  if (format === "indexed8") {
    const u = data as Uint8Array;
    for (let y = 0; y < lh; y++) {
      for (let x = 0; x < lw; x++) {
        if (u[y * lw + x] !== 255) {
          if (x < minX) minX = x;
          if (x > maxX) maxX = x;
          if (y < minY) minY = y;
          if (y > maxY) maxY = y;
        }
      }
    }
  } else if (format === "rgba32f") {
    const f = data as Float32Array;
    for (let y = 0; y < lh; y++) {
      for (let x = 0; x < lw; x++) {
        if (f[(y * lw + x) * 4 + 3] > 1 / 255) {
          if (x < minX) minX = x;
          if (x > maxX) maxX = x;
          if (y < minY) minY = y;
          if (y > maxY) maxY = y;
        }
      }
    }
  } else {
    const u = data as Uint8Array;
    for (let y = 0; y < lh; y++) {
      for (let x = 0; x < lw; x++) {
        if (u[(y * lw + x) * 4 + 3] > 0) {
          if (x < minX) minX = x;
          if (x > maxX) maxX = x;
          if (y < minY) minY = y;
          if (y > maxY) maxY = y;
        }
      }
    }
  }

  if (maxX === -1) return null;
  return { l: ox + minX, t: oy + minY, r: ox + maxX, b: oy + maxY };
}

// ─── Hook ─────────────────────────────────────────────────────────────────────

export function useLayerArrange({
  canvasHandleRef,
  stateRef,
  captureHistory,
  dispatch,
}: UseLayerArrangeOptions): UseLayerArrangeReturn {
  /** Returns the set of layer IDs to operate on. Falls back to all layers when nothing is selected. */
  const getEffectiveIds = useCallback((): Set<string> => {
    const { layers, selectedLayerIds, activeLayerId } = stateRef.current;
    const ids = new Set(selectedLayerIds);
    if (activeLayerId) ids.add(activeLayerId);
    if (ids.size === 0) {
      for (const l of layers) ids.add(l.id);
    }
    return ids;
  }, [stateRef]);

  // ── Align ────────────────────────────────────────────────────────────────────

  const handleAlign = useCallback(
    (edge: AlignEdge): void => {
      const handle = canvasHandleRef.current;
      if (!handle) return;
      const { layers } = stateRef.current;
      const ids = getEffectiveIds();

      type LayerInfo = {
        gpuLayer: GpuLayer;
        bbox: NonNullable<ReturnType<typeof computeCanvasBbox>>;
      };
      const infos: LayerInfo[] = [];
      for (const l of layers) {
        if (!ids.has(l.id)) continue;
        const gpuLayer = handle.getGpuLayer(l.id);
        if (!gpuLayer) continue;
        const bbox = computeCanvasBbox(gpuLayer);
        if (!bbox) continue;
        infos.push({ gpuLayer, bbox });
      }
      if (infos.length < 2) return;

      let anchorX = 0,
        anchorY = 0;
      switch (edge) {
        case "left":
          anchorX = Math.min(...infos.map((i) => i.bbox.l));
          break;
        case "right":
          anchorX = Math.max(...infos.map((i) => i.bbox.r));
          break;
        case "centerV":
          anchorX = Math.round(
            (Math.min(...infos.map((i) => i.bbox.l)) +
              Math.max(...infos.map((i) => i.bbox.r))) /
              2,
          );
          break;
        case "top":
          anchorY = Math.min(...infos.map((i) => i.bbox.t));
          break;
        case "bottom":
          anchorY = Math.max(...infos.map((i) => i.bbox.b));
          break;
        case "centerH":
          anchorY = Math.round(
            (Math.min(...infos.map((i) => i.bbox.t)) +
              Math.max(...infos.map((i) => i.bbox.b))) /
              2,
          );
          break;
      }

      captureHistory("Before Align");
      for (const { gpuLayer, bbox } of infos) {
        switch (edge) {
          case "left":
            gpuLayer.offsetX += anchorX - bbox.l;
            break;
          case "right":
            gpuLayer.offsetX += anchorX - bbox.r;
            break;
          case "centerV":
            gpuLayer.offsetX += anchorX - Math.round((bbox.l + bbox.r) / 2);
            break;
          case "top":
            gpuLayer.offsetY += anchorY - bbox.t;
            break;
          case "bottom":
            gpuLayer.offsetY += anchorY - bbox.b;
            break;
          case "centerH":
            gpuLayer.offsetY += anchorY - Math.round((bbox.t + bbox.b) / 2);
            break;
        }
      }
      handle.invalidate();
    },
    [canvasHandleRef, stateRef, captureHistory, getEffectiveIds],
  );

  // ── Distribute ───────────────────────────────────────────────────────────────

  const handleDistribute = useCallback(
    (axis: DistributeAxis): void => {
      const handle = canvasHandleRef.current;
      if (!handle) return;
      const { layers } = stateRef.current;
      const ids = getEffectiveIds();

      type LayerInfo = {
        gpuLayer: GpuLayer;
        bbox: NonNullable<ReturnType<typeof computeCanvasBbox>>;
      };
      const infos: LayerInfo[] = [];
      for (const l of layers) {
        if (!ids.has(l.id)) continue;
        const gpuLayer = handle.getGpuLayer(l.id);
        if (!gpuLayer) continue;
        const bbox = computeCanvasBbox(gpuLayer);
        if (!bbox) continue;
        infos.push({ gpuLayer, bbox });
      }
      if (infos.length < 3) return;

      captureHistory("Before Distribute");
      if (axis === "horizontal") {
        infos.sort((a, b) => a.bbox.l + a.bbox.r - (b.bbox.l + b.bbox.r));
        const firstCenter = (infos[0].bbox.l + infos[0].bbox.r) / 2;
        const lastCenter =
          (infos[infos.length - 1].bbox.l + infos[infos.length - 1].bbox.r) / 2;
        const step = (lastCenter - firstCenter) / (infos.length - 1);
        for (let i = 1; i < infos.length - 1; i++) {
          const { gpuLayer, bbox } = infos[i];
          const targetCenter = firstCenter + i * step;
          gpuLayer.offsetX += Math.round(targetCenter - (bbox.l + bbox.r) / 2);
        }
      } else {
        infos.sort((a, b) => a.bbox.t + a.bbox.b - (b.bbox.t + b.bbox.b));
        const firstCenter = (infos[0].bbox.t + infos[0].bbox.b) / 2;
        const lastCenter =
          (infos[infos.length - 1].bbox.t + infos[infos.length - 1].bbox.b) / 2;
        const step = (lastCenter - firstCenter) / (infos.length - 1);
        for (let i = 1; i < infos.length - 1; i++) {
          const { gpuLayer, bbox } = infos[i];
          const targetCenter = firstCenter + i * step;
          gpuLayer.offsetY += Math.round(targetCenter - (bbox.t + bbox.b) / 2);
        }
      }
      handle.invalidate();
    },
    [canvasHandleRef, stateRef, captureHistory, getEffectiveIds],
  );

  // ── Order ─────────────────────────────────────────────────────────────────────

  const handleOrder = useCallback(
    (op: OrderOp): void => {
      const { layers } = stateRef.current;
      const ids = getEffectiveIds();

      // Filter effective IDs to root layers only — children/masks/adjustments travel with their parent cluster.
      const rootIds = new Set(buildRootLayerIds(layers));
      const selectedRootIds = new Set([...ids].filter((id) => rootIds.has(id)));
      if (selectedRootIds.size === 0) return;

      const { clusters, remaining } = buildClusters(layers);

      const isSel = (c: (typeof clusters)[number]): boolean =>
        selectedRootIds.has(c[0].id);

      let newClusters: typeof clusters;

      switch (op) {
        case "front": {
          newClusters = [
            ...clusters.filter((c) => !isSel(c)),
            ...clusters.filter(isSel),
          ];
          break;
        }
        case "back": {
          newClusters = [
            ...clusters.filter(isSel),
            ...clusters.filter((c) => !isSel(c)),
          ];
          break;
        }
        case "forward": {
          newClusters = [...clusters];
          // Iterate top-to-bottom (high index first) so each selected cluster moves up once.
          for (let i = newClusters.length - 2; i >= 0; i--) {
            if (isSel(newClusters[i]) && !isSel(newClusters[i + 1])) {
              [newClusters[i], newClusters[i + 1]] = [
                newClusters[i + 1],
                newClusters[i],
              ];
            }
          }
          break;
        }
        case "backward": {
          newClusters = [...clusters];
          // Iterate bottom-to-top (low index first) so each selected cluster moves down once.
          for (let i = 1; i < newClusters.length; i++) {
            if (isSel(newClusters[i]) && !isSel(newClusters[i - 1])) {
              [newClusters[i], newClusters[i - 1]] = [
                newClusters[i - 1],
                newClusters[i],
              ];
            }
          }
          break;
        }
        case "reverse": {
          newClusters = [...clusters];
          const selIdxs = newClusters
            .map((c, i) => (isSel(c) ? i : -1))
            .filter((i) => i >= 0);
          const selClusters = selIdxs.map((i) => newClusters[i]);
          for (let i = 0; i < selIdxs.length; i++) {
            newClusters[selIdxs[i]] = selClusters[selClusters.length - 1 - i];
          }
          break;
        }
      }

      captureHistory("Before Reorder");
      dispatch({
        type: "REORDER_LAYERS",
        payload: [...newClusters.flat(), ...remaining],
      });
    },
    [stateRef, captureHistory, dispatch, getEffectiveIds],
  );

  return { handleAlign, handleDistribute, handleOrder };
}
