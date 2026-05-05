import type { CurvesChannel } from "@/types";
import type { CanvasHandle } from "@/ux/main/Canvas/Canvas";
import { computeHistogramRGBA } from "@/wasm";
import type { CurvesHistogramResult } from "@/wasm/types";
import { useEffect, useMemo, useRef, useState } from "react";

interface UseCurvesHistogramOptions {
  canvasHandleRef: { readonly current: CanvasHandle | null };
  adjustmentLayerId: string;
  selectedChannel: CurvesChannel;
  showHistogram: boolean;
  width: number;
  height: number;
  sourceRevisionHint: string;
}

interface UseCurvesHistogramReturn {
  histogram: Float32Array | null;
  status: "hidden" | "loading" | "ready" | "unavailable" | "error";
  message: string | null;
}

const MAX_HASH_SAMPLES = 4096;

function hashBytes(data: Uint8Array): number {
  const step = Math.max(1, Math.floor(data.length / MAX_HASH_SAMPLES));
  let hash = 2166136261 >>> 0;
  for (let i = 0; i < data.length; i += step) {
    hash ^= data[i];
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function buildSourceRevision(
  adjustmentLayerId: string,
  sourcePixels: Uint8Array,
  mask: Uint8Array | null,
  sourceRevisionHint: string,
): string {
  const pixHash = hashBytes(sourcePixels);
  const maskHash = mask ? hashBytes(mask) : 0;
  return [
    adjustmentLayerId,
    sourcePixels.length,
    pixHash,
    mask ? mask.length : 0,
    maskHash,
    sourceRevisionHint,
  ].join(":");
}

function extractMaskChannel(
  maskRgba: Uint8Array | null,
): Uint8Array | undefined {
  if (!maskRgba) return undefined;
  const pixelCount = Math.floor(maskRgba.length / 4);
  const out = new Uint8Array(pixelCount);
  for (let i = 0; i < pixelCount; i++) {
    out[i] = maskRgba[i * 4];
  }
  return out;
}

export function useCurvesHistogram({
  canvasHandleRef,
  adjustmentLayerId,
  selectedChannel,
  showHistogram,
  width,
  height,
  sourceRevisionHint,
}: UseCurvesHistogramOptions): UseCurvesHistogramReturn {
  const cacheRef = useRef(new Map<string, CurvesHistogramResult>());
  const requestTokenRef = useRef(0);

  const [result, setResult] = useState<CurvesHistogramResult | null>(null);
  const [status, setStatus] =
    useState<UseCurvesHistogramReturn["status"]>("hidden");
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    if (!showHistogram) {
      setStatus("hidden");
      setMessage(null);
      return;
    }

    const handle = canvasHandleRef.current;
    if (!handle) {
      setResult(null);
      setStatus("unavailable");
      setMessage("Histogram unavailable until canvas is ready.");
      return;
    }

    let cancelled = false;
    const token = ++requestTokenRef.current;
    setStatus("loading");
    setMessage("Computing histogram...");

    const load = async (): Promise<void> => {
      const sourceNative =
        await handle.readAdjustmentInputPixels(adjustmentLayerId);
      if (cancelled) return;
      if (!sourceNative || sourceNative.length !== width * height * 4) {
        setResult(null);
        setStatus("unavailable");
        setMessage("Histogram unavailable for this layer source.");
        return;
      }
      // Histogram WASM operates on 8-bit RGBA; convert HDR float pixels (clamped) at the boundary.
      const sourcePixels: Uint8Array =
        sourceNative instanceof Float32Array
          ? (() => {
              const out = new Uint8Array(sourceNative.length);
              for (let i = 0; i < sourceNative.length; i++) {
                const v = sourceNative[i];
                out[i] = v <= 0 ? 0 : v >= 1 ? 255 : Math.round(v * 255);
              }
              return out;
            })()
          : sourceNative;

      const maskRgba = handle.getAdjustmentMaskPixels(adjustmentLayerId);
      const mask = extractMaskChannel(maskRgba as Uint8Array | null);
      const sourceRevision = buildSourceRevision(
        adjustmentLayerId,
        sourcePixels,
        maskRgba as Uint8Array | null,
        sourceRevisionHint,
      );
      const cacheKey = `${adjustmentLayerId}:${sourceRevision}`;
      const cached = cacheRef.current.get(cacheKey);
      if (cached) {
        setResult(cached);
        setStatus("ready");
        setMessage(null);
        return;
      }

      void computeHistogramRGBA(sourcePixels, width, height, mask)
        .then((hist) => {
          if (token !== requestTokenRef.current) return;
          cacheRef.current.set(cacheKey, hist);
          setResult(hist);
          setStatus("ready");
          setMessage(null);
        })
        .catch((error: unknown) => {
          if (token !== requestTokenRef.current) return;
          setResult(null);
          setStatus("error");
          setMessage(
            error instanceof Error
              ? error.message
              : "Failed to compute histogram.",
          );
        });
    };

    void load();
    return () => {
      cancelled = true;
    };
  }, [
    canvasHandleRef,
    adjustmentLayerId,
    showHistogram,
    width,
    height,
    sourceRevisionHint,
  ]);

  const histogram = useMemo((): Float32Array | null => {
    if (!showHistogram || !result) return null;
    if (selectedChannel === "rgb") return result.rgb;
    if (selectedChannel === "red") return result.red;
    if (selectedChannel === "green") return result.green;
    return result.blue;
  }, [showHistogram, result, selectedChannel]);

  return { histogram, status, message };
}
