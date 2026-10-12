// Encodes every registered effect against a recording fake GPUDevice
// (test/fakes/effectsGpuRecorder.ts) and checks the WebGPU validation rules
// a real device would enforce, plus the runtime rules from CLAUDE.md
// ("Effects → Runtime rules"):
//
//  - pipeline target format == attachment format (s8 vs f32 pipeline pick),
//  - bind groups match the WGSL bindings each entry point uses, uniform
//    buffers cover the WGSL struct, the host writes every field the shader
//    reads, u32/f32 slots hold the right kind of bits, no NaN uniforms,
//  - intermediates match the document format (no hard-coded rgba8 scratch
//    on float documents),
//  - per-frame `makeParamsBuf` buffers and scratch textures aren't kept
//    across frames,
//  - `perPixel` effects draw only into dstTex through the scissored helper.
//
// There's no GPU here: shader compilation itself is covered by the E2E run.

import { describe, expect, it } from "vitest";
import { effectRegistry } from "@/core/effects";
import { lutStore } from "@/core/lut";
import { EffectEncoder } from "@/graphics/webgpu/EffectEncoder";
import type { IPipelineEffect } from "@/core/effects/IPipelineEffect";
import type { EffectParamField } from "@/core/effects/_shared/effectParams";
import type { EffectRenderOp, GpuLayer } from "@/graphics/webgpu/rendering/WebGPURenderer";
import type { ParamValue } from "@/core/params/paramTypes";
import type { RGBAColor } from "@/types";
import { FakeGpu, type FakeBuffer, type FakeTexture } from "@tests/fakes/effectsGpuRecorder";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyEffect = IPipelineEffect<any, any>;

const W = 64;
const H = 48;
const FORMATS: GPUTextureFormat[] = ["rgba8unorm", "rgba32float"];
const SWATCHES: RGBAColor[] = [
  { r: 255, g: 0, b: 0, a: 255 },
  { r: 0, g: 0, b: 255, a: 255 },
  { r: 30, g: 200, b: 40, a: 255 },
];

/** Intermediates that are 8-bit by design (not image data). */
const RGBA8_SCRATCH_ALLOWED: Record<string, string> = {
  "film-grain": "the grain noise field is generated and blurred in 8 bits",
};

const effects = effectRegistry.all() as AnyEffect[];

function layerFor(effect: AnyEffect, params: unknown, hasMask = false) {
  return {
    id: `adj-${effect.id}`,
    name: effect.label,
    visible: true,
    type: "adjustment" as const,
    parentId: "parent",
    effectType: effect.id,
    params,
    hasMask,
  };
}

/** Defaults plus each param pushed to its extremes / every option. */
function paramVariants(effect: AnyEffect): [string, unknown][] {
  const defaults = effect.defaultParams;
  const out: [string, unknown][] = [["defaults", { ...defaults }]];
  for (const f of (effect.paramFields ?? []) as readonly EffectParamField<unknown>[]) {
    const s = f.spec;
    const vals: ParamValue[] = [];
    if (s.kind === "float" || s.kind === "int") {
      if (s.min !== undefined) vals.push(s.min);
      if (s.max !== undefined) vals.push(s.max);
    } else if (s.kind === "enum") vals.push(...s.options.map((o) => o.value));
    else if (s.kind === "bool") vals.push(!f.get(defaults));
    else if (s.kind === "color") vals.push([1, 0, 0, 1], [0, 0, 0, 0]);
    else if (s.kind === "vec2") vals.push([0, 0], [1, 1]);
    for (const v of vals) out.push([`${f.id}=${JSON.stringify(v)}`, f.set(defaults, v)]);
  }
  if (effect.id === "lut") {
    for (const lut of lutStore.all()) out.push([`lutId=${lut.id}`, { ...defaults, lutId: lut.id }]);
  }
  return out;
}

