import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Route `rename` through a hook so tests can inject transient / permanent
// failures (antivirus holding the target, full disk); everything else is
// the real fs.
const hooks = vi.hoisted(() => ({
  rename: null as null | ((from: string, to: string) => Promise<void> | void)
}))
vi.mock('node:fs/promises', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:fs/promises')>()
  return {
    ...real,
    rename: async (from: string, to: string) => {
      if (hooks.rename) await hooks.rename(from, to)
      return real.rename(from, to)
    }
  }
})

import { openAtomicWriter, writeFileAtomic } from '../../../../electron/main/atomicWrite'

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'verve-atomic-'))
  hooks.rename = null
})

afterEach(() => {
  hooks.rename = null
  rmSync(dir, { recursive: true, force: true })
})

const leftovers = (): string[] => readdirSync(dir).filter((n) => n.endsWith('.tmp'))
const errno = (code: string): NodeJS.ErrnoException =>
  Object.assign(new Error(code), { code })

describe('writeFileAtomic', () => {
  it('creates a new file with string data (utf-8 by default)', async () => {
    const target = join(dir, 'a.json')
    await writeFileAtomic(target, '{"ü":1}')
    expect(readFileSync(target, 'utf-8')).toBe('{"ü":1}')
    expect(leftovers()).toEqual([])
  })

  it('honours an explicit encoding', async () => {
    const target = join(dir, 'a.txt')
    await writeFileAtomic(target, 'aGVsbG8=', 'base64')
    expect(readFileSync(target, 'utf-8')).toBe('hello')
  })

  it('writes binary data byte-exactly, including a view into a larger buffer', async () => {
    const target = join(dir, 'a.bin')
    const backing = new Uint8Array([9, 9, 0, 1, 2, 255, 9])
    await writeFileAtomic(target, backing.subarray(2, 6))
    expect([...readFileSync(target)]).toEqual([0, 1, 2, 255])
  })

  it('replaces an existing file completely (no tail of the old content)', async () => {
    const target = join(dir, 'a.txt')
    writeFileSync(target, 'a much longer previous content')
    await writeFileAtomic(target, 'short')
    expect(readFileSync(target, 'utf-8')).toBe('short')
    expect(leftovers()).toEqual([])
  })

  it('writes the temp file next to the target, then renames it over the target', async () => {
    const target = join(dir, 'a.png')
    const renames: Array<[string, string]> = []
    hooks.rename = (from, to) => {
      renames.push([from, to])
      // While the rename is pending the target doesn't exist yet and the
      // full content is already in the temp file.
      expect(readFileSync(from, 'utf-8')).toBe('data')
    }
    await writeFileAtomic(target, 'data')
    expect(renames).toHaveLength(1)
    expect(renames[0][1]).toBe(target)
    expect(renames[0][0].startsWith(`${target}.`)).toBe(true)
    expect(renames[0][0].endsWith('.tmp')).toBe(true)
  })

  it('uses a distinct temp name per write, so concurrent writes do not clobber each other', async () => {
    const target = join(dir, 'a.txt')
    const temps = new Set<string>()
    hooks.rename = (from) => {
      temps.add(from)
    }
    await Promise.all([writeFileAtomic(target, 'one'), writeFileAtomic(target, 'two')])
    expect(temps.size).toBe(2)
    expect(['one', 'two']).toContain(readFileSync(target, 'utf-8'))
    expect(leftovers()).toEqual([])
  })

  it('on a failed rename, keeps the previous file intact and removes the temp file', async () => {
    const target = join(dir, 'a.txt')
    writeFileSync(target, 'previous')
    hooks.rename = () => {
      throw errno('ENOSPC')
    }
    await expect(writeFileAtomic(target, 'new')).rejects.toMatchObject({ code: 'ENOSPC' })
    expect(readFileSync(target, 'utf-8')).toBe('previous')
    expect(leftovers()).toEqual([])
  })

  it('does not retry a non-transient rename error', async () => {
    let calls = 0
    hooks.rename = () => {
      calls++
      throw errno('EXDEV')
    }
    await expect(writeFileAtomic(join(dir, 'a.txt'), 'x')).rejects.toThrow()
    expect(calls).toBe(1)
  })

  it.each(['EPERM', 'EBUSY', 'EACCES'])(
    'retries a transient %s rename failure (file briefly locked) and succeeds',
    async (code) => {
      const target = join(dir, 'a.txt')
      writeFileSync(target, 'previous')
      let calls = 0
      hooks.rename = () => {
        if (++calls <= 2) throw errno(code)
      }
      await writeFileAtomic(target, 'new')
      expect(calls).toBe(3)
      expect(readFileSync(target, 'utf-8')).toBe('new')
      expect(leftovers()).toEqual([])
    }
  )

  it('gives up after a bounded number of retries and cleans up', async () => {
    const target = join(dir, 'a.txt')
    writeFileSync(target, 'previous')
    let calls = 0
    hooks.rename = () => {
      calls++
      throw errno('EBUSY')
    }
    await expect(writeFileAtomic(target, 'new')).rejects.toMatchObject({ code: 'EBUSY' })
    expect(calls).toBe(6)
    expect(readFileSync(target, 'utf-8')).toBe('previous')
    expect(leftovers()).toEqual([])
  })

  it('fails without leaving anything behind when the folder does not exist', async () => {
    await expect(writeFileAtomic(join(dir, 'missing', 'a.txt'), 'x')).rejects.toMatchObject({
      code: 'ENOENT'
    })
    expect(readdirSync(dir)).toEqual([])
  })

  it('refuses to replace a directory and leaves no temp file', async () => {
    const target = join(dir, 'taken')
    mkdirSync(target)
    await expect(writeFileAtomic(target, 'x')).rejects.toThrow()
    expect(leftovers()).toEqual([])
    expect(readdirSync(target)).toEqual([])
  })
})

