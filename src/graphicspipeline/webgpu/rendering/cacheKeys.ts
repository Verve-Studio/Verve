import type { AdjustmentRenderOp } from "../types";

/**
 * Produces a stable string key for a single AdjustmentRenderOp, excluding GPU
 * objects (`selMaskLayer`, `luts`) and substituting content-tracked surrogates.
 * Used to detect params changes for the adj-group output cache.
 */
export function serializeAdjOp(op: AdjustmentRenderOp): string {
  const parts: string[] = [`${op.kind}|${op.layerId}|${op.visible ? 1 : 0}`];
  if (op.selMaskLayer) parts.push(`selV:${op.selMaskLayer.contentVersion}`);
  const record = op as Record<string, unknown>;
  for (const [k, v] of Object.entries(record)) {
    if (
      k === "kind" ||
      k === "layerId" ||
      k === "visible" ||
      k === "selMaskLayer" ||
      k === "luts"
    )
      continue;
    if (v instanceof Float32Array) {
      parts.push(`${k}:${Array.from(v).join(",")}`);
    } else if (typeof v === "object" && v !== null) {
      try {
        parts.push(`${k}:${JSON.stringify(v)}`);
      } catch {
        parts.push(`${k}:[object]`);
      }
    } else {
      parts.push(`${k}:${v}`);
    }
  }
  return parts.join("~");
}

/** Stable key for a list of adjustment ops — used as the params portion of the group cache key. */
export function computeAdjGroupParamsKey(
  adjustments: AdjustmentRenderOp[],
): string {
  return adjustments.map(serializeAdjOp).join("§");
}