interface Harness {
  gpu: FakeGpu;
  engine: EffectEncoder;
  mask: GpuLayer;
  /** Encode one frame (encode → submit → flush → endFrame). */
  frame(entry: unknown, format: GPUTextureFormat): FrameRecord;
}

interface FrameRecord {
  src: FakeTexture;
  dst: FakeTexture;
  newTextures: FakeTexture[];
  paramsBufs: Set<FakeBuffer>;
  commandsFrom: number;
  copiesFrom: number;
}

function harness(format: GPUTextureFormat): Harness {
  const gpu = new FakeGpu();
  const engine = new EffectEncoder(gpu.device, W, H, format);
  const maskTex = gpu.makeTarget(W, H, "rgba8unorm");
  const mask = { id: "mask", texture: maskTex, contentVersion: 1, layerWidth: W, layerHeight: H } as unknown as GpuLayer;

  // Track the buffers makeParamsBuf hands out per frame.
  const rt = engine.runtime;
  const orig = rt.makeParamsBuf.bind(rt);
  let current = new Set<FakeBuffer>();
  rt.makeParamsBuf = (data) => {
    const b = orig(data);
    current.add(b as unknown as FakeBuffer);
    return b;
  };

  return {
    gpu,
    engine,
    mask,
    frame(entry, fmt) {
      const src = gpu.makeTarget(W, H, fmt) as unknown as FakeTexture;
      const dst = gpu.makeTarget(W, H, fmt) as unknown as FakeTexture;
      current = new Set();
      const texFrom = gpu.textures.length;
      const commandsFrom = gpu.commands.length;
      const copiesFrom = gpu.copies.length;
      const encoder = gpu.device.createCommandEncoder();
      engine.encode(encoder, entry as never, src as unknown as GPUTexture, dst as unknown as GPUTexture, fmt);
      gpu.device.queue.submit([encoder.finish()]);
      engine.flushPendingDestroys();
      engine.endFrame();
      return { src, dst, newTextures: gpu.textures.slice(texFrom), paramsBufs: current, commandsFrom, copiesFrom };
    },
  };
}

