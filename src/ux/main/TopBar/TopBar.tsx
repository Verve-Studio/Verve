import React, { useMemo } from "react";
import { MenuBar } from "../MenuBar/MenuBar";
import type { MenuDef } from "../MenuBar/MenuBar";
import type { AdjustmentType, FilterKey, PixelFormat } from "@/types";
import type { GuidePreset } from "@/core/services/useViewActions";
import type {
  AlignEdge,
  DistributeAxis,
  OrderOp,
} from "@/core/services/useLayerArrange";
import { dockStore } from "@/ux/main/RightPanel/Dock/dockStore";
import { useDockLayout } from "@/ux/main/RightPanel/Dock/useDockLayout";
import { ALL_PANEL_IDS, PANEL_LABELS } from "@/ux/main/RightPanel/Dock/types";
import styles from "./TopBar.module.scss";

// ─── TopBar ───────────────────────────────────────────────────────────────────

interface TopBarProps {
  onDebug?: () => void;
  onNew?: () => void;
  onOpen?: () => void;
  onSave?: () => void;
  onSaveAs?: () => void;
  onExport?: () => void;
  onUndo?: () => void;
  onRedo?: () => void;
  onCut?: () => void;
  onCopy?: () => void;
  onCopyMerged?: () => void;
  onPaste?: () => void;
  onPasteInto?: () => void;
  onDelete?: () => void;
  onResizeImage?: () => void;
  onResizeCanvas?: () => void;
  onRotate90CW?: () => void;
  onRotate180?: () => void;
  onRotate270CW?: () => void;
  onFlipHorizontal?: () => void;
  onFlipVertical?: () => void;
  onZoomIn?: () => void;
  onZoomOut?: () => void;
  onZoom100?: () => void;
  onFitToWindow?: () => void;
  onToggleGrid?: () => void;
  showGrid?: boolean;
  onToggleRulers?: () => void;
  showRulers?: boolean;
  onToggleGuides?: () => void;
  showGuides?: boolean;
  onApplyGuidePreset?: (preset: GuidePreset) => void;
  onSetNormalMode?: () => void;
  onSetTiledMode?: () => void;
  tiledMode?: boolean;
  onToggleTileGrid?: () => void;
  showTileGrid?: boolean;
  onSetAnimationMode?: (enabled: boolean) => void;
  animationMode?: boolean;
  onNewLayer?: () => void;
  onNewLayerGroup?: () => void;
  onNewCompositeLayer?: () => void;
  onAddLayerMask?: () => void;
  onDuplicateLayer?: () => void;
  onDeleteLayer?: () => void;
  onGroupLayers?: () => void;
  isGroupLayersEnabled?: boolean;
  onUngroupLayers?: () => void;
  isUngroupLayersEnabled?: boolean;
  onMergeDown?: () => void;
  onMergeVisible?: () => void;
  onFlattenImage?: () => void;
  onRasterizeLayer?: () => void;
  isRasterizeEnabled?: boolean;
  onMergeSelected?: () => void;
  isMergeSelectedEnabled?: boolean;
  onLayerRotate?: (amount: "90cw" | "180" | "270cw") => void;
  onLayerFlip?: (axis: "horizontal" | "vertical") => void;
  onLayerAlign?: (edge: AlignEdge) => void;
  onLayerDistribute?: (axis: DistributeAxis) => void;
  onLayerOrder?: (op: OrderOp) => void;
  onAbout?: () => void;
  onKeyboardShortcuts?: () => void;
  onSystemInfo?: () => void;
  onCreateAdjustmentLayer?: (type: AdjustmentType) => void;
  isAdjustmentMenuEnabled?: boolean;
  adjustmentMenuItems?: Array<{
    type: AdjustmentType;
    label: string;
    group?: string;
  }>;
  effectsMenuItems?: Array<{
    type: AdjustmentType;
    label: string;
    group?: string;
  }>;
  onOpenFilterDialog?: (key: FilterKey) => void;
  onInstantFilter?: (key: FilterKey) => void;
  isFiltersMenuEnabled?: boolean;
  filterMenuItems?: Array<{
    key: FilterKey;
    label: string;
    instant?: boolean;
    group?: string;
  }>;
  onContentAwareFill?: () => void;
  onContentAwareDelete?: () => void;
  onFreeTransform?: () => void;
  isFreeTransformEnabled?: boolean;
  onInvertSelection?: () => void;
  onSelectAll?: () => void;
  onDeselect?: () => void;
  onSelectAllLayers?: () => void;
  onDeselectLayers?: () => void;
  onFindLayers?: () => void;
  onClose?: () => void;
  onCloseAll?: () => void;
  onSaveACopy?: () => void;
  recentFiles?: string[];
  onOpenRecent?: (path: string) => void;
  onClearRecentFiles?: () => void;
  onExit?: () => void;
  onPreferences?: () => void;
  /** Current document pixel format — drives the Image → Color Mode checked states. */
  pixelFormat?: PixelFormat;
  /** Called when the user picks a color mode from Image → Color Mode. */
  onSetColorMode?: (format: PixelFormat) => void;
  /** When true, hides the custom menu bar (logo + menu) — used on macOS where the native app menu is shown instead. */
  isMac?: boolean;
}

