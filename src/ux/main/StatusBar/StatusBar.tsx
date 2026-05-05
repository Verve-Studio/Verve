import React, { useEffect, useState } from "react";
import { useAppContext } from "@/core/store/AppContext";
import { cursorStore } from "@/core/store/cursorStore";
import type { IndexedPixelInfo } from "@/core/store/cursorStore";
import { SliderInput } from "@/ux/widgets/SliderInput/SliderInput";
import { ColorSwatch } from "@/ux/widgets/ColorSwatch/ColorSwatch";
import type { PixelFormat } from "@/types";
import styles from "./StatusBar.module.scss";

function toHex(r: number, g: number, b: number): string {
  return [r, g, b].map((v) => v.toString(16).padStart(2, "0")).join("");
}

const FORMAT_LABELS: Record<PixelFormat, string> = {
  rgba8: "RGB/8",
  rgba32f: "RGB/32F",
  indexed8: "Indexed/8",
};

export function StatusBar(): React.JSX.Element {
  const { state, dispatch } = useAppContext();
  const zoom = Math.round(state.canvas.zoom * 100);
  const { width, height, showGrid, gridSize, gridColor, gridType } =
    state.canvas;
  const formatLabel = FORMAT_LABELS[state.pixelFormat ?? "rgba8"];

  const [cursor, setCursor] = useState<{
    x: number;
    y: number;
    visible: boolean;
    pixelInfo: IndexedPixelInfo | null;
    pixelValues: number[] | null;
    pixelIsFloat: boolean;
  }>({
    x: cursorStore.x,
    y: cursorStore.y,
    visible: cursorStore.visible,
    pixelInfo: cursorStore.pixelInfo,
    pixelValues: cursorStore.pixelValues,
    pixelIsFloat: cursorStore.pixelIsFloat,
  });

  useEffect(() => {
    const onUpdate = (): void =>
      setCursor({
        x: cursorStore.x,
        y: cursorStore.y,
        visible: cursorStore.visible,
        pixelInfo: cursorStore.pixelInfo,
        pixelValues: cursorStore.pixelValues,
        pixelIsFloat: cursorStore.pixelIsFloat,
      });
    cursorStore.subscribe(onUpdate);
    return () => cursorStore.unsubscribe(onUpdate);
  }, []);

  return (
    <div className={styles.statusBar}>
      {/* Left: doc info */}
      <div className={styles.docInfo}>
        <span className={styles.infoItem}>
          {width} × {height} px
        </span>
        <span className={styles.sep} />
        <span className={styles.infoItem}>{formatLabel}</span>
        {/* Right: zoom */}
        <div className={styles.zoom}>
          <span className={styles.infoItem}>{zoom}%</span>
        </div>
        {cursor.visible && (
          <>
            <span className={styles.sep} />
            <span className={styles.infoItem}>
              {cursor.x}, {cursor.y}
            </span>
            {state.pixelFormat === "indexed8" && cursor.pixelInfo !== null && (
              <>
                <span className={styles.sep} />
                <span className={styles.infoItem}>
                  idx {cursor.pixelInfo.index}
                  {cursor.pixelInfo.index < 255 &&
                    cursor.pixelInfo.color !== null && (
                      <>
                        {" "}
                        · #
                        {toHex(
                          cursor.pixelInfo.color.r,
                          cursor.pixelInfo.color.g,
                          cursor.pixelInfo.color.b,
                        )}
                      </>
                    )}
                </span>
              </>
            )}
            {state.pixelFormat === "rgba32f" &&
              cursor.pixelIsFloat &&
              cursor.pixelValues !== null && (
                <>
                  <span className={styles.sep} />
                  <span className={`${styles.infoItem} ${styles.floatReadout}`}>
                    R:{cursor.pixelValues[0].toFixed(4)} G:
                    {cursor.pixelValues[1].toFixed(4)} B:
                    {cursor.pixelValues[2].toFixed(4)} A:
                    {cursor.pixelValues[3].toFixed(4)}
                  </span>
                </>
              )}
          </>
        )}
      </div>

      {/* Centre: grid controls — only visible when grid is on */}
      {showGrid && (
        <div className={styles.gridControls}>
          <span className={styles.sep} />
          <span className={styles.gridLabel}>Grid:</span>
          <select
            className={styles.gridTypeSelect}
            value={gridType}
            title="Grid type"
            onChange={(e) =>
              dispatch({
                type: "SET_GRID_TYPE",
                payload: e.target.value as import("@/types").GridType,
              })
            }
          >
            <option value="normal">Normal</option>
            <option value="thirds">Thirds</option>
            <option value="safe-zone">Safe Zone</option>
          </select>
          {gridType === "normal" && (
            <>
              <SliderInput
                value={gridSize}
                min={1}
                max={128}
                step={1}
                inputWidth={36}
                suffix="px"
                onChange={(v) =>
                  dispatch({ type: "SET_GRID_SIZE", payload: v })
                }
              />
              <ColorSwatch
                value={gridColor}
                title="Grid color"
                onChange={(hex) =>
                  dispatch({ type: "SET_GRID_COLOR", payload: hex })
                }
              />
            </>
          )}
          {gridType !== "normal" && (
            <ColorSwatch
              value={gridColor}
              title="Grid color"
              onChange={(hex) =>
                dispatch({ type: "SET_GRID_COLOR", payload: hex })
              }
            />
          )}
        </div>
      )}
    </div>
  );
}
