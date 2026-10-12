import { describe, expect, it } from "vitest";
import { copyOutsideRect, encodeClearTexture } from "@/graphics/webgpu/rendering/copyEncoders";
import { FakeGpu } from "@tests/fakes/effectsGpuRecorder";

interface Copy {
  sx: number;
  sy: number;
  dx: number;
  dy: number;
  w: number;
  h: number;
}

function recordCopies(run: (enc: GPUCommandEncoder) => void): Copy[] {
  const copies: Copy[] = [];
  const enc = {
    copyTextureToTexture(src: GPUTexelCopyTextureInfo, dst: GPUTexelCopyTextureInfo, size: GPUExtent3DDict) {
      const so = (src.origin ?? {}) as GPUOrigin3DDict;
      const dO = (dst.origin ?? {}) as GPUOrigin3DDict;
      copies.push({ sx: so.x ?? 0, sy: so.y ?? 0, dx: dO.x ?? 0, dy: dO.y ?? 0, w: size.width, h: size.height ?? 1 });
    },
  } as unknown as GPUCommandEncoder;
  run(enc);
  return copies;
}

/** Per-pixel copy count over a cw × ch canvas. */
function coverage(copies: Copy[], cw: number, ch: number): Uint8Array {
  const c = new Uint8Array(cw * ch);
  for (const k of copies) {
    expect(k.sx).toBe(k.dx);
    expect(k.sy).toBe(k.dy);
    expect(k.w).toBeGreaterThan(0);
    expect(k.h).toBeGreaterThan(0);
    expect(k.sx + k.w).toBeLessThanOrEqual(cw);
    expect(k.sy + k.h).toBeLessThanOrEqual(ch);
    for (let y = k.sy; y < k.sy + k.h; y++) for (let x = k.sx; x < k.sx + k.w; x++) c[y * cw + x]++;
  }
  return c;
}

describe("copyOutsideRect", () => {
  it("copies exactly the canvas outside the (clamped) rect, each pixel once", () => {
    const cw = 13;
    const ch = 9;
    let seed = 7;
    const rnd = (n: number) => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed % n;
    };
    for (let i = 0; i < 300; i++) {
      const rx = rnd(cw + 8) - 4;
      const ry = rnd(ch + 8) - 4;
      const rw = rnd(cw + 4);
      const rh = rnd(ch + 4);
      const cov = coverage(
        recordCopies((enc) => copyOutsideRect(enc, {} as GPUTexture, {} as GPUTexture, rx, ry, rw, rh, cw, ch)),
        cw,
        ch,
      );
      for (let y = 0; y < ch; y++) {
        for (let x = 0; x < cw; x++) {
          const inside = x >= rx && x < rx + rw && y >= ry && y < ry + rh;
          expect(cov[y * cw + x], `rect ${rx},${ry} ${rw}x${rh} at ${x},${y}`).toBe(inside ? 0 : 1);
        }
      }
    }
  });

  it("issues no copies when the rect covers the canvas", () => {
    expect(recordCopies((enc) => copyOutsideRect(enc, {} as GPUTexture, {} as GPUTexture, -2, -2, 50, 50, 10, 10))).toEqual([]);
  });
});

describe("encodeClearTexture", () => {
  it("records a clear-to-transparent pass with no draws", () => {
    const gpu = new FakeGpu();
    const tex = gpu.makeTarget(4, 4, "rgba8unorm");
    const enc = gpu.device.createCommandEncoder();
    const descs: GPURenderPassDescriptor[] = [];
    const begin = enc.beginRenderPass.bind(enc);
    enc.beginRenderPass = (d) => {
      descs.push(d);
      return begin(d);
    };
    encodeClearTexture(enc, tex);
    const att = [...descs[0].colorAttachments][0]!;
    expect(att).toMatchObject({ loadOp: "clear", storeOp: "store", clearValue: { r: 0, g: 0, b: 0, a: 0 } });
    expect(gpu.commands).toEqual([]);
  });
});
