/**
 * Full compilation check of a shader graph, for the properties panel and
 * before saving an `.effect`:
 *  - errors: graph compile errors (unknown nodes, cycles, a required input
 *    such as the output's Color left unlinked, …) and WGSL errors reported
 *    by the GPU for the generated shader, for both document kinds (sRGB and
 *    linear);
 *  - warnings: nodes that don't contribute to the output. Allowed — they
 *    are simply left out of the shader.
 */
import type { NodeGraph } from "@/core/nodes/graphTypes";
import { nodeRegistry } from "@/core/nodes/nodeRegistry";
import { compileShaderGraph, usedKey } from "@/core/nodes/shaderCompiler";
import { assembleShaderSource } from "./customShaderSource";

export interface ShaderIssue {
  severity: "error" | "warning";
  /** Owner node ids from the root graph to the graph holding `nodeId`. */
  path: readonly string[];
  nodeId: string | null;
  message: string;
}

let devicePromise: Promise<GPUDevice | null> | null = null;

/** A small device of our own, used only to validate WGSL. */
function checkDevice(): Promise<GPUDevice | null> {
  devicePromise ??= (async () => {
    try {
      const adapter = await navigator.gpu?.requestAdapter();
      return (await adapter?.requestDevice()) ?? null;
    } catch {
      return null;
    }
  })();
  return devicePromise;
}

/** Nodes (at any depth reached by the output) that the output doesn't use. */
function unusedNodes(
  graph: NodeGraph,
  used: ReadonlySet<string>,
  path: readonly string[] = [],
): ShaderIssue[] {
  const out: ShaderIssue[] = [];
  for (const n of graph.nodes) {
    const def = nodeRegistry.get(n.type);
    if (def?.boundary) continue;
    if (!used.has(usedKey(path, n.id))) {
      out.push({
        severity: "warning",
        path,
        nodeId: n.id,
        message: `${def?.label ?? n.type} isn't connected to the output`,
      });
    } else if (n.body) {
      out.push(...unusedNodes(n.body, used, [...path, n.id]));
    }
  }
  return out;
}

export async function checkShaderGraph(graph: NodeGraph): Promise<ShaderIssue[]> {
  const issues: ShaderIssue[] = [];
  const sources = new Set<string>();
  for (const linear of [false, true]) {
    const r = compileShaderGraph(graph, { linear });
    if (!r.ok) {
      // The same structural error shows up for both kinds; report it once.
      if (!linear) issues.push(...r.errors.map((e) => ({ severity: "error" as const, ...e })));
      return issues;
    }
    sources.add(
      assembleShaderSource(r.code, r.uniforms.length / 4, r.layerSources.length, r.passes),
    );
    if (!linear) issues.push(...unusedNodes(graph, r.used));
  }

  const device = await checkDevice();
  if (!device) {
    issues.push({ severity: "warning", path: [], nodeId: null, message: "GPU validation unavailable" });
    return issues;
  }
  for (const code of sources) {
    const info = await device.createShaderModule({ code }).getCompilationInfo();
    for (const m of info.messages) {
      if (m.type !== "error") continue;
      issues.push({
        severity: "error",
        path: [],
        nodeId: null,
        message: `Generated shader doesn't compile: ${m.message} (line ${m.lineNum})`,
      });
    }
    if (issues.some((i) => i.severity === "error")) break;
  }
  return issues;
}
