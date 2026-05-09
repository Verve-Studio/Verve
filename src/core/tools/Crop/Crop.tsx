import React, { useEffect, useState } from "react";
import { cropStore } from "@/core/store/cropStore";
import type { CropRect } from "@/core/store/cropStore";
import type {
  ToolHandler,
  ToolPointerPos,
  ToolContext,
  ToolOptionsStyles,
} from "../_shared/types";
import type { ITool } from "../_shared/ITool";
import { ToolGroup } from "../_shared/ITool";
import { SvgIcon } from "../_shared/SvgIcon";
import cropIconSvg from "./crop.svg?raw";

// ─── Handler ──────────────────────────────────────────────────────────────────

function createCropHandler(): ToolHandler {
  let startX = 0;
  let startY = 0;

  return {
    onPointerDown({ x, y }: ToolPointerPos, _ctx: ToolContext) {
      startX = Math.round(x);
      startY = Math.round(y);
      cropStore.setPending(startX, startY, startX, startY);
    },

    onPointerMove({ x, y }: ToolPointerPos, _ctx: ToolContext) {
      cropStore.setPending(startX, startY, x, y);
    },

    onPointerUp({ x, y }: ToolPointerPos, _ctx: ToolContext) {
      cropStore.commitRect(startX, startY, x, y);
    },
  };
}

// ─── Options UI ───────────────────────────────────────────────────────────────

function CropOptions({
  styles,
}: {
  styles: ToolOptionsStyles;
}): React.JSX.Element {
  const [rect, setRect] = useState<CropRect | null>(cropStore.rect);

  useEffect(() => {
    const fn = (): void => setRect(cropStore.rect);
    cropStore.subscribe(fn);
    return () => cropStore.unsubscribe(fn);
  }, []);

  return (
    <>
      <label className={styles.optLabel}>X:</label>
      <span className={styles.optText}>{rect != null ? rect.x : "—"}</span>
      <span className={styles.optSep} />
      <label className={styles.optLabel}>Y:</label>
      <span className={styles.optText}>{rect != null ? rect.y : "—"}</span>
      <span className={styles.optSep} />
      <label className={styles.optLabel}>W:</label>
      <span className={styles.optText}>{rect != null ? rect.w : "—"}</span>
      <span className={styles.optSep} />
      <label className={styles.optLabel}>H:</label>
      <span className={styles.optText}>{rect != null ? rect.h : "—"}</span>
      <span className={styles.optSep} />
      <button
        className={styles.optBtn}
        disabled={rect == null}
        onClick={() => cropStore.triggerCrop()}
      >
        Crop
      </button>
    </>
  );
}

// ─── Export ───────────────────────────────────────────────────────────────────

class CropTool implements ITool {
  readonly id = "crop";
  readonly label = "Crop";
  readonly shortcut = "C";
  readonly icon = <SvgIcon src={cropIconSvg} />;
  readonly placement = { group: ToolGroup.Crop, row: 0, column: 0 } as const;
  createHandler(): ToolHandler {
    return createCropHandler();
  }
  readonly Options = CropOptions;
}

export const cropTool: ITool = new CropTool();
