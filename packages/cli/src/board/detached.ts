import { spawn as nodeSpawn } from 'node:child_process'
import { mkdir, open, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'

import { configDir } from '../core/auth.ts'

/**
 * Runs `rness <args>` detached, from `cwd`: the hooks return at once and the
 * boards' GitHub calls finish on their own (spec 0017 §5).
 */
export type Spawn = (args: string[], cwd: string) => void

/**
 * The hook already runs as the pinned copy's bin, so `process.argv[1]` is
 * the launcher to run again. `RNESS_NO_DELEGATE` keeps the child from
 * delegating or catching up.
 */
export const detached: Spawn = (args, cwd) => {
  const bin = process.argv[1]
  if (bin === undefined) return
  const child = nodeSpawn(process.execPath, [bin, ...args], {
    detached: true,
    stdio: 'ignore',
    cwd,
    env: { ...process.env, RNESS_NO_DELEGATE: '1' },
  })
  child.on('error', () => undefined)
  child.unref()
}

const failureFile = (): string => join(configDir(), 'board.json')
/** Where 0.21 and before recorded it: still read, once (plan 0048). */
const formerFailureFile = (): string => join(configDir(), 'pulse.json')

/** What a detached `board run` could not do, for the next session start. */
export async function recordFailure(reason: string): Promise<void> {
  try {
    await mkdir(configDir(), { recursive: true, mode: 0o700 })
    await writeFile(
      failureFile(),
      `${JSON.stringify({ at: new Date().toISOString(), reason })}\n`
    )
  } catch {
    // Nowhere to say it: the mark already failed, and nothing may throw here.
  }
}

/** The recorded failure's reason, once: reading it deletes it; a former record is read when there is no other. */
export async function takeFailure(): Promise<string | null> {
  return (
    (await takeFrom(failureFile())) ?? (await takeFrom(formerFailureFile()))
  )
}

async function takeFrom(file: string): Promise<string | null> {
  try {
    const data: unknown = JSON.parse(await readFile(file, 'utf8'))
    await rm(file, { force: true })
    const reason =
      data !== null && typeof data === 'object'
        ? (data as Record<string, unknown>)['reason']
        : undefined
    return typeof reason === 'string' && reason !== '' ? reason : null
  } catch {
    return null
  }
}

/** A lock older than this is a crashed process's: a sync waits 10 minutes at most on GitHub. */
const LOCK_STALE_MS = 15 * 60_000

/**
 * The hooks' syncs of one board, one at a time: two at once would each give
 * a new document an issue (plan 0027 Task 6). Runs `work` holding the lock
 * and says true. Held by another process, it says false at once — or, with
 * `wait`, polls each second until the lock is free or stale.
 */
export async function oneSyncAtATime(
  key: string,
  work: () => Promise<void>,
  options: { wait?: boolean; sleep?: (ms: number) => Promise<void> } = {}
): Promise<boolean> {
  await mkdir(configDir(), { recursive: true, mode: 0o700 })
  const file = join(configDir(), `board-${key}.lock`)
  for (;;) {
    try {
      const handle = await open(file, 'wx')
      await handle.close()
      break
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e
      const age = await stat(file).then(
        (s) => Date.now() - s.mtimeMs,
        () => 0
      )
      if (age > LOCK_STALE_MS) await rm(file, { force: true })
      else if (options.wait !== true) return false
      else await (options.sleep ?? ((ms: number) => delay(ms)))(1_000)
    }
  }
  try {
    await work()
    return true
  } finally {
    await rm(file, { force: true })
  }
}
