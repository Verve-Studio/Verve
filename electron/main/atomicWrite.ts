import { writeFile, rename, unlink } from 'node:fs/promises'
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
