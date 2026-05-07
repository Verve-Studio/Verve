import type { SelectiveColorEffectLayer } from "@/types";
import type { EffectRenderOp } from "@/graphics/webgpu/rendering/WebGPURenderer";
import { SelectiveColorPanel } from "./SelectiveColorPanel";
import type { IPipelineEffect } from "../IPipelineEffect";
import { STD_BINDINGS } from "@/graphics/webgpu/EffectRuntime";

type SelectiveColorOp = Extract<EffectRenderOp, { kind: "selective-color" }>;

const ZERO_CHANNEL = { cyan: 0, magenta: 0, yellow: 0, black: 0 };

export const SelectiveColorEffect: IPipelineEffect<
  SelectiveColorEffectLayer,
  SelectiveColorOp
> = {
  id: "selective-color",
  label: "Selective Color…",
  menu: { root: "adjustments", submenu: "color-adjustments" },
  defaultParams: {
    reds: { ...ZERO_CHANNEL },
    yellows: { ...ZERO_CHANNEL },
    greens: { ...ZERO_CHANNEL },
    cyans: { ...ZERO_CHANNEL },
    blues: { ...ZERO_CHANNEL },
    magentas: { ...ZERO_CHANNEL },
    whites: { ...ZERO_CHANNEL },
    neutrals: { ...ZERO_CHANNEL },
    blacks: { ...ZERO_CHANNEL },
    mode: "relative",
  },

  buildPlanEntry(layer, { mask }) {
    return {
      kind: "selective-color",
      layerId: layer.id,
      params: layer.params,
      visible: layer.visible,
      selMaskLayer: mask,
    };
  },

  encode({ engine, encoder, srcTex, dstTex, format }, entry) {
    const params = entry.params;
    const RANGE_ORDER = [
      params.reds,
      params.yellows,
      params.greens,
      params.cyans,
      params.blues,
      params.magentas,
      params.whites,
      params.neutrals,
      params.blacks,
    ] as const;
    // SelectiveColorParams: 4 × array<vec4f,3> + u32 + vec3u = 4×48 + 16 = 208 bytes
    const buf = new ArrayBuffer(208);
    const f = new Float32Array(buf);
    const packArray9 = (offset: number, values: readonly number[]) => {
      for (let i = 0; i < 9; i++) {
        f[offset + i] = values[i];
      }
    };
    packArray9(
      0,
      RANGE_ORDER.map((r) => r.cyan),
    );
    packArray9(
      12,
      RANGE_ORDER.map((r) => r.magenta),
    );
    packArray9(
      24,
      RANGE_ORDER.map((r) => r.yellow),
    );
    packArray9(
      36,
      RANGE_ORDER.map((r) => r.black),
    );
    const u32View = new Uint32Array(buf);
    u32View[48] = params.mode === "relative" ? 1 : 0;

    engine.runtime.encodeStdAdjRenderPass(
      encoder,
      engine.runtime.getRenderPipelinePair(
        "sel-color",
        "fs_selective_color",
        STD_BINDINGS,
      ),
      srcTex,
      dstTex,
      format,
      buf,
      entry.selMaskLayer,
    );
  },

  Panel: SelectiveColorPanel,
};
