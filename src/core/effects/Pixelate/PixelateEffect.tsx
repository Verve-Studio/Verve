import React from "react";
import type { PixelateEffectLayer } from "@/types";
import type { EffectRenderOp } from "@/graphics/webgpu/rendering/WebGPURenderer";
import { useAppContext } from "@/core/store/AppContext";
import { ParentConnectorIcon } from "@/ux/windows/ToolWindowIcons";
import styles from "@/core/effects/_shared/filterPanel.module.scss";
import type { IPipelineEffect, PanelProps } from "../IPipelineEffect";

type PixelateOp = Extract<EffectRenderOp, { kind: "pixelate" }>;

function PixelatePanel({
  layer,
  parentLayerName,
}: PanelProps<PixelateEffectLayer>): React.JSX.Element {
  const { dispatch } = useAppContext();
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

export const PixelateEffect: IPipelineEffect<PixelateEffectLayer, PixelateOp> = {
  id: "pixelate",
  label: "Pixelate…",
  menu: { root: "filters", submenu: "pixelate" },
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
    const pair = rt.getRenderPipelinePair("filter-pixelate", "fs_pixelate");
    const paramsBuf = rt.makeParamsBuf(
      new Uint32Array([entry.params.blockSize, 0, 0, 0]),
    );
    rt.encodeRenderPass(
      encoder,
      rt.selectPipeline(pair, dstTex),
      dstTex,
      [
        { binding: 0, resource: srcTex.createView() },
        { binding: 2, resource: { buffer: paramsBuf } },
      ],
    );
  },

  Panel: PixelatePanel,
};
