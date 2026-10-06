import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

import { gitPath } from '../core/git.ts'

/**
 * What a sync has told this clone once (spec 0031 §4): a field or a view no
 * longer declared, views out of the declared order. Kept in the git
 * directory — per worktree, never pushed — as a JSON list of lines, each
 * prefixed with its board's number. Said again once it stops and returns.
 */
const NAME = 'rness/noted'

export function notedFile(rnessDir: string): Promise<string | null> {
  return gitPath(rnessDir, NAME)
}

/** The lines `file` records; missing or corrupt, none. Never throws. */
export async function readNoted(file: string | null): Promise<Set<string>> {
  if (file === null) return new Set()
  try {
    const data: unknown = JSON.parse(await readFile(file, 'utf8'))
    return new Set(
      Array.isArray(data)
        ? data.filter((l): l is string => typeof l === 'string')
        : []
    )
  } catch {
    return new Set()
  }
}

/** `noted` written whole, as `writeOpened` does; none, no file. Best effort. */
export async function writeNoted(
  file: string | null,
  noted: ReadonlySet<string>
): Promise<void> {
  if (file === null) return
  try {
    if (noted.size === 0) {
      await rm(file, { force: true })
      return
    }
    await mkdir(dirname(file), { recursive: true })
    const temporary = `${file}.${process.pid}`
    await writeFile(
      temporary,
      `${JSON.stringify([...noted].sort(), null, 2)}\n`
    )
    await rename(temporary, file)
  } catch {
    // A note said twice is the worst a lost record does.
  }
}

/**
 * The layout lines of one board to say: every line but a note already said
 * for it. The record keeps the notes that still hold, the others forgotten.
 */
export async function onceSaid(
  rnessDir: string,
  board: number,
  lines: readonly string[]
): Promise<string[]> {
  const file = await notedFile(rnessDir)
  const noted = await readNoted(file)
  const prefix = `${board}: `
  const notes = lines.filter((l) => l.startsWith('note '))
  const now = new Set(notes.map((l) => `${prefix}${l}`))
  const said = lines.filter(
    (l) => !l.startsWith('note ') || !noted.has(`${prefix}${l}`)
  )
  const next = new Set([
    ...[...noted].filter((l) => !l.startsWith(prefix)),
    ...now,
  ])
  if (next.size !== noted.size || [...next].some((l) => !noted.has(l)))
    await writeNoted(file, next)
  return said
}
