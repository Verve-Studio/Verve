let counter = 0;

/**
 * A new layer id, e.g. `layer-lq3k9x2a-1`. Unique within the session even
 * when many layers are created in the same millisecond (automation loops),
 * which a bare `Date.now()` suffix isn't.
 */
export function newLayerId(prefix: string): string {
  counter = (counter + 1) % 0x100000;
  return `${prefix}-${Date.now().toString(36)}-${counter.toString(36)}`;
}
