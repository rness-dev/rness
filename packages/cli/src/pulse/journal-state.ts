import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

import { configDir } from '../core/auth.ts'
import { gitPath } from '../core/git.ts'

/**
 * What the agent journal keeps on this machine (spec 0030 §4, §3.4): the
 * notes each session posted on each plan, in the `.rness` clone's git
 * directory (`rness/journal`, never pushed), as the issues the pulse opened
 * are; and the fallbacks the next session start says once, beside the
 * pulse's failures in rness's configuration directory.
 */

type Counts = Record<string, Record<string, number>>

const COUNTS = 'rness/journal'

async function readJson(file: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(file, 'utf8'))
  } catch {
    return null
  }
}

async function writeJson(file: string, value: unknown): Promise<void> {
  await mkdir(dirname(file), { recursive: true })
  const temporary = `${file}.${process.pid}`
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`)
  await rename(temporary, file)
}

/** The notes `session` posted on `plan` from this clone; 0 when none, or no record. */
export async function notesPosted(
  rnessDir: string,
  session: string,
  plan: string
): Promise<number> {
  const file = await gitPath(rnessDir, COUNTS)
  if (file === null) return 0
  const data = (await readJson(file)) as Counts | null
  const n = data?.[session]?.[plan]
  return typeof n === 'number' ? n : 0
}

/** One more note of `session` on `plan`, recorded; best effort. */
export async function notePosted(
  rnessDir: string,
  session: string,
  plan: string
): Promise<void> {
  const file = await gitPath(rnessDir, COUNTS)
  if (file === null) return
  try {
    const data = ((await readJson(file)) as Counts | null) ?? {}
    const of = data[session] ?? {}
    of[plan] = (of[plan] ?? 0) + 1
    data[session] = of
    await writeJson(file, data)
  } catch {
    // A note uncounted is one more allowed, nothing worse.
  }
}

/** The plans `session` posted a note on, from this clone. */
export async function plansNoted(
  rnessDir: string,
  session: string
): Promise<string[]> {
  const file = await gitPath(rnessDir, COUNTS)
  if (file === null) return []
  const data = (await readJson(file)) as Counts | null
  return Object.keys(data?.[session] ?? {})
}

const notices = (): string => join(configDir(), 'journal.json')

/** A line for the next session start (`<repo> takes no issues, …`), kept until said; each once. */
export async function recordNotice(line: string): Promise<void> {
  try {
    const now = ((await readJson(notices())) as string[] | null) ?? []
    if (!now.includes(line)) await writeJson(notices(), [...now, line])
  } catch {
    // Said at the next fallback, then.
  }
}

/** The lines recorded since the last session start, taken: said once. */
export async function takeNotices(): Promise<string[]> {
  const now = await readJson(notices())
  await rm(notices(), { force: true }).catch(() => {})
  return Array.isArray(now)
    ? now.filter((l): l is string => typeof l === 'string')
    : []
}
