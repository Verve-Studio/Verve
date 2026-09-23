import { shallowEqual2, useAppSelector } from "@/core/store/AppContext";
import type { ToolOptionsStyles } from "@/core/tools";
import { TOOL_REGISTRY } from "@/core/tools";
import React from "react";
import styles from "./ToolOptionsBar.module.scss";

function ToolOptionsBarImpl(): React.JSX.Element {
  const state = useAppSelector(
    (s) => ({ activeTool: s.activeTool }),
    shallowEqual2,
  );
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

// Memoized: subscribes to its own store slice, so it only needs to re-render
// when that slice or its props change — not whenever the app shell does.
export const ToolOptionsBar = React.memo(ToolOptionsBarImpl);
