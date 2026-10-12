import { describe, expect, it } from "vitest";
import { deflate, inflate } from "@/utils/zlib";
import { seededRandom } from "@tests/fakes/toolsPixelFakes";

describe("zlib", () => {
  it("round-trips with the zlib wrapper (default)", async () => {
    const rnd = seededRandom(7);
    const data = new Uint8Array(10000).map(() => Math.floor(rnd() * 16));
    const z = await deflate(data);
    // zlib header: CMF 0x78 and (CMF*256 + FLG) % 31 === 0.
    expect(z[0]).toBe(0x78);
    expect((z[0] * 256 + z[1]) % 31).toBe(0);
    expect(await inflate(z)).toEqual(data);
  });

  it("round-trips raw deflate (no header)", async () => {
    const data = new TextEncoder().encode("verve ".repeat(500));
    const z = await deflate(data, "deflate-raw");
    expect(z.length).toBeLessThan(data.length / 10);
    expect(await inflate(z, "deflate-raw")).toEqual(data);
  });

  it("handles empty input", async () => {
    expect((await inflate(await deflate(new Uint8Array(0)))).length).toBe(0);
  });

  it("rejects corrupt data", async () => {
    await expect(inflate(new Uint8Array([1, 2, 3, 4, 5]))).rejects.toThrow();
  });
});
