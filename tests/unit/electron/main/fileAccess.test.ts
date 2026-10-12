import { join, resolve } from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// fileAccess keeps the "picked in a dialog" set in module state: load a
// fresh copy per test so grants don't leak between tests.
type FileAccess = typeof import('../../../../electron/main/fileAccess')
let fa: FileAccess

beforeEach(async () => {
  vi.resetModules()
  fa = await import('../../../../electron/main/fileAccess')
})

const isWin = process.platform === 'win32'
const base = isWin ? 'C:\\Users\\me\\Pictures' : '/home/me/Pictures'

describe('assertReadable', () => {
  it('accepts paths with an allowed extension, case-insensitively, and returns them unchanged', () => {
    const p = join(base, 'Photo.PNG')
    expect(fa.assertReadable(p, ['png'])).toBe(p)
    expect(fa.assertReadable(join(base, 'a.b.jpeg'), fa.IMAGE_EXTENSIONS)).toBe(join(base, 'a.b.jpeg'))
  })

  it.each([
    ['private key without extension', isWin ? 'C:\\Users\\me\\.ssh\\id_rsa' : '/home/me/.ssh/id_rsa'],
    ['dotfile', join(base, '.bashrc')],
    ['executable', join(base, 'tool.exe')],
    ['double extension ending in a disallowed one', join(base, 'photo.png.exe')],
    ['trailing dot', join(base, 'photo.png.')],
    ['extension followed by whitespace', join(base, 'photo.png ')],
    ['alternate data stream suffix', join(base, 'secret.txt::$DATA')],
    ['traversal to a disallowed file', join(base, 'x.png', '..', '..', 'secrets.txt')]
  ])('refuses a %s', (_label, p) => {
    expect(() => fa.assertReadable(p, fa.IMAGE_EXTENSIONS)).toThrow(/Refusing to read/)
  })

  it('judges the final path component after `..` segments, not the text', () => {
    // `x.png/../secrets.txt` ends in .txt: the .png in the middle must not count.
    expect(() => fa.assertReadable(`${base}/x.png/../secrets.txt`, ['png'])).toThrow()
  })

  it.each([undefined, null, 42, {}, ['a.png'], ''])('rejects a non-string or empty path (%j)', (p) => {
    expect(() => fa.assertReadable(p, ['png'])).toThrow('Invalid file path')
  })

  it('accepts any extension once the exact file was picked in an open dialog', () => {
    const picked = join(base, 'scan.raw')
    expect(() => fa.assertReadable(picked, ['png'])).toThrow()
    fa.grantPicked([picked])
    expect(fa.assertReadable(picked, ['png'])).toBe(picked)
  })

  it('accepts a single string grant and ignores null / undefined grants', () => {
    fa.grantPicked(null)
    fa.grantPicked(undefined)
    const picked = join(base, 'notes.dat')
    fa.grantPicked(picked)
    expect(fa.assertReadable(picked, [])).toBe(picked)
  })

  it('a grant covers only the picked file, not its siblings or folder', () => {
    fa.grantPicked(join(base, 'scan.raw'))
    expect(() => fa.assertReadable(join(base, 'other.raw'), ['png'])).toThrow()
    expect(() => fa.assertReadable(base, ['png'])).toThrow()
    expect(() => fa.assertReadable(join(base, 'scan.raw', 'child'), ['png'])).toThrow()
  })

  it('matches a grant through `..` and `.` segments that resolve to the same file', () => {
    fa.grantPicked(join(base, 'scan.raw'))
    expect(fa.assertReadable(`${base}/sub/../scan.raw`, [])).toBe(`${base}/sub/../scan.raw`)
    expect(fa.assertReadable(`${base}/./scan.raw`, [])).toBe(`${base}/./scan.raw`)
  })

  it('a grant does not extend to a different file reached by traversal', () => {
    fa.grantPicked(join(base, 'scan.raw'))
    expect(() => fa.assertReadable(`${base}/scan.raw/../../secret.raw`, [])).toThrow()
  })

  it('treats a relative path as relative to the working directory', () => {
    fa.grantPicked(resolve('picked.raw'))
    expect(fa.assertReadable('picked.raw', [])).toBe('picked.raw')
    expect(() => fa.assertReadable('other.raw', [])).toThrow()
  })

  it.runIf(isWin)('on Windows, matches grants regardless of case and separator style', () => {
    fa.grantPicked('C:\\Users\\Me\\Scans\\Page.RAW')
    expect(fa.assertReadable('c:/users/me/scans/page.raw', [])).toBe('c:/users/me/scans/page.raw')
    expect(fa.assertReadable('C:\\USERS\\ME\\SCANS\\PAGE.raw', [])).toBe('C:\\USERS\\ME\\SCANS\\PAGE.raw')
  })

  it.runIf(isWin)('on Windows, a granted local file does not grant the same name on a UNC share', () => {
    fa.grantPicked('C:\\share\\scan.raw')
    expect(() => fa.assertReadable('\\\\server\\share\\scan.raw', [])).toThrow()
  })

  it.runIf(!isWin)('on case-sensitive platforms, a grant is case-sensitive', () => {
    fa.grantPicked('/home/me/Scan.raw')
    expect(() => fa.assertReadable('/home/me/scan.raw', [])).toThrow()
  })
})

