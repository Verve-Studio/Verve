/**
 * Dedicated worker running a second pixelops WASM instance for long
 * operations (inpaint, whole-image GrabCut, quantize), so they don't freeze
 * the UI thread. Driven by `pixelopsWorkerClient.ts`.
 */
import { grabCut, inpaintRegion, quantize } from "@/wasm";

export type PixelopsWorkerJob =
  | {
      op: "inpaint";
      pixels: Uint8Array;
      width: number;
      height: number;
      mask: Uint8Array;
      sourceMask?: Uint8Array;
    }
  | { op: "quantize"; pixels: Uint8Array; maxColors: number }
  | {
      op: "grabcut";
      pixels: Uint8Array;
      width: number;
      height: number;
      trimap: Uint8Array;
      iterations: number;
      k: number;
    };

const ctx = self as unknown as {
  postMessage(msg: unknown, transfer?: Transferable[]): void;
  onmessage: ((e: MessageEvent<{ id: number; job: PixelopsWorkerJob }>) => void) | null;
};

ctx.onmessage = async (e) => {
  const { id, job } = e.data;
  try {
    switch (job.op) {
      case "inpaint": {
        const out = await inpaintRegion(
          job.pixels,
          job.width,
          job.height,
          job.mask,
          job.sourceMask,
        );
        ctx.postMessage({ id, ok: true, result: out }, [out.buffer]);
        return;
      }
      case "quantize": {
        const out = await quantize(job.pixels, job.maxColors);
        ctx.postMessage({ id, ok: true, result: out }, [out.palette.buffer]);
        return;
      }
      case "grabcut": {
        const out = await grabCut(
          job.pixels,
          job.width,
          job.height,
          job.trimap,
          job.iterations,
          job.k,
        );
        ctx.postMessage({ id, ok: true, result: out }, [out.buffer]);
        return;
      }
    }
  } catch (err) {
    ctx.postMessage({
      id,
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    });
  }
};
