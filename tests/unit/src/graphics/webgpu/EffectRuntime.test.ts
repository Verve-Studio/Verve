import { describe, expect, it } from "vitest";
import { EffectRuntime, STD_BINDINGS } from "@/graphics/webgpu/EffectRuntime";
import { FakeGpu, type FakeBuffer, type FakePipeline, type FakeTexture } from "@tests/fakes/effectsGpuRecorder";

function setup(intermediate: GPUTextureFormat = "rgba8unorm") {
  const gpu = new FakeGpu();
  const rt = new EffectRuntime(gpu.device, 32, 16, intermediate);
  return { gpu, rt };
}
const fb = (b: GPUBuffer) => b as unknown as FakeBuffer;
const ft = (t: GPUTexture) => t as unknown as FakeTexture;
const fp = (p: GPURenderPipeline | GPUComputePipeline) => p as unknown as FakePipeline;

describe("EffectRuntime construction", () => {
  it("allocates a canvas-sized intermediate in the requested (document) format", () => {
    const { rt } = setup("rgba32float");
    expect(ft(rt.intermediate)).toMatchObject({ width: 32, height: 16, format: "rgba32float" });
    expect(rt.pixelWidth).toBe(32);
    expect(rt.pixelHeight).toBe(16);
  });
});

describe("makeParamsBuf (per-frame uniform pool)", () => {
  it("rounds sizes up to 16 bytes (min 16) and uploads the data", () => {
    const { rt } = setup();
    expect(fb(rt.makeParamsBuf(new Float32Array(1))).size).toBe(16);
    expect(fb(rt.makeParamsBuf(new Float32Array(5))).size).toBe(32);
    expect(fb(rt.makeParamsBuf(new ArrayBuffer(48))).size).toBe(48);
    const b = fb(rt.makeParamsBuf(new Uint32Array([7, 8])));
    expect(b.writtenBytes).toBe(8);
    expect(Array.from(new Uint32Array(b.lastWrite!.buffer.slice(0)))).toEqual([7, 8]);
    expect(b.usage & GPUBufferUsage.UNIFORM).toBeTruthy();
  });

  it("never hands out the same buffer twice within a frame", () => {
    const { rt } = setup();
    const bufs = new Set(Array.from({ length: 10 }, () => rt.makeParamsBuf(new Float32Array(4))));
    expect(bufs.size).toBe(10);
  });

  it("recycles buffers only after flushPendingDestroys, by size", () => {
    const { rt, gpu } = setup();
    const a = rt.makeParamsBuf(new Float32Array(4));
    const b = rt.makeParamsBuf(new Float32Array(8));
    rt.flushPendingDestroys();
    expect(fb(a).destroyed).toBe(false);
    const created = gpu.buffers.length;
    const a2 = rt.makeParamsBuf(new Float32Array(4));
    const b2 = rt.makeParamsBuf(new Float32Array(8));
    expect(a2).toBe(a);
    expect(b2).toBe(b);
    expect(gpu.buffers.length).toBe(created);
    // Pool exhausted for this size → a new buffer.
    expect(rt.makeParamsBuf(new Float32Array(4))).not.toBe(a);
  });

  it("uploads exactly the bytes of a typed-array view", () => {
    const { rt, gpu } = setup();
    const backing = new Float32Array([9, 9, 9, 9, 1, 2, 3, 4]);
    const b = fb(rt.makeParamsBuf(backing.subarray(4)));
    expect(gpu.violations).toEqual([]);
    expect(Array.from(new Float32Array(b.lastWrite!.slice().buffer))).toEqual([1, 2, 3, 4]);
  });

  it("bounds the pool per size and destroys the overflow", () => {
    const { rt } = setup();
    const bufs = Array.from({ length: 140 }, () => rt.makeParamsBuf(new Float32Array(4)));
    rt.flushPendingDestroys();
    expect(bufs.filter((b) => fb(b).destroyed).length).toBe(140 - 128);
  });
});

describe("makeMaskFlagsBuf", () => {
  it("is one constant 32-byte buffer per (present, linear) combination", () => {
    const { rt } = setup();
    const combos = [
      [false, false],
      [true, false],
      [false, true],
      [true, true],
    ] as const;
    const bufs = combos.map(([p, l]) => rt.makeMaskFlagsBuf(p, l));
    expect(new Set(bufs).size).toBe(4);
    combos.forEach(([p, l], i) => {
      const b = fb(bufs[i]);
      expect(b.size).toBe(32);
      const u = new Uint32Array(b.lastWrite!.slice().buffer);
      expect([u[0], u[1]]).toEqual([p ? 1 : 0, l ? 1 : 0]);
      expect(rt.makeMaskFlagsBuf(p, l)).toBe(bufs[i]);
    });
    expect(rt.makeMaskFlagsBuf(true)).toBe(bufs[1]);
  });

  it("survives frame flushes (not part of the per-frame pool)", () => {
    const { rt } = setup();
    const b = rt.makeMaskFlagsBuf(true, true);
    rt.flushPendingDestroys();
    expect(fb(b).destroyed).toBe(false);
    expect(rt.makeParamsBuf(new Uint32Array(8))).not.toBe(b);
  });
});

