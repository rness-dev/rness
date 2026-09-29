import { spawn as nodeSpawn } from 'node:child_process'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { configDir } from '../core/auth.ts'

/**
 * Runs `rness <args>` detached, from `cwd`: the hooks return at once and the
 * pulse's GitHub calls finish on their own (spec 0017 §5).
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

const failureFile = (): string => join(configDir(), 'pulse.json')

/** What a detached `pulse mark` could not do, for the next session start. */
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

/** The recorded failure's reason, once: reading it deletes it. */
export async function takeFailure(): Promise<string | null> {
  try {
    const data: unknown = JSON.parse(await readFile(failureFile(), 'utf8'))
    await rm(failureFile(), { force: true })
    const reason =
      data !== null && typeof data === 'object'
        ? (data as Record<string, unknown>)['reason']
        : undefined
    return typeof reason === 'string' && reason !== '' ? reason : null
  } catch {
    return null
  }
}
