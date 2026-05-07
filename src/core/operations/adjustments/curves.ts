import type {
  CurvesChannel,
  CurvesChannelCurve,
  CurvesControlPoint,
  EffectParamsMap,
  CurvesPresetRef,
} from "@/types";

export interface CurvesLuts {
  rgb: Uint8Array;
  red: Uint8Array;
  green: Uint8Array;
  blue: Uint8Array;
}

const CHANNELS: CurvesChannel[] = ["rgb", "red", "green", "blue"];

function clampByte(v: number): number {
  return Math.max(0, Math.min(255, Math.round(v)));
}

export function makeIdentityCurve(channel: CurvesChannel): CurvesChannelCurve {
  return {
    points: [
      { id: `${channel}-0`, x: 0, y: 0 },
      { id: `${channel}-255`, x: 255, y: 255 },
    ],
  };
}

export function createDefaultCurvesParams(): EffectParamsMap["curves"] {
  return {
    version: 1,
    channels: {
      rgb: makeIdentityCurve("rgb"),
      red: makeIdentityCurve("red"),
      green: makeIdentityCurve("green"),
      blue: makeIdentityCurve("blue"),
    },
    ui: {
      selectedChannel: "rgb",
      visualAids: {
        gridDensity: "4x4",
        showClippingIndicators: true,
        showReadout: true,
      },
      presetRef: null,
    },
  };
}

export function cloneCurvesParams(
  params: EffectParamsMap["curves"],
): EffectParamsMap["curves"] {
  return {
    version: 1,
    channels: {
      rgb: { points: params.channels.rgb.points.map((p) => ({ ...p })) },
      red: { points: params.channels.red.points.map((p) => ({ ...p })) },
      green: { points: params.channels.green.points.map((p) => ({ ...p })) },
      blue: { points: params.channels.blue.points.map((p) => ({ ...p })) },
    },
    ui: {
      selectedChannel: params.ui.selectedChannel,
      visualAids: { ...params.ui.visualAids },
      presetRef: params.ui.presetRef ? { ...params.ui.presetRef } : null,
    },
  };
}

export function curvesChannelsSignature(
  channels: EffectParamsMap["curves"]["channels"],
): string {
  return CHANNELS.map((channel) =>
    channels[channel].points.map((p) => `${p.x}:${p.y}`).join(","),
  ).join("|");
}

export function validateCurvesParams(
  value: unknown,
): value is EffectParamsMap["curves"] {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as EffectParamsMap["curves"];
  if (candidate.version !== 1) return false;
  if (!candidate.channels || !candidate.ui) return false;
  for (const channel of CHANNELS) {
    if (!isValidCurve(candidate.channels[channel])) return false;
  }
  const aids = candidate.ui.visualAids;
  if (!aids) return false;
  if (aids.gridDensity !== "4x4" && aids.gridDensity !== "8x8") return false;
  if (typeof aids.showClippingIndicators !== "boolean") return false;
  if (typeof aids.showReadout !== "boolean") return false;
  if (!CHANNELS.includes(candidate.ui.selectedChannel)) return false;
  if (
    candidate.ui.presetRef !== null &&
    !isValidPresetRef(candidate.ui.presetRef)
  )
    return false;
  return true;
}

function isValidPresetRef(ref: CurvesPresetRef): boolean {
  if (ref.source !== "builtin" && ref.source !== "custom") return false;
  if (typeof ref.id !== "string" || ref.id.length === 0) return false;
  if (typeof ref.name !== "string" || ref.name.length === 0) return false;
  if (typeof ref.dirty !== "boolean") return false;
  return true;
}

export function isValidCurve(
  curve: CurvesChannelCurve | undefined,
): curve is CurvesChannelCurve {
  if (!curve || !Array.isArray(curve.points) || curve.points.length < 2)
    return false;
  const points = curve.points;
  const first = points[0];
  const last = points[points.length - 1];
  if (!first || first.x !== 0 || first.y !== 0) return false;
  if (!last || last.x !== 255 || last.y !== 255) return false;
  for (let i = 0; i < points.length; i++) {
    const p = points[i];
    if (!Number.isFinite(p.x) || !Number.isFinite(p.y)) return false;
    if (!Number.isInteger(p.x) || !Number.isInteger(p.y)) return false;
    if (p.x < 0 || p.x > 255 || p.y < 0 || p.y > 255) return false;
    if (i > 0 && p.x <= points[i - 1].x) return false;
  }
  return true;
}