describe("transient textures", () => {
  it("makeScratchTex follows the destination format (rgba32float stays float, everything else rgba8)", () => {
    const { rt, gpu } = setup();
    expect(ft(rt.makeScratchTex(4, 4, "rgba32float")).format).toBe("rgba32float");
    expect(ft(rt.makeScratchTex(4, 4, "rgba8unorm")).format).toBe("rgba8unorm");
    const like = gpu.makeTarget(2, 2, "rgba32float");
    expect(ft(rt.makeScratchTex(3, 5, like))).toMatchObject({ format: "rgba32float", width: 3, height: 5 });
  });

  it("all transient textures are destroyed on flush, not before", () => {
    const { rt } = setup();
    const texs = [rt.makeScratchTex(4, 4, "rgba32float"), rt.makeRgba8Tex(4, 4), rt.makeRgba16FloatTex(4, 4)];
    expect(ft(texs[2]).format).toBe("rgba16float");
    expect(texs.every((t) => !ft(t).destroyed)).toBe(true);
    rt.flushPendingDestroys();
    expect(texs.every((t) => ft(t).destroyed)).toBe(true);
    expect(rt.pendingDestroyTextures).toEqual([]);
  });

  it("flushes pending buffers too", () => {
    const { rt, gpu } = setup();
    const b = gpu.device.createBuffer({ size: 64, usage: GPUBufferUsage.STORAGE });
    rt.pendingDestroyBuffers.push(b);
    rt.flushPendingDestroys();
    expect(fb(b).destroyed).toBe(true);
    expect(rt.pendingDestroyBuffers).toEqual([]);
  });
});

describe("pipeline caches", () => {
  it("getRenderPipelinePair caches per (shader, entry, bindings) and builds s8 + f32 targets", () => {
    const { rt } = setup();
    const a = rt.getRenderPipelinePair("bc", "fs_brightness_contrast", STD_BINDINGS);
    expect(rt.getRenderPipelinePair("bc", "fs_brightness_contrast", STD_BINDINGS)).toBe(a);
    expect(fp(a.s8).targets).toEqual(["rgba8unorm"]);
    expect(fp(a.f32).targets).toEqual(["rgba32float"]);
    expect(a.bgl).toBeDefined();
    const auto = rt.getRenderPipelinePair("bc", "fs_brightness_contrast");
    expect(auto).not.toBe(a);
    expect(auto.bgl).toBeUndefined();
    expect(fp(auto.s8).auto).toBe(true);
  });

  it("selectPipeline picks f32 only for rgba32float targets", () => {
    const { rt, gpu } = setup();
    const pair = rt.getRenderPipelinePair("bc", "fs_brightness_contrast", STD_BINDINGS);
    expect(rt.selectPipeline(pair, "rgba32float")).toBe(pair.f32);
    expect(rt.selectPipeline(pair, "rgba8unorm")).toBe(pair.s8);
    expect(rt.selectPipeline(pair, gpu.makeTarget(1, 1, "rgba32float"))).toBe(pair.f32);
  });

  it("single-format pipelines are cached per format", () => {
    const { rt } = setup();
    const p8 = rt.getRenderPipelineAuto("bc", "fs_brightness_contrast", "rgba8unorm");
    expect(rt.getRenderPipelineAuto("bc", "fs_brightness_contrast", "rgba8unorm")).toBe(p8);
    expect(rt.getRenderPipelineSingle("bc", "fs_brightness_contrast", "rgba16float")).not.toBe(p8);
    const w = rt.getRenderPipelineWithBGL("bc", "fs_brightness_contrast", "rgba32float", STD_BINDINGS);
    expect(rt.getRenderPipelineSingle("bc", "fs_brightness_contrast", "rgba32float", STD_BINDINGS)).toBe(w.pipeline);
    expect(fp(w.pipeline).targets).toEqual(["rgba32float"]);
  });

  it("getComputePipelineForStorageFormat rewrites the storage texel format for float targets", () => {
    const { rt, gpu } = setup();
    // Any effect compute shader that writes rgba8unorm storage.
    const shader = "bevel-composite";
    const entry = "cs_bevel_composite";
    const p8 = fp(rt.getComputePipelineForStorageFormat(shader, entry, "rgba8unorm"));
    expect(p8).toBe(fp(rt.getComputePipeline(shader, entry)));
    expect(p8.stages[0].module.code).toMatch(/texture_storage_2d<rgba8unorm,/);
    const pf = fp(rt.getComputePipelineForStorageFormat(shader, entry, gpu.makeTarget(1, 1, "rgba32float")));
    expect(pf.stages[0].module.code).not.toMatch(/texture_storage_2d<rgba8unorm,/);
    expect(pf.stages[0].module.code).toMatch(/texture_storage_2d<rgba32float,/);
    expect(fp(rt.getComputePipelineForStorageFormat(shader, entry, "rgba32float"))).toBe(pf);
  });

  it("source pipelines are an LRU of 32 keyed by source", () => {
    const { rt } = setup();
    const src = (i: number) => `@vertex fn vs_adj() -> @builtin(position) vec4f { return vec4f(${i}.0); }
      @fragment fn fs_custom_shader() -> @location(0) vec4f { return vec4f(1.0); }`;
    const first = rt.getRenderPipelinePairForSource(src(0), "fs_custom_shader", STD_BINDINGS);
    for (let i = 1; i < 32; i++) rt.getRenderPipelinePairForSource(src(i), "fs_custom_shader", STD_BINDINGS);
    // Touch 0 so 1 becomes the oldest, then overflow by one.
    expect(rt.getRenderPipelinePairForSource(src(0), "fs_custom_shader", STD_BINDINGS)).toBe(first);
    const one = rt.getRenderPipelinePairForSource(src(1), "fs_custom_shader", STD_BINDINGS);
    rt.getRenderPipelinePairForSource(src(2), "fs_custom_shader", STD_BINDINGS);
    rt.getRenderPipelinePairForSource(src(99), "fs_custom_shader", STD_BINDINGS);
    // 3 was the LRU → rebuilt; 0, 1 and 2 survive.
    expect(rt.getRenderPipelinePairForSource(src(0), "fs_custom_shader", STD_BINDINGS)).toBe(first);
    expect(rt.getRenderPipelinePairForSource(src(1), "fs_custom_shader", STD_BINDINGS)).toBe(one);
  });
});

