import type { RGBAColor, SwatchGroup } from "@/types";

// ─── Module-level cycle tick ──────────────────────────────────────────────────

/** A single integer tick driven by the animation playback loop while palette
 *  animation is enabled. Renderer code reads this via {@link computeEffectivePalette}
 *  to derive the displayed colours. */
class PaletteCycleStore {
  private _tick = 0;
  private subs = new Set<() => void>();

  get tick(): number {
    return this._tick;
  }

  set(tick: number): void {
    if (tick === this._tick) return;
    this._tick = tick;
    for (const fn of this.subs) fn();
  }

  reset(): void {
    if (this._tick === 0) return;
    this._tick = 0;
    for (const fn of this.subs) fn();
  }

  subscribe(fn: () => void): () => void {
    this.subs.add(fn);
    return () => this.subs.delete(fn);
  }
}

export const paletteCycleStore = new PaletteCycleStore();

// ─── Period ──────────────────────────────────────────────────────────────────

function gcd(a: number, b: number): number {
  a = Math.abs(a);
  b = Math.abs(b);
  while (b !== 0) {
    [a, b] = [b, a % b];
  }
  return a;
}

function lcm(a: number, b: number): number {
  if (a === 0 || b === 0) return 0;
  return Math.abs((a / gcd(a, b)) * b);
}

/** Number of palette-animation ticks before every cycling group has returned
 *  to its starting rotation. Returns 0 when no group is actively cycling
 *  (i.e. nothing to export). */
export function paletteCyclePeriod(swatchGroups: readonly SwatchGroup[]): number {
  let period = 0;
  for (const g of swatchGroups) {
    const cyc = g.cycle;
    if (!cyc || !cyc.enabled) continue;
    const n = g.swatchIndices.length;
    if (n < 2) continue;
    const eff = ((Math.floor(cyc.stepsPerStep) % n) + n) % n;
    if (eff === 0) continue;
    const ticksPerStep = Math.max(1, Math.floor(cyc.ticksPerStep));
    const stepsToReturn = n / gcd(eff, n);
    const groupPeriod = stepsToReturn * ticksPerStep;
    period = period === 0 ? groupPeriod : lcm(period, groupPeriod);
  }
  return period;
}

// ─── Cycle math ───────────────────────────────────────────────────────────────

/** Build the displayed-colour palette: identical to `swatches` except for
 *  slots inside a cycling group, whose colours are rotated by the group's
 *  configured step rate at the given `tick`. The original `swatches` array
 *  is left untouched (the cycle is virtual).
 *
 *  For a group whose `swatchIndices = [a, b, c, d]`, advancing one step
 *  forward shifts each colour to the next slot — the colour previously
 *  shown at slot `a` is shown at slot `b`, and the colour from slot `d`
 *  wraps to slot `a`. Negative `stepsPerStep` cycles in the opposite
 *  direction. */
export function computeEffectivePalette(
  swatches: readonly RGBAColor[],
  swatchGroups: readonly SwatchGroup[],
  tick: number,
): RGBAColor[] {
  const out = swatches.slice();
  for (const group of swatchGroups) {
    const cyc = group.cycle;
    if (!cyc || !cyc.enabled) continue;
    const indices = group.swatchIndices;
    const n = indices.length;
    if (n < 2) continue;
    const ticksPerStep = Math.max(1, Math.floor(cyc.ticksPerStep));
    const stepsPerStep = Math.floor(cyc.stepsPerStep);
    const advance = Math.floor(tick / ticksPerStep) * stepsPerStep;
    // Modulo that handles negative shifts.
    const shift = ((advance % n) + n) % n;
    if (shift === 0) continue;
    // Snapshot original colours at this group's slots so the rotation reads
    // from a stable source even if the same slot appears in multiple groups
    // (last-applied wins; documented in the panel).
    const original = indices.map((i) => swatches[i]);
    for (let k = 0; k < n; k++) {
      const dstSlot = indices[k];
      const srcK = (k - shift + n * n) % n;
      const colour = original[srcK];
      if (colour) out[dstSlot] = colour;
    }
  }
  return out;
}
