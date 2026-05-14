/**
 * Unified menu definitions.
 *
 * One function — `buildMenuTree(deps)` — produces the entire app menu as a
 * tree of `MenuNode`s. Two consumers walk that same tree:
 *
 *   * `TopBar.tsx` (Windows/Linux): filters out macOS-only nodes,
 *     hands the tree to `<MenuBar />`. Each node carries a direct
 *     `action: () => void` invoked on click.
 *
 *   * `useMacNativeMenu.ts` (macOS): filters out in-app-only nodes,
 *     serializes a function-free copy of the tree to the main process
 *     (which builds the native macOS menu from it), and locally keeps
 *     a `Map<actionId, action>` for dispatching IPC menu actions
 *     back to renderer-side handlers.
 *
 * Previously each menu entry had to be hand-encoded twice — once as a
 * `MenuDef` here in the renderer, once as a static template in the main
 * process — with three separate IPC channels syncing the enabled/checked
 * /visible flags between them. Every menu change became a four-file
 * cross-process edit and the two definitions drifted easily. This module
 * is the single source of truth; the two consumers are thin transforms.
 *
 * ── Design notes ──────────────────────────────────────────────────────
 *
 * `MenuNode.targets` decides which consumer renders the node:
 *   * `"both"` (default) — both menus include it.
 *   * `"app"` — only the in-app menu (Windows/Linux). Used for entries
 *     that macOS hosts in its app-menu spot (About, Preferences, Exit).
 *   * `"mac"` — only the macOS menu. Used for the app-menu spot and for
 *     OS-provided roles (Services, Hide Others, Quit, etc.).
 *
 * `MenuNode.role` carries an Electron native role (`"quit"`, `"services"`,
 * etc.). When set, the macOS menu uses Electron's built-in behavior for
 * that role and ignores `action`. The in-app menu doesn't see role-only
 * nodes because they all carry `targets: "mac"`.
 *
 * `MenuNode.shortcut` uses Electron's `CmdOrCtrl+T` notation throughout
 * — the macOS menu uses it verbatim; the in-app menu's `MenuBar` strips
 * `CmdOrCtrl+` → `Ctrl+` for display so Windows/Linux users see the
 * idiomatic form.
 *
 * `MenuNode.noIntercept` (macOS only) makes the accelerator display in
 * the menu but lets the renderer's own `keydown` listener handle the
 * combo. Required for shortcuts the renderer dispatches conditionally
 * based on focus / tool state (Ctrl+Z, Ctrl+C, …).
 */
import type { FilterKey, PixelFormat } from "@/types";
import type { EffectType } from "@/core/effects/effectTypes";
import type { GuidePreset } from "@/core/services/useViewActions";
import type {
  AlignEdge,
  DistributeAxis,
  OrderOp,
} from "@/core/services/useLayerArrange";
import type { LutCategory, LutTransform } from "@/core/lut";
import type { PanelId } from "@/ux/main/RightPanel/Dock/types";
import { ALL_PANEL_IDS, PANEL_LABELS } from "@/ux/main/RightPanel/Dock/types";
import { lutCategory } from "@/core/lut";
import { dockStore } from "@/ux/main/RightPanel/Dock/dockStore";

// ─── MenuNode ─────────────────────────────────────────────────────────────

export type MenuTarget = "both" | "app" | "mac";

export type MenuRole =
  | "about"
  | "services"
  | "hide"
  | "hideOthers"
  | "unhide"
  | "quit";

export interface MenuNode {
  label: string;
  /** Stable ID. Required for any node with an action so the macOS IPC
   *  bridge can route clicks back to a renderer-side handler. Auto-
   *  generated for inline menu items only when not provided. */
  actionId?: string;
  /** Direct handler. Stripped before IPC serialization to the main
   *  process. The macOS IPC dispatcher invokes it via `actionId`
   *  lookup; the in-app menu invokes it directly on click. */
  action?: () => void;
  /** Electron native menu role. Implies `targets: "mac"` and OS-managed
   *  behavior (Services list, Quit, etc.). */
  role?: MenuRole;
  /** Which menu consumer renders this node. Default `"both"`. */
  targets?: MenuTarget;
  /** Electron-notation accelerator (e.g. `"CmdOrCtrl+T"`). Renderer
   *  strips the platform prefix for display. */
  shortcut?: string;
  /** macOS: show the accelerator without intercepting the keypress.
   *  Used for shortcuts the renderer's keydown listener owns. */
  noIntercept?: boolean;
  /** Submenu's display state. */
  disabled?: boolean;
  checked?: boolean;
  /** When true, the entry is filtered out before rendering — used for
   *  conditional show/hide such as "hide Animation when animation mode
   *  is off." Implemented by both consumers. */
  hidden?: boolean;
  separator?: boolean;
  submenu?: MenuNode[];
  /** Windows/Linux only. Override the dropdown width (in px) for this
   *  node's `submenu`. Ignored by the macOS native menu, which sizes
   *  its dropdowns automatically. */
  width?: number;
}

/** Function-free shape that gets sent over IPC. Identical to MenuNode but
 *  without `action`. The main process builds the macOS menu from this. */