export function TopBar({
  onDebug,
  onNew,
  onOpen,
  onSave,
  onSaveAs,
  onExport,
  onUndo,
  onRedo,
  onCut,
  onCopy,
  onCopyMerged,
  onPaste,
  onPasteInto,
  onDelete,
  onResizeImage,
  onResizeCanvas,
  onRotate90CW,
  onRotate180,
  onRotate270CW,
  onFlipHorizontal,
  onFlipVertical,
  onZoomIn,
  onZoomOut,
  onZoom100,
  onFitToWindow,
  onToggleGrid,
  showGrid,
  onToggleRulers,
  showRulers,
  onToggleGuides,
  showGuides,
  onApplyGuidePreset,
  onSetNormalMode,
  onSetTiledMode,
  tiledMode,
  onToggleTileGrid,
  showTileGrid,
  onSetAnimationMode,
  animationMode,
  onNewLayer,
  onNewLayerGroup,
  onNewCompositeLayer,
  onAddLayerMask,
  onDuplicateLayer,
  onDeleteLayer,
  onGroupLayers,
  isGroupLayersEnabled,
  onUngroupLayers,
  isUngroupLayersEnabled,
  onMergeDown,
  onMergeVisible,
  onFlattenImage,
  onRasterizeLayer,
  isRasterizeEnabled,
  onMergeSelected,
  isMergeSelectedEnabled,
  onLayerRotate,
  onLayerFlip,
  onLayerAlign,
  onLayerDistribute,
  onLayerOrder,
  onAbout,
  onKeyboardShortcuts,
  onSystemInfo,
  onCreateAdjustmentLayer,
  isAdjustmentMenuEnabled,
  adjustmentMenuItems,
  effectsMenuItems,
  onOpenFilterDialog,
  onInstantFilter,
  isFiltersMenuEnabled,
  filterMenuItems,
  onContentAwareFill,
  onContentAwareDelete,
  onFreeTransform,
  isFreeTransformEnabled,
  onInvertSelection,
  onSelectAll,
  onDeselect,
  onSelectAllLayers,
  onDeselectLayers,
  onFindLayers,
  onClose,
  onCloseAll,
  onSaveACopy,
  recentFiles,
  onOpenRecent,
  onClearRecentFiles,
  onExit,
  onPreferences,
  pixelFormat,
  onSetColorMode,
  isMac,
}: TopBarProps): React.JSX.Element {
  const dockLayout = useDockLayout();
  const menus = useMemo(
    (): MenuDef[] => [
      {
        label: "File",
        items: [
          { label: "New\u2026", shortcut: "Ctrl+N", action: onNew },
          { label: "Open\u2026", shortcut: "Ctrl+O", action: onOpen },
          {
            label: "Open Recent",
            submenu:
              recentFiles && recentFiles.length > 0
                ? [
                    ...recentFiles.map((path) => ({
                      label: path.split(/[\\/]/).pop() ?? path,
                      action: () => onOpenRecent?.(path),
                    })),
                    { separator: true, label: "" },
                    { label: "Clear Recent", action: onClearRecentFiles },
                  ]
                : [{ label: "No Recent Files", disabled: true }],
          },
          { separator: true, label: "" },
          { label: "Close", action: onClose },
          { label: "Close All", action: onCloseAll },
          { separator: true, label: "" },
          { label: "Save", shortcut: "Ctrl+S", action: onSave },
          {
            label: "Save As\u2026",
            shortcut: "Ctrl+Shift+S",
            action: onSaveAs,
          },
          { label: "Save a Copy\u2026", action: onSaveACopy },
          { label: "Export As\u2026", shortcut: "Ctrl+E", action: onExport },
          { separator: true, label: "" },
          { label: "Preferences…", action: onPreferences },
          { separator: true, label: "" },
          { label: "Exit", action: onExit },
        ],
      },
      {
        label: "Edit",
        items: [
          { label: "Undo", shortcut: "Ctrl+Z", action: onUndo },
          { label: "Redo", shortcut: "Ctrl+Y", action: onRedo },
          { separator: true, label: "" },
          { label: "Cut", shortcut: "Ctrl+X", action: onCut },
          { label: "Copy", shortcut: "Ctrl+C", action: onCopy },
          {
            label: "Copy Merged",
            shortcut: "Ctrl+Shift+C",
            action: onCopyMerged,
          },
          { label: "Paste", shortcut: "Ctrl+V", action: onPaste },
          {
            label: "Paste Into",
            shortcut: "Ctrl+Shift+V",
            action: onPasteInto,
          },
          { label: "Delete", shortcut: "Del", action: onDelete },
          { separator: true, label: "" },

          { label: "Content-Aware Fill", action: onContentAwareFill },
          {
            label: "Content-Aware Delete",
            shortcut: "Shift+Del",
            action: onContentAwareDelete,
          },
          { separator: true, label: "" },
          {
            label: "Transform\u2026",
            shortcut: "Ctrl+T",
            disabled: !isFreeTransformEnabled,
            action: onFreeTransform,
          },
        ],
      },
      {
        label: "Select",
        items: [
          { label: "All", shortcut: "Ctrl+A", action: onSelectAll },
          { label: "Deselect", shortcut: "Ctrl+D", action: onDeselect },
          { separator: true, label: "" },
          {
            label: "All Layers",
            shortcut: "Alt+Ctrl+A",
            action: onSelectAllLayers,
          },
          { label: "Deselect Layers", action: onDeselectLayers },
          { separator: true, label: "" },
          {
            label: "Find Layers",
            shortcut: isMac ? "Alt+Shift+Cmd+F" : "Alt+Shift+Ctrl+F",
            action: onFindLayers,
          },
          { separator: true, label: "" },
          {
            label: "Invert Selection",
            shortcut: "Ctrl+Shift+I",
            action: onInvertSelection,
          },
        ],
      },
      {
        label: "Layer",
        items: [
          { label: "New Layer", shortcut: "Ctrl+Shift+N", action: onNewLayer },
          { label: "New Layer Group", action: onNewLayerGroup },
          { label: "New Composite Layer", action: onNewCompositeLayer },
          {
            label: "Add Layer Mask",
            disabled: !onAddLayerMask,
            action: onAddLayerMask,
          },
          { label: "Duplicate Layer", action: onDuplicateLayer },
          { label: "Delete Layer", action: onDeleteLayer },
          { separator: true, label: "" },
          {
            label: "Rasterize Layer",
            disabled: !isRasterizeEnabled,
            action: onRasterizeLayer,
          },
          { separator: true, label: "" },
          {
            label: "Group Layers",
            shortcut: "Ctrl+G",
            disabled: !isGroupLayersEnabled,
            action: onGroupLayers,
          },
          {
            label: "Ungroup Layers",
            shortcut: "Ctrl+Shift+G",
            disabled: !isUngroupLayersEnabled,
            action: onUngroupLayers,
          },
          { separator: true, label: "" },
          {
            label: "Merge Selected",
            disabled: !isMergeSelectedEnabled,
            action: onMergeSelected,
          },
          { label: "Merge Down", action: onMergeDown },
          { label: "Merge Visible", action: onMergeVisible },
          { label: "Flatten Image", action: onFlattenImage },
          { separator: true, label: "" },
          {
            label: "Rotate",
            submenu: [
              { label: "90° CW", action: () => onLayerRotate?.("90cw") },
              { label: "180° CW", action: () => onLayerRotate?.("180") },
              { label: "270° CW", action: () => onLayerRotate?.("270cw") },
            ],
          },
          {
            label: "Flip",
            submenu: [
              {
                label: "Horizontal",
                action: () => onLayerFlip?.("horizontal"),
              },
              { label: "Vertical", action: () => onLayerFlip?.("vertical") },
            ],
          },
          { separator: true, label: "" },
          {
            label: "Align",
            submenu: [
              { label: "Left", action: () => onLayerAlign?.("left") },
              {
                label: "Center Vertical",
                action: () => onLayerAlign?.("centerV"),
              },
              { label: "Right", action: () => onLayerAlign?.("right") },
              { label: "Top", action: () => onLayerAlign?.("top") },
              {
                label: "Center Horizontal",
                action: () => onLayerAlign?.("centerH"),
              },
              { label: "Bottom", action: () => onLayerAlign?.("bottom") },
            ],
          },
          {
            label: "Distribute",
            submenu: [
              {
                label: "Horizontally",
                action: () => onLayerDistribute?.("horizontal"),
              },
              {
                label: "Vertically",
                action: () => onLayerDistribute?.("vertical"),
              },
            ],
          },
          {
            label: "Order",
            submenu: [
              {
                label: "Bring to Front",
                action: () => onLayerOrder?.("front"),
              },
              { label: "Bring to Back", action: () => onLayerOrder?.("back") },
              { label: "Forward", action: () => onLayerOrder?.("forward") },
              { label: "Backward", action: () => onLayerOrder?.("backward") },
              { separator: true, label: "" },
              {
                label: "Reverse Order",
                action: () => onLayerOrder?.("reverse"),
              },
            ],
          },
        ],
      },
      {
        label: "Image",
        items: [
          {
            label: "Color Mode",
            submenu: [
              {
                label: "RGB/8",
                checked: pixelFormat === "rgba8",
                action: () => onSetColorMode?.("rgba8"),
              },
              {
                label: "RGB/32 Float",
                checked: pixelFormat === "rgba32f",
                action: () => onSetColorMode?.("rgba32f"),
              },
              {
                label: "Indexed/8",
                checked: pixelFormat === "indexed8",
                action: () => onSetColorMode?.("indexed8"),
              },
            ],
          },
          { separator: true, label: "" },
          { label: "Resize Image…", action: onResizeImage },
          { label: "Resize Image Canvas…", action: onResizeCanvas },
          { separator: true, label: "" },
          {
            label: "Rotate",
            submenu: [
              { label: "90° CW", action: onRotate90CW },
              { label: "180° CW", action: onRotate180 },
              { label: "270° CW", action: onRotate270CW },
            ],
          },
          {
            label: "Flip",
            submenu: [
              { label: "Horizontal", action: onFlipHorizontal },
              { label: "Vertical", action: onFlipVertical },
            ],
          },
        ],
      },
      {
        label: "Adjustments",
        items: (() => {
          const result: MenuDef["items"] = [];
          let lastGroup: string | undefined = undefined;
          for (const item of adjustmentMenuItems ?? []) {
            if (
              item.group !== undefined &&
              item.group !== lastGroup &&
              lastGroup !== undefined
            ) {
              result.push({ separator: true, label: "" });
            }
            lastGroup = item.group;
            result.push({
              label: item.label,
              disabled:
                !isAdjustmentMenuEnabled ||
                pixelFormat === "indexed8" ||
                (item.type === "reduce-colors" && pixelFormat !== "rgba8"),
              action: () => onCreateAdjustmentLayer?.(item.type),
            });
          }
          return result;
        })(),
      },
      {
        label: "Effects",
        items: (() => {
          const result: MenuDef["items"] = [];
          let lastGroup: string | undefined = undefined;
          for (const item of effectsMenuItems ?? []) {
            if (
              item.group !== undefined &&
              item.group !== lastGroup &&
              lastGroup !== undefined
            ) {
              result.push({ separator: true, label: "" });
            }
            lastGroup = item.group;
            result.push({
              label: item.label,
              disabled: !isAdjustmentMenuEnabled || pixelFormat === "indexed8",
              action: () => onCreateAdjustmentLayer?.(item.type),
            });
          }
          return result;
        })(),
      },
      {
        label: "Filters",
        items: (() => {
          const result: MenuDef["items"] = [];
          let lastGroup: string | undefined = undefined;
          for (const item of filterMenuItems ?? []) {
            if (
              item.group !== undefined &&
              item.group !== lastGroup &&
              lastGroup !== undefined
            ) {
              result.push({ separator: true, label: "" });
            }
            lastGroup = item.group;
            result.push({
              label: item.label,
              disabled: !isFiltersMenuEnabled || pixelFormat === "indexed8",
              action: () =>
                item.instant
                  ? onInstantFilter?.(item.key)
                  : onOpenFilterDialog?.(item.key),
            });
          }
          return result;
        })(),
      },
      {
        label: "View",
        items: [
          { label: "Zoom In", shortcut: "Ctrl+=", action: onZoomIn },
          { label: "Zoom Out", shortcut: "Ctrl+-", action: onZoomOut },
          { label: "Zoom to 100%", shortcut: "Ctrl+1", action: onZoom100 },
          { label: "Fit to Window", shortcut: "Ctrl+0", action: onFitToWindow },
          { separator: true, label: "" },
          {
            label: "Show Grid",
            shortcut: "Ctrl+'",
            action: onToggleGrid,
            checked: showGrid,
          },
          {
            label: "Show Rulers",
            shortcut: "Ctrl+R",
            action: onToggleRulers,
            checked: showRulers,
          },
          {
            label: "Show Guides",
            shortcut: "Ctrl+;",
            action: onToggleGuides,
            checked: showGuides,
          },
          {
            label: "Guide Presets",
            submenu: [
              { label: "Thirds", action: () => onApplyGuidePreset?.("thirds") },
              {
                label: "Fourths",
                action: () => onApplyGuidePreset?.("fourths"),
              },
              {
                label: "Center Split",
                action: () => onApplyGuidePreset?.("center-split"),
              },
              {
                label: "Safe Zone",
                action: () => onApplyGuidePreset?.("safe-zone"),
              },
            ],
          },
          { separator: true, label: "" },
          {
            label: "Normal Mode",
            action: onSetNormalMode,
            checked: !tiledMode && !animationMode,
          },
          {
            label: "Tiled Mode",
            action: onSetTiledMode,
            checked: !!tiledMode && !animationMode,
          },
          {
            label: "Animation Mode",
            action: () => onSetAnimationMode?.(!animationMode),
            checked: !!animationMode,
          },
          { separator: true, label: "" },
          {
            label: "Show Tile Grid",
            action: onToggleTileGrid,
            checked: !!showTileGrid,
            disabled: !tiledMode,
          },
          { separator: true, label: "" },
          ...ALL_PANEL_IDS.map((id) => ({
            label: PANEL_LABELS[id],
            checked:
              dockLayout.rows.some((r) => r.panels.includes(id)) ||
              dockLayout.floatingWindows.some((w) => w.panelId === id),
            action: () => dockStore.togglePanel(id),
          })),
          { separator: true, label: "" },
          {
            label: "Reset Panel Layout",
            action: () => dockStore.resetLayout(),
          },
        ],
      },
      {
        label: "Help",
        items: [
          { label: "About Verve", action: onAbout },
          {
            label: "Keyboard Shortcuts",
            shortcut: "?",
            action: onKeyboardShortcuts,
          },
          { label: "System Information", action: onSystemInfo },
          { separator: true, label: "" },
          { label: "Open DevTools", action: onDebug },
        ],
      },
    ],
    [
      isMac,
      dockLayout,
      onDebug,
      onNew,
      onOpen,
      onSave,
      onSaveAs,
      onExport,
      onUndo,
      onRedo,
      onCut,
      onCopy,
      onCopyMerged,
      onPaste,
      onPasteInto,
      onDelete,
      onResizeImage,
      onResizeCanvas,
      onRotate90CW,
      onRotate180,
      onRotate270CW,
      onFlipHorizontal,
      onFlipVertical,
      onZoomIn,
      onZoomOut,
      onZoom100,
      onFitToWindow,
      onToggleGrid,
      showGrid,
      onToggleRulers,
      showRulers,
      onToggleGuides,
      showGuides,
      onApplyGuidePreset,
      onSetNormalMode,
      onSetTiledMode,
      tiledMode,
      onToggleTileGrid,
      showTileGrid,
      onSetAnimationMode,
      animationMode,
      onNewLayer,
      onNewLayerGroup,
      onNewCompositeLayer,
      onAddLayerMask,
      onDuplicateLayer,
      onDeleteLayer,
      onGroupLayers,
      isGroupLayersEnabled,
      onUngroupLayers,
      isUngroupLayersEnabled,
      onMergeDown,
      onMergeVisible,
      onFlattenImage,
      onRasterizeLayer,
      isRasterizeEnabled,
      onMergeSelected,
      isMergeSelectedEnabled,
      onLayerRotate,
      onLayerFlip,
      onLayerAlign,
      onLayerDistribute,
      onLayerOrder,
      onAbout,
      onKeyboardShortcuts,
      onSystemInfo,
      onCreateAdjustmentLayer,
      isAdjustmentMenuEnabled,
      adjustmentMenuItems,
      effectsMenuItems,
      onOpenFilterDialog,
      onInstantFilter,
      isFiltersMenuEnabled,
      filterMenuItems,
      onContentAwareFill,
      onContentAwareDelete,
      onFreeTransform,
      isFreeTransformEnabled,
      onInvertSelection,
      onSelectAll,
      onDeselect,
      onSelectAllLayers,
      onDeselectLayers,
      onFindLayers,
      onClose,
      onCloseAll,
      onSaveACopy,
      recentFiles,
      onOpenRecent,
      onClearRecentFiles,
      onExit,
      onPreferences,
      pixelFormat,
      onSetColorMode,
    ],
  );

  // On macOS the native application menu replaces the entire custom top bar.
  if (isMac) return <></>;

  return (
    <div className={styles.topBar}>
      {/* Left: Logo + menus */}
      <div className={styles.left}>
        {/* PS-style home/logo icon */}
        <button
          className={styles.logoBtn}
          aria-label="Verve home"
          title="Verve"
        >
          <svg viewBox="0 0 16 16" fill="currentColor" width="16" height="16">
            <rect x="1" y="1" width="6" height="6" rx="1" />
            <rect x="9" y="1" width="6" height="6" rx="1" />
            <rect x="1" y="9" width="6" height="6" rx="1" />
            <rect x="9" y="9" width="6" height="6" rx="1" />
          </svg>
        </button>

        <div className={styles.menuDivider} />

        <MenuBar menus={menus} />
      </div>

      {tiledMode && (
        <div className={styles.center}>
          <span className={styles.tiledBadge}>TILED</span>
        </div>
      )}

      {/* Right: debug button */}
      <div className={styles.right}>
        <button
          className={styles.debugBtn}
          onClick={onDebug}
          title="Open DevTools"
          aria-label="Open DevTools"
        >
          <svg
            viewBox="0 0 16 16"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.4"
            strokeLinecap="round"
            strokeLinejoin="round"
            width="14"
            height="14"
          >
            <polyline points="4,6 1,8 4,10" />
            <polyline points="12,6 15,8 12,10" />
            <line x1="9" y1="3" x2="7" y2="13" />
          </svg>
        </button>
      </div>
    </div>
  );
}