describe("render-pass helpers", () => {
  it("encodeStdAdjRenderPass binds the standard layout and passes the linear flag on float targets", () => {
    const { rt, gpu } = setup("rgba32float");
    const src = gpu.makeTarget(32, 16, "rgba32float");
    const dst = gpu.makeTarget(32, 16, "rgba32float");
    const pair = rt.getRenderPipelinePair("bc", "fs_brightness_contrast", STD_BINDINGS);
    rt.encodeStdAdjRenderPass(
      gpu.device.createCommandEncoder(),
      pair,
      src,
      dst,
      "rgba32float",
      new Float32Array([0, 0, 1, 0]).buffer,
    );
    expect(gpu.violations).toEqual([]);
    const cmd = gpu.commands[0];
    expect(cmd.pipeline).toBe(fp(pair.f32));
    expect(cmd.attachments).toEqual([dst]);
    const entries = cmd.bindGroups.get(0)!.entries;
    expect(entries.map((e) => e.binding)).toEqual([0, 1, 2, 3, 4]);
    // No mask → the source stands in for the mask texture, flags say linear.
    expect((entries[3].resource as unknown as { texture: unknown }).texture).toBe(src);
    expect((entries[4].resource as { buffer: GPUBuffer }).buffer).toBe(rt.makeMaskFlagsBuf(false, true));
  });

  it("encodeRenderPass clears without a scissor and loads + clips under one", () => {
    const { rt, gpu } = setup();
    const dst = gpu.makeTarget(32, 16, "rgba8unorm");
    const pair = rt.getRenderPipelinePair("bc", "fs_brightness_contrast", STD_BINDINGS);
    const passes: GPURenderPassDescriptor[] = [];
    const enc = gpu.device.createCommandEncoder();
    const begin = enc.beginRenderPass.bind(enc);
    enc.beginRenderPass = (d) => {
      passes.push(d);
      return begin(d);
    };
    const entries = (): GPUBindGroupEntry[] => [
      { binding: 0, resource: gpu.makeTarget(32, 16, "rgba8unorm").createView() },
      { binding: 1, resource: rt.adjSampler },
      { binding: 2, resource: { buffer: rt.makeParamsBuf(new Float32Array(4)) } },
      { binding: 3, resource: gpu.makeTarget(32, 16, "rgba8unorm").createView() },
      { binding: 4, resource: { buffer: rt.makeMaskFlagsBuf(false) } },
    ];
    rt.encodeRenderPass(enc, pair.s8, dst, entries(), pair.bgl);
    rt.scissor = { x: 1, y: 2, w: 3, h: 4 };
    rt.encodeRenderPass(enc, pair.s8, dst, entries(), pair.bgl);
    const ca = (i: number) => [...passes[i].colorAttachments][0]!;
    expect(ca(0).loadOp).toBe("clear");
    expect(ca(1).loadOp).toBe("load");
    expect(gpu.commands[0].scissor).toBeNull();
    expect(gpu.commands[1].scissor).toEqual([1, 2, 3, 4]);
  });

  it("destroy releases the intermediate and pooled buffers", () => {
    const { rt } = setup();
    const b = rt.makeParamsBuf(new Float32Array(4));
    const m = rt.makeMaskFlagsBuf(true);
    rt.destroy();
    expect(ft(rt.intermediate).destroyed).toBe(true);
    expect(fb(b).destroyed).toBe(true);
    expect(fb(m).destroyed).toBe(true);
  });
});
