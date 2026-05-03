import { Menu, BrowserWindow, app } from 'electron'
import type { MenuItemConstructorOptions, MenuItem } from 'electron'

// ─── Types ────────────────────────────────────────────────────────────────────

export interface MenuBuildPayload {
  adjustments: Array<{ id: string; label: string; group?: string }>
  effects: Array<{ id: string; label: string; group?: string }>
  filters: Array<{ id: string; label: string; instant?: boolean; group?: string }>
  recentFiles: string[]
}

// ─── Internal state ───────────────────────────────────────────────────────────

// Map from item id → MenuItem for dynamic enable/checked updates.
const itemsById = new Map<string, MenuItem>()

let recentFilesList: string[] = []

// ─── Helpers ──────────────────────────────────────────────────────────────────

function send(actionId: string): void {
  const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0]
  if (!win || win.isDestroyed() || win.webContents.isDestroyed()) return
  try {
    win.webContents.send('menu:action', actionId)
  } catch {
    // Renderer frame was disposed mid-flight (e.g. during hot-reload); ignore.
  }
}

type ItemOpts = Omit<MenuItemConstructorOptions, 'id' | 'label' | 'click'> & {
  /** When true, the accelerator is shown in the menu but does NOT intercept the keyboard shortcut.
   *  Use this for shortcuts that are already handled by the renderer's keydown listener. */
  noIntercept?: boolean
}

function item(label: string, id: string, opts: ItemOpts = {}): MenuItemConstructorOptions {
  const { noIntercept = false, ...menuOpts } = opts
  return {
    id,
    label,
    registerAccelerator: !noIntercept,
    click: () => send(id),
    ...menuOpts,
  }
}

function sep(): MenuItemConstructorOptions {
  return { type: 'separator' }
}

function groupedItems(
  entries: Array<{ id: string; label: string; group?: string }>,
  actionPrefix: string,
): MenuItemConstructorOptions[] {
  const result: MenuItemConstructorOptions[] = []
  let lastGroup: string | undefined = undefined
  for (const entry of entries) {
    if (entry.group !== undefined && entry.group !== lastGroup && lastGroup !== undefined) {
      result.push(sep())
    }
    lastGroup = entry.group
    result.push(item(entry.label, `${actionPrefix}${entry.id}`))
  }
  return result
}

// ─── Build & set macOS application menu ──────────────────────────────────────

