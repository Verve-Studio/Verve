import { describe, expect, it } from "vitest";
import { base64ToBytes, bytesToBase64 } from "@/utils/base64";
import { seededRandom } from "@tests/fakes/toolsPixelFakes";

describe("base64", () => {
  it("encodes known vectors (RFC 4648)", () => {
    const enc = (s: string): string => bytesToBase64(new TextEncoder().encode(s));
    expect(enc("")).toBe("");
    expect(enc("f")).toBe("Zg==");
    expect(enc("fo")).toBe("Zm8=");
    expect(enc("foo")).toBe("Zm9v");
    expect(enc("foobar")).toBe("Zm9vYmFy");
  });

  it("round-trips every byte value", () => {
    const all = new Uint8Array(256).map((_, i) => i);
    expect(Array.from(base64ToBytes(bytesToBase64(all)))).toEqual(Array.from(all));
  });

  it("round-trips buffers larger than the 32 KiB encode chunk", () => {
    const rnd = seededRandom(42);
    const big = new Uint8Array(0x8000 * 3 + 17).map(() => Math.floor(rnd() * 256));
    const b64 = bytesToBase64(big);
    expect(b64.length).toBe(Math.ceil(big.length / 3) * 4);
    expect(base64ToBytes(b64)).toEqual(big);
  });

  it("encodes a subarray view, not its whole backing buffer", () => {
    const buf = new Uint8Array([1, 2, 3, 4, 5, 6]);
    expect(Array.from(base64ToBytes(bytesToBase64(buf.subarray(2, 4))))).toEqual([3, 4]);
  });

  it("throws on malformed input", () => {
    expect(() => base64ToBytes("not base64!!")).toThrow();
  });
});
