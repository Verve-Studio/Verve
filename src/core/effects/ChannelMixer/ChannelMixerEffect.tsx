import type { ChannelMixerAdjustmentLayer } from "@/types";
import type { AdjustmentRenderOp } from "@/graphicspipeline/webgpu/rendering/WebGPURenderer";
import { ChannelMixerPanel } from "./ChannelMixerPanel";
import type { IPipelineEffect } from "../IPipelineEffect";
import { STD_BINDINGS } from "@/graphicspipeline/webgpu/AdjustmentRuntime";

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
};
