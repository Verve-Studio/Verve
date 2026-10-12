// Fake, recording GPUDevice for effect / renderer unit tests.
//
// Every object it hands out is a plain JS object cast to the WebGPU type.
// Draws and dispatches are checked as they are recorded against the rules a
// real device validates (attachment format vs pipeline target, resource
// usage flags, destroyed resources, bind groups vs the shader's declared and
// used bindings, uniform buffer sizes vs the WGSL struct). Problems are
// collected in `violations` instead of thrown so a test can report them all.

import { WgslModule } from "./effectsWgsl";

export interface FakeTexture {
  readonly __fake: "texture";
  readonly id: number;
  label?: string;
  width: number;
  height: number;
  depthOrArrayLayers: number;
  format: GPUTextureFormat;
  usage: number;
  dimension: GPUTextureDimension;
  mipLevelCount: number;
  sampleCount: number;
  destroyed: boolean;
  createView(desc?: GPUTextureViewDescriptor): FakeView;
  destroy(): void;
}

export interface FakeView {
  readonly __fake: "view";
  texture: FakeTexture;
}

export interface FakeBuffer {
  readonly __fake: "buffer";
  readonly id: number;
  size: number;
  usage: number;
  destroyed: boolean;
  mapState: GPUBufferMapState;
  /** Byte length of the most recent `queue.writeBuffer` at offset 0. */
  writtenBytes: number;
  lastWrite: Uint8Array | null;
  getMappedRange(): ArrayBuffer;
  unmap(): void;
  mapAsync(): Promise<void>;
  destroy(): void;
}

export interface FakeSampler {
  readonly __fake: "sampler";
  desc: GPUSamplerDescriptor;
}

export interface FakeModule {
  readonly __fake: "module";
  code: string;
  wgsl(): WgslModule;
  getCompilationInfo(): Promise<GPUCompilationInfo>;
}

export interface FakeBGL {
  readonly __fake: "bgl";
  /** Explicit layout entries; null for an auto-layout pipeline's group. */
  entries: GPUBindGroupLayoutEntry[] | null;
  pipeline?: FakePipeline;
  group?: number;
}

export interface FakePipeline {
  readonly __fake: "pipeline";
  kind: "render" | "compute";
  auto: boolean;
  layout: GPUPipelineLayout | "auto";
  /** (module, entry point) of each stage. */
  stages: { module: FakeModule; entryPoint: string }[];
  targets: GPUTextureFormat[];
  getBindGroupLayout(i: number): FakeBGL;
}

export interface FakeBindGroup {
  readonly __fake: "bindGroup";
  layout: FakeBGL;
  entries: GPUBindGroupEntry[];
}

export interface RecordedCommand {
  kind: "draw" | "dispatch";
  pipeline: FakePipeline;
  bindGroups: Map<number, FakeBindGroup>;
  attachments: FakeTexture[];
  scissor: [number, number, number, number] | null;
}

type Violation = string;

let nextId = 1;

function makeTexture(desc: GPUTextureDescriptor): FakeTexture {
  const size = desc.size as GPUExtent3DDict | number[];
  const width = Array.isArray(size) ? size[0] : size.width;
  const height = Array.isArray(size) ? (size[1] ?? 1) : (size.height ?? 1);
  const tex: FakeTexture = {
    __fake: "texture",
    id: nextId++,
    label: desc.label,
    width,
    height,
    depthOrArrayLayers: 1,
    format: desc.format,
    usage: desc.usage,
    dimension: desc.dimension ?? "2d",
    mipLevelCount: desc.mipLevelCount ?? 1,
    sampleCount: desc.sampleCount ?? 1,
    destroyed: false,
    createView: () => ({ __fake: "view", texture: tex }),
    destroy: () => {
      tex.destroyed = true;
    },
  };
  return tex;
}

/** Texture formats that are not filterable without `float32-filterable`. */
const UNFILTERABLE = new Set<GPUTextureFormat>(["rgba32float", "r32float", "rg32float"]);

export class FakeGpu {
  readonly violations: Violation[] = [];
  readonly commands: RecordedCommand[] = [];
  readonly textures: FakeTexture[] = [];
  readonly buffers: FakeBuffer[] = [];
  /** Every `copyTextureToTexture`, in order. */
  readonly copies: { src: FakeTexture; dst: FakeTexture }[] = [];
  readonly writes: { buffer: FakeBuffer; bytes: number }[] = [];
  readonly device: GPUDevice;
  /** Prefix added to every violation (e.g. the effect id). */
  context = "";

