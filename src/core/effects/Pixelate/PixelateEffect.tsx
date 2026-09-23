import React from "react";
import type { EffectLayerOf } from "@/types";
import type { EffectRenderOp } from "@/graphics/webgpu/rendering/WebGPURenderer";
import { useAppDispatch } from "@/core/store/AppContext";
import { ParentConnectorIcon } from "@/ux/windows/ToolWindowIcons";
import styles from "@/core/effects/_shared/filterPanel.module.scss";
import type { IPipelineEffect, PanelProps } from "../IPipelineEffect";

export interface PixelateParams {
  blockSize: number;
}

export type PixelateEffectLayer = EffectLayerOf<"pixelate", PixelateParams>;

type PixelateOp = Extract<EffectRenderOp, { kind: "pixelate" }>;

function PixelatePanel({
  layer,
  parentLayerName,
}: PanelProps<PixelateEffectLayer>): React.JSX.Element {
  const dispatch = useAppDispatch();
  const { blockSize } = layer.params;
  const up = (v: number): void =>
    dispatch({
      type: "UPDATE_ADJUSTMENT_LAYER",
      payload: { ...layer, params: { ...layer.params, blockSize: v } },
    });

  return (
    <div className={styles.content}>
      <div className={styles.row}>
        <span className={styles.label}>Block Size</span>
        <div className={styles.trackWrap}>
          <input
            type="range"
            className={styles.track}
            min={2}
            max={500}
            step={1}
            value={blockSize}
            style={
              { "--pct": String((blockSize - 2) / 498) } as React.CSSProperties
            }
            onChange={(e) => up(Number(e.target.value))}
          />
        </div>
        <input
          type="number"
          className={styles.numInput}
          min={2}
          max={500}
          step={1}
          value={blockSize}
          onChange={(e) => {
            const v = e.target.valueAsNumber;
            if (!isNaN(v)) up(Math.min(500, Math.max(2, Math.round(v))));
          }}
        />
        <span className={styles.unitLabel}>px</span>
      </div>
      <div className={styles.footer}>
        <span className={styles.footerInfo}>
          <ParentConnectorIcon />
          Adjusting <strong>{parentLayerName}</strong>
        </span>
        <button
          className={styles.resetBtn}
          onClick={() => up(10)}
          title="Reset"
        >
          Reset
        </button>
      </div>
    </div>
  );
}

export const PixelateEffect: IPipelineEffect<PixelateEffectLayer, PixelateOp> =
  {
    id: "pixelate",
    label: "Pixelate…",
    menu: { root: "filters", submenu: "artistic" },
    defaultParams: { blockSize: 10 },

    buildPlanEntry(layer, { mask }) {
      return {
        kind: "pixelate",
        layerId: layer.id,
        visible: layer.visible,
        selMaskLayer: mask,
        params: layer.params,
      };
    },

    encode({ encoder, srcTex, dstTex, engine }, entry) {
      const rt = engine.runtime;
      const blockSize = Math.max(1, Math.round(entry.params.blockSize));
      const reduce = rt.getRenderPipelinePair(
        "filter-pixelate",
        "fs_pixelate_reduce",
      );
      const expand = rt.getRenderPipelinePair(
        "filter-pixelate",
        "fs_pixelate_expand",
      );
      const paramsBuf = rt.makeParamsBuf(new Uint32Array([blockSize, 0, 0, 0]));
      // One texel per block, in the doc format so f32 averages aren't clipped.
      const blocks = rt.makeScratchTex(
        Math.ceil(srcTex.width / blockSize),
        Math.ceil(srcTex.height / blockSize),
        dstTex,
      );
      rt.encodeRenderPass(encoder, rt.selectPipeline(reduce, blocks), blocks, [
        { binding: 0, resource: srcTex.createView() },
        { binding: 2, resource: { buffer: paramsBuf } },
      ]);
      rt.encodeRenderPass(encoder, rt.selectPipeline(expand, dstTex), dstTex, [
        { binding: 0, resource: blocks.createView() },
        { binding: 2, resource: { buffer: paramsBuf } },
      ]);
    },

    Panel: PixelatePanel,
  };
