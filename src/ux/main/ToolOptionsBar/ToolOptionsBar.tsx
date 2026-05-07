import { useAppContext } from "@/core/store/AppContext";
import type { ToolOptionsStyles } from "@/tools";
import { TOOL_REGISTRY } from "@/tools";
import React from "react";
import styles from "./ToolOptionsBar.module.scss";

export function ToolOptionsBar(): React.JSX.Element {
  const { state } = useAppContext();
  const { Options } = TOOL_REGISTRY[state.activeTool];

  return (
    <div
      className={styles.bar}
      role="toolbar"
      aria-label="Tool options"
      data-text-editor-safe
    >
      <Options styles={styles as unknown as ToolOptionsStyles} />
    </div>
  );
}