export interface SerializableMenuNode {
  label: string;
  actionId?: string;
  role?: MenuRole;
  targets?: MenuTarget;
  shortcut?: string;
  noIntercept?: boolean;
  disabled?: boolean;
  checked?: boolean;
  hidden?: boolean;
  separator?: boolean;
  submenu?: SerializableMenuNode[];
}

/** Strip `action` functions from a tree so it can cross the renderer ↔
 *  main process boundary via `structuredClone` / JSON. The macOS path's
 *  IPC dispatcher already has the matching `action` via the actionId
 *  map built in `useMacNativeMenu`. */
export function serializeTree(nodes: MenuNode[]): SerializableMenuNode[] {
  return nodes.map(serializeNode);
}

function serializeNode(node: MenuNode): SerializableMenuNode {
  const out: SerializableMenuNode = { label: node.label };
  if (node.actionId !== undefined) out.actionId = node.actionId;
  if (node.role !== undefined) out.role = node.role;
  if (node.targets !== undefined) out.targets = node.targets;
  if (node.shortcut !== undefined) out.shortcut = node.shortcut;
  if (node.noIntercept !== undefined) out.noIntercept = node.noIntercept;
  if (node.disabled !== undefined) out.disabled = node.disabled;
  if (node.checked !== undefined) out.checked = node.checked;
  if (node.hidden !== undefined) out.hidden = node.hidden;
  if (node.separator !== undefined) out.separator = node.separator;
  if (node.submenu !== undefined) out.submenu = node.submenu.map(serializeNode);
  return out;
}

/** Walk a tree and build a flat `actionId → action` map. Used by
 *  `useMacNativeMenu` to dispatch IPC clicks. */
export function collectActions(
  nodes: MenuNode[],
  out: Map<string, () => void> = new Map(),
): Map<string, () => void> {
  for (const n of nodes) {
    if (n.actionId !== undefined && n.action !== undefined) {
      out.set(n.actionId, n.action);
    }
    if (n.submenu) collectActions(n.submenu, out);
  }
  return out;
}

/** Drop nodes whose `targets` excludes this consumer, and recursively
 *  filter their submenus. Top-level menus that end up with empty
 *  submenus after filtering are dropped too (no Adjustments trigger
 *  pointing to an empty list, etc.). */
export function filterForTarget(
  nodes: MenuNode[],
  target: "app" | "mac",
): MenuNode[] {
  const out: MenuNode[] = [];
  for (const n of nodes) {
    if (n.hidden) continue;
    if (n.targets && n.targets !== "both" && n.targets !== target) continue;
    if (n.submenu) {
      const subFiltered = filterForTarget(n.submenu, target);
      if (subFiltered.length === 0 && !n.action && !n.role && !n.separator) {
        // Container with no surviving children → drop.
        continue;
      }
      out.push({ ...n, submenu: subFiltered });
    } else {
      out.push(n);
    }
  }
  return out;
}

// ─── Deps ─────────────────────────────────────────────────────────────────

export interface MenuDeps {
  // ── File ──────────────────────────────────────────────────────────────
  onNew?: () => void;
  onOpen?: () => void;
  onSave?: () => void;
  onSaveAs?: () => void;
  onSaveACopy?: () => void;
  onExport?: () => void;
  onClose?: () => void;
  onCloseAll?: () => void;
  recentFiles?: string[];
  onOpenRecent?: (path: string) => void;
  onClearRecentFiles?: () => void;
  onPreferences?: () => void;
  onExit?: () => void;

  // ── Edit ──────────────────────────────────────────────────────────────
  onUndo?: () => void;
  onRedo?: () => void;
  onCut?: () => void;
  onCopy?: () => void;
  onCopyMerged?: () => void;
  onPaste?: () => void;
  onPasteInto?: () => void;
  onDelete?: () => void;
  onContentAwareFill?: () => void;
  onContentAwareDelete?: () => void;
  onFreeTransform?: () => void;
  isFreeTransformEnabled?: boolean;

  // ── Select ────────────────────────────────────────────────────────────
  onSelectAll?: () => void;
  onDeselect?: () => void;
  onSelectAllLayers?: () => void;
  onDeselectLayers?: () => void;
  onFindLayers?: () => void;
  onInvertSelection?: () => void;

  // ── Layer ─────────────────────────────────────────────────────────────
  onNewLayer?: () => void;
  onNewLayerGroup?: () => void;
  onNewCompositeLayer?: () => void;
  onNewLinkedLayer?: () => void;
  onRefreshLinkedLayer?: () => void;
  /** True when the active layer is a linked layer (drives enabled-state on
   *  Refresh Linked Layer). */
  isLinkedLayerActive?: boolean;
  onAddLayerMask?: () => void;
  onDuplicateLayer?: () => void;
  onDeleteLayer?: () => void;
  onRasterizeLayer?: () => void;
  isRasterizeEnabled?: boolean;
  onGroupLayers?: () => void;
  isGroupLayersEnabled?: boolean;
  onUngroupLayers?: () => void;
  isUngroupLayersEnabled?: boolean;
  onMergeSelected?: () => void;
  isMergeSelectedEnabled?: boolean;
  onMergeDown?: () => void;
  onMergeVisible?: () => void;
  onFlattenImage?: () => void;
  onLayerRotate?: (amount: "90cw" | "180" | "270cw") => void;
  onLayerFlip?: (axis: "horizontal" | "vertical") => void;
  onLayerAlign?: (edge: AlignEdge) => void;
  onLayerDistribute?: (axis: DistributeAxis) => void;
  onLayerOrder?: (op: OrderOp) => void;

