import {
  WebGPURenderer,
  WebGPUUnavailableError,
  type GpuLayer,
} from "@/graphics/webgpu/rendering/WebGPURenderer";
import { useCallback, useEffect, useRef, useState } from "react";

interface UseWebGPUOptions {
  pixelWidth: number;
  pixelHeight: number;
  pixelFormat?: import("@/types").PixelFormat;
  onWebGPUError?: (err: Error) => void;
}

interface UseWebGPUReturn {
  canvasRef: React.RefObject<HTMLCanvasElement | null>;
  rendererRef: React.RefObject<WebGPURenderer | null>;
  /** Increments from 0 to 1 once the renderer is ready. Use as an effect dependency. */
  rendererVersion: number;
  createLayer: (id: string, name: string) => GpuLayer | null;
  render: (layers: GpuLayer[], maskMap?: Map<string, GpuLayer>) => void;
}

export function useWebGPU({
  pixelWidth,
  pixelHeight,
  pixelFormat,
  onWebGPUError,
}: UseWebGPUOptions): UseWebGPUReturn {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const rendererRef = useRef<WebGPURenderer | null>(null);
  const hasInitializedRef = useRef(false);
  const onErrorRef = useRef(onWebGPUError);
  onErrorRef.current = onWebGPUError;
  // Increments to 1 once the renderer is ready — drives re-renders in consumers.
  const [rendererVersion, setRendererVersion] = useState(0);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || hasInitializedRef.current) return;
    hasInitializedRef.current = true;

    let mounted = true;
    WebGPURenderer.create(canvas, pixelWidth, pixelHeight, pixelFormat)
      .then((renderer) => {
        if (!mounted) {
          renderer.destroy();
          return;
        }
        rendererRef.current = renderer;
        setRendererVersion((v) => v + 1);
      })
      .catch((err: unknown) => {
        const error = err instanceof Error ? err : new Error(String(err));
        console.error(
          "[useWebGPU] Failed to initialize WebGPU renderer:",
          error,
        );
        if (error instanceof WebGPUUnavailableError) {
          onErrorRef.current?.(error);
        }
      });

    return () => {
      mounted = false;
      rendererRef.current?.destroy();
      rendererRef.current = null;
      hasInitializedRef.current = false;
    };
  }, [pixelWidth, pixelHeight]);

  const createLayer = useCallback(
    (id: string, name: string): GpuLayer | null =>
      rendererRef.current?.createLayer(id, name) ?? null,
    [],
  );

  const render = useCallback(
    (layers: GpuLayer[], maskMap?: Map<string, GpuLayer>): void => {
      rendererRef.current?.render(layers, maskMap);
    },
    [],
  );

  return { canvasRef, rendererRef, rendererVersion, createLayer, render };
}
