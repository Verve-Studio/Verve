import { Menu, BrowserWindow } from 'electron'
import type { MenuItemConstructorOptions } from 'electron'

/**
 * macOS native menu builder.
 *
 * The renderer (`useMacNativeMenu.ts`) is the single source of truth for
 * menu structure: it calls `buildMenuTree(deps)` from
 * `src/ux/main/menu/menuTree.ts`, filters the tree to mac-only nodes,
 * strips the inline `action` functions out, and sends the resulting
 * `SerializedMenuNode[]` payload over IPC. This module turns that
 * payload into Electron's `MenuItemConstructorOptions[]` and installs
 * it as the application menu.
 *
 * Every state change (color mode toggle, animation-mode toggle, panel
 * open/close, etc.) re-runs the build/serialize/IPC/install cycle.
 * That's ~1 ms on the round trip — well under the frame budget — and
 * replaces the previous three separate IPC channels (`set-enabled`,
 * `set-checked`, `set-visible`) that updated specific flags in place.
 * Cheaper to think about than to optimize: one channel, one rebuild.
 */

// ─── Types ────────────────────────────────────────────────────────────────────
//
// Mirror of `MenuNode` (with `action` stripped) in `src/ux/main/menu/menuTree.ts`.
// We can't import the renderer-side type without dragging the entire frontend
// dependency graph into the main process, so the shape is duplicated here.
// Whichever shape diverges first, typecheck will flag — both files are short.

type MacRole =
  | 'about'
  | 'services'
  | 'hide'
  | 'hideOthers'
  | 'unhide'
  | 'quit'

export interface SerializedMenuNode {
  label: string
  actionId?: string
  role?: MacRole
  targets?: 'both' | 'app' | 'mac'
  shortcut?: string
  noIntercept?: boolean
  disabled?: boolean
  checked?: boolean
  hidden?: boolean
  separator?: boolean
  submenu?: SerializedMenuNode[]
}

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

/** Translate one node to Electron's MenuItemConstructorOptions. */
function toMenuItem(node: SerializedMenuNode): MenuItemConstructorOptions | null {
  if (node.targets === 'app') return null
  if (node.hidden) return null
  if (node.separator) return { type: 'separator' }

  const out: MenuItemConstructorOptions = { label: node.label }

  if (node.role) {
    // OS-managed item — Electron's role handles label, behavior, even
    // hierarchy in some cases (Services). Skip our own click handler.
    out.role = node.role
    return out
  }

  if (node.actionId) {
    out.id = node.actionId
    out.click = () => send(node.actionId!)
    // `registerAccelerator: false` makes the menu DISPLAY the accelerator
    // but not intercept the keypress — the renderer's keydown listener
    // handles those shortcuts conditionally based on focus / tool state.
    if (node.noIntercept) out.registerAccelerator = false
  }
  if (node.shortcut) out.accelerator = node.shortcut

  if (node.checked !== undefined) {
    out.type = 'checkbox'
    out.checked = node.checked
  }
  if (node.disabled !== undefined) out.enabled = !node.disabled

  if (node.submenu) {
    const sub = node.submenu
      .map(toMenuItem)
      .filter((m): m is MenuItemConstructorOptions => m !== null)
    // Drop top-level entries whose submenu is empty after filtering —
    // an Animation menu with no items would be a confusing trigger.
    if (sub.length === 0 && !node.role) return null
    out.submenu = sub
  }
  return out
}

// ─── Public API ───────────────────────────────────────────────────────────────

export function buildAndSetMacMenu(tree: SerializedMenuNode[]): void {
  const template: MenuItemConstructorOptions[] = tree
    .map(toMenuItem)
    .filter((m): m is MenuItemConstructorOptions => m !== null)
  const menu = Menu.buildFromTemplate(template)
  Menu.setApplicationMenu(menu)
}
