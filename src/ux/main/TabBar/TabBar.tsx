import React from "react";
import type { PixelFormat } from "@/types";
import styles from "./TabBar.module.scss";

export interface TabInfo {
  id: string;
  title: string;
  pixelFormat: PixelFormat;
}

function formatLabel(fmt: PixelFormat): string {
  if (fmt === "rgba32f") return "RGB/32f";
  if (fmt === "indexed8") return "Idx/8";
  return "RGB/8";
}

interface TabBarProps {
  tabs: TabInfo[];
  activeTabId: string;
  activeZoom: number;
  onSwitch: (id: string) => void;
  onClose: (id: string) => void;
}

export function TabBar({
  tabs,
  activeTabId,
  activeZoom,
  onSwitch,
  onClose,
}: TabBarProps): React.JSX.Element {
  const zoom = Math.round(activeZoom * 100);

  return (
    <div className={styles.tabBar} role="tablist">
      {tabs.map((tab) => {
        const isActive = tab.id === activeTabId;
        return (
          <div
            key={tab.id}
            className={`${styles.tab} ${isActive ? styles.tabActive : ""}`}
            role="tab"
            aria-selected={isActive}
            onClick={() => onSwitch(tab.id)}
          >
            <span className={styles.tabName}>
              {tab.title}
              {isActive ? ` @ ${zoom}% (${formatLabel(tab.pixelFormat)})` : ""}
            </span>
            <button
              className={styles.closeBtn}
              aria-label={`Close ${tab.title}`}
              title="Close"
              onClick={(e) => {
                e.stopPropagation();
                onClose(tab.id);
              }}
            >
              ×
            </button>
          </div>
        );
      })}
    </div>
  );
}
