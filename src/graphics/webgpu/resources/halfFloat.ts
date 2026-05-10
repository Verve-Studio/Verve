// IEEE-754 binary16 encoder (round-to-nearest-even-ish); used to upload the
// renderer's identity LUT placeholders as rgba16float.
const _f32buf = new ArrayBuffer(4);
const _f32arr = new Float32Array(_f32buf);
const _u32arr = new Uint32Array(_f32buf);

export function floatToHalf16(value: number): number {
  _f32arr[0] = value;
  const x = _u32arr[0];
  const sign = (x >>> 16) & 0x8000;
  const mant = x & 0x7fffff;
  let exp = (x >>> 23) & 0xff;
  if (exp === 0xff) return sign | 0x7c00 | (mant !== 0 ? 0x0200 : 0);
  exp = exp - 127 + 15;
  if (exp >= 31) return sign | 0x7c00;
  if (exp <= 0) return sign;
  return sign | (exp << 10) | (mant >>> 13);
}
