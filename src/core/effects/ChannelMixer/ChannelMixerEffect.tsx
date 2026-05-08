import type { EffectLayerOf } from "@/types";
import type { EffectRenderOp } from "@/graphics/webgpu/rendering/WebGPURenderer";
import { ChannelMixerPanel } from "./ChannelMixerPanel";
import type { IPipelineEffect } from "../IPipelineEffect";
import { STD_BINDINGS } from "@/graphics/webgpu/EffectRuntime";

const ChannelMixerIcon = (
  <svg
    width="12"
    height="12"
    viewBox="0 0 12 12"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.1"
    strokeLinecap="round"
    aria-hidden="true"
  >
    <line x1="3" y1="2" x2="3" y2="10" stroke="#ff6060" />
    <line x1="6" y1="2" x2="6" y2="10" stroke="#60d060" />
    <line x1="9" y1="2" x2="9" y2="10" stroke="#6060ff" />
    <circle cx="3" cy="4" r="1" fill="#ff6060" stroke="none" />
    <circle cx="6" cy="7" r="1" fill="#60d060" stroke="none" />
    <circle cx="9" cy="5" r="1" fill="#6060ff" stroke="none" />
  </svg>
);


export interface ChannelMixerParams {
    monochrome: boolean;
    /** Output channel currently shown in the panel UI. */
    outputChannel: "red" | "green" | "blue" | "gray";
    /** Source-channel multipliers (-200..+200, expressed as percent) and constant offset. */
    red: { red: number; green: number; blue: number; constant: number };
    green: { red: number; green: number; blue: number; constant: number };
    blue: { red: number; green: number; blue: number; constant: number };
    gray: { red: number; green: number; blue: number; constant: number };
}

export type ChannelMixerEffectLayer = EffectLayerOf<"channel-mixer", ChannelMixerParams>;

type ChannelMixerOp = Extract<EffectRenderOp, { kind: "channel-mixer" }>;

export const ChannelMixerEffect: IPipelineEffect<
  ChannelMixerEffectLayer,
  ChannelMixerOp
> = {
  id: "channel-mixer",
  label: "Channel Mixer…",
  menu: { root: "adjustments", submenu: "color-adjustments" },
  defaultParams: {
    monochrome: false,
    outputChannel: "red",
    red: { red: 100, green: 0, blue: 0, constant: 0 },
    green: { red: 0, green: 100, blue: 0, constant: 0 },
    blue: { red: 0, green: 0, blue: 100, constant: 0 },
    gray: { red: 40, green: 40, blue: 20, constant: 0 },
  },

  buildPlanEntry(layer, { mask }) {
    return {
      kind: "channel-mixer",
      layerId: layer.id,
      params: layer.params,
      visible: layer.visible,
      selMaskLayer: mask,
    };
  },

  encode({ engine, encoder, srcTex, dstTex, format }, entry) {
    // Layout: red, green, blue, gray (4 × vec4f) + flags (vec4u) = 80 bytes
    const p = entry.params;
    const buf = new ArrayBuffer(80);
    const f = new Float32Array(buf);
    const u = new Uint32Array(buf);
    const writeRow = (
      offset: number,
      c: { red: number; green: number; blue: number; constant: number },
    ): void => {
      f[offset + 0] = c.red;
      f[offset + 1] = c.green;
      f[offset + 2] = c.blue;
      f[offset + 3] = c.constant;
    };
    writeRow(0, p.red);
    writeRow(4, p.green);
    writeRow(8, p.blue);
    writeRow(12, p.gray);
    u[16] = p.monochrome ? 1 : 0;

    engine.runtime.encodeStdAdjRenderPass(
      encoder,
      engine.runtime.getRenderPipelinePair(
        "channel-mixer",
        "fs_channel_mixer",
        STD_BINDINGS,
      ),
      srcTex,
      dstTex,
      format,
      buf,
      entry.selMaskLayer,
    );
  },

  Panel: ChannelMixerPanel,
  icon: ChannelMixerIcon,
};
