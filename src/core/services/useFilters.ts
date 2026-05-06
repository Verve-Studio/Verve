import type { AppAction } from "@/core/store/AppContext";
import type { AdjustmentType, AppState, FilterKey, LayerState } from "@/types";
import { isPixelLayer } from "@/types";
import type { CanvasHandle } from "@/ux/main/Canvas/canvasHandle";
import type { Dispatch, MutableRefObject } from "react";
import { useCallback, useMemo } from "react";

interface UseFiltersOptions {
  layers: LayerState[];
  activeLayerId: string | null;
  onOpenFilterDialog: (key: FilterKey) => void;
  onCreateFilterAdjLayer: (type: AdjustmentType) => void;
  canvasHandleRef: { readonly current: CanvasHandle | null };
  captureHistory: (label: string) => void;
  dispatch: Dispatch<AppAction>;
  stateRef: MutableRefObject<AppState>;
}

export interface UseFiltersReturn {
  isFiltersMenuEnabled: boolean;
  handleOpenGaussianBlur: () => void;
  handleOpenBoxBlur: () => void;
  handleOpenRadialBlur: () => void;
  handleOpenMotionBlur: () => void;
  handleOpenRemoveMotionBlur: () => void;
  handleSharpen: () => void;
  handleSharpenMore: () => void;
  handleOpenUnsharpMask: () => void;
  handleOpenSmartSharpen: () => void;
  handleOpenAddNoise: () => void;
  handleOpenFilmGrain: () => void;
  handleOpenLensBlur: () => void;
  handleOpenClouds: () => void;
  handleOpenMedianFilter: () => void;
  handleOpenBilateralFilter: () => void;
  handleOpenReduceNoise: () => void;
  handleOpenLensFlare: () => void;
  handleApplyLensFlare: (
    pixels: Uint8Array,
    width: number,
    height: number,
  ) => void;
  handleInstantFilter: (key: FilterKey) => void;
  handleOpenPixelate: () => void;
  handleOpenSeamlessTexture: () => void;
  handleOpenOffset: () => void;
}

export function useFilters({
  layers,
  activeLayerId,
  onOpenFilterDialog,
  onCreateFilterAdjLayer,
  canvasHandleRef,
  captureHistory,
  dispatch,
  stateRef,
}: UseFiltersOptions): UseFiltersReturn {
  const isFiltersMenuEnabled = useMemo(() => {
    const active = layers.find((l) => l.id === activeLayerId);
    if (active == null) return false;
    return isPixelLayer(active);
  }, [layers, activeLayerId]);

  const handleOpenGaussianBlur = useCallback(
    () => onCreateFilterAdjLayer("gaussian-blur"),
    [onCreateFilterAdjLayer],
  );

  const handleOpenBoxBlur = useCallback(
    () => onCreateFilterAdjLayer("box-blur"),
    [onCreateFilterAdjLayer],
  );

  const handleOpenRadialBlur = useCallback(
    () => onCreateFilterAdjLayer("radial-blur"),
    [onCreateFilterAdjLayer],
  );

  const handleOpenMotionBlur = useCallback(
    () => onCreateFilterAdjLayer("motion-blur"),
    [onCreateFilterAdjLayer],
  );

  const handleOpenRemoveMotionBlur = useCallback(
    () => onCreateFilterAdjLayer("remove-motion-blur"),
    [onCreateFilterAdjLayer],
  );

  const handleSharpen = useCallback((): void => {
    onCreateFilterAdjLayer("sharpen");
  }, [onCreateFilterAdjLayer]);

  const handleSharpenMore = useCallback((): void => {
    onCreateFilterAdjLayer("sharpen-more");
  }, [onCreateFilterAdjLayer]);

  const handleOpenUnsharpMask = useCallback(
    () => onCreateFilterAdjLayer("unsharp-mask"),
    [onCreateFilterAdjLayer],
  );

  const handleOpenSmartSharpen = useCallback(
    () => onCreateFilterAdjLayer("smart-sharpen"),
    [onCreateFilterAdjLayer],
  );

  const handleOpenAddNoise = useCallback(
    () => onCreateFilterAdjLayer("add-noise"),
    [onCreateFilterAdjLayer],
  );

  const handleOpenFilmGrain = useCallback(
    () => onCreateFilterAdjLayer("film-grain"),
    [onCreateFilterAdjLayer],
  );

  const handleOpenLensBlur = useCallback(
    () => onCreateFilterAdjLayer("lens-blur"),
    [onCreateFilterAdjLayer],
  );

  const handleOpenClouds = useCallback(
    () => onCreateFilterAdjLayer("clouds"),
    [onCreateFilterAdjLayer],
  );

  const handleOpenMedianFilter = useCallback(
    () => onCreateFilterAdjLayer("median-filter"),
    [onCreateFilterAdjLayer],
  );

  const handleOpenBilateralFilter = useCallback(
    () => onCreateFilterAdjLayer("bilateral-filter"),
    [onCreateFilterAdjLayer],
  );

  const handleOpenReduceNoise = useCallback(
    () => onCreateFilterAdjLayer("reduce-noise"),
    [onCreateFilterAdjLayer],
  );

  const handleOpenLensFlare = useCallback(
    () => onOpenFilterDialog("render-lens-flare"),
    [onOpenFilterDialog],
  );

  const handleApplyLensFlare = useCallback(
    (pixels: Uint8Array, _width: number, _height: number): void => {
      const handle = canvasHandleRef.current;
      const activeId = stateRef.current.activeLayerId;
      if (!handle || !activeId) return;
      const newId = `layer-${Date.now()}`;
      captureHistory("Lens Flare");
      handle.prepareNewLayer(newId, "Lens Flare", pixels);
      dispatch({
        type: "INSERT_LAYER_ABOVE",
        payload: {
          layer: {
            id: newId,
            name: "Lens Flare",
            visible: true,
            opacity: 1,
            locked: false,
            blendMode: "normal",
          },
          aboveId: activeId,
        },
      });
    },
    [canvasHandleRef, stateRef, captureHistory, dispatch],
  );

  const handleInstantFilter = useCallback(
    (key: FilterKey): void => {
      if (key === "sharpen") onCreateFilterAdjLayer("sharpen");
      if (key === "sharpen-more") onCreateFilterAdjLayer("sharpen-more");
    },
    [onCreateFilterAdjLayer],
  );

  const handleOpenPixelate = useCallback(
    () => onCreateFilterAdjLayer("pixelate"),
    [onCreateFilterAdjLayer],
  );

  const handleOpenSeamlessTexture = useCallback(
    () => onCreateFilterAdjLayer("seamless-texture"),
    [onCreateFilterAdjLayer],
  );

  const handleOpenOffset = useCallback(
    () => onCreateFilterAdjLayer("offset"),
    [onCreateFilterAdjLayer],
  );

  return {
    isFiltersMenuEnabled,
    handleOpenGaussianBlur,
    handleOpenBoxBlur,
    handleOpenRadialBlur,
    handleOpenMotionBlur,
    handleOpenRemoveMotionBlur,
    handleSharpen,
    handleSharpenMore,
    handleOpenUnsharpMask,
    handleOpenSmartSharpen,
    handleOpenAddNoise,
    handleOpenFilmGrain,
    handleOpenLensBlur,
    handleOpenClouds,
    handleOpenMedianFilter,
    handleOpenBilateralFilter,
    handleOpenReduceNoise,
    handleOpenLensFlare,
    handleApplyLensFlare,
    handleInstantFilter,
    handleOpenPixelate,
    handleOpenSeamlessTexture,
    handleOpenOffset,
  };
}