describe('openAtomicWriter', () => {
  it('appends chunks in call order even when the writes are not awaited', async () => {
    const target = join(dir, 'doc.verve')
    const w = await openAtomicWriter(target)
    const parts = Array.from({ length: 50 }, (_, i) => new Uint8Array(1000).fill(i))
    const pending = parts.map((p) => w.write(p))
    await w.commit()
    await Promise.all(pending)
    const out = readFileSync(target)
    expect(out.length).toBe(50_000)
    for (let i = 0; i < 50; i++) expect(out[i * 1000]).toBe(i)
    expect(leftovers()).toEqual([])
  })

  it('does not touch the target until commit', async () => {
    const target = join(dir, 'doc.verve')
    writeFileSync(target, 'previous')
    const w = await openAtomicWriter(target)
    await w.write(new TextEncoder().encode('new content'))
    expect(readFileSync(target, 'utf-8')).toBe('previous')
    expect(leftovers()).toHaveLength(1)
    await w.commit()
    expect(readFileSync(target, 'utf-8')).toBe('new content')
    expect(leftovers()).toEqual([])
  })

  it('abort keeps the previous file and deletes the temp file', async () => {
    const target = join(dir, 'doc.verve')
    writeFileSync(target, 'previous')
    const w = await openAtomicWriter(target)
    await w.write(new Uint8Array([1, 2, 3]))
    await w.abort()
    expect(readFileSync(target, 'utf-8')).toBe('previous')
    expect(leftovers()).toEqual([])
  })

  it('abort without a previous file leaves nothing behind', async () => {
    const w = await openAtomicWriter(join(dir, 'doc.verve'))
    await w.abort()
    expect(readdirSync(dir)).toEqual([])
  })

  it('abort is idempotent', async () => {
    const w = await openAtomicWriter(join(dir, 'doc.verve'))
    await w.abort()
    await expect(w.abort()).resolves.toBeUndefined()
  })

  it('rejects writes after commit or abort', async () => {
    const a = await openAtomicWriter(join(dir, 'a.verve'))
    await a.commit()
    await expect(a.write(new Uint8Array(1))).rejects.toThrow(/already closed/)

    const b = await openAtomicWriter(join(dir, 'b.verve'))
    await b.abort()
    await expect(b.write(new Uint8Array(1))).rejects.toThrow(/already closed/)
  })

  it('a second commit fails and leaves the committed file in place', async () => {
    const target = join(dir, 'doc.verve')
    const w = await openAtomicWriter(target)
    await w.write(new Uint8Array([7]))
    await w.commit()
    await expect(w.commit()).rejects.toThrow(/already closed/)
    expect([...readFileSync(target)]).toEqual([7])
  })

  it('a commit whose rename fails deletes the temp file and keeps the previous file', async () => {
    const target = join(dir, 'doc.verve')
    writeFileSync(target, 'previous')
    const w = await openAtomicWriter(target)
    await w.write(new Uint8Array([1, 2, 3]))
    hooks.rename = () => {
      throw errno('ENOSPC')
    }
    await expect(w.commit()).rejects.toMatchObject({ code: 'ENOSPC' })
    expect(readFileSync(target, 'utf-8')).toBe('previous')
    expect(leftovers()).toEqual([])
  })

  it('commits an empty file when nothing was written', async () => {
    const target = join(dir, 'empty.verve')
    const w = await openAtomicWriter(target)
    await w.commit()
    expect(readFileSync(target).length).toBe(0)
  })

  it('fails to open when the folder does not exist', async () => {
    await expect(openAtomicWriter(join(dir, 'missing', 'doc.verve'))).rejects.toMatchObject({
      code: 'ENOENT'
    })
  })
})
