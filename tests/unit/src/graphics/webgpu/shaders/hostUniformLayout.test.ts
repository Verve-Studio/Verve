// "The WGSL uniform struct must match the packed host data exactly." The
// renderer's own passes (composite, HDR blit, checker, GrabCut) pack their
// uniforms with DataView setters at literal byte offsets; this checks every
// such write against the struct layout computed with WGSL alignment rules.

import { readFileSync } from "fs";
import { resolve } from "path";
import { describe, expect, it } from "vitest";
import { WgslModule } from "@tests/fakes/effectsWgsl";
import { SRC_DIR } from "@tests/paths";

const SRC = SRC_DIR;
const read = (p: string) => readFileSync(resolve(SRC, p), "utf8");

interface Case {
  name: string;
  host: string;
  /** DataView variable the host writes through. */
  view: string;
  /** Expression that sizes the host buffer, if it is a literal. */
  bufferSize?: RegExp;
  wgsl: string;
  struct: string;
}

const CASES: Case[] = [
  {
    name: "composite (RenderPlanExecutor)",
    host: "graphics/webgpu/frame/RenderPlanExecutor.ts",
    view: "unifView",
    bufferSize: /compositeUnifAB = new ArrayBuffer\((\d+)\)/,
    wgsl: "graphics/webgpu/shaders/rendering/wgsl/composite.wgsl",
    struct: "CompositeUniforms",
  },
  {
    name: "HDR blit tone mapping (DisplayPresenter)",
    host: "graphics/webgpu/frame/DisplayPresenter.ts",
    view: "tmView",
    bufferSize: /blitUnifAB = new ArrayBuffer\((\d+)\)/,
    wgsl: "graphics/webgpu/shaders/rendering/wgsl/hdr-blit.wgsl",
    struct: "ToneMappingUniforms",
  },
  {
    name: "checkerboard (ResourceCache)",
    host: "graphics/webgpu/resources/ResourceCache.ts",
    view: "cuData",
    bufferSize: /cuData = new DataView\(new ArrayBuffer\((\d+)\)\)/,
    wgsl: "graphics/webgpu/shaders/rendering/wgsl/checker.wgsl",
    struct: "CheckerUniforms",
  },
  {
    name: "GrabCut n-links params (grabcutCompute)",
    host: "graphics/webgpu/compute/grabcutCompute.ts",
    view: "dv",
    bufferSize: /paramsData = new ArrayBuffer\((\d+)\)/,
    wgsl: "graphics/webgpu/shaders/compute/grabcut/wgsl/filter-grabcut-nlinks.wgsl",
    struct: "Params",
  },
];

const SCALAR_OF: Record<string, string> = { Float32: "f32", Uint32: "u32", Int32: "i32" };

/** Scalar type of the 4-byte slot at `offset`, descending into vectors. */
function slotType(mod: WgslModule, struct: string, offset: number): string | null {
  const s = mod.structLayout(struct);
  if (!s) return null;
  for (const m of s.members) {
    if (offset < m.offset || offset >= m.offset + m.size) continue;
    const t = m.type.replace(/\s/g, "");
    if (/^(f32|u32|i32)$/.test(t)) return offset === m.offset ? t : null;
    const v = /^vec[234](?:<(\w+)>|([fiu]))$/.exec(t);
    if (v) return (offset - m.offset) % 4 === 0 ? (v[1] ?? { f: "f32", i: "i32", u: "u32" }[v[2]]!) : null;
    return null;
  }
  return "padding";
}

describe.each(CASES)("$name", (c) => {
  const host = read(c.host);
  const mod = new WgslModule(read(c.wgsl));
  const layout = mod.structLayout(c.struct);
  const writes = [...host.matchAll(new RegExp(`\\b${c.view}\\.set(Float32|Uint32|Int32)\\(\\s*(\\d+)\\s*,`, "g"))].map(
    (m) => ({ type: SCALAR_OF[m[1]], offset: Number(m[2]) }),
  );

  it("the struct layout is computable and the host writes into it", () => {
    expect(layout).not.toBeNull();
    expect(writes.length).toBeGreaterThan(0);
  });

  it("every host write lands on a member of the same scalar type", () => {
    const bad = writes
      .map((w) => ({ ...w, slot: slotType(mod, c.struct, w.offset) }))
      .filter((w) => w.slot !== w.type)
      .map((w) => `offset ${w.offset}: host writes ${w.type}, struct has ${w.slot}`);
    expect(bad).toEqual([]);
  });

  it("every non-padding member is written and the host buffer covers the struct", () => {
    const written = new Set(writes.map((w) => w.offset));
    const missing: string[] = [];
    for (const m of layout!.members) {
      if (m.name.startsWith("_")) continue;
      for (let o = m.offset; o < m.offset + Math.min(m.size, 16); o += 4) {
        // vec3 members are 12 bytes; vec4 16.
        if (o >= m.offset + m.size) break;
        if (!written.has(o)) missing.push(`${m.name}@${o}`);
      }
    }
    expect(missing).toEqual([]);
    if (c.bufferSize) {
      const size = Number(c.bufferSize.exec(host)?.[1]);
      expect(size).toBeGreaterThanOrEqual(layout!.size);
    }
  });
});
