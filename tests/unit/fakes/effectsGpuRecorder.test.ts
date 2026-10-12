import { describe, expect, it } from "vitest";
import { FakeGpu } from "./effectsGpuRecorder";

// The effect sweeps only mean something if the recorder actually catches the
// mistakes it claims to. Each case here feeds it one deliberate error.

const SHADER = /* wgsl */ `
struct V { @builtin(position) pos: vec4f }
@vertex fn vs_adj(@builtin(vertex_index) i: u32) -> V { return V(vec4f(f32(i))); }
struct P { scale: f32, mode: u32, _pad: vec2f }
@group(0) @binding(0) var srcTex : texture_2d<f32>;
@group(0) @binding(1) var<uniform> params : P;
@group(0) @binding(2) var unusedTex : texture_2d<f32>;
@fragment fn fs(v: V) -> @location(0) vec4f {
  return textureLoad(srcTex, vec2i(v.pos.xy), 0) * params.scale * f32(params.mode);
}
`;

function setup(target: GPUTextureFormat = "rgba8unorm") {
  const gpu = new FakeGpu();
  const d = gpu.device;
  const module = d.createShaderModule({ code: SHADER });
  const pipeline = d.createRenderPipeline({
    layout: "auto",
    vertex: { module, entryPoint: "vs_adj" },
    fragment: { module, entryPoint: "fs", targets: [{ format: target }] },
  });
  const src = gpu.makeTarget(8, 8, "rgba8unorm");
  const dst = gpu.makeTarget(8, 8, "rgba8unorm");
  const params = d.createBuffer({ size: 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
  const write = (f: number, u: number) => {
    const b = new ArrayBuffer(16);
    new Float32Array(b)[0] = f;
    new Uint32Array(b)[1] = u;
    d.queue.writeBuffer(params, 0, b);
  };
  write(1, 1);
  const draw = (entries: GPUBindGroupEntry[], into: GPUTexture = dst) => {
    const enc = d.createCommandEncoder();
    const pass = enc.beginRenderPass({
      colorAttachments: [{ view: into.createView(), loadOp: "clear", storeOp: "store" }],
    });
    pass.setPipeline(pipeline);
    pass.setBindGroup(0, d.createBindGroup({ layout: pipeline.getBindGroupLayout(0), entries }));
    pass.draw(6);
    pass.end();
  };
  const good = (): GPUBindGroupEntry[] => [
    { binding: 0, resource: src.createView() },
    { binding: 1, resource: { buffer: params } },
  ];
  return { gpu, d, src, dst, params, write, draw, good };
}

describe("FakeGpu recorder", () => {
  it("accepts a correct draw", () => {
    const s = setup();
    s.draw(s.good());
    expect(s.gpu.violations).toEqual([]);
    expect(s.gpu.commands).toHaveLength(1);
  });

  it("flags a pipeline target format that differs from the attachment", () => {
    const s = setup("rgba32float");
    s.draw(s.good());
    expect(s.gpu.violations.join()).toMatch(/targets rgba32float but draws into a rgba8unorm/);
  });

  it("flags missing used bindings and extra bindings auto layout dropped", () => {
    const s = setup();
    s.draw([{ binding: 0, resource: s.src.createView() }]);
    s.draw([...s.good(), { binding: 2, resource: s.src.createView() }]);
    const v = s.gpu.violations.join("\n");
    expect(v).toMatch(/binding 1 missing/);
    expect(v).toMatch(/binding 2 is not in the layout/);
  });

  it("flags a uniform buffer smaller than the struct and a short host write", () => {
    const s = setup();
    const small = s.d.createBuffer({ size: 8, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    s.d.queue.writeBuffer(small, 0, new Float32Array([1, 0]));
    s.draw([{ binding: 0, resource: s.src.createView() }, { binding: 1, resource: { buffer: small } }]);
    expect(s.gpu.violations.join()).toMatch(/needs 16 bytes, buffer binding has 8/);

    const s2 = setup();
    s2.d.queue.writeBuffer(s2.params, 0, new Float32Array([1]));
    s2.draw(s2.good());
    expect(s2.gpu.violations.join()).toMatch(/reads 8 bytes, host wrote only 4/);
  });

  it("flags float bits in a u32 member, integer bits in an f32 member, and NaN", () => {
    const s = setup();
    s.d.queue.writeBuffer(s.params, 0, new Float32Array([1, 1, 0, 0]));
    s.draw(s.good());
    s.d.queue.writeBuffer(s.params, 0, new Uint32Array([3, 1, 0, 0]));
    s.draw(s.good());
    s.d.queue.writeBuffer(s.params, 0, new Float32Array([NaN, 0, 0, 0]));
    s.draw(s.good());
    const v = s.gpu.violations.join("\n");
    expect(v).toMatch(/P\.mode is u32 but holds float bits/);
    expect(v).toMatch(/P\.scale is f32 but holds integer bits/);
    expect(v).toMatch(/P\.scale is NaN/);
  });

  it("flags destroyed resources, sampling the render target, and missing usages", () => {
    const s = setup();
    s.src.destroy();
    s.draw(s.good());
    expect(s.gpu.violations.join()).toMatch(/destroyed texture/);

    const s2 = setup();
    s2.draw([{ binding: 0, resource: s2.dst.createView() }, { binding: 1, resource: { buffer: s2.params } }]);
    expect(s2.gpu.violations.join()).toMatch(/also the pass's render attachment/);

    const s3 = setup();
    const noBind = s3.d.createTexture({ size: [8, 8], format: "rgba8unorm", usage: GPUTextureUsage.RENDER_ATTACHMENT });
    s3.draw([{ binding: 0, resource: noBind.createView() }, { binding: 1, resource: { buffer: s3.params } }]);
    expect(s3.gpu.violations.join()).toMatch(/lacks TEXTURE_BINDING/);
  });

  it("flags explicit layouts that disagree with the shader, and unfilterable formats on filterable entries", () => {
    const gpu = new FakeGpu();
    const d = gpu.device;
    const module = d.createShaderModule({ code: SHADER });
    const bgl = d.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: "float" } },
        { binding: 1, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: "float" } },
      ],
    });
    const pipeline = d.createRenderPipeline({
      layout: d.createPipelineLayout({ bindGroupLayouts: [bgl] }),
      vertex: { module, entryPoint: "vs_adj" },
      fragment: { module, entryPoint: "fs", targets: [{ format: "rgba32float" }] },
    });
    const src = gpu.makeTarget(4, 4, "rgba32float");
    const dst = gpu.makeTarget(4, 4, "rgba32float");
    const enc = d.createCommandEncoder();
    const pass = enc.beginRenderPass({ colorAttachments: [{ view: dst.createView(), loadOp: "clear", storeOp: "store" }] });
    pass.setPipeline(pipeline);
    pass.setBindGroup(
      0,
      d.createBindGroup({
        layout: bgl,
        entries: [
          { binding: 0, resource: src.createView() },
          { binding: 1, resource: src.createView() },
        ],
      }),
    );
    pass.draw(6);
    const v = gpu.violations.join("\n");
    expect(v).toMatch(/rgba32float to a filterable/);
    expect(v).toMatch(/shader declares uniform 'params' but the layout entry is/);
  });

  it("flags a missing entry point and storage-texture format mismatches", () => {
    const gpu = new FakeGpu();
    const d = gpu.device;
    const module = d.createShaderModule({
      code: `@group(0) @binding(0) var o : texture_storage_2d<rgba8unorm, write>;
             @compute @workgroup_size(1) fn cs() { textureStore(o, vec2i(0), vec4f(1.0)); }`,
    });
    d.createComputePipeline({ layout: "auto", compute: { module, entryPoint: "nope" } });
    expect(gpu.violations.join()).toMatch(/entry point 'nope' not found/);
    const p = d.createComputePipeline({ layout: "auto", compute: { module, entryPoint: "cs" } });
    const t = gpu.makeTarget(4, 4, "rgba32float");
    const pass = d.createCommandEncoder().beginComputePass();
    pass.setPipeline(p);
    pass.setBindGroup(0, d.createBindGroup({ layout: p.getBindGroupLayout(0), entries: [{ binding: 0, resource: t.createView() }] }));
    pass.dispatchWorkgroups(1.5);
    const v = gpu.violations.join("\n");
    expect(v).toMatch(/declared rgba8unorm, bound texture is rgba32float/);
    expect(v).toMatch(/non-integer/);
  });
});