  // ── Image ─────────────────────────────────────────────────────────────
  pixelFormat?: PixelFormat;
  onSetColorMode?: (format: PixelFormat) => void;
  /** True when the active document has an embedded ICC profile. Drives
   *  enabled-state on Convert to Profile / Remove Profile. */
  hasIccProfile?: boolean;
  /** Open a file picker, read the chosen .icc/.icm, and assign it to the
   *  active document. Tag-only — pixel values are unchanged. */
  onAssignProfile?: () => void;
  /** Open a file picker and convert the active document's pixels from the
   *  current profile to the picked profile via lcms2. */
  onConvertToProfile?: () => void;
  /** Clear the document's ICC tag (renderer falls back to the working-
   *  space default for the document's pixel format). */
  onRemoveProfile?: () => void;
  /** True when a display-profile correction LUT is currently active. */
  hasDisplayProfile?: boolean;
  /** Pick an .icc/.icm file describing the display and apply it as a
   *  correction LUT in the blit pipeline. Tier 2b. */
  onSetDisplayProfile?: () => void;
  /** Clear the active display profile. */
  onClearDisplayProfile?: () => void;
  /** Open the Color Settings dialog (default intents, BPC, missing-profile
   *  policy). Tier 2c. */
  onOpenColorSettings?: () => void;
  /** Open the Profile Manager dialog (browse system + user-imported ICC
   *  profiles, import new ones). Tier 3d. */
  onOpenProfileManager?: () => void;
  onResizeImage?: () => void;
  onResizeCanvas?: () => void;
  onRescaleImage?: () => void;
  isRescaleEnabled?: boolean;
  onRestoreImage?: () => void;
  isRestoreEnabled?: boolean;
  onRotate90CW?: () => void;
  onRotate180?: () => void;
  onRotate270CW?: () => void;
  onFlipHorizontal?: () => void;
  onFlipVertical?: () => void;
  onLoadLut?: () => void;
  onManageLuts?: () => void;
  onSetViewTransform?: (id: string | null) => void;
  luts?: LutTransform[];
  activeViewLut?: string | null;