describe('assertWritable', () => {
  it('accepts allowed extensions case-insensitively', () => {
    const p = join(base, 'Out.JPG')
    expect(fa.assertWritable(p, fa.EXPORT_EXTENSIONS)).toBe(p)
    expect(fa.assertWritable(join(base, 'doc.pdf'), fa.EXPORT_EXTENSIONS)).toBe(join(base, 'doc.pdf'))
  })

  it('names the expected extensions in the error', () => {
    expect(() => fa.assertWritable(join(base, 'x.txt'), ['palette', 'json'])).toThrow(
      /expected a \.palette \/ \.json file/
    )
  })

  it.each([
    ['script into a startup folder', isWin
      ? 'C:\\Users\\me\\AppData\\Roaming\\Microsoft\\Windows\\Start Menu\\Programs\\Startup\\run.bat'
      : '/home/me/.config/autostart/run.desktop'],
    ['shell profile', isWin ? 'C:\\Users\\me\\Documents\\profile.ps1' : '/home/me/.bashrc'],
    ['double extension ending in a disallowed one', join(base, 'x.png.lnk')],
    ['no extension', join(base, 'README')],
    ['trailing dot', join(base, 'x.png.')]
  ])('refuses a %s', (_label, p) => {
    expect(() => fa.assertWritable(p, fa.EXPORT_EXTENSIONS)).toThrow()
  })

  it('is not widened by an open-dialog grant (grants are for reading only)', () => {
    const picked = join(base, 'scan.raw')
    fa.grantPicked(picked)
    expect(() => fa.assertWritable(picked, ['png'])).toThrow(/Refusing to write/)
  })

  it.each([undefined, null, 1, {}, ''])('rejects a non-string or empty path (%j)', (p) => {
    expect(() => fa.assertWritable(p, ['png'])).toThrow('Invalid file path')
  })
})

describe('extension lists', () => {
  it('EXPORT_EXTENSIONS is the image list plus pdf, all lower-case without dots', () => {
    expect(fa.EXPORT_EXTENSIONS).toEqual([...fa.IMAGE_EXTENSIONS, 'pdf'])
    for (const e of fa.EXPORT_EXTENSIONS) expect(e).toMatch(/^[a-z0-9]+$/)
  })

  it('does not list executable or script types', () => {
    for (const bad of ['exe', 'bat', 'cmd', 'ps1', 'lnk', 'js', 'html', 'sh', 'desktop']) {
      expect(fa.EXPORT_EXTENSIONS as readonly string[]).not.toContain(bad)
    }
  })
})
