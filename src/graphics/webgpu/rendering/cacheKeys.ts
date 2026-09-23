import type { EffectRenderOp } from "../types";

/**
 * Produces a stable string key for a single EffectRenderOp, excluding GPU
 * objects (`selMaskLayer`, `luts`) and substituting content-tracked surrogates.
 * Used to detect params changes for the adj-group output cache.
 */
// Serialization is memoized by object identity. Op field values (params
// objects from reducer state, palettes derived from them) are immutable once
// they are in a plan — a change always produces a new object — so a
// cached string can't go stale. The plan is rebuilt every frame but its
// params objects are the same, so this removes the per-frame
// JSON.stringify / typed-array joins; the per-op cache also covers the
// 2–3 serializations of the same op within one frame.
const valueKeyCache = new WeakMap<object, string>();
const opKeyCache = new WeakMap<EffectRenderOp, string>();

function serializeValue(v: object): string {
  const cached = valueKeyCache.get(v);
  if (cached !== undefined) return cached;
  let key: string;
  if (v instanceof Float32Array) {
    key = Array.from(v).join(",");
  } else {
    try {
      key = JSON.stringify(v);
    } catch {
      key = "[object]";
    }
  }
  valueKeyCache.set(v, key);
  return key;
}

export function serializeAdjOp(op: EffectRenderOp): string {
  const cached = opKeyCache.get(op);
  // An op with a selection mask is always re-keyed: the mask's
  // contentVersion can change while the op object stays the same (its
  // field values still hit valueKeyCache).
  if (cached !== undefined && !op.selMaskLayer) return cached;
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
    if (typeof v === "object" && v !== null) {
      parts.push(`${k}:${serializeValue(v)}`);
    } else {
      parts.push(`${k}:${v}`);
    }
  }
  const key = parts.join("~");
  opKeyCache.set(op, key);
  return key;
}

/** Stable key for a list of adjustment ops — used as the params portion of the group cache key. */
export function computeAdjGroupParamsKey(
  adjustments: EffectRenderOp[],
): string {
  return adjustments.map(serializeAdjOp).join("§");
}
