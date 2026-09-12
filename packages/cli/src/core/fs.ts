import { access, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'

export async function exists(p: string): Promise<boolean> {
  try {
    await access(p)
    return true
  } catch {
    return false
  }
}

/** File content, or null when the file does not exist; any other error propagates. */
export async function readOrNull(p: string): Promise<string | null> {
  try {
    return await readFile(p, 'utf8')
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw e
  }
}

let sequence = 0

/** Write to a temporary file in the same directory, then rename over the target. */
export async function writeFileAtomic(p: string, text: string): Promise<void> {
  sequence += 1
  const tmp = join(dirname(p), `.${basename(p)}.${process.pid}.${sequence}.tmp`)
  await writeFile(tmp, text, 'utf8')
  try {
    await rename(tmp, p)
  } catch (e) {
    await rm(tmp, { force: true }).catch(() => undefined)
    throw e
  }
}
