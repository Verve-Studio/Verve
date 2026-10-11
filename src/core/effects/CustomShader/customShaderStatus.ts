/**
 * GPU compile errors of custom shader layers, keyed by layer id. Graph
 * errors (no output node, …) are found by the editor compiling the graph
 * itself; this store only carries what WGSL compilation reports, which the
 * effect learns asynchronously while rendering.
 */
const errors = new Map<string, string>();
const listeners = new Set<() => void>();

export const customShaderStatus = {
  subscribe(fn: () => void): () => void {
    listeners.add(fn);
    return () => listeners.delete(fn);
  },

  gpuError(layerId: string): string | null {
    return errors.get(layerId) ?? null;
  },

  setGpuError(layerId: string, message: string | null): void {
    if ((errors.get(layerId) ?? null) === message) return;
    if (message === null) errors.delete(layerId);
    else errors.set(layerId, message);
    listeners.forEach((fn) => fn());
  },
};
