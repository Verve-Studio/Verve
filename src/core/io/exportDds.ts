import { DdsHeaderMode } from "@/wasm";

export interface DdsExportOptions {
  pixels: Uint8Array | Float32Array;
  width: number;
  height: number;
  fmt: number;
  mipLevels?: number;
  headerMode?: number;
  inputFormat: "rgba8" | "rgba32f";
  signal?: AbortSignal;
}

/**
 * Encode pixels to a DDS file off the main thread.
 * Returns the DDS file bytes.
 */
export async function exportDds(
  options: DdsExportOptions,
): Promise<Uint8Array> {
  const { pixels, width, height, fmt, inputFormat, signal } = options;
  const headerMode = options.headerMode ?? DdsHeaderMode.AUTO;
  const mipLevels = options.mipLevels ?? 1;

  return new Promise<Uint8Array>((resolve, reject) => {
    const worker = new Worker(new URL("./ddsWorker.ts", import.meta.url), {
      type: "module",
    });

    const cleanup = () => worker.terminate();

    if (signal) {
      if (signal.aborted) {
        cleanup();
        reject(new DOMException("Aborted", "AbortError"));
        return;
      }
      signal.addEventListener(
        "abort",
        () => {
          cleanup();
          reject(new DOMException("Aborted", "AbortError"));
        },
        { once: true },
      );
    }

    worker.onmessage = (
      e: MessageEvent<{ ok: boolean; data?: Uint8Array; error?: string }>,
    ) => {
      cleanup();
      if (!e.data.ok || !e.data.data) {
        reject(new Error(e.data.error ?? "DDS encode failed"));
        return;
      }
      resolve(e.data.data);
    };

    worker.onerror = (err) => {
      cleanup();
      reject(new Error(err.message));
    };

    const msg = {
      pixels,
      width,
      height,
      fmt,
      mipLevels,
      headerMode,
      inputFormat,
    };
    const transfer = [pixels.buffer];
    worker.postMessage(msg, transfer);
  });
}