describe.each(FORMATS)("effect encode on a %s document", (format) => {
  describe.each(effects.map((e) => [e.id, e] as const))("%s", (_id, effect) => {
    it("encodes every param variant, with and without a selection mask, without GPU validation errors", () => {
      const h = harness(format);
      for (const [name, params] of paramVariants(effect)) {
        for (const withMask of [false, true]) {
          h.gpu.context = `${effect.id} [${name}${withMask ? ", masked" : ""}]`;
          const entry = effect.buildPlanEntry(layerFor(effect, params, withMask), {
            swatches: SWATCHES,
            mask: withMask ? h.mask : undefined,
            resolveLayer: () => undefined,
          });
          expect(() => h.frame(entry, format), h.gpu.context).not.toThrow();
        }
      }
      expect(h.gpu.violations).toEqual([]);
    });

    it("writes the result into dstTex and keeps intermediates in the document format", () => {
      const h = harness(format);
      const entry = effect.buildPlanEntry(layerFor(effect, { ...effect.defaultParams }), {
        swatches: SWATCHES,
        mask: undefined,
        resolveLayer: () => undefined,
      });
      const rec = h.frame(entry, format);
      const cmds = h.gpu.commands.slice(rec.commandsFrom);
      const touchesDst =
        cmds.some((c) => c.attachments.includes(rec.dst)) ||
        cmds.some((c) =>
          [...c.bindGroups.values()].some((bg) =>
            bg.entries.some((e) => (e.resource as unknown as { texture?: FakeTexture }).texture === rec.dst),
          ),
        ) ||
        h.gpu.copies.slice(rec.copiesFrom).some((c) => c.dst === rec.dst);
      expect(touchesDst, "nothing writes dstTex").toBe(true);

      if (format === "rgba32float" && !RGBA8_SCRATCH_ALLOWED[effect.id]) {
        const rgba8 = rec.newTextures.filter(
          (t) => t.format === "rgba8unorm" && t.usage & GPUTextureUsage.RENDER_ATTACHMENT,
        );
        expect(rgba8.map((t) => `${t.width}x${t.height}`), "rgba8 render targets on a float document").toEqual([]);
      }
    });

    it("doesn't reuse per-frame params buffers or released textures in the next frame", () => {
      const h = harness(format);
      const entry = effect.buildPlanEntry(layerFor(effect, { ...effect.defaultParams }, true), {
        swatches: SWATCHES,
        mask: h.mask,
        resolveLayer: () => undefined,
      });
      const first = h.frame(entry, format);
      const second = h.frame(entry, format);
      const stale: string[] = [];
      for (const c of h.gpu.commands.slice(second.commandsFrom)) {
        for (const bg of c.bindGroups.values()) {
          for (const e of bg.entries) {
            const buf = (e.resource as unknown as { buffer?: FakeBuffer }).buffer;
            if (buf && first.paramsBufs.has(buf) && !second.paramsBufs.has(buf)) {
              stale.push(`binding ${e.binding} reuses last frame's params buffer #${buf.id}`);
            }
          }
        }
      }
      expect(stale).toEqual([]);
      // Destroyed resources are reported by the recorder.
      expect(h.gpu.violations).toEqual([]);
    });

    if (effect.perPixel) {
      it("perPixel: draws only into dstTex, through the scissored render-pass helper", () => {
        const h = harness(format);
        h.engine.runtime.scissor = { x: 3, y: 4, w: 10, h: 12 };
        // LUT with no LUT selected is a whole-texture copy (which a scissor
        // can't clip, and is still correct); check the drawing path.
        const params =
          effect.id === "lut"
            ? { ...effect.defaultParams, lutId: lutStore.all()[0].id }
            : { ...effect.defaultParams };
        const entry = effect.buildPlanEntry(layerFor(effect, params), {
          swatches: SWATCHES,
          mask: undefined,
          resolveLayer: () => undefined,
        });
        const rec = h.frame(entry, format);
        const cmds = h.gpu.commands.slice(rec.commandsFrom);
        expect(cmds.length).toBeGreaterThan(0);
        for (const c of cmds) {
          expect(c.kind).toBe("draw");
          expect(c.attachments).toEqual([rec.dst]);
          expect(c.scissor).toEqual([3, 4, 10, 12]);
          // Only the pixel's own source texel may be read: a neighbour read
          // would go stale outside the scissor.
          const frag = c.pipeline.stages.at(-1)!;
          const wgsl = frag.module.wgsl();
          const srcName = wgsl.binding(0, 0)?.name;
          expect(srcName).toBeDefined();
          const fns = [...wgsl.reachableFunctions(frag.entryPoint)]
            .map((n) => wgsl.functions.get(n)!.body)
            .join("\n");
          for (const m of fns.matchAll(new RegExp(String.raw`texture(Sample|SampleLevel|Load)\(\s*${srcName}\s*,([^;]*)`, "g"))) {
            const coordArg = m[1] === "Load" ? m[2].split(",")[0] : m[2].split(",")[1];
            expect(coordArg.replace(/\)\s*$/, "").trim(), `${effect.id}: ${m[0]}`).toMatch(/^[\w.]+$/);
          }
        }
        expect(h.gpu.violations).toEqual([]);
      });
    }
  });
});

