import React from "react";
import type { ToolDefinition, ToolHandler, ToolOptionsStyles } from "../_shared/types";

// Stub for tools not yet implemented — no canvas behavior, no options UI.
const noopHandler: ToolHandler = {
  onPointerDown() {},
  onPointerMove() {},
  onPointerUp() {},
};

function NoopOptions(_props: { styles: ToolOptionsStyles }): React.JSX.Element {
  return <></>;
}

export const noopTool: ToolDefinition = {
  createHandler: () => noopHandler,
  Options: NoopOptions,
};
