// ─── Per-document brush overrides ────────────────────────────────────────────
//
// Each document/tab owns an instance of this store, holding the ephemeral
// "tweaks" an artist has made to brushes while painting in that document.
// Reads merge over the canonical brush (the one persisted to disk in
// `brushStore` or to the .verve file in `AppState.brushes`), so the
// runtime sees the effective brush while the canonical definition stays
// untouched.
//
// Lifecycle:
//   * Patch-on-edit. Every slider drag in BrushSettingsPanel calls
//     `patch(brushId, partial)`, which shallow-merges the patch onto any
//     existing override for that id. Sub-objects (tip / scatter / pose /
//     etc.) are sent in full by the panel — the override fully shadows
//     the canonical field, which keeps the store dead-simple.
//   * Save. The settings panel's "Save" button reads the effective brush
//     (canonical + override), writes it back to the canonical store, and
//     calls `clear(brushId)` to drop the override.
//   * Save As New. Reads the effective brush and creates a new canonical
//     entry; the override on the current id is kept (the user's still
//     tweaking) unless the panel chooses to switch active to the new id.
//   * Revert. `clear(brushId)` discards the override; the canonical
//     re-asserts.
//   * Tab close. The scope is dropped — its overrides go with it. No
//     explicit cleanup needed.
//
// This mirrors how Photoshop scopes brush tweaks: the change is local to
// the document you're painting in and doesn't leak across to the brush
// library or to other open documents.

import type { Brush } from "@/types";

type Listener = () => void;
const listeners = new Set<Listener>();

export class BrushOverridesStore {
  private overrides: Map<string, Partial<Brush>> = new Map();

  subscribe(fn: Listener): void {
    listeners.add(fn);
  }
  unsubscribe(fn: Listener): void {
    listeners.delete(fn);
  }
  notify(): void {
    for (const fn of listeners) fn();
  }

  /** Returns the partial override for `brushId`, or null. */
  get(brushId: string): Partial<Brush> | null {
    return this.overrides.get(brushId) ?? null;
  }

  /** True when there is any override for `brushId`. */
  has(brushId: string): boolean {
    return this.overrides.has(brushId);
  }

  /** True when ANY brush in this document has unsaved overrides. */
  hasAny(): boolean {
    return this.overrides.size > 0;
  }

  /** The set of brush ids that currently have overrides. Used by the
   *  brush picker to render a "modified" indicator. */
  modifiedIds(): ReadonlySet<string> {
    return new Set(this.overrides.keys());
  }

  /** Merge `patch` into the existing override for `brushId`. Top-level
   *  keys are shallow-replaced — the settings panel always sends full
   *  sub-objects (e.g. `{ tip: { ...activeBrush.tip, size: 25 } }`) so a
   *  shallow merge is the right semantics. */
  patch(brushId: string, patch: Partial<Brush>): void {
    const existing = this.overrides.get(brushId) ?? {};
    this.overrides.set(brushId, { ...existing, ...patch });
    this.notify();
  }

  /** Drop the override for `brushId`. Returns true if there was one. */
  clear(brushId: string): boolean {
    const had = this.overrides.delete(brushId);
    if (had) this.notify();
    return had;
  }

  /** Apply the overrides on top of `brush` and return a fresh Brush. If
   *  there is no override, returns `brush` unchanged (identity preserved
   *  so React memo paths still hit). */
  applyTo(brush: Brush): Brush {
    const ov = this.overrides.get(brush.id);
    if (!ov) return brush;
    return { ...brush, ...ov };
  }
}
