import React from "react";
import type { ColorInvertAdjustmentLayer } from "@/types";
import { ParentConnectorIcon } from "@/ux/windows/ToolWindowIcons";
import styles from "./InvertPanel.module.scss";

interface InvertPanelProps {
  layer: ColorInvertAdjustmentLayer;
  parentLayerName: string;
}

export function InvertPanel({
  layer: _layer,
  parentLayerName,
}: InvertPanelProps): React.JSX.Element {
  return (
    <div className={styles.content}>
      <p className={styles.description}>
        Inverts all <strong>RGB</strong> channel values.
        <br />
        Toggle layer visibility to enable/disable.
      </p>
      <div className={styles.footer}>
        <span className={styles.footerInfo}>
          <ParentConnectorIcon />
          Adjusting <strong>{parentLayerName}</strong>
        </span>
      </div>
    </div>
  );
}
