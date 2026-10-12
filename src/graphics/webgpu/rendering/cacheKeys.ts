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

/** Key for an op's params, excluding its selection mask's content version.
 *  Two ops with equal static keys differ at most in mask pixels, which the
 *  dirty-rect path can re-render locally. */
export function serializeAdjOpStatic(op: EffectRenderOp): string {
  const cached = opKeyCache.get(op);
  if (cached !== undefined) return cached;
  const parts: string[] = [`${op.kind}|${op.layerId}|${op.visible ? 1 : 0}`];
  if (op.selMaskLayer) parts.push("selM");
  const record = op as Record<string, unknown>;
  for (const [k, v] of Object.entries(record)) {
    if (
      k === "kind" ||
      k === "layerId" ||
      k === "visible" ||
      k === "selMaskLayer" ||
      k === "sourceLayers" ||
      k === "luts"
    )
      continue;
    if (typeof v === "object" && v !== null) {
      parts.push(`${k}:${serializeValue(v)}`);
    } else {
      parts.push(`${k}:${v}`);
    }
  }
  // Source layers are part of the static key, content included: the op
  // can read them anywhere, so the dirty-rect path can't patch its output.
  // A source renders with its mask and its own effects, so they're keyed too.
  if (op.sourceLayers) {
    for (const s of op.sourceLayers) {
      if (!s) {
        parts.push("src:-");
        continue;
      }
      const { layer: l, mask: m } = s;
      parts.push(
        `src:${l.id}:${l.contentVersion}:${l.offsetX}:${l.offsetY}:${l.layerWidth}x${l.layerHeight}` +
          (m ? `:M${m.id}:${m.contentVersion}:${m.offsetX}:${m.offsetY}` : "") +
          (s.adjustments.length > 0 ? `:[${computeAdjGroupParamsKey(s.adjustments)}]` : ""),
      );
    }
  }
  const key = parts.join("~");
  opKeyCache.set(op, key);
  return key;
}

// An op with a selection mask is re-keyed with the mask's contentVersion:
// it can change while the op object stays the same.
export function serializeAdjOp(op: EffectRenderOp): string {
  const key = serializeAdjOpStatic(op);
  return op.selMaskLayer ? `${key}~selV:${op.selMaskLayer.contentVersion}` : key;
}

/** Stable key for a list of adjustment ops — used as the params portion of the group cache key. */
export function computeAdjGroupParamsKey(
  adjustments: readonly EffectRenderOp[],
): string {
  return adjustments.map(serializeAdjOp).join("§");
}

/** {@link computeAdjGroupParamsKey} without selection-mask content versions. */
export function computeAdjGroupStaticKey(
  adjustments: readonly EffectRenderOp[],
): string {
  return adjustments.map(serializeAdjOpStatic).join("§");
}
