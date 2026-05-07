import { getPixelOps, encodeDds, encodeDdsF32, DdsHeaderMode } from "@/wasm";

interface EncodeMsg {
  pixels: Uint8Array | Float32Array;
  width: number;
  height: number;
  fmt: number;
  mipLevels: number;
  headerMode: number;
  inputFormat: "rgba8" | "rgba32f";
}

const ctx = self as unknown as {
  postMessage(msg: unknown, transfer?: Transferable[]): void;
  onmessage: ((e: MessageEvent) => void) | null;
};

ctx.onmessage = async (e: MessageEvent<EncodeMsg>) => {
  try {
    await getPixelOps();
    const { pixels, width, height, fmt, mipLevels, headerMode, inputFormat } =
      e.data;
    let result: Uint8Array;
    if (inputFormat === "rgba32f") {
      result = await encodeDdsF32(
        pixels as Float32Array,
        width,
        height,
        fmt,
        mipLevels,
      );
    } else {
      result = await encodeDds(
        pixels as Uint8Array,
        width,
        height,
        fmt,
        mipLevels,
        headerMode ?? DdsHeaderMode.AUTO,
      );
    }
    ctx.postMessage({ ok: true, data: result }, [result.buffer]);
  } catch (err) {
    ctx.postMessage({ ok: false, error: (err as Error).message });
  }
};
