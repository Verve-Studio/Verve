import { app, BrowserWindow, dialog, ipcMain } from 'electron'
import { readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { writeFileAtomic } from './atomicWrite'
import { assertReadable, assertWritable } from './fileAccess'

/**
 * `.automation` files: automation workflows (node graphs) saved from the
 * node editor. The renderer serializes / validates the JSON; this side only
 * moves text, with the usual extension checks and atomic writes.
 */

const EXT = 'automation'
/** Larger files are refused: workflows are small JSON documents. */
const MAX_BYTES = 16 * 1024 * 1024
const FILTERS = [{ name: 'Verve Automation', extensions: [EXT] }]

async function readAutomation(path: string): Promise<string> {
  const full = assertReadable(path, [EXT])
  const { size } = await stat(full)
  if (size > MAX_BYTES) throw new Error('File is too large')
  return readFile(full, 'utf-8')
}

export function registerAutomationHandlers(): void {
  /** Open dialog; resolves to the chosen file's path and text, or null. */
  ipcMain.handle('automation:open', async (event) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    const options = {
      title: 'Open Automation',
      defaultPath: app.getPath('documents'),
      properties: ['openFile' as const],
      filters: FILTERS
    }
    const { canceled, filePaths } = win
      ? await dialog.showOpenDialog(win, options)
      : await dialog.showOpenDialog(options)
    if (canceled || !filePaths[0]) return null
    return { path: filePaths[0], text: await readAutomation(filePaths[0]) }
  })

  /** Save dialog, then write; resolves to the path, or null when cancelled. */
  ipcMain.handle('automation:saveAs', async (event, text: unknown, suggestedPath: unknown) => {
    if (typeof text !== 'string') throw new Error('Invalid automation data')
    const win = BrowserWindow.fromWebContents(event.sender)
    const suggested =
      typeof suggestedPath === 'string' && suggestedPath
        ? suggestedPath
        : join(app.getPath('documents'), `Workflow.${EXT}`)
    const options = { title: 'Save Automation', defaultPath: suggested, filters: FILTERS }
    const { canceled, filePath } = win
      ? await dialog.showSaveDialog(win, options)
      : await dialog.showSaveDialog(options)
    if (canceled || !filePath) return null
    await writeFileAtomic(assertWritable(filePath, [EXT]), text, 'utf-8')
    return filePath
  })

  /** Overwrite an `.automation` file (Save on a workflow opened from disk). */
  ipcMain.handle('automation:write', async (_event, path: unknown, text: unknown) => {
    if (typeof text !== 'string') throw new Error('Invalid automation data')
    await writeFileAtomic(assertWritable(path, [EXT]), text, 'utf-8')
  })
}
