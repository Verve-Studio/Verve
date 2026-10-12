import type { MenuItemConstructorOptions } from 'electron'
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => import('@tests/fakes/electronMain').then((m) => m.electronModule))

import {
  FakeBrowserWindow,
  disposeFakeElectron,
  fakeElectron,
  resetFakeElectron
} from '@tests/fakes/electronMain'
import { buildAndSetMacMenu, type SerializedMenuNode } from '../../../../electron/main/menu'

beforeEach(() => {
  resetFakeElectron()
})
afterAll(disposeFakeElectron)

/** Build and return the template handed to Menu.buildFromTemplate. */
function build(tree: SerializedMenuNode[]): MenuItemConstructorOptions[] {
  buildAndSetMacMenu(tree)
  return (fakeElectron.applicationMenu as { template: MenuItemConstructorOptions[] }).template
}

describe('buildAndSetMacMenu', () => {
  it('installs the built menu as the application menu', () => {
    build([{ label: 'File', submenu: [{ label: 'New', actionId: 'file.new' }] }])
    expect(fakeElectron.applicationMenu).not.toBeNull()
  })

  it('maps labels, ids, accelerators and checkbox / enabled state', () => {
    const [file] = build([
      {
        label: 'File',
        submenu: [
          { label: 'New', actionId: 'file.new', shortcut: 'CmdOrCtrl+N' },
          { label: 'Grid', actionId: 'view.grid', checked: false },
          { label: 'Undo', actionId: 'edit.undo', disabled: true },
          { label: 'Redo', actionId: 'edit.redo', disabled: false }
        ]
      }
    ])
    const [newItem, grid, undo, redo] = file.submenu as MenuItemConstructorOptions[]
    expect(newItem).toMatchObject({ label: 'New', id: 'file.new', accelerator: 'CmdOrCtrl+N' })
    expect(newItem.type).toBeUndefined()
    expect(newItem.enabled).toBeUndefined()
    expect(grid).toMatchObject({ type: 'checkbox', checked: false })
    expect(undo.enabled).toBe(false)
    expect(redo.enabled).toBe(true)
  })

  it('keeps the accelerator visible but unregistered for noIntercept items', () => {
    const [m] = build([
      { label: 'Edit', submenu: [{ label: 'Brush', actionId: 'tool.brush', shortcut: 'B', noIntercept: true }] }
    ])
    const [item] = m.submenu as MenuItemConstructorOptions[]
    expect(item.accelerator).toBe('B')
    expect(item.registerAccelerator).toBe(false)
  })

  it('drops app-only and hidden items, and maps separators', () => {
    const [m] = build([
      {
        label: 'View',
        submenu: [
          { label: 'A', actionId: 'a' },
          { label: '', separator: true },
          { label: 'In-app only', actionId: 'b', targets: 'app' },
          { label: 'Hidden', actionId: 'c', hidden: true },
          { label: 'Mac', actionId: 'd', targets: 'mac' },
          { label: 'Both', actionId: 'e', targets: 'both' }
        ]
      }
    ])
    expect(m.submenu).toEqual([
      expect.objectContaining({ label: 'A' }),
      { type: 'separator' },
      expect.objectContaining({ label: 'Mac' }),
      expect.objectContaining({ label: 'Both' })
    ])
  })

  it('drops a menu whose submenu is empty after filtering, at any depth', () => {
    const template = build([
      { label: 'Animation', submenu: [{ label: 'x', actionId: 'x', targets: 'app' }] },
      {
        label: 'Layer',
        submenu: [
          { label: 'Empty group', submenu: [{ label: 'y', actionId: 'y', hidden: true }] },
          { label: 'Kept', actionId: 'k' }
        ]
      }
    ])
    expect(template.map((t) => t.label)).toEqual(['Layer'])
    expect((template[0].submenu as MenuItemConstructorOptions[]).map((t) => t.label)).toEqual(['Kept'])
  })

  it('passes OS roles through without a click handler or other fields', () => {
    const [m] = build([
      {
        label: 'Verve',
        submenu: [
          { label: 'About Verve', role: 'about', actionId: 'ignored', shortcut: 'X', disabled: true },
          { label: 'Quit', role: 'quit' }
        ]
      }
    ])
    expect(m.submenu).toEqual([
      { label: 'About Verve', role: 'about' },
      { label: 'Quit', role: 'quit' }
    ])
  })

  it('an item without actionId gets no click handler', () => {
    const [m] = build([{ label: 'Help', submenu: [{ label: 'Plain' }] }])
    expect((m.submenu as MenuItemConstructorOptions[])[0].click).toBeUndefined()
  })
})

describe('menu clicks', () => {
  function clickFirst(tree: SerializedMenuNode[]): void {
    const [m] = build(tree)
    const item = (m.submenu as MenuItemConstructorOptions[])[0]
    ;(item.click as () => void)()
  }
  const tree: SerializedMenuNode[] = [{ label: 'File', submenu: [{ label: 'Save', actionId: 'file.save' }] }]

  it('sends menu:action with the action id to the focused window', () => {
    const a = new FakeBrowserWindow()
    const b = new FakeBrowserWindow()
    fakeElectron.focusedWindow = b
    clickFirst(tree)
    expect(b.webContents.sent).toEqual([{ channel: 'menu:action', args: ['file.save'] }])
    expect(a.webContents.sent).toEqual([])
  })

  it('falls back to the first window when none is focused', () => {
    const a = new FakeBrowserWindow()
    clickFirst(tree)
    expect(a.webContents.sent).toEqual([{ channel: 'menu:action', args: ['file.save'] }])
  })

  it('does nothing when there is no window or its renderer is gone', () => {
    expect(() => clickFirst(tree)).not.toThrow()
    const w = new FakeBrowserWindow()
    w.webContents.destroyed = true
    expect(() => clickFirst(tree)).not.toThrow()
    expect(w.webContents.sent).toEqual([])
  })

  it('swallows a send that fails mid-flight', () => {
    const w = new FakeBrowserWindow()
    w.webContents.send = () => {
      throw new Error('Render frame was disposed')
    }
    expect(() => clickFirst(tree)).not.toThrow()
  })
})
