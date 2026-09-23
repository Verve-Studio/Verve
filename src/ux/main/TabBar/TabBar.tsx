import React from "react";
import type { PixelFormat } from "@/types";
import styles from "./TabBar.module.scss";
import { useAppSelector } from "@/core/store/AppContext";

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
  onSwitch: (id: string) => void;
  onClose: (id: string) => void;
}

function TabBarImpl({
  tabs,
  activeTabId,
  onSwitch,
  onClose,
}: TabBarProps): React.JSX.Element {
  // Selected here (not passed down) so zooming re-renders only the tab bar.
  const activeZoom = useAppSelector((s) => s.canvas.zoom);
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

// Memoized: subscribes to its own store slice, so it only needs to re-render
// when that slice or its props change — not whenever the app shell does.
export const TabBar = React.memo(TabBarImpl);