export function buildAndSetMacMenu(payload: MenuBuildPayload): void {
  itemsById.clear()
  recentFilesList = payload.recentFiles

  const appName = app.name || 'Verve'

  const template: MenuItemConstructorOptions[] = [
    // macOS app menu (first entry is always shown as the app name in the macOS menu bar)
    {
      label: appName,
      submenu: [
        { role: 'about', label: `About ${appName}` },
        sep(),
        item('Preferences\u2026', 'preferences', { accelerator: 'CmdOrCtrl+,' }),
        sep(),
        { role: 'services' },
        sep(),
        { role: 'hide' },
        { role: 'hideOthers' },
        { role: 'unhide' },
        sep(),
        { role: 'quit' },
      ],
    },

    // File
    {
      label: 'File',
      submenu: [
        item('New\u2026', 'new', { accelerator: 'CmdOrCtrl+N' }),
        item('Open\u2026', 'open', { accelerator: 'CmdOrCtrl+O' }),
        {
          label: 'Open Recent',
          submenu: payload.recentFiles.length > 0
            ? [
              ...payload.recentFiles.map((filePath, i) => ({
                id: `recentFile:${i}`,
                label: filePath.split(/[\\/]/).pop() ?? filePath,
                click: () => send(`recentFile:${i}`),
              })),
              sep(),
              item('Clear Recent', 'clearRecentFiles'),
            ]
            : [{ label: 'No Recent Files', enabled: false }],
        },
        sep(),
        item('Close', 'close'),
        item('Close All', 'closeAll'),
        sep(),
        item('Save', 'save', { accelerator: 'CmdOrCtrl+S' }),
        item('Save As\u2026', 'saveAs', { accelerator: 'CmdOrCtrl+Shift+S' }),
        item('Save a Copy\u2026', 'saveACopy'),
        item('Export As\u2026', 'export', { accelerator: 'CmdOrCtrl+E' }),
      ],
    },

    // Edit
    {
      label: 'Edit',
      submenu: [
        item('Undo', 'undo', { accelerator: 'CmdOrCtrl+Z', noIntercept: true }),
        item('Redo', 'redo', { accelerator: 'CmdOrCtrl+Y', noIntercept: true }),
        sep(),
        item('Cut', 'cut', { accelerator: 'CmdOrCtrl+X', noIntercept: true }),
        item('Copy', 'copy', { accelerator: 'CmdOrCtrl+C', noIntercept: true }),
        item('Copy Merged', 'copyMerged', { accelerator: 'CmdOrCtrl+Shift+C', noIntercept: true }),
        item('Paste', 'paste', { accelerator: 'CmdOrCtrl+V', noIntercept: true }),
        item('Paste Into', 'pasteInto', { accelerator: 'CmdOrCtrl+Shift+V', noIntercept: true }),
        item('Delete', 'delete', { accelerator: 'Backspace', noIntercept: true }),
        sep(),
        item('Content-Aware Fill', 'contentAwareFill'),
        item('Content-Aware Delete', 'contentAwareDelete', { accelerator: 'Shift+Delete' }),
        sep(),

        item('Transform\u2026', 'freeTransform', { accelerator: 'CmdOrCtrl+T', noIntercept: true }),
      ],
    },

    // Select
    {
      label: 'Select',
      submenu: [
        item('All', 'selectAll', { accelerator: 'CmdOrCtrl+A', noIntercept: true }),
        item('Deselect', 'deselect', { accelerator: 'CmdOrCtrl+D', noIntercept: true }),
        sep(),
        item('All Layers', 'selectAllLayers', { accelerator: 'Alt+CmdOrCtrl+A', noIntercept: true }),
        item('Deselect Layers', 'deselectLayers'),
        sep(),
        item('Find Layers', 'findLayers', { accelerator: 'Alt+Shift+CmdOrCtrl+F', noIntercept: true }),
        sep(),
        item('Invert Selection', 'invertSelection', { accelerator: 'CmdOrCtrl+Shift+I', noIntercept: true }),
      ],
    },

    // Layer
    {
      label: 'Layer',
      submenu: [
        item('New Layer', 'newLayer', { accelerator: 'CmdOrCtrl+Shift+N' }),
        item('New Layer Group', 'newLayerGroup'),
        item('New Composite Layer', 'newCompositeLayer'),
        item('Add Layer Mask', 'addLayerMask'),
        item('Duplicate Layer', 'duplicateLayer'),
        item('Delete Layer', 'deleteLayer'),
        sep(),
        item('Rasterize Layer', 'rasterizeLayer'),
        sep(),
        item('Group Layers', 'groupLayers', { accelerator: 'CmdOrCtrl+G', noIntercept: true }),
        item('Ungroup Layers', 'ungroupLayers', { accelerator: 'CmdOrCtrl+Shift+G', noIntercept: true }),
        sep(),
        item('Merge Selected', 'mergeSelected'),
        item('Merge Down', 'mergeDown'),
        item('Merge Visible', 'mergeVisible'),
        item('Flatten Image', 'flattenImage'),
        sep(),
        {
          label: 'Rotate',
          submenu: [
            item('90\u00b0 CW',  'layer:rotate90CW'),
            item('180\u00b0 CW', 'layer:rotate180CW'),
            item('270\u00b0 CW', 'layer:rotate270CW'),
          ],
        },
        {
          label: 'Flip',
          submenu: [
            item('Horizontal', 'layer:flipHorizontal'),
            item('Vertical',   'layer:flipVertical'),
          ],
        },
        sep(),
        {
          label: 'Align',
          submenu: [
            item('Left',              'layer:alignLeft'),
            item('Center Vertical',   'layer:alignCenterV'),
            item('Right',             'layer:alignRight'),
            item('Top',               'layer:alignTop'),
            item('Center Horizontal', 'layer:alignCenterH'),
            item('Bottom',            'layer:alignBottom'),
          ],
        },
        {
          label: 'Distribute',
          submenu: [
            item('Horizontally', 'layer:distributeH'),
            item('Vertically',   'layer:distributeV'),
          ],
        },
        {
          label: 'Order',
          submenu: [
            item('Bring to Front', 'layer:orderFront'),
            item('Bring to Back',  'layer:orderBack'),
            item('Forward',        'layer:orderForward'),
            item('Backward',       'layer:orderBackward'),
            sep(),
            item('Reverse Order',  'layer:orderReverse'),
          ],
        },
      ],
    },

    // Image
    {
      label: 'Image',
      submenu: [
        {
          label: 'Color Mode',
          submenu: [
            item('RGB/8', 'colorMode:rgba8'),
            item('RGB/32 Float', 'colorMode:rgba32f'),
            item('Indexed/8', 'colorMode:indexed8'),
          ],
        },
        sep(),
        item('Resize Image\u2026', 'resizeImage'),
        item('Resize Image Canvas\u2026', 'resizeCanvas'),
        sep(),
        {
          label: 'Rotate',
          submenu: [
            item('90\u00b0 CW',  'rotate90CW'),
            item('180\u00b0 CW', 'rotate180CW'),
            item('270\u00b0 CW', 'rotate270CW'),
          ],
        },
        {
          label: 'Flip',
          submenu: [
            item('Horizontal', 'flipHorizontal'),
            item('Vertical',   'flipVertical'),
          ],
        },
      ],
    },

    // Adjustments
    {
      label: 'Adjustments',
      submenu: groupedItems(payload.adjustments, 'adj:'),
    },

    // Effects
    {
      label: 'Effects',
      submenu: groupedItems(payload.effects, 'adj:'),
    },

    // Filters
    {
      label: 'Filters',
      submenu: groupedItems(payload.filters, 'filter:'),
    },

    // View
    {
      label: 'View',
      submenu: [
        item('Zoom In', 'zoomIn', { accelerator: 'CmdOrCtrl+=', noIntercept: true }),
        item('Zoom Out', 'zoomOut', { accelerator: 'CmdOrCtrl+-', noIntercept: true }),
        item('Zoom to 100%', 'zoom100', { accelerator: 'CmdOrCtrl+1', noIntercept: true }),
        item('Fit to Window', 'fitToWindow', { accelerator: 'CmdOrCtrl+0', noIntercept: true }),
        sep(),
        {
          id: 'toggleGrid',
          label: 'Show Grid',
          type: 'checkbox',
          checked: false,
          accelerator: 'CmdOrCtrl+\'',
          click: () => send('toggleGrid'),
        },
        {
          id: 'toggleRulers',
          label: 'Show Rulers',
          type: 'checkbox',
          checked: false,
          accelerator: 'CmdOrCtrl+R',
          click: () => send('toggleRulers'),
        },
        {
          id: 'toggleGuides',
          label: 'Show Guides',
          type: 'checkbox',
          checked: true,
          accelerator: 'CmdOrCtrl+;',
          click: () => send('toggleGuides'),
        },
        {
          label: 'Guide Presets',
          submenu: [
            { id: 'guidePreset:thirds',       label: 'Thirds',       click: () => send('guidePreset:thirds')       },
            { id: 'guidePreset:fourths',      label: 'Fourths',      click: () => send('guidePreset:fourths')      },
            { id: 'guidePreset:center-split', label: 'Center Split', click: () => send('guidePreset:center-split') },
            { id: 'guidePreset:safe-zone',    label: 'Safe Zone',    click: () => send('guidePreset:safe-zone')    },
          ],
        },
        sep(),
        { id: 'normalMode', label: 'Normal Mode', type: 'checkbox', checked: true, click: () => send('setNormalMode') },
        { id: 'tiledMode', label: 'Tiled Mode', type: 'checkbox', checked: false, click: () => send('setTiledMode') },
        { id: 'animationMode', label: 'Animation Mode', type: 'checkbox', checked: false, click: () => send('setAnimationMode') },
        sep(),
        { id: 'showTileGrid', label: 'Show Tile Grid', type: 'checkbox', checked: false, enabled: false, click: () => send('toggleTileGrid') },
        sep(),
        { id: 'togglePanel:Color',     label: 'Color',     type: 'checkbox', checked: true, click: () => send('togglePanel:Color') },
        { id: 'togglePanel:Swatches',  label: 'Swatches',  type: 'checkbox', checked: true, click: () => send('togglePanel:Swatches') },
        { id: 'togglePanel:Navigator', label: 'Navigator', type: 'checkbox', checked: true, click: () => send('togglePanel:Navigator') },
        { id: 'togglePanel:Layers',    label: 'Layers',    type: 'checkbox', checked: true, click: () => send('togglePanel:Layers') },
        { id: 'togglePanel:History',   label: 'History',   type: 'checkbox', checked: true, click: () => send('togglePanel:History') },
        { id: 'togglePanel:Info',      label: 'Info',      type: 'checkbox', checked: true, click: () => send('togglePanel:Info') },
        { id: 'togglePanel:HDR',       label: 'HDR',       type: 'checkbox', checked: false, click: () => send('togglePanel:HDR') },
        sep(),
        { label: 'Reset Panel Layout', click: () => send('resetPanelLayout') },
      ],
    },

    // Help
    {
      label: 'Help',
      submenu: [
        item('About Verve', 'about'),
        item('Keyboard Shortcuts', 'keyboardShortcuts'),
        item('System Information', 'systemInfo'),
        sep(),
        item('Open DevTools', 'openDevTools'),
      ],
    },
  ]

  const menu = Menu.buildFromTemplate(template)
  Menu.setApplicationMenu(menu)

  // Collect all items with an explicit id into the update map.
  function collectItems(m: Menu): void {
    for (const mi of m.items) {
      if (mi.id) itemsById.set(mi.id, mi)
      if (mi.submenu) collectItems(mi.submenu)
    }
  }
  collectItems(menu)
}

// ─── Dynamic state updates ────────────────────────────────────────────────────

export function getRecentFileByIndex(index: number): string | undefined {
  return recentFilesList[index]
}

export function setMacMenuItemEnabled(updates: Record<string, boolean>): void {
  for (const [id, enabled] of Object.entries(updates)) {
    const mi = itemsById.get(id)
    if (mi) mi.enabled = enabled
  }
}

export function setMacMenuItemChecked(updates: Record<string, boolean>): void {
  for (const [id, checked] of Object.entries(updates)) {
    const mi = itemsById.get(id)
    if (mi) mi.checked = checked
  }
}
