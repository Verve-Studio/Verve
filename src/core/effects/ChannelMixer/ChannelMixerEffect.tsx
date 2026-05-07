import type { ChannelMixerAdjustmentLayer } from "@/types";
import type { AdjustmentRenderOp } from "@/graphicspipeline/webgpu/rendering/WebGPURenderer";
import { ChannelMixerPanel } from "./ChannelMixerPanel";
import type { IPipelineEffect } from "../IPipelineEffect";

type ChannelMixerOp = Extract<AdjustmentRenderOp, { kind: "channel-mixer" }>;

export const ChannelMixerEffect: IPipelineEffect<
  ChannelMixerAdjustmentLayer,
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
    engine.encodeChannelMixerRenderPass(
      encoder,
      srcTex,
      dstTex,
      format,
      entry.params,
      entry.selMaskLayer,
    );
  },

  Panel: ChannelMixerPanel,
};
