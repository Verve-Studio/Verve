import React from "react";
import type { ToolDefinition, ToolHandler, ToolOptionsStyles } from "./types";

function createZoomHandler(): ToolHandler {
  return {
    onPointerDown() {},
    onPointerMove() {},
    onPointerUp() {},
  };
}

function ZoomOptions({
  styles,
}: {
  styles: ToolOptionsStyles;
}): React.JSX.Element {
  return (
    <>
      <button className={styles.optBtn}>Fit Screen</button>
      <button className={styles.optBtn}>100%</button>
    </>
  );
}

export const zoomTool: ToolDefinition = {
  createHandler: createZoomHandler,
  Options: ZoomOptions,
};