  constructor() {
    const self = this;
    const queue = {
      writeBuffer(
        buffer: FakeBuffer,
        offset: number,
        data: ArrayBuffer | ArrayBufferView,
        dataOffset = 0,
        size?: number,
      ) {
        const bytes =
          data instanceof ArrayBuffer
            ? new Uint8Array(data)
            : new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
        const elem = data instanceof ArrayBuffer ? 1 : ((data as unknown as { BYTES_PER_ELEMENT?: number }).BYTES_PER_ELEMENT ?? 1);
        const start = dataOffset * elem;
        const len = size !== undefined ? size * elem : bytes.byteLength - start;
        if (buffer.destroyed) self.fail(`writeBuffer into a destroyed buffer #${buffer.id}`);
        if (offset + len > buffer.size) {
          self.fail(`writeBuffer of ${len} bytes at ${offset} overruns buffer #${buffer.id} (${buffer.size} bytes)`);
        }
        if (offset === 0) {
          buffer.writtenBytes = len;
          buffer.lastWrite = bytes.slice(start, start + len);
        }
        self.writes.push({ buffer, bytes: len });
      },
      writeTexture(dst: GPUTexelCopyTextureInfo) {
        const t = dst.texture as unknown as FakeTexture;
        if (t.destroyed) self.fail(`writeTexture into destroyed texture #${t.id}`);
        if (!(t.usage & GPUTextureUsage.COPY_DST)) self.fail(`writeTexture into texture #${t.id} without COPY_DST`);
      },
      submit() {},
      onSubmittedWorkDone: () => Promise.resolve(),
      copyExternalImageToTexture() {},
    };
    const device = {
      __fake: "device",
      label: "fake",
      features: new Set<string>(),
      limits: {
        maxTextureDimension2D: 16384,
        maxBufferSize: 2 ** 31,
        maxStorageBufferBindingSize: 2 ** 27,
        maxUniformBufferBindingSize: 65536,
        maxComputeWorkgroupsPerDimension: 65535,
        maxBindGroups: 4,
      },
      queue,
      lost: new Promise(() => {}),
      pushErrorScope() {},
      popErrorScope: () => Promise.resolve(null),
      addEventListener() {},
      removeEventListener() {},
      destroy() {},
      createTexture(desc: GPUTextureDescriptor) {
        const t = makeTexture(desc);
        self.textures.push(t);
        return t;
      },
      createBuffer(desc: GPUBufferDescriptor) {
        const buf: FakeBuffer = {
          __fake: "buffer",
          id: nextId++,
          size: desc.size,
          usage: desc.usage,
          destroyed: false,
          mapState: desc.mappedAtCreation ? "mapped" : "unmapped",
          writtenBytes: 0,
          lastWrite: null,
          getMappedRange: () => new ArrayBuffer(desc.size),
          unmap: () => {
            buf.mapState = "unmapped";
          },
          mapAsync: () => Promise.resolve(),
          destroy: () => {
            buf.destroyed = true;
          },
        };
        self.buffers.push(buf);
        return buf;
      },
      createSampler(desc: GPUSamplerDescriptor = {}) {
        return { __fake: "sampler", desc } satisfies FakeSampler;
      },
      createShaderModule(desc: GPUShaderModuleDescriptor) {
        let parsed: WgslModule | null = null;
        const mod: FakeModule = {
          __fake: "module",
          code: desc.code,
          wgsl: () => (parsed ??= new WgslModule(desc.code)),
          getCompilationInfo: () => Promise.resolve({ messages: [] } as unknown as GPUCompilationInfo),
        };
        return mod;
      },
      createBindGroupLayout(desc: GPUBindGroupLayoutDescriptor) {
        return { __fake: "bgl", entries: [...desc.entries] } satisfies FakeBGL;
      },
      createPipelineLayout(desc: GPUPipelineLayoutDescriptor) {
        return { __fake: "pipelineLayout", bindGroupLayouts: desc.bindGroupLayouts };
      },
      createRenderPipeline(desc: GPURenderPipelineDescriptor) {
        return self.makePipeline("render", desc.layout, [
          { module: desc.vertex.module as unknown as FakeModule, entryPoint: desc.vertex.entryPoint ?? "" },
          ...(desc.fragment
            ? [{ module: desc.fragment.module as unknown as FakeModule, entryPoint: desc.fragment.entryPoint ?? "" }]
            : []),
        ], (desc.fragment?.targets ?? []).map((t) => t!.format));
      },
      createRenderPipelineAsync(desc: GPURenderPipelineDescriptor) {
        return Promise.resolve(device.createRenderPipeline(desc));
      },
      createComputePipeline(desc: GPUComputePipelineDescriptor) {
        return self.makePipeline("compute", desc.layout, [
          { module: desc.compute.module as unknown as FakeModule, entryPoint: desc.compute.entryPoint ?? "" },
        ], []);
      },
      createComputePipelineAsync(desc: GPUComputePipelineDescriptor) {
        return Promise.resolve(device.createComputePipeline(desc));
      },
      createBindGroup(desc: GPUBindGroupDescriptor) {
        return {
          __fake: "bindGroup",
          layout: desc.layout as unknown as FakeBGL,
          entries: [...desc.entries],
        } satisfies FakeBindGroup;
      },
      createCommandEncoder: () => self.makeEncoder(),
    };
    this.device = device as unknown as GPUDevice;
  }

