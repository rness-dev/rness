import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

import { gitPath } from '../core/git.ts'
import type { Opened } from './plan.ts'

/**
 * The issues this clone's syncs opened (spec 0018 §2), kept in its git
 * directory — per worktree, never pushed — as a JSON map from issue number
 * to path: `{ "12": "specs/0019-x.md" }`.
 */
const NAME = 'rness/opened'

/** Where this clone keeps its record; null when `.rness` is no repository: nothing is recorded. */
export function openedFile(rnessDir: string): Promise<string | null> {
  return gitPath(rnessDir, NAME)
}

/** A positive issue number, as JSON keys write it: `12`, not `012` nor `1.5`. */
const NUMBER = /^[1-9][0-9]*$/

/**
 * What `file` records. Missing, unreadable or corrupt, it records nothing;
 * an entry that is no number and path is skipped. Never throws.
 */
export async function readOpened(
  file: string | null
): Promise<Map<number, string>> {
  const opened = new Map<number, string>()
  if (file === null) return opened
  let data: unknown
  try {
    data = JSON.parse(await readFile(file, 'utf8'))
  } catch {
    return opened
  }
  if (data === null || typeof data !== 'object' || Array.isArray(data))
    return opened
  for (const [key, path] of Object.entries(data))
    if (NUMBER.test(key) && typeof path === 'string' && path !== '')
      opened.set(Number(key), path)
  return opened
}

/**
 * `opened` written to `file` whole — a temporary file renamed over it, so a
 * reader never sees half of one; none left, no file. Best effort: a record
 * lost leaves at most a stale card, never a wrong close.
 */
export async function writeOpened(
  file: string | null,
  opened: Opened
): Promise<void> {
  if (file === null) return
  try {
    if (opened.size === 0) {
      await rm(file, { force: true })
      return
    }
    const entries = [...opened].sort(([a], [b]) => a - b)
    await mkdir(dirname(file), { recursive: true })
    const temporary = `${file}.${process.pid}`
    await writeFile(
      temporary,
      `${JSON.stringify(Object.fromEntries(entries), null, 2)}\n`
    )
    await rename(temporary, file)
  } catch {
    // See above.
  }
}
