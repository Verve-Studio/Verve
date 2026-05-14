import React, { useRef, useState } from "react";
import { ColorPicker } from "@/ux/main/RightPanel/ColorPicker/ColorPicker";
import { Layers } from "@/ux/main/RightPanel/Layers/Layers";
import { Navigator } from "@/ux/main/RightPanel/Navigator/Navigator";
import { SwatchPanel } from "@/ux/main/RightPanel/Swatch/SwatchPanel";
import { HistoryPanel } from "@/ux/main/RightPanel/History/HistoryPanel";
import { InfoPanel } from "@/ux/main/RightPanel/Info/InfoPanel";
import { DisplayPanel } from "@/ux/main/RightPanel/DisplayPanel/DisplayPanel";
import { Dock } from "./Dock/Dock";
import { useDockLayoutLoader } from "./Dock/useDockLayout";
import type { PanelId } from "./Dock/types";
import styles from "./RightPanel.module.scss";

interface RightPanelProps {
  activeTabId: string;
  findLayersTrigger?: number;
  onMergeSelected: (ids: string[]) => void;
  onMergeVisible: () => void;
  onMergeDown: () => void;
  onFlattenImage: () => void;
  onRasterizeLayer: (layerId: string) => void;
  onDuplicateLayer: () => void;
  onOpenAdjustmentPanel?: (layerId: string) => void;
  onGeneratePalette?: () => void;
  onMergeGroup: (groupId: string) => void;
  onGroupSelected: (layerIds: string[]) => void;
  onUngroup: (groupId: string) => void;
  onCreateCompositeLayer: () => void;
  onRefreshLinkedLayer: () => void;
}

const MIN_WIDTH = 200;
const MAX_WIDTH = 600;
const DEFAULT_WIDTH = 250;
const STORAGE_KEY = "verve-right-panel-width";

export function RightPanel({
  activeTabId,
  findLayersTrigger,
  onMergeSelected,
  onMergeVisible,
  onMergeDown,
  onFlattenImage,
  onRasterizeLayer,
  onDuplicateLayer,
  onOpenAdjustmentPanel,
  onGeneratePalette,
  onMergeGroup,
  onGroupSelected,
  onUngroup,
  onCreateCompositeLayer,
  onRefreshLinkedLayer,
}: RightPanelProps): React.JSX.Element {
  useDockLayoutLoader();

  const [width, setWidth] = useState<number>(() => {
    const stored = localStorage.getItem(STORAGE_KEY);
    const n = stored ? parseInt(stored, 10) : NaN;
    return isNaN(n)
      ? DEFAULT_WIDTH
      : Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, n));
  });
  const dragStartX = useRef<number | null>(null);
  const dragStartW = useRef<number>(width);

  const onHandlePointerDown = (e: React.PointerEvent): void => {
    e.preventDefault();
    dragStartX.current = e.clientX;
    dragStartW.current = width;
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
  };

  const onHandlePointerMove = (e: React.PointerEvent): void => {
    if (dragStartX.current === null) return;
    const delta = dragStartX.current - e.clientX;
    const next = Math.min(
      MAX_WIDTH,
      Math.max(MIN_WIDTH, dragStartW.current + delta),
    );
    setWidth(next);
  };

  const onHandlePointerUp = (e: React.PointerEvent): void => {
    if (dragStartX.current === null) return;
    const delta = dragStartX.current - e.clientX;
    const final = Math.min(
      MAX_WIDTH,
      Math.max(MIN_WIDTH, dragStartW.current + delta),
    );
    setWidth(final);
    localStorage.setItem(STORAGE_KEY, String(final));
    dragStartX.current = null;
  };

  // Panel-open checkbox states in the macOS native menu used to be
  // synced here via a separate `setMenuItemChecked` IPC. That's now
  // owned by `useMacNativeMenu`, which subscribes to `dockStore`
  // directly and rebuilds the unified menu tree on every layout
  // change. No separate plumbing needed.

  function renderPanel(panelId: PanelId): React.ReactNode {
    switch (panelId) {
      case "Color":
        return <ColorPicker />;
      case "Swatches":
        return (
          <SwatchPanel
            activeTabId={activeTabId}
            onGeneratePalette={onGeneratePalette}
          />
        );
      case "Navigator":
        return <Navigator />;
      case "Layers":
        return (
          <Layers
            onMergeSelected={onMergeSelected}
            onMergeVisible={onMergeVisible}
            onMergeDown={onMergeDown}
            onFlattenImage={onFlattenImage}
            onRasterizeLayer={onRasterizeLayer}
            onDuplicateLayer={onDuplicateLayer}
            onOpenAdjustmentPanel={onOpenAdjustmentPanel}
            onMergeGroup={onMergeGroup}
            onGroupSelected={onGroupSelected}
            onUngroup={onUngroup}
            onCreateCompositeLayer={onCreateCompositeLayer}
            onRefreshLinkedLayer={onRefreshLinkedLayer}
            activeTabId={activeTabId}
            findLayersTrigger={findLayersTrigger}
          />
        );
      case "History":
        return <HistoryPanel />;
      case "Info":
        return <InfoPanel />;
      case "Display":
        return <DisplayPanel />;
      default:
        return null;
    }
  }

  return (
    <aside className={styles.panel} style={{ width }}>
      <div
        className={styles.resizeHandle}
        onPointerDown={onHandlePointerDown}
        onPointerMove={onHandlePointerMove}
        onPointerUp={onHandlePointerUp}
      />
      <Dock renderPanel={renderPanel} />
    </aside>
  );
}