  // ── Adjustments / Effects / Filters ───────────────────────────────────
  onCreateAdjustmentLayer?: (type: EffectType) => void;
  isAdjustmentMenuEnabled?: boolean;
  adjustmentMenuItems?: Array<{
    type: EffectType;
    label: string;
    group?: string;
  }>;
  effectsMenuItems?: Array<{
    type: EffectType;
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

  // ── Animation ─────────────────────────────────────────────────────────
  animationMode?: boolean;
  isPlaying?: boolean;
  paletteAnimationActive?: boolean;
  onPlayPause?: () => void;
  onPrevFrame?: () => void;
  onNextFrame?: () => void;
  onPrevAnimation?: () => void;
  onNextAnimation?: () => void;
  onImportSpritesheetFrames?: () => void;
  onExportSpritesheetJson?: () => void;
  onExportPaletteAnimationJson?: () => void;
  onExportAnimationFrames?: () => void;

  // ── View ──────────────────────────────────────────────────────────────
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
  /** Panel ids currently open (used to drive the checkbox states on
   *  the View → <panel name> entries). */
  openPanelIds?: ReadonlyArray<PanelId>;
  // ── Soft proofing (Tier 3a/3b) ─────────────────────────────────────────
  /** Open the Proof Setup dialog. */
  onOpenProofSetup?: () => void;
  /** Toggle the "Proof Colors" mode (Cmd/Ctrl+Y). */
  onToggleProofColors?: () => void;
  /** Toggle gamut warning overlay (Cmd/Ctrl+Shift+Y). */
  onToggleGamutWarning?: () => void;
  /** True when soft proofing is currently active. */
  proofColorsActive?: boolean;
  /** True when gamut warning overlay is on. */
  gamutWarningActive?: boolean;
  /** True when a proof profile has been picked (drives enabled-state on
   *  the Proof Colors / Gamut Warning toggles). */
  hasProofProfile?: boolean;

  // ── Help ──────────────────────────────────────────────────────────────
  onAbout?: () => void;
  onKeyboardShortcuts?: () => void;
  onSystemInfo?: () => void;
  onDebug?: () => void;
  /** When true, dev-only entries (Open DevTools) are filtered out. */
  isProd?: boolean;

  /** App name shown in the macOS app menu (defaults to "Verve"). */
  appName?: string;
}

// ─── Helpers ─────────────────────────────────────────────────────────────

const SEP: MenuNode = { label: "", separator: true };
const macOnly = <T extends MenuNode>(n: T): T => ({ ...n, targets: "mac" });
const appOnly = <T extends MenuNode>(n: T): T => ({ ...n, targets: "app" });

/** Group the dynamic registries (adjustments / effects / filters) by
 *  their `group` tag, inserting separators between groups. Same logic
 *  the previous in-app builder used. */
function groupedItems<T extends { group?: string }>(
  items: ReadonlyArray<T>,
  build: (item: T) => MenuNode,
): MenuNode[] {
  const out: MenuNode[] = [];
  let lastGroup: string | undefined = undefined;
  for (const item of items) {
    if (
      item.group !== undefined &&
      item.group !== lastGroup &&
      lastGroup !== undefined
    ) {
      out.push(SEP);
    }
    lastGroup = item.group;
    out.push(build(item));
  }
  return out;
}

/** View Transform submenu — "None" + categorised LUT picks with a
 *  checkmark on the active one. */
function viewTransformSubmenu(deps: MenuDeps): MenuNode[] {
  const luts = deps.luts ?? [];
  const active = deps.activeViewLut ?? null;
  const items: MenuNode[] = [
    {
      label: "None",
      actionId: "lut:setView:",
      action: () => deps.onSetViewTransform?.(null),
      checked: active === null,
    },
  ];
  const order: LutCategory[] = [
    "view-transform",
    "camera-idt",
    "creative",
    "ocio",
  ];
  const grouped = new Map<LutCategory, LutTransform[]>();
  for (const l of luts) {
    const cat = lutCategory(l);
    const list = grouped.get(cat) ?? [];
    list.push(l);
    grouped.set(cat, list);
  }
  for (const cat of order) {
    const list = grouped.get(cat);
    if (!list || list.length === 0) continue;
    items.push(SEP);
    for (const l of list) {
      items.push({
        label: l.name,
        actionId: `lut:setView:${l.id}`,
        action: () => deps.onSetViewTransform?.(l.id),
        checked: active === l.id,
      });
    }
  }
  return items;
}

/** Effects menu has one special case the others don't: items whose group
 *  is `fx-distortion` collapse into a single "Distortion" submenu at the
 *  first such item's position. Keeps the top-level Effects list flat. */
function effectsItems(deps: MenuDeps): MenuNode[] {
  const items = deps.effectsMenuItems ?? [];
  const distortionItems = items.filter((i) => i.group === "fx-distortion");
  const indexedBlocked = deps.pixelFormat === "indexed8";
  const disable =
    !deps.isAdjustmentMenuEnabled || indexedBlocked;
  const out: MenuNode[] = [];
  let lastGroup: string | undefined = undefined;
  let distortionInserted = false;
  for (const item of items) {
    if (item.group === "fx-distortion") {
      if (!distortionInserted) {
        if (lastGroup !== undefined && lastGroup !== "fx-distortion") out.push(SEP);
        out.push({
          label: "Distortion",
          submenu: distortionItems.map((d) => ({
            label: d.label,
            actionId: `adj:${d.type}`,
            action: () => deps.onCreateAdjustmentLayer?.(d.type),
            disabled: disable,
          })),
        });
        distortionInserted = true;
        lastGroup = item.group;
      }
      continue;
    }
    if (item.group !== undefined && item.group !== lastGroup && lastGroup !== undefined) {
      out.push(SEP);
    }
    lastGroup = item.group;
    out.push({
      label: item.label,
      actionId: `adj:${item.type}`,
      action: () => deps.onCreateAdjustmentLayer?.(item.type),
      disabled: disable,
    });
  }
  return out;
}

// ─── buildMenuTree ────────────────────────────────────────────────────────

export function buildMenuTree(deps: MenuDeps): MenuNode[] {
  const appName = deps.appName ?? "Verve";
  const indexedBlocked = deps.pixelFormat === "indexed8";
  const adjDisable =
    !deps.isAdjustmentMenuEnabled || indexedBlocked;
  const filterDisable = !deps.isFiltersMenuEnabled || indexedBlocked;

  // ── macOS App menu (Verve > About, Preferences, Services, Quit, …) ──
  //
  // The whole menu only exists on macOS. About / Preferences also appear
  // in the in-app Help and File menus respectively (via `appOnly` nodes)
  // — same handlers, different parent. Native roles handle the rest.
  const appMenu: MenuNode = macOnly({
    label: appName,
    submenu: [
      { label: `About ${appName}`, role: "about", targets: "mac" },
      { ...SEP, targets: "mac" },
      {
        label: "Preferences…",
        actionId: "preferences",
        action: deps.onPreferences,
        shortcut: "CmdOrCtrl+,",
        targets: "mac",
      },
      { ...SEP, targets: "mac" },
      { label: "Services", role: "services", targets: "mac" },
      { ...SEP, targets: "mac" },
      { label: "Hide", role: "hide", targets: "mac" },
      { label: "Hide Others", role: "hideOthers", targets: "mac" },
      { label: "Show All", role: "unhide", targets: "mac" },
      { ...SEP, targets: "mac" },
      { label: "Quit", role: "quit", targets: "mac" },
    ],
  });

  // ── Recent files ────────────────────────────────────────────────────
  const recent = deps.recentFiles ?? [];
  const recentSubmenu: MenuNode[] =
    recent.length > 0
      ? [
          ...recent.map((path, i) => ({
            label: path.split(/[\\/]/).pop() ?? path,
            actionId: `recentFile:${i}`,
            action: () => deps.onOpenRecent?.(path),
          })),
          SEP,
          {
            label: "Clear Recent",
            actionId: "clearRecentFiles",
            action: deps.onClearRecentFiles,
          },
        ]
      : [{ label: "No Recent Files", disabled: true }];

  // ── Help (DevTools is dev-only) ─────────────────────────────────────
  const helpItems: MenuNode[] = [
    // About appears here in the in-app menu; on macOS it lives in the
    // app menu (above) so we skip it on that side.
    {
      label: `About ${appName}`,
      actionId: "about",
      action: deps.onAbout,
      targets: "app",
    },
    {
      label: "Keyboard Shortcuts",
      actionId: "keyboardShortcuts",
      action: deps.onKeyboardShortcuts,
      shortcut: "?",
      noIntercept: true,
    },
    {
      label: "System Information",
      actionId: "systemInfo",
      action: deps.onSystemInfo,
    },
  ];
  if (!deps.isProd) {
    helpItems.push(SEP, {
      label: "Open DevTools",
      actionId: "openDevTools",
      action: deps.onDebug,
    });
  }

  return [
    appMenu,
    {
      label: "File",
      submenu: [
        { label: "New…", actionId: "new", action: deps.onNew, shortcut: "CmdOrCtrl+N" },
        { label: "Open…", actionId: "open", action: deps.onOpen, shortcut: "CmdOrCtrl+O" },
        { label: "Open Recent", submenu: recentSubmenu },
        SEP,
        { label: "Close", actionId: "close", action: deps.onClose },
        { label: "Close All", actionId: "closeAll", action: deps.onCloseAll },
        SEP,
        { label: "Save", actionId: "save", action: deps.onSave, shortcut: "CmdOrCtrl+S" },
        {
          label: "Save As…",
          actionId: "saveAs",
          action: deps.onSaveAs,
          shortcut: "CmdOrCtrl+Shift+S",
        },
        { label: "Save a Copy…", actionId: "saveACopy", action: deps.onSaveACopy },
        { label: "Export As…", actionId: "export", action: deps.onExport, shortcut: "CmdOrCtrl+E" },
        // Preferences and Exit appear here only on Windows/Linux (macOS has
        // them in the app menu). `appOnly` keeps the native menu clean.
        appOnly(SEP),
        appOnly({ label: "Preferences…", actionId: "preferences", action: deps.onPreferences }),
        appOnly(SEP),
        appOnly({ label: "Exit", actionId: "exit", action: deps.onExit }),
      ],
    },
    {
      label: "Edit",
      submenu: [
        {
          label: "Undo",
          actionId: "undo",
          action: deps.onUndo,
          shortcut: "CmdOrCtrl+Z",
          noIntercept: true,
        },
        {
          label: "Redo",
          actionId: "redo",
          action: deps.onRedo,
          shortcut: "CmdOrCtrl+Y",
          noIntercept: true,
        },
        SEP,
        {
          label: "Cut",
          actionId: "cut",
          action: deps.onCut,
          shortcut: "CmdOrCtrl+X",
          noIntercept: true,
        },
        {
          label: "Copy",
          actionId: "copy",
          action: deps.onCopy,
          shortcut: "CmdOrCtrl+C",
          noIntercept: true,
        },
        {
          label: "Copy Merged",
          actionId: "copyMerged",
          action: deps.onCopyMerged,
          shortcut: "CmdOrCtrl+Shift+C",
          noIntercept: true,
        },
        {
          label: "Paste",
          actionId: "paste",
          action: deps.onPaste,
          shortcut: "CmdOrCtrl+V",
          noIntercept: true,
        },
        {
          label: "Paste Into",
          actionId: "pasteInto",
          action: deps.onPasteInto,
          shortcut: "CmdOrCtrl+Shift+V",
          noIntercept: true,
        },
        {
          label: "Delete",
          actionId: "delete",
          action: deps.onDelete,
          shortcut: "Backspace",
          noIntercept: true,
        },
        SEP,
        {
          label: "Content-Aware Fill",
          actionId: "contentAwareFill",
          action: deps.onContentAwareFill,
        },
        {
          label: "Content-Aware Delete",
          actionId: "contentAwareDelete",
          action: deps.onContentAwareDelete,
          shortcut: "Shift+Delete",
        },
        SEP,
        {
          label: "Transform…",
          actionId: "freeTransform",
          action: deps.onFreeTransform,
          shortcut: "CmdOrCtrl+T",
          noIntercept: true,
          disabled: !deps.isFreeTransformEnabled,
        },
      ],
    },
    {
      label: "Select",
      submenu: [
        {
          label: "All",
          actionId: "selectAll",
          action: deps.onSelectAll,
          shortcut: "CmdOrCtrl+A",
          noIntercept: true,
        },
        {
          label: "Deselect",
          actionId: "deselect",
          action: deps.onDeselect,
          shortcut: "CmdOrCtrl+D",
          noIntercept: true,
        },
        SEP,
        {
          label: "All Layers",
          actionId: "selectAllLayers",
          action: deps.onSelectAllLayers,
          shortcut: "Alt+CmdOrCtrl+A",
          noIntercept: true,
        },
        {
          label: "Deselect Layers",
          actionId: "deselectLayers",
          action: deps.onDeselectLayers,
        },
        SEP,
        {
          label: "Find Layers",
          actionId: "findLayers",
          action: deps.onFindLayers,
          shortcut: "Alt+Shift+CmdOrCtrl+F",
          noIntercept: true,
        },
        SEP,
        {
          label: "Invert Selection",
          actionId: "invertSelection",
          action: deps.onInvertSelection,
          shortcut: "CmdOrCtrl+Shift+I",
          noIntercept: true,
        },
      ],
    },
    {
      label: "Layer",
      submenu: [
        { label: "New Layer", actionId: "newLayer", action: deps.onNewLayer, shortcut: "CmdOrCtrl+Shift+N" },
        { label: "New Layer Group", actionId: "newLayerGroup", action: deps.onNewLayerGroup },
        { label: "New Composite Layer", actionId: "newCompositeLayer", action: deps.onNewCompositeLayer },
        { label: "New Linked Layer…", actionId: "newLinkedLayer", action: deps.onNewLinkedLayer },
        {
          label: "Refresh Linked Layer",
          actionId: "refreshLinkedLayer",
          action: deps.onRefreshLinkedLayer,
          disabled: !deps.isLinkedLayerActive,
        },
        {
          label: "Add Layer Mask",
          actionId: "addLayerMask",
          action: deps.onAddLayerMask,
          disabled: !deps.onAddLayerMask,
        },
        { label: "Duplicate Layer", actionId: "duplicateLayer", action: deps.onDuplicateLayer },
        { label: "Delete Layer", actionId: "deleteLayer", action: deps.onDeleteLayer },
        SEP,
        {
          label: "Rasterize Layer",
          actionId: "rasterizeLayer",
          action: deps.onRasterizeLayer,
          disabled: !deps.isRasterizeEnabled,
        },
        SEP,
        {
          label: "Group Layers",
          actionId: "groupLayers",
          action: deps.onGroupLayers,
          shortcut: "CmdOrCtrl+G",
          noIntercept: true,
          disabled: !deps.isGroupLayersEnabled,
        },
        {
          label: "Ungroup Layers",
          actionId: "ungroupLayers",
          action: deps.onUngroupLayers,
          shortcut: "CmdOrCtrl+Shift+G",
          noIntercept: true,
          disabled: !deps.isUngroupLayersEnabled,
        },
        SEP,
        {
          label: "Merge Selected",
          actionId: "mergeSelected",
          action: deps.onMergeSelected,
          disabled: !deps.isMergeSelectedEnabled,
        },
        { label: "Merge Down", actionId: "mergeDown", action: deps.onMergeDown },
        { label: "Merge Visible", actionId: "mergeVisible", action: deps.onMergeVisible },
        { label: "Flatten Image", actionId: "flattenImage", action: deps.onFlattenImage },
        SEP,
        {
          label: "Rotate",
          submenu: [
            { label: "90° CW", actionId: "layer:rotate90CW", action: () => deps.onLayerRotate?.("90cw") },
            { label: "180° CW", actionId: "layer:rotate180CW", action: () => deps.onLayerRotate?.("180") },
            { label: "270° CW", actionId: "layer:rotate270CW", action: () => deps.onLayerRotate?.("270cw") },
          ],
        },
        {
          label: "Flip",
          submenu: [
            { label: "Horizontal", actionId: "layer:flipHorizontal", action: () => deps.onLayerFlip?.("horizontal") },
            { label: "Vertical", actionId: "layer:flipVertical", action: () => deps.onLayerFlip?.("vertical") },
          ],
        },
        SEP,
        {
          label: "Align",
          submenu: [
            { label: "Left", actionId: "layer:alignLeft", action: () => deps.onLayerAlign?.("left") },
            { label: "Center Vertical", actionId: "layer:alignCenterV", action: () => deps.onLayerAlign?.("centerV") },
            { label: "Right", actionId: "layer:alignRight", action: () => deps.onLayerAlign?.("right") },
            { label: "Top", actionId: "layer:alignTop", action: () => deps.onLayerAlign?.("top") },
            { label: "Center Horizontal", actionId: "layer:alignCenterH", action: () => deps.onLayerAlign?.("centerH") },
            { label: "Bottom", actionId: "layer:alignBottom", action: () => deps.onLayerAlign?.("bottom") },
          ],
        },
        {
          label: "Distribute",
          submenu: [
            { label: "Horizontally", actionId: "layer:distributeH", action: () => deps.onLayerDistribute?.("horizontal") },
            { label: "Vertically", actionId: "layer:distributeV", action: () => deps.onLayerDistribute?.("vertical") },
          ],
        },
        {
          label: "Order",
          submenu: [
            { label: "Bring to Front", actionId: "layer:orderFront", action: () => deps.onLayerOrder?.("front") },
            { label: "Bring to Back", actionId: "layer:orderBack", action: () => deps.onLayerOrder?.("back") },
            { label: "Forward", actionId: "layer:orderForward", action: () => deps.onLayerOrder?.("forward") },
            { label: "Backward", actionId: "layer:orderBackward", action: () => deps.onLayerOrder?.("backward") },
            SEP,
            { label: "Reverse Order", actionId: "layer:orderReverse", action: () => deps.onLayerOrder?.("reverse") },
          ],
        },
      ],
    },
    {
      label: "Image",
      submenu: [
        {
          label: "Color Mode",
          submenu: [
            {
              label: "RGB/8",
              actionId: "colorMode:rgba8",
              action: () => deps.onSetColorMode?.("rgba8"),
              checked: deps.pixelFormat === "rgba8",
            },
            {
              label: "RGB/32 Float",
              actionId: "colorMode:rgba32f",
              action: () => deps.onSetColorMode?.("rgba32f"),
              checked: deps.pixelFormat === "rgba32f",
            },
            {
              label: "Indexed/8",
              actionId: "colorMode:indexed8",
              action: () => deps.onSetColorMode?.("indexed8"),
              checked: deps.pixelFormat === "indexed8",
            },
          ],
        },
        SEP,
        {
          label: "Color Settings…",
          actionId: "iccColorSettings",
          action: deps.onOpenColorSettings,
        },
        {
          label: "Manage Profiles…",
          actionId: "iccProfileManager",
          action: deps.onOpenProfileManager,
        },
        {
          label: "Assign Profile…",
          actionId: "iccAssignProfile",
          action: deps.onAssignProfile,
          // Indexed8 documents don't carry an ICC profile (palette indices
          // aren't colour values), so the operation is blocked there.
          disabled: deps.pixelFormat === "indexed8",
        },
        {
          label: "Convert to Profile…",
          actionId: "iccConvertToProfile",
          action: deps.onConvertToProfile,
          disabled: deps.pixelFormat === "indexed8",
        },
        {
          label: "Remove Profile",
          actionId: "iccRemoveProfile",
          action: deps.onRemoveProfile,
          disabled: !deps.hasIccProfile,
        },
        {
          label: "Display Profile",
          submenu: [
            {
              label: "Set Display Profile…",
              actionId: "iccSetDisplayProfile",
              action: deps.onSetDisplayProfile,
            },
            {
              label: "Clear Display Profile",
              actionId: "iccClearDisplayProfile",
              action: deps.onClearDisplayProfile,
              disabled: !deps.hasDisplayProfile,
            },
          ],
        },
        SEP,
        { label: "Load LUT…", actionId: "lut:loadCube", action: deps.onLoadLut },
        { label: "Manage LUTs…", actionId: "lut:manage", action: deps.onManageLuts },
        { label: "View Transform", submenu: viewTransformSubmenu(deps) },
        SEP,
        { label: "Resize Image…", actionId: "resizeImage", action: deps.onResizeImage },
        { label: "Resize Image Canvas…", actionId: "resizeCanvas", action: deps.onResizeCanvas },
        {
          label: "Rescale Image…",
          actionId: "rescaleImage",
          action: deps.onRescaleImage,
          disabled: !deps.isRescaleEnabled,
        },
        {
          label: "Restore Image…",
          actionId: "restoreImage",
          action: deps.onRestoreImage,
          disabled: !deps.isRestoreEnabled,
        },
        SEP,
        {
          label: "Rotate",
          submenu: [
            { label: "90° CW", actionId: "rotate90CW", action: deps.onRotate90CW },
            { label: "180° CW", actionId: "rotate180CW", action: deps.onRotate180 },
            { label: "270° CW", actionId: "rotate270CW", action: deps.onRotate270CW },
          ],
        },
        {
          label: "Flip",
          submenu: [
            { label: "Horizontal", actionId: "flipHorizontal", action: deps.onFlipHorizontal },
            { label: "Vertical", actionId: "flipVertical", action: deps.onFlipVertical },
          ],
        },
        
      ],
    },
    // Adjustments / Effects / Filters: hidden in indexed8, otherwise
    // their item list is built from the dynamic registries.
    {
      label: "Adjustments",
      hidden: indexedBlocked,
      submenu: groupedItems(deps.adjustmentMenuItems ?? [], (item) => ({
        label: item.label,
        actionId: `adj:${item.type}`,
        action: () => deps.onCreateAdjustmentLayer?.(item.type),
        disabled:
          adjDisable ||
          (item.type === "reduce-colors" && deps.pixelFormat !== "rgba8"),
      })),
    },
    {
      label: "Effects",
      hidden: indexedBlocked,
      submenu: effectsItems(deps),
    },
    {
      label: "Filters",
      hidden: indexedBlocked,
      submenu: (() => {
        const all = deps.filterMenuItems ?? [];
        const buildItem = (item: (typeof all)[number]): MenuNode => ({
          label: item.label,
          actionId: `filter:${item.key}`,
          action: () =>
            item.instant
              ? deps.onInstantFilter?.(item.key)
              : deps.onOpenFilterDialog?.(item.key),
          disabled: filterDisable,
        });
        // Split the "artistic" group out as a real nested submenu;
        // everything else stays in the flat top-level list (grouped by
        // separators between sections).
        const artistic = all.filter((i) => i.group === "artistic");
        const rest = all.filter((i) => i.group !== "artistic");
        const out: MenuNode[] = groupedItems(rest, buildItem);
        if (artistic.length > 0) {
          if (out.length > 0) out.push(SEP);
          out.push({
            label: "Artistic",
            disabled: filterDisable,
            submenu: artistic.map(buildItem),
          });
        }
        return out;
      })(),
    },
    // Animation: hidden entirely outside animation mode.
    {
      label: "Animation",
      hidden: !deps.animationMode,
      submenu: [
        {
          label: deps.isPlaying ? "Pause" : "Play",
          actionId: "playPause",
          action: deps.onPlayPause,
          shortcut: "Space",
          disabled: !deps.animationMode,
        },
        SEP,
        {
          label: "Previous Frame",
          actionId: "prevFrame",
          action: deps.onPrevFrame,
          shortcut: "Left",
          disabled: !deps.animationMode,
        },
        {
          label: "Next Frame",
          actionId: "nextFrame",
          action: deps.onNextFrame,
          shortcut: "Right",
          disabled: !deps.animationMode,
        },
        SEP,
        {
          label: "Previous Animation",
          actionId: "prevAnimation",
          action: deps.onPrevAnimation,
          shortcut: "Up",
          disabled: !deps.animationMode || !!deps.paletteAnimationActive,
        },
        {
          label: "Next Animation",
          actionId: "nextAnimation",
          action: deps.onNextAnimation,
          shortcut: "Down",
          disabled: !deps.animationMode || !!deps.paletteAnimationActive,
        },
        SEP,
        {
          label: "Import Frames Into Spritesheet…",
          actionId: "importSpritesheetFrames",
          action: deps.onImportSpritesheetFrames,
          disabled: !deps.animationMode,
        },
        {
          label: "Export Spritesheet JSON…",
          actionId: "exportSpritesheetJson",
          action: deps.onExportSpritesheetJson,
          disabled: !deps.animationMode,
        },
        {
          label: "Export Palette Animation JSON…",
          actionId: "exportPaletteAnimationJson",
          action: deps.onExportPaletteAnimationJson,
          disabled: !deps.animationMode,
        },
        SEP,
        {
          label: "Export Animation to Frames…",
          actionId: "exportAnimationFrames",
          action: deps.onExportAnimationFrames,
          disabled: !deps.animationMode,
        },
      ],
    },
    {
      label: "View",
      submenu: [
        { label: "Zoom In", actionId: "zoomIn", action: deps.onZoomIn, shortcut: "CmdOrCtrl+=", noIntercept: true },
        { label: "Zoom Out", actionId: "zoomOut", action: deps.onZoomOut, shortcut: "CmdOrCtrl+-", noIntercept: true },
        { label: "Zoom to 100%", actionId: "zoom100", action: deps.onZoom100, shortcut: "CmdOrCtrl+1", noIntercept: true },
        { label: "Fit to Window", actionId: "fitToWindow", action: deps.onFitToWindow, shortcut: "CmdOrCtrl+0", noIntercept: true },
        SEP,
        {
          label: "Show Grid",
          actionId: "toggleGrid",
          action: deps.onToggleGrid,
          shortcut: "CmdOrCtrl+'",
          checked: !!deps.showGrid,
        },
        {
          label: "Show Rulers",
          actionId: "toggleRulers",
          action: deps.onToggleRulers,
          shortcut: "CmdOrCtrl+R",
          checked: !!deps.showRulers,
        },
        {
          label: "Show Guides",
          actionId: "toggleGuides",
          action: deps.onToggleGuides,
          shortcut: "CmdOrCtrl+;",
          checked: !!deps.showGuides,
        },
        {
          label: "Guide Presets",
          submenu: [
            { label: "Thirds", actionId: "guidePreset:thirds", action: () => deps.onApplyGuidePreset?.("thirds") },
            { label: "Fourths", actionId: "guidePreset:fourths", action: () => deps.onApplyGuidePreset?.("fourths") },
            { label: "Center Split", actionId: "guidePreset:center-split", action: () => deps.onApplyGuidePreset?.("center-split") },
            { label: "Safe Zone", actionId: "guidePreset:safe-zone", action: () => deps.onApplyGuidePreset?.("safe-zone") },
          ],
        },
        SEP,
        {
          label: "Normal Mode",
          actionId: "setNormalMode",
          action: deps.onSetNormalMode,
          checked: !deps.tiledMode && !deps.animationMode,
        },
        {
          label: "Tiled Mode",
          actionId: "setTiledMode",
          action: deps.onSetTiledMode,
          checked: !!deps.tiledMode && !deps.animationMode,
        },
        {
          label: "Animation Mode",
          actionId: "setAnimationMode",
          action: () => deps.onSetAnimationMode?.(!deps.animationMode),
          checked: !!deps.animationMode,
        },
        SEP,
        {
          label: "Show Tile Grid",
          actionId: "toggleTileGrid",
          action: deps.onToggleTileGrid,
          checked: !!deps.showTileGrid,
          disabled: !deps.tiledMode,
        },
        SEP,
        {
          label: "Proof Setup…",
          actionId: "proofSetup",
          action: deps.onOpenProofSetup,
        },
        {
          label: "Proof Colors",
          actionId: "proofColors",
          action: deps.onToggleProofColors,
          shortcut: "CmdOrCtrl+Y",
          noIntercept: true,
          checked: !!deps.proofColorsActive,
          disabled: !deps.hasProofProfile,
        },
        {
          label: "Gamut Warning",
          actionId: "gamutWarning",
          action: deps.onToggleGamutWarning,
          shortcut: "CmdOrCtrl+Shift+Y",
          noIntercept: true,
          checked: !!deps.gamutWarningActive,
          disabled: !deps.hasProofProfile,
        },
        SEP,
        ...ALL_PANEL_IDS.map((id) => ({
          label: PANEL_LABELS[id],
          actionId: `togglePanel:${id}`,
          action: () => dockStore.togglePanel(id),
          checked: !!deps.openPanelIds?.includes(id),
        })),
        SEP,
        {
          label: "Reset Panel Layout",
          actionId: "resetPanelLayout",
          action: () => dockStore.resetLayout(),
        },
      ],
    },
    { label: "Help", submenu: helpItems },
  ];
}