describe("EffectEncoder lifecycle across all effects", () => {
  it("onFrameEnd / onDestroy run for every effect without throwing and release the runtime", () => {
    const gpu = new FakeGpu();
    const engine = new EffectEncoder(gpu.device, W, H, "rgba32float");
    for (const e of effects) {
      const entry = e.buildPlanEntry(layerFor(e, { ...e.defaultParams }), {
        swatches: SWATCHES,
        mask: undefined,
        resolveLayer: () => undefined,
      });
      const enc = gpu.device.createCommandEncoder();
      engine.encode(enc, entry, gpu.makeTarget(W, H, "rgba32float"), gpu.makeTarget(W, H, "rgba32float"), "rgba32float");
    }
    engine.flushPendingDestroys();
    expect(() => engine.endFrame()).not.toThrow();
    expect(() => engine.destroy()).not.toThrow();
    expect((engine.runtime.intermediate as unknown as FakeTexture).destroyed).toBe(true);
    expect(gpu.violations).toEqual([]);
  });

  it("throws for an op kind with no registered effect", () => {
    const gpu = new FakeGpu();
    const engine = new EffectEncoder(gpu.device, W, H);
    const t = gpu.makeTarget(W, H, "rgba8unorm");
    expect(() =>
      engine.encode(gpu.device.createCommandEncoder(), { kind: "nope" } as never, t, t, "rgba8unorm"),
    ).toThrow(/no effect registered for kind=nope/);
  });
});

describe("custom shader reading another layer by name", () => {
  async function graphSampling(layerName: string) {
    const { createNode, connect, setParam } = await import("@/core/nodes/graphOps");
    const { nodeRegistry } = await import("@/core/nodes");
    const effect = effectRegistry.get("custom-shader")!;
    const base = (effect.defaultParams as { graph: import("@/core/nodes/graphTypes").NodeGraph }).graph;
    const sample = createNode(nodeRegistry.get("sampleLayer")!, 160, 0);
    let graph: typeof base = { ...base, nodes: [...base.nodes, sample] };
    graph = setParam(graph, sample.id, "layer", layerName);
    const output = graph.nodes.find((n) => n.type === "layerOutput")!;
    const r = connect(graph, { node: sample.id, port: "color" }, { node: output.id, port: "color" });
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error("connect failed");
    return { effect: effect as AnyEffect, graph: r.graph };
  }

  it.each(FORMATS)("binds the named layer's texture (or a placeholder) on %s", async (format) => {
    const { effect, graph } = await graphSampling("Texture Source");
    const h = harness(format);
    const source = {
      id: "src-layer",
      texture: h.gpu.makeTarget(W, H, format),
      offsetX: 2,
      offsetY: 3,
      layerWidth: W,
      layerHeight: H,
      contentVersion: 1,
    } as unknown as GpuLayer;
    const layer = layerFor(effect, { ...effect.defaultParams, graph });
    for (const resolved of [{ layer: source, adjustments: [] }, undefined]) {
      const entry = effect.buildPlanEntry(layer, {
        swatches: SWATCHES,
        mask: undefined,
        parentRect: { x: 1, y: 1, width: 10, height: 10 },
        resolveLayer: (name: string) => (name === "Texture Source" ? resolved : undefined),
      });
      expect(entry.sourceLayers).toEqual([resolved ?? null]);
      const rec = h.frame(entry, format);
      const cmd = h.gpu.commands[rec.commandsFrom];
      // The graph compiled (not the passthrough fallback).
      expect(cmd.pipeline.stages.at(-1)!.module.code).toMatch(/ng_layer0/);
      const bound = cmd.bindGroups.get(0)!.entries.map((e) => (e.resource as unknown as { texture?: unknown }).texture);
      expect(bound).toContain(resolved ? source.texture : rec.src);
    }
    expect(h.gpu.violations).toEqual([]);
  });

  it.each(FORMATS)("binds a source with effects as rendered by the executor on %s", async (format) => {
    const { effect, graph } = await graphSampling("Texture Source");
    const h = harness(format);
    const raw = { id: "src-layer", texture: h.gpu.makeTarget(W, H, format), offsetX: 2, offsetY: 3 } as unknown as GpuLayer;
    const rendered = h.gpu.makeTarget(W, H, format) as unknown as GPUTexture;
    const fx = { kind: "color-invert", layerId: "fx", visible: true, params: {} } as unknown as EffectRenderOp;
    const source = { layer: raw, adjustments: [fx] };
    const calls: unknown[] = [];
    h.engine.sourceRenderer = (_enc, s) => {
      calls.push(s);
      return rendered;
    };
    const entry = effect.buildPlanEntry(layerFor(effect, { ...effect.defaultParams, graph }), {
      swatches: SWATCHES,
      mask: undefined,
      resolveLayer: () => source,
    });
    const rec = h.frame(entry, format);
    expect(calls).toEqual([source]);
    const cmd = h.gpu.commands[rec.commandsFrom];
    const bound = cmd.bindGroups.get(0)!.entries.map((e) => (e.resource as unknown as { texture?: unknown }).texture);
    expect(bound).toContain(rendered);
    expect(bound).not.toContain(raw.texture);
    expect(h.gpu.violations).toEqual([]);
  });
});

