import "@/core/nodes";
import type { EffectLayerOf } from "@/types";
import type { EffectRenderOp } from "@/graphics/webgpu/rendering/WebGPURenderer";
import type { IPipelineEffect } from "../IPipelineEffect";
import type { NodeGraph, ParamValue } from "@/core/nodes/graphTypes";
import { resolveArgumentValue } from "@/core/nodes/graphArguments";
import { packValue } from "@/core/nodes/wgsl";
import { CustomShaderPanel } from "./CustomShaderPanel";
import { newGraphId } from "@/core/nodes/graphTypes";
import { nodeRegistry } from "@/core/nodes/nodeRegistry";
import { connect, createNode } from "@/core/nodes/graphOps";
import {
  CONTEXT_SLOTS,
  compileShaderGraph,
  writeShaderContext,
  type ShaderCompileResult,
} from "@/core/nodes/shaderCompiler";
import { STD_BINDINGS } from "@/graphics/webgpu/EffectRuntime";
import { PASSTHROUGH_SOURCE, assembleShaderSource } from "./customShaderSource";
import { DEFAULT_INFO } from "./effectFile";
import { EffectFallbackIcon } from "../_shared/icons";
import { openShaderGraph } from "./openShaderGraph";
import { customShaderStatus } from "./customShaderStatus";

/** A node-graph shader applied to the parent layer. The graph is edited in
 *  the node editor and stored in the layer, so it saves with the document. */
export interface CustomShaderParams {
  graph: NodeGraph;
  /** The `.effect` file the graph was opened from / last saved to; the
   *  editor's Save overwrites it. Absent for new graphs and read-only
   *  (bundled) effects. */
  source?: string;
  /** This layer's values for the graph's arguments, by argument id
   *  (missing = the argument's default). */
  args?: Readonly<Record<string, ParamValue>>;
  /** Applied as a finished effect (Effects → Custom Effects): opening the
   *  layer shows its settings window; the graph is edited from there. A
   *  new Custom Shader opens straight in the node editor. */
  asEffect?: boolean;
}

export type CustomShaderEffectLayer = EffectLayerOf<"custom-shader", CustomShaderParams>;

type CustomShaderOp = Extract<EffectRenderOp, { kind: "custom-shader" }>;

/** Layer Input → Layer Output: renders the layer unchanged. */
function starterGraph(): NodeGraph {
  const input = createNode(nodeRegistry.get("layerInput")!, 0, 0);
  const output = createNode(nodeRegistry.get("layerOutput")!, 320, 0);
  let graph: NodeGraph = {
    id: newGraphId(),
    name: "Custom Shader",
    domain: "shader",
    nodes: [input, output],
    edges: [],
    info: DEFAULT_INFO,
  };
  for (const port of ["color", "alpha"]) {
    const r = connect(graph, { node: input.id, port }, { node: output.id, port });
    if (r.ok) graph = r.graph;
  }
  return graph;
}

interface Program {
  /** Complete WGSL module. */
  source: string;
  uniforms: Float32Array;
  /** Uniform slot of each argument the shader reads. */
  argumentSlots: ReadonlyMap<string, number>;
}

/** Renders the layer unchanged while its graph doesn't compile. */
const PASSTHROUGH: Program = {
  source: PASSTHROUGH_SOURCE,
  uniforms: new Float32Array(CONTEXT_SLOTS * 4),
  argumentSlots: new Map(),
};

// Graphs are immutable, so a compile is cached on the graph object and
// redone only when the user edits it. Index 0 = sRGB target, 1 = linear.
const programs = new WeakMap<NodeGraph, [Program | null, Program | null]>();
/** Sources the GPU rejected; rendered as passthrough from then on. */
const gpuRejected = new Set<string>();

function programFor(graph: NodeGraph, linear: boolean): Program | null {
  let entry = programs.get(graph);
  if (!entry) {
    entry = [null, null];
    programs.set(graph, entry);
  }
  const i = linear ? 1 : 0;
  if (!entry[i]) {
    const r: ShaderCompileResult = compileShaderGraph(graph, { linear });
    entry[i] = r.ok
      ? {
          source: assembleShaderSource(r.code, r.uniforms.length / 4),
          uniforms: r.uniforms,
          argumentSlots: r.argumentSlots,
        }
      : PASSTHROUGH;
  }
  return entry[i];
}

export const CustomShaderEffect: IPipelineEffect<CustomShaderEffectLayer, CustomShaderOp> = {
  id: "custom-shader",
  label: "Custom Shader…",
  menu: { root: "effects", submenu: "fx-custom" },
  defaultParams: { graph: starterGraph() },

  buildPlanEntry(layer, { mask, parentRect }) {
    return {
      kind: "custom-shader",
      layerId: layer.id,
      visible: layer.visible,
      selMaskLayer: mask,
      params: layer.params,
      parentX: parentRect?.x ?? 0,
      parentY: parentRect?.y ?? 0,
      parentW: parentRect?.width ?? 0,
      parentH: parentRect?.height ?? 0,
    };
  },

  encode({ engine, encoder, srcTex, dstTex, format }, entry) {
    const linear = format === "rgba32float" || format === "rgba16float";
    let program = programFor(entry.params.graph, linear) ?? PASSTHROUGH;
    if (gpuRejected.has(program.source)) program = PASSTHROUGH;
    else if (program !== PASSTHROUGH) customShaderStatus.setGpuError(entry.layerId, null);

    const source = program.source;
    const pair = engine.runtime.getRenderPipelinePairForSource(
      source,
      "fs_custom_shader",
      STD_BINDINGS,
      (message) => {
        console.error(`[custom-shader] WGSL compile error:\n${message}\n${source}`);
        gpuRejected.add(source);
        customShaderStatus.setGpuError(entry.layerId, message);
      },
    );
    // Per-frame context (canvas size, parent layer rect) in the reserved
    // leading uniform slots.
    const uniforms = program.uniforms.slice();
    const whole = entry.parentW <= 0;
    writeShaderContext(uniforms, {
      width: srcTex.width,
      height: srcTex.height,
      layerX: whole ? 0 : entry.parentX,
      layerY: whole ? 0 : entry.parentY,
      layerWidth: whole ? srcTex.width : entry.parentW,
      layerHeight: whole ? srcTex.height : entry.parentH,
      isFloat: linear,
    });
    // The layer's argument values (clamped to their ranges) go into their
    // slots: changing one never rebuilds the shader.
    for (const [id, slot] of program.argumentSlots) {
      const arg = entry.params.graph.arguments?.find((a) => a.id === id);
      if (!arg) continue;
      const packed = packValue(resolveArgumentValue(arg, entry.params.args?.[id]), linear);
      if (packed) uniforms.set(packed.data, slot * 4);
    }
    engine.runtime.encodeStdAdjRenderPass(
      encoder,
      pair,
      srcTex,
      dstTex,
      format,
      uniforms.buffer as ArrayBuffer,
      entry.selMaskLayer,
    );
  },

  openEditor(layer) {
    if (layer.params.asEffect) return false; // settings window (Panel)
    openShaderGraph(layer.id);
    return true;
  },

  Panel: CustomShaderPanel,
  panelTitle: (layer) => layer.name,

  icon: EffectFallbackIcon,
};
