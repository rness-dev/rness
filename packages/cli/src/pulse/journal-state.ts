import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

import { configDir } from '../core/auth.ts'
import { gitPath, headOf } from '../core/git.ts'

/**
 * What the agent journal keeps on this machine (spec 0030 §4, §3.4): the
 * notes each session posted on each plan, in the `.rness` clone's git
 * directory (`rness/journal`, never pushed), as the issues the pulse opened
 * are; each session's start, in the git directory of the clone it works
 * in (`rness/sessions/<id>`), for its summary; and the fallbacks the next
 * session start says once, beside the pulse's failures in rness's
 * configuration directory.
 */

type Counts = Record<string, Record<string, number>>

const COUNTS = 'rness/journal'

/**
 * A session's key: its id, `1a2b3c4d` of `claude · 1a2b3c4d`. The Bash
 * tool names a session without its agent type, the hooks with it: one key.
 */
const keyOf = (session: string): string =>
  session.split(' · ').at(-1)?.trim() ?? session

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
  const n = data?.[keyOf(session)]?.[plan]
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
    const key = keyOf(session)
    const of = data[key] ?? {}
    of[plan] = (of[plan] ?? 0) + 1
    data[key] = of
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
  return Object.keys(data?.[keyOf(session)] ?? {})
}

/** Where a session started: the clone's `HEAD`, and when (ms). */
export interface SessionStart {
  head: string
  at: number
}

/** The file of a session's start in `clone`'s git directory; null for an id that is not one. */
async function startFile(
  clone: string,
  session: string
): Promise<string | null> {
  const id = keyOf(session)
  return /^[A-Za-z0-9-]{1,64}$/.test(id)
    ? gitPath(clone, `rness/sessions/${id}`)
    : null
}

/**
 * The session's start recorded in `clone`, once: a resumed or compacted
 * session keeps its first. Nothing outside a repository; best effort.
 */
export async function recordStart(
  clone: string,
  session: string,
  now: number = Date.now()
): Promise<void> {
  try {
    const [file, head] = await Promise.all([
      startFile(clone, session),
      headOf(clone),
    ])
    if (file === null || head === null) return
    await mkdir(dirname(file), { recursive: true })
    await writeFile(file, `${JSON.stringify({ head, at: now })}\n`, {
      flag: 'wx',
    })
  } catch {
    // Already recorded, or not writable: the summary goes without commits.
  }
}

/** The session's start recorded in `clone`; null when there is none. */
export async function startOf(
  clone: string,
  session: string
): Promise<SessionStart | null> {
  const file = await startFile(clone, session)
  if (file === null) return null
  const data = (await readJson(file)) as Partial<SessionStart> | null
  return typeof data?.head === 'string' && typeof data.at === 'number'
    ? { head: data.head, at: data.at }
    : null
}

/** The session's start, removed once its summary is posted or skipped. */
export async function forgetStart(
  clone: string,
  session: string
): Promise<void> {
  const file = await startFile(clone, session)
  if (file !== null) await rm(file, { force: true }).catch(() => {})
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