describe("custom shader with intermediate passes (Blur Color)", () => {
  async function blurGraph(radius: number) {
    const { GraphBuilder } = await import("@tests/fakes/nodesGraphKit");
    const b = new GraphBuilder("shader");
    const input = b.add("layerInput");
    const blur = b.add("blurColor", { radius });
    const out = b.add("layerOutput");
    b.link(input, "color", blur, "color").link(blur, "color", out, "color");
    return b.graph;
  }
  const entryOf = (cmd: { pipeline: { stages: { entryPoint: string }[] } }) => cmd.pipeline.stages.at(-1)!.entryPoint;
  const boundTextures = (cmd: { bindGroups: Map<number, { entries: GPUBindGroupEntry[] }> }) =>
    cmd.bindGroups.get(0)!.entries.map((e) => (e.resource as unknown as { texture?: unknown }).texture);

  it.each(FORMATS)("renders the pass, blurs it, then the main pass reads it on %s", async (format) => {
    const effect = effectRegistry.get("custom-shader")! as AnyEffect;
    const h = harness(format);
    const entry = effect.buildPlanEntry(layerFor(effect, { ...effect.defaultParams, graph: await blurGraph(6) }), {
      swatches: SWATCHES,
      mask: h.mask,
      resolveLayer: () => undefined,
    });
    const rec = h.frame(entry, format);
    const cmds = h.gpu.commands.slice(rec.commandsFrom);
    expect(cmds.map(entryOf)).toEqual(["fs_custom_pass0", "fs_gaussian_h", "fs_gaussian_v", "fs_custom_shader"]);
    // The pass renders into a document-format scratch texture, which the
    // blur reads; the main pass reads the blur's output and writes dstTex.
    const passOut = cmds[0].attachments[0];
    expect(passOut.format).toBe(format);
    expect(boundTextures(cmds[1])).toContain(passOut);
    const blurred = cmds[2].attachments[0];
    expect(cmds[3].attachments).toEqual([rec.dst]);
    expect(boundTextures(cmds[3])).toContain(blurred);
    expect(h.gpu.violations).toEqual([]);
  });

  it("skips the blur at radius 0 and stays one pass without Blur Color", async () => {
    const effect = effectRegistry.get("custom-shader")! as AnyEffect;
    const h = harness("rgba8unorm");
    const frame = (graph: unknown) => {
      const entry = effect.buildPlanEntry(layerFor(effect, { ...effect.defaultParams, graph }), {
        swatches: SWATCHES,
        mask: undefined,
        resolveLayer: () => undefined,
      });
      const rec = h.frame(entry, "rgba8unorm");
      return h.gpu.commands.slice(rec.commandsFrom).map(entryOf);
    };
    expect(frame(await blurGraph(0))).toEqual(["fs_custom_pass0", "fs_custom_shader"]);
    expect(frame((effect.defaultParams as { graph: unknown }).graph)).toEqual(["fs_custom_shader"]);
    expect(h.gpu.violations).toEqual([]);
  });
});