  fail(msg: string): void {
    this.violations.push(this.context ? `${this.context}: ${msg}` : msg);
  }

  /** A texture with the usages the render-plan executor gives its
   *  ping-pong targets. */
  makeTarget(w: number, h: number, format: GPUTextureFormat): GPUTexture {
    return this.device.createTexture({
      size: { width: w, height: h },
      format,
      usage:
        GPUTextureUsage.TEXTURE_BINDING |
        GPUTextureUsage.COPY_DST |
        GPUTextureUsage.COPY_SRC |
        GPUTextureUsage.STORAGE_BINDING |
        GPUTextureUsage.RENDER_ATTACHMENT,
    });
  }

  private makePipeline(
    kind: "render" | "compute",
    layout: GPUPipelineLayout | "auto",
    stages: { module: FakeModule; entryPoint: string }[],
    targets: GPUTextureFormat[],
  ): FakePipeline {
    const auto = layout === "auto";
    const groups = new Map<number, FakeBGL>();
    const pipeline: FakePipeline = {
      __fake: "pipeline",
      kind,
      auto,
      layout,
      stages,
      targets,
      getBindGroupLayout: (i: number) => {
        if (!auto) {
          const bgls = (layout as unknown as { bindGroupLayouts: FakeBGL[] }).bindGroupLayouts;
          return bgls[i];
        }
        let g = groups.get(i);
        if (!g) {
          g = { __fake: "bgl", entries: null, pipeline, group: i };
          groups.set(i, g);
        }
        return g;
      },
    };
    for (const s of stages) {
      if (!s.module.wgsl().functions.get(s.entryPoint)) {
        this.fail(`${kind} pipeline entry point '${s.entryPoint}' not found in its module`);
      }
    }
    return pipeline;
  }

