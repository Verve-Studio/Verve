import { describe, expect, it } from "vitest";
import { WgslModule, delimiterBalance, stripWgslComments } from "./effectsWgsl";

// The layout calculator backs the "uniform struct matches the packed host
// array" checks, so it is pinned against the WGSL spec's alignment table.
describe("WGSL layout calculator", () => {
  const mod = (src: string) => new WgslModule(src);

  it("follows the spec's align/size table for scalars, vectors and matrices", () => {
    const m = mod("");
    expect(m.layout("f32")).toEqual({ align: 4, size: 4 });
    expect(m.layout("vec2f")).toEqual({ align: 8, size: 8 });
    expect(m.layout("vec3<f32>")).toEqual({ align: 16, size: 12 });
    expect(m.layout("vec4u")).toEqual({ align: 16, size: 16 });
    expect(m.layout("vec3h")).toEqual({ align: 8, size: 6 });
    expect(m.layout("mat4x4f")).toEqual({ align: 16, size: 64 });
    expect(m.layout("mat3x3<f32>")).toEqual({ align: 16, size: 48 });
    expect(m.layout("mat2x2f")).toEqual({ align: 8, size: 16 });
    expect(m.layout("array<vec4f, 4>")).toEqual({ align: 16, size: 64 });
    expect(m.layout("array<vec3f, 2>")).toEqual({ align: 16, size: 32 });
    expect(m.layout("array<f32>")).toBeNull(); // runtime-sized
  });

  it("lays out structs with vec3 padding, nested structs, @align/@size and const counts", () => {
    const m = mod(`
      const N : u32 = 3u;
      struct Inner { a: f32, b: vec3f }   // b at 16 → size 32
      struct P {
        x : f32,
        v : vec3f,       // 16
        y : f32,         // 28
        i : Inner,       // 32
        @align(16) z : f32, // 64
        @size(8) w : u32,   // 68..76
        arr : array<vec4f, N>, // 80
      }
      struct MaskFlags { hasMask : u32, _pad : vec3u }
    `);
    const p = m.structLayout("P")!;
    expect(p.members.map((x) => [x.name, x.offset])).toEqual([
      ["x", 0],
      ["v", 16],
      ["y", 28],
      ["i", 32],
      ["z", 64],
      ["w", 68],
      ["arr", 80],
    ]);
    expect(p.size).toBe(128);
    expect(m.structLayout("MaskFlags")!.size).toBe(32);
    expect(m.meaningfulBytes("MaskFlags")).toBe(4);
  });

  it("reads bindings, entry points and which bindings an entry point reaches", () => {
    const m = mod(`
      @group(0) @binding(0) var srcTex : texture_2d<f32>;
      @group(0) @binding(1) var<uniform> params : P; // comment var<uniform> fake
      @binding(2) @group(0) var outTex : texture_storage_2d<rgba8unorm, write>;
      @group(1) @binding(0) var<storage, read> pal : array<vec4f>;
      struct P { k: f32 }
      fn helper() -> f32 { return params.k; }
      @fragment fn fs_a() -> @location(0) vec4f { return textureLoad(srcTex, vec2i(0), 0) * helper(); }
      @compute @workgroup_size(8, 8) fn cs_b() { textureStore(outTex, vec2i(0), pal[0]); }
    `);
    expect(m.bindings.map((b) => [b.group, b.binding, b.kind])).toEqual([
      [0, 0, "texture"],
      [0, 1, "uniform"],
      [0, 2, "storage-texture"],
      [1, 0, "storage"],
    ]);
    expect(m.binding(0, 2)!.storageFormat).toBe("rgba8unorm");
    expect(m.entryPoints().map((f) => [f.name, f.stage])).toEqual([
      ["fs_a", "fragment"],
      ["cs_b", "compute"],
    ]);
    expect(m.usedBindings(["fs_a"]).map((b) => b.name)).toEqual(["srcTex", "params"]);
    expect(m.usedBindings(["cs_b"]).map((b) => b.name)).toEqual(["outTex", "pal"]);
  });

  it("strips nested block comments and line comments", () => {
    expect(stripWgslComments("a /* b /* c */ d */ e // f\ng")).toBe("a  e \ng");
  });

  it("detects unbalanced delimiters", () => {
    expect(delimiterBalance("fn f() { let a = (1); }")).toBeNull();
    expect(delimiterBalance("fn f() { let a = (1; }")).toMatch(/unbalanced/);
    expect(delimiterBalance("fn f() { ")).toMatch(/unclosed/);
    expect(delimiterBalance("// } \nfn f() {}")).toBeNull();
  });
});
