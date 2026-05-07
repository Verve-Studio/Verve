import type {
  CurvesChannel,
  CurvesChannelCurve,
  AdjustmentParamsMap,
} from "@/types";
import { curvesChannelsSignature, makeIdentityCurve } from "./curves";

export interface BuiltinCurvesPreset {
  id: "linear" | "medium-contrast" | "strong-contrast" | "invert";
  label: string;
  channels: Record<CurvesChannel, CurvesChannelCurve>;
}

function cloneCurve(curve: CurvesChannelCurve): CurvesChannelCurve {
  return { points: curve.points.map((p) => ({ ...p })) };
}

function identityChannels(): Record<CurvesChannel, CurvesChannelCurve> {
  return {
    rgb: makeIdentityCurve("rgb"),
    red: makeIdentityCurve("red"),
    green: makeIdentityCurve("green"),
    blue: makeIdentityCurve("blue"),
  };
}

export const BUILTIN_CURVES_PRESETS: BuiltinCurvesPreset[] = [
  {
    id: "linear",
    label: "Linear",
    channels: identityChannels(),
  },
  {
    id: "medium-contrast",
    label: "Medium Contrast",
    channels: {
      ...identityChannels(),
      rgb: {
        points: [
          { id: "rgb-0", x: 0, y: 0 },
          { id: "rgb-48", x: 48, y: 34 },
          { id: "rgb-128", x: 128, y: 128 },
          { id: "rgb-208", x: 208, y: 224 },
          { id: "rgb-255", x: 255, y: 255 },
        ],
      },
    },
  },
  {
    id: "strong-contrast",
    label: "Strong Contrast",
    channels: {
      ...identityChannels(),
      rgb: {
        points: [
          { id: "rgb-0", x: 0, y: 0 },
          { id: "rgb-44", x: 44, y: 24 },
          { id: "rgb-128", x: 128, y: 128 },
          { id: "rgb-210", x: 210, y: 236 },
          { id: "rgb-255", x: 255, y: 255 },
        ],
      },
    },
  },
  {
    id: "invert",
    label: "Inverted",
    channels: {
      rgb: {
        points: [
          { id: "rgb-0", x: 0, y: 255 },
          { id: "rgb-255", x: 255, y: 0 },
        ],
      },
      red: makeIdentityCurve("red"),
      green: makeIdentityCurve("green"),
      blue: makeIdentityCurve("blue"),
    },
  },
];

export function clonePresetChannels(
  channels: Record<CurvesChannel, CurvesChannelCurve>,
): Record<CurvesChannel, CurvesChannelCurve> {
  return {
    rgb: cloneCurve(channels.rgb),
    red: cloneCurve(channels.red),
    green: cloneCurve(channels.green),
    blue: cloneCurve(channels.blue),
  };
}

export function findBuiltinPresetById(id: string): BuiltinCurvesPreset | null {
  return BUILTIN_CURVES_PRESETS.find((p) => p.id === id) ?? null;
}

export function findMatchingBuiltinPreset(
  params: AdjustmentParamsMap["curves"],
): BuiltinCurvesPreset | null {
  const sig = curvesChannelsSignature(params.channels);
  return (
    BUILTIN_CURVES_PRESETS.find(
      (p) => curvesChannelsSignature(p.channels) === sig,
    ) ?? null
  );
}