  private makeEncoder(): GPUCommandEncoder {
    const self = this;
    const passBase = (kind: "draw" | "dispatch", attachments: FakeTexture[]) => {
      let pipeline: FakePipeline | null = null;
      const bindGroups = new Map<number, FakeBindGroup>();
      let scissor: [number, number, number, number] | null = null;
      const record = () => {
        if (!pipeline) {
          self.fail(`${kind} without a pipeline`);
          return;
        }
        const cmd: RecordedCommand = { kind, pipeline, bindGroups: new Map(bindGroups), attachments, scissor };
        self.commands.push(cmd);
        self.validate(cmd);
      };
      return {
        setPipeline(p: FakePipeline) {
          pipeline = p;
        },
        setBindGroup(i: number, bg: FakeBindGroup) {
          bindGroups.set(i, bg);
        },
        setScissorRect(x: number, y: number, w: number, h: number) {
          scissor = [x, y, w, h];
        },
        setViewport() {},
        setVertexBuffer() {},
        setIndexBuffer() {},
        setBlendConstant() {},
        setStencilReference() {},
        draw: record,
        drawIndexed: record,
        dispatchWorkgroups(x: number, y = 1, z = 1) {
          if (![x, y, z].every((n) => Number.isInteger(n) && n >= 0)) {
            self.fail(`dispatchWorkgroups(${x}, ${y}, ${z}) has a non-integer / negative count`);
          }
          record();
        },
        end() {},
        pushDebugGroup() {},
        popDebugGroup() {},
        insertDebugMarker() {},
      };
    };
    const enc = {
      beginRenderPass(desc: GPURenderPassDescriptor) {
        const attachments = [...desc.colorAttachments].map((a) => (a!.view as unknown as FakeView).texture);
        return passBase("draw", attachments);
      },
      beginComputePass() {
        return passBase("dispatch", []);
      },
      copyTextureToTexture(src: GPUTexelCopyTextureInfo, dst: GPUTexelCopyTextureInfo, size: GPUExtent3D) {
        const s = src.texture as unknown as FakeTexture;
        const d = dst.texture as unknown as FakeTexture;
        self.copies.push({ src: s, dst: d });
        if (s.destroyed || d.destroyed) self.fail("copyTextureToTexture with a destroyed texture");
        if (!(s.usage & GPUTextureUsage.COPY_SRC)) self.fail(`copyTextureToTexture source #${s.id} lacks COPY_SRC`);
        if (!(d.usage & GPUTextureUsage.COPY_DST)) self.fail(`copyTextureToTexture destination #${d.id} lacks COPY_DST`);
        if (s.format !== d.format) self.fail(`copyTextureToTexture between formats ${s.format} → ${d.format}`);
        const e = size as GPUExtent3DDict;
        const w = Array.isArray(size) ? size[0] : e.width;
        const h = Array.isArray(size) ? (size[1] ?? 1) : (e.height ?? 1);
        const so = (src.origin ?? {}) as GPUOrigin3DDict;
        const dO = (dst.origin ?? {}) as GPUOrigin3DDict;
        if ((so.x ?? 0) + w > s.width || (so.y ?? 0) + h > s.height) self.fail("copyTextureToTexture reads out of source bounds");
        if ((dO.x ?? 0) + w > d.width || (dO.y ?? 0) + h > d.height) self.fail("copyTextureToTexture writes out of destination bounds");
      },
      copyBufferToTexture() {},
      copyTextureToBuffer() {},
      copyBufferToBuffer() {},
      clearBuffer() {},
      resolveQuerySet() {},
      pushDebugGroup() {},
      popDebugGroup() {},
      insertDebugMarker() {},
      finish: () => ({ __fake: "commandBuffer" }),
    };
    return enc as unknown as GPUCommandEncoder;
  }

  private validate(cmd: RecordedCommand): void {
    const { pipeline } = cmd;
    // ── Attachments ──────────────────────────────────────────────────────
    if (cmd.kind === "draw") {
      if (cmd.attachments.length !== pipeline.targets.length) {
        this.fail(`draw with ${cmd.attachments.length} attachments into a pipeline with ${pipeline.targets.length} targets`);
      }
      cmd.attachments.forEach((t, i) => {
        if (t.destroyed) this.fail(`render attachment #${t.id} was destroyed`);
        if (!(t.usage & GPUTextureUsage.RENDER_ATTACHMENT)) this.fail(`render attachment #${t.id} lacks RENDER_ATTACHMENT`);
        if (pipeline.targets[i] && pipeline.targets[i] !== t.format) {
          this.fail(`pipeline '${this.entryOf(pipeline)}' targets ${pipeline.targets[i]} but draws into a ${t.format} attachment`);
        }
      });
    }

    // ── Bind groups vs shader ────────────────────────────────────────────
    const used = new Map<string, { group: number; binding: number; wgsl: WgslModule; decl: ReturnType<WgslModule["binding"]> }>();
    for (const s of pipeline.stages) {
      const mod = s.module.wgsl();
      for (const b of mod.usedBindings([s.entryPoint])) {
        used.set(`${b.group}:${b.binding}`, { group: b.group, binding: b.binding, wgsl: mod, decl: b });
      }
    }
    const usedGroups = new Set([...used.values()].map((u) => u.group));
    for (const g of usedGroups) {
      if (!cmd.bindGroups.has(g)) this.fail(`'${this.entryOf(pipeline)}' uses group ${g} but none is set`);
    }

    for (const [g, bg] of cmd.bindGroups) {
      const layoutEntries = this.layoutEntriesFor(pipeline, g, used);
      if (bg.layout.entries === null && bg.layout.pipeline && bg.layout.pipeline !== pipeline) {
        // Auto layouts are only compatible with their own pipeline.
        const otherEntries = this.layoutEntriesFor(bg.layout.pipeline, g, null);
        if (!sameBindings(otherEntries, layoutEntries)) {
          this.fail(`bind group made for another auto-layout pipeline used with '${this.entryOf(pipeline)}'`);
        }
      }
      const provided = new Set(bg.entries.map((e) => e.binding));
      const expected = new Set(layoutEntries);
      for (const b of expected) {
        if (!provided.has(b)) this.fail(`'${this.entryOf(pipeline)}' group ${g} binding ${b} missing from the bind group`);
      }
      for (const b of provided) {
        if (!expected.has(b)) this.fail(`'${this.entryOf(pipeline)}' group ${g} binding ${b} is not in the layout`);
      }
      for (const e of bg.entries) {
        const decl = this.declFor(pipeline, g, e.binding);
        const explicit = bg.layout.entries?.find((le) => le.binding === e.binding);
        this.checkEntry(pipeline, g, e, decl, explicit, cmd.attachments);
      }
    }
  }

