import React from "react";
import type {
  SharpenAdjustmentLayer,
  SharpenMoreAdjustmentLayer,
} from "@/types";
import { ParentConnectorIcon } from "@/ux/windows/ToolWindowIcons";
import styles from "@/core/effects/_shared/filterPanel.module.scss";

interface Props {
  layer: SharpenAdjustmentLayer | SharpenMoreAdjustmentLayer;
  parentLayerName: string;
}

export function SharpenPanel({ parentLayerName }: Props): React.JSX.Element {
  return (
    <div className={styles.content}>
      <div className={styles.noParams}>No configurable parameters.</div>
      <div className={styles.footer}>
        <span className={styles.footerInfo}>
          <ParentConnectorIcon />
          Adjusting <strong>{parentLayerName}</strong>
        </span>
      </div>
    </div>
  );
}
