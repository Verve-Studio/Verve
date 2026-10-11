import { writeFile, rename, unlink, open } from 'node:fs/promises'
import type { FileHandle } from 'node:fs/promises'
import { randomBytes } from 'node:crypto'

/**
 * Write a file atomically: write to a temp file in the same directory, then
 * rename it over the target. A crash, power loss or full disk mid-write
 * leaves the previous file intact instead of a truncated one — plain
 * `writeFile` truncates the target before writing.
 *
 * The temp file lives next to the target so the rename stays on one volume
 * (atomic on NTFS, APFS and ext4). On Windows the rename can fail briefly
 * with EPERM/EBUSY/EACCES while antivirus or the search indexer holds the
 * target open, so it is retried a few times before giving up.
 */
export async function writeFileAtomic(
  path: string,
  data: string | Uint8Array,
  encoding?: BufferEncoding
): Promise<void> {
  const tmp = `${path}.${randomBytes(6).toString('hex')}.tmp`
  try {
    if (typeof data === 'string') {
      await writeFile(tmp, data, encoding ?? 'utf-8')
    } else {
      await writeFile(tmp, data)
    }
    await renameWithRetry(tmp, path)
  } catch (err) {
    await unlink(tmp).catch(() => undefined)
    throw err
  }
}

/**
 * Streaming counterpart of `writeFileAtomic` for payloads too large to hold
 * (or send over IPC) as one buffer: bytes are appended to a temp file next
 * to the target, and `commit` fsyncs it and renames it over the target with
 * the same retry. `abort` (or a failed `commit`) deletes the temp file, so
 * the previous file stays intact either way.
 */
export interface AtomicFileWriter {
  /** Append `data`. Calls are applied in order, even when not awaited. */
  write(data: Uint8Array): Promise<void>
  commit(): Promise<void>
  abort(): Promise<void>
}

export async function openAtomicWriter(path: string): Promise<AtomicFileWriter> {
  const tmp = `${path}.${randomBytes(6).toString('hex')}.tmp`
  const fh: FileHandle = await open(tmp, 'wx')
  let closed = false
  // Writes chain on one promise so they land in call order.
  let tail: Promise<void> = Promise.resolve()
  let failure: unknown = null
  const close = async (): Promise<void> => {
    if (closed) return
    closed = true
    await fh.close().catch(() => undefined)
  }
  const discard = async (): Promise<void> => {
    await tail.catch(() => undefined)
    await close()
    await unlink(tmp).catch(() => undefined)
  }
  return {
    write(data) {
      if (closed) return Promise.reject(new Error('The file writer is already closed.'))
      const step = tail.then(async () => {
        if (failure) throw failure
        let done = 0
        while (done < data.byteLength) {
          const { bytesWritten } = await fh.write(data, done, data.byteLength - done)
          if (bytesWritten <= 0) throw new Error('Writing the file made no progress.')
          done += bytesWritten
        }
      })
      tail = step.catch((err) => {
        failure ??= err
      })
      return step
    },
    async commit() {
      try {
        await tail
        if (failure) throw failure
        if (closed) throw new Error('The file writer is already closed.')
        await fh.sync()
        await close()
        await renameWithRetry(tmp, path)
      } catch (err) {
        await discard()
        throw err
      }
    },
    abort: discard
  }
}

const RETRYABLE = new Set(['EPERM', 'EBUSY', 'EACCES'])

async function renameWithRetry(from: string, to: string): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    try {
      await rename(from, to)
      return
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code
      if (attempt >= 5 || !code || !RETRYABLE.has(code)) throw err
      await new Promise((resolve) => setTimeout(resolve, 50 * (attempt + 1)))
    }
  }
}