  private entryOf(p: FakePipeline): string {
    return p.stages[p.stages.length - 1]?.entryPoint ?? "?";
  }

  private declFor(p: FakePipeline, group: number, binding: number) {
    for (const s of p.stages) {
      const d = s.module.wgsl().binding(group, binding);
      if (d) return { decl: d, wgsl: s.module.wgsl() };
    }
    return null;
  }

  /** Binding indices the pipeline's layout has in `group`. */
  private layoutEntriesFor(
    p: FakePipeline,
    group: number,
    used: Map<string, { group: number; binding: number }> | null,
  ): number[] {
    if (!p.auto) {
      const bgl = p.getBindGroupLayout(group);
      return (bgl?.entries ?? []).map((e) => e.binding);
    }
    let u = used;
    if (!u) {
      u = new Map();
      for (const s of p.stages) {
        for (const b of s.module.wgsl().usedBindings([s.entryPoint])) u.set(`${b.group}:${b.binding}`, b);
      }
    }
    return [...u.values()].filter((b) => b.group === group).map((b) => b.binding);
  }

  private checkEntry(
    p: FakePipeline,
    group: number,
    e: GPUBindGroupEntry,
    found: { decl: NonNullable<ReturnType<WgslModule["binding"]>>; wgsl: WgslModule } | null,
    explicit: GPUBindGroupLayoutEntry | undefined,
    attachments: FakeTexture[],
  ): void {
    const where = `'${this.entryOf(p)}' @group(${group}) @binding(${e.binding})`;
    const res = e.resource as unknown as { __fake?: string; buffer?: FakeBuffer; offset?: number; size?: number };
    const kindOf = (): string => {
      if (res.__fake === "view") return "texture";
      if (res.__fake === "texture") return "texture";
      if (res.__fake === "sampler") return "sampler";
      if (res.buffer || res.__fake === "buffer") return "buffer";
      return "unknown";
    };
    const rk = kindOf();
    const tex =
      res.__fake === "view" ? (res as unknown as FakeView).texture : res.__fake === "texture" ? (res as unknown as FakeTexture) : null;
    const buf = res.buffer ?? (res.__fake === "buffer" ? (res as unknown as FakeBuffer) : null);

    if (tex) {
      if (tex.destroyed) this.fail(`${where} binds destroyed texture #${tex.id}`);
      if (attachments.includes(tex)) this.fail(`${where} samples texture #${tex.id} that is also the pass's render attachment`);
    }
    if (buf?.destroyed) this.fail(`${where} binds destroyed buffer #${buf.id}`);

    if (explicit) {
      const ek = explicit.buffer ? "buffer" : explicit.texture ? "texture" : explicit.storageTexture ? "texture" : explicit.sampler ? "sampler" : "?";
      if (ek !== rk) this.fail(`${where} layout expects a ${ek}, got a ${rk}`);
      if (explicit.texture && tex && explicit.texture.sampleType === "float" && UNFILTERABLE.has(tex.format)) {
        this.fail(`${where} binds ${tex.format} to a filterable ('float') layout entry; needs float32-filterable`);
      }
      if (explicit.texture && tex && explicit.texture.sampleType === "unfilterable-float" && /uint|sint/.test(tex.format)) {
        this.fail(`${where} binds integer ${tex.format} to a float layout entry`);
      }
    }

    if (!found) return;
    const { decl, wgsl } = found;
    if (explicit) {
      const ok =
        (decl.kind === "uniform" && explicit.buffer?.type === "uniform") ||
        (decl.kind === "storage" &&
          (explicit.buffer?.type === "read-only-storage" || explicit.buffer?.type === "storage")) ||
        (decl.kind === "texture" && !!explicit.texture) ||
        (decl.kind === "storage-texture" && !!explicit.storageTexture) ||
        (decl.kind === "sampler" && !!explicit.sampler);
      if (!ok) this.fail(`${where} shader declares ${decl.kind} '${decl.name}' but the layout entry is ${JSON.stringify(explicit)}`);
    }
    const want = decl.kind === "uniform" || decl.kind === "storage" ? "buffer" : decl.kind === "storage-texture" ? "texture" : decl.kind;
    if (want !== "other" && want !== rk) {
      this.fail(`${where} shader declares ${decl.kind} '${decl.name}', bind group gives a ${rk}`);
      return;
    }
    if (decl.kind === "uniform" && buf) {
      if (!(buf.usage & GPUBufferUsage.UNIFORM)) this.fail(`${where} buffer lacks UNIFORM usage`);
      const lay = wgsl.layout(decl.type);
      const avail = res.size ?? buf.size - (res.offset ?? 0);
      if (lay && avail < lay.size) {
        this.fail(`${where} uniform '${decl.name}: ${decl.type}' needs ${lay.size} bytes, buffer binding has ${avail}`);
      }
      const need = wgsl.meaningfulBytes(decl.type);
      if (need !== null && buf.lastWrite && buf.writtenBytes < need) {
        this.fail(`${where} uniform '${decl.name}: ${decl.type}' reads ${need} bytes, host wrote only ${buf.writtenBytes}`);
      }
      if (buf.lastWrite) this.checkSlotTypes(where, wgsl, decl.type, buf.lastWrite);
    }
    if (decl.kind === "storage" && buf) {
      if (!(buf.usage & GPUBufferUsage.STORAGE)) this.fail(`${where} buffer lacks STORAGE usage`);
      const lay = wgsl.layout(decl.type);
      const avail = res.size ?? buf.size - (res.offset ?? 0);
      if (lay && avail < lay.size) this.fail(`${where} storage '${decl.name}' needs ${lay.size} bytes, has ${avail}`);
    }
    if (decl.kind === "texture" && tex) {
      if (!(tex.usage & GPUTextureUsage.TEXTURE_BINDING)) this.fail(`${where} texture #${tex.id} lacks TEXTURE_BINDING`);
      const sampled = /<\s*(\w+)\s*>/.exec(decl.type)?.[1];
      const isInt = /uint|sint/.test(tex.format);
      if (sampled === "f32" && isInt) this.fail(`${where} f32 texture binding gets integer ${tex.format}`);
      if ((sampled === "u32" || sampled === "i32") && !isInt) this.fail(`${where} ${sampled} texture binding gets ${tex.format}`);
    }
    if (decl.kind === "storage-texture" && tex) {
      if (!(tex.usage & GPUTextureUsage.STORAGE_BINDING)) this.fail(`${where} texture #${tex.id} lacks STORAGE_BINDING`);
      if (decl.storageFormat && decl.storageFormat !== tex.format) {
        this.fail(`${where} storage texture declared ${decl.storageFormat}, bound texture is ${tex.format}`);
      }
    }
  }

