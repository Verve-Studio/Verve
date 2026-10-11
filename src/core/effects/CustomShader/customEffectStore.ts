/**
 * The `.effect` files found in the effects folders (see
 * electron/main/effects.ts), listed in Effects → Custom Effects. Reloads
 * when the user effects folder changes.
 */
import type { NodeGraph } from "@/core/nodes/graphTypes";
import { parseEffect } from "./effectFile";

export interface CustomEffectEntry {
  path: string;
  source: "user" | "bundled";
  /** Menu label: the effect's name, else the file name. */
  label: string;
  /** The parsed graph, or why the file couldn't be used. */
  graph?: NodeGraph;
  error?: string;
}

let entries: readonly CustomEffectEntry[] = [];
const listeners = new Set<() => void>();
let started = false;

const fileName = (path: string): string =>
  (path.split(/[\\/]/).pop() ?? path).replace(/\.effect$/i, "");

async function reload(): Promise<void> {
  const files = await window.api.listEffectFiles();
  entries = files.map((f): CustomEffectEntry => {
    if (f.text === undefined) {
      return { path: f.path, source: f.source, label: fileName(f.path), error: f.error ?? "Unreadable" };
    }
    const parsed = parseEffect(f.text);
    if (!parsed.ok) {
      return { path: f.path, source: f.source, label: fileName(f.path), error: parsed.error };
    }
    return {
      path: f.path,
      source: f.source,
      label: parsed.graph.info?.name || fileName(f.path),
      graph: parsed.graph,
    };
  });
  listeners.forEach((fn) => fn());
}

export const customEffectStore = {
  /** Load the list and follow folder changes (idempotent). */
  start(): void {
    if (started) return;
    started = true;
    void reload();
    window.api.onEffectsChanged(() => void reload());
  },

  reload,

  all(): readonly CustomEffectEntry[] {
    return entries;
  },

  subscribe(fn: () => void): () => void {
    listeners.add(fn);
    return () => listeners.delete(fn);
  },
};