export function buildCurveLut(points: CurvesControlPoint[]): Uint8Array {
  const lut = new Uint8Array(256);
  if (points.length < 2) {
    for (let i = 0; i < 256; i++) lut[i] = i;
    return lut;
  }

  const n = points.length;
  const x = new Array<number>(n);
  const y = new Array<number>(n);
  for (let i = 0; i < n; i++) {
    x[i] = clampByte(points[i].x);
    y[i] = clampByte(points[i].y);
  }

  const h = new Array<number>(n - 1);
  const d = new Array<number>(n - 1);
  for (let i = 0; i < n - 1; i++) {
    const dx = Math.max(1e-6, x[i + 1] - x[i]);
    h[i] = dx;
    d[i] = (y[i + 1] - y[i]) / dx;
  }

  const m = new Array<number>(n);
  m[0] = d[0];
  m[n - 1] = d[n - 2];
  for (let i = 1; i < n - 1; i++) {
    if (d[i - 1] * d[i] <= 0) {
      m[i] = 0;
    } else {
      m[i] = (d[i - 1] + d[i]) * 0.5;
    }
  }

  for (let i = 0; i < n - 1; i++) {
    if (Math.abs(d[i]) < 1e-6) {
      m[i] = 0;
      m[i + 1] = 0;
      continue;
    }
    const a = m[i] / d[i];
    const b = m[i + 1] / d[i];
    const sum = a * a + b * b;
    if (sum > 9) {
      const t = 3 / Math.sqrt(sum);
      m[i] = t * a * d[i];
      m[i + 1] = t * b * d[i];
    }
  }

  let segment = 0;
  for (let xi = 0; xi <= 255; xi++) {
    while (segment < n - 2 && xi > x[segment + 1]) segment++;
    const x0 = x[segment];
    const x1 = x[segment + 1];
    const y0 = y[segment];
    const y1 = y[segment + 1];
    const dx = Math.max(1e-6, x1 - x0);
    const t = Math.max(0, Math.min(1, (xi - x0) / dx));
    const t2 = t * t;
    const t3 = t2 * t;
    const h00 = 2 * t3 - 3 * t2 + 1;
    const h10 = t3 - 2 * t2 + t;
    const h01 = -2 * t3 + 3 * t2;
    const h11 = t3 - t2;
    const yi =
      h00 * y0 + h10 * dx * m[segment] + h01 * y1 + h11 * dx * m[segment + 1];
    lut[xi] = clampByte(yi);
  }

  return lut;
}

export function buildCurvesLuts(
  params: EffectParamsMap["curves"],
): CurvesLuts {
  return {
    rgb: buildCurveLut(params.channels.rgb.points),
    red: buildCurveLut(params.channels.red.points),
    green: buildCurveLut(params.channels.green.points),
    blue: buildCurveLut(params.channels.blue.points),
  };
}

export function detectLutClipping(lut: Uint8Array): {
  low: boolean;
  high: boolean;
} {
  let low = false;
  let high = false;
  for (let i = 0; i < lut.length; i++) {
    if (lut[i] === 0) low = true;
    if (lut[i] === 255) high = true;
    if (low && high) break;
  }
  return { low, high };
}

export function nextPointId(
  channel: CurvesChannel,
  points: CurvesControlPoint[],
): string {
  return `${channel}-${Date.now()}-${points.length}-${Math.random().toString(36).slice(2, 7)}`;
}

export function withDirtyPresetRef(
  presetRef: CurvesPresetRef | null,
  dirty: boolean,
): CurvesPresetRef | null {
  if (!presetRef) return null;
  if (presetRef.dirty === dirty) return presetRef;
  return { ...presetRef, dirty };
}