  /** Bit patterns that show a host wrote a float into a u32/i32 member (e.g.
   *  1.0 → 0x3f800000) or an integer into an f32 member (small integers are
   *  f32 denormals, which no host computes on purpose). Members whose name
   *  says they hold hashes / seeds / bit masks are skipped. */
  private checkSlotTypes(where: string, wgsl: WgslModule, type: string, bytes: Uint8Array): void {
    const s = wgsl.structLayout(type.trim());
    if (!s) return;
    const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    for (const m of s.members) {
      if (m.offset + 4 > bytes.byteLength || /seed|hash|bits|mask/i.test(m.name)) continue;
      const t = m.type.replace(/\s/g, "");
      const u = dv.getUint32(m.offset, true);
      if ((t === "u32" || t === "i32") && u >= 0x3a800000 && u <= 0x4f000000) {
        this.fail(`${where} ${type}.${m.name} is ${t} but holds float bits (${dv.getFloat32(m.offset, true)})`);
      }
      if (t === "f32" && u !== 0 && u !== 0x80000000 && (u & 0x7f800000) === 0) {
        this.fail(`${where} ${type}.${m.name} is f32 but holds integer bits (${u})`);
      }
      if (t === "f32" && (u & 0x7f800000) === 0x7f800000) {
        this.fail(`${where} ${type}.${m.name} is ${dv.getFloat32(m.offset, true)}`);
      }
    }
  }
}


function sameBindings(a: number[], b: number[]): boolean {
  return a.length === b.length && [...a].sort().join() === [...b].sort().join();
}
