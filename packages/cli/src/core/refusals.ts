import { appendFile, mkdir, readFile, stat } from 'node:fs/promises'
import { dirname, join } from 'node:path'

import { writeFileAtomic } from './fs.ts'
import { gitPath } from './git.ts'
import type { PolicyFailure } from './policy-check.ts'
import { POLICY_CHECKS, type PolicyCheck } from './policy.ts'

/**
 * The refusals on record (spec 0040 §6): one JSON line per policy and check
 * that refused an action, in the git directory of the clone it happened in,
 * beside the sessions of spec 0030. Never committed, never pushed. Writing
 * is best effort: a record that cannot be written never fails the hook or
 * the guard that refused.
 */

/**
 * In the clone's git directory: `.git/rness/refusals.jsonl`. For a linked
 * worktree, the common one: every reader and writer names the main work
 * tree, or the git directory a hook was given (its common directory).
 */
export const REFUSALS_FILE = 'rness/refusals.jsonl'

/** How long `sync` keeps a record (spec 0040 §6, proposal). */
export const REFUSALS_KEPT_DAYS = 30

/** Who refused: the Claude Code guard, or one of the git hooks. */
export const REFUSED_BY = [
  'guard',
  'pre-commit',
  'commit-msg',
  'pre-push',
] as const
export type RefusedBy = (typeof REFUSED_BY)[number]

export interface Refusal {
  /** ISO 8601, UTC. */
  readonly time: string
  /** The policy's id, its file name. */
  readonly policy: string
  readonly check: PolicyCheck
  readonly by: RefusedBy
  /** The session, when the refuser knows it. */
  readonly session?: string
}

export type RefusalEntry = Omit<Refusal, 'time'>

const DAY = 24 * 60 * 60 * 1000

const has = <T extends string>(
  list: readonly T[],
  value: unknown
): value is T => (list as readonly unknown[]).includes(value)

/**
 * The entries of one refused action: one per policy and check, however many
 * lines broke it, so a count of records is a count of refusals.
 */
export function refusalsOf(
  failures: readonly PolicyFailure[],
  by: RefusedBy,
  session?: string | null
): RefusalEntry[] {
  const seen = new Set<string>()
  const entries: RefusalEntry[] = []
  for (const { policy, rule } of failures) {
    const key = `${policy.name}\n${rule.check}`
    if (seen.has(key)) continue
    seen.add(key)
    entries.push({
      policy: policy.name,
      check: rule.check,
      by,
      ...(session === undefined || session === null || session === ''
        ? {}
        : { session }),
    })
  }
  return entries
}

/**
 * Append `entries` to the record of `clone`, stamped `now`. True once
 * written (or nothing to write); false when it could not be, never thrown.
 */
export async function recordRefusals(
  clone: string,
  entries: readonly RefusalEntry[],
  now: number = Date.now()
): Promise<boolean> {
  if (entries.length === 0) return true
  const file = await gitPath(clone, REFUSALS_FILE)
  return file !== null && appendRecords(file, entries, now)
}

/**
 * The same, for a repository whose git directory is known (a git hook's,
 * which `gitPath` would look for again in an environment that may not be
 * the hook's): the record of its main work tree, `<gitDir>/rness/...`.
 */
export async function recordRefusalsIn(
  gitDir: string,
  entries: readonly RefusalEntry[],
  now: number = Date.now()
): Promise<boolean> {
  if (entries.length === 0) return true
  try {
    // Never made: a directory that is not there is no repository.
    if (!(await stat(gitDir)).isDirectory()) return false
  } catch {
    return false
  }
  return appendRecords(join(gitDir, ...REFUSALS_FILE.split('/')), entries, now)
}

async function appendRecords(
  file: string,
  entries: readonly RefusalEntry[],
  now: number
): Promise<boolean> {
  try {
    const time = new Date(now).toISOString()
    const text = entries
      .map((e) =>
        JSON.stringify({
          time,
          policy: e.policy,
          check: e.check,
          by: e.by,
          ...(e.session === undefined ? {} : { session: e.session }),
        })
      )
      .join('\n')
    await mkdir(dirname(file), { recursive: true })
    // One write in append mode: lines from two hooks do not interleave.
    await appendFile(file, `${text}\n`, 'utf8')
    return true
  } catch {
    return false
  }
}

/** A line of the record, or null for one that is not a record. */
function parseRecord(line: string): (Refusal & { at: number }) | null {
  let data: unknown
  try {
    data = JSON.parse(line)
  } catch {
    return null
  }
  if (data === null || typeof data !== 'object' || Array.isArray(data))
    return null
  const r = data as Record<string, unknown>
  const { time, policy, check, by, session } = r
  if (typeof time !== 'string' || typeof policy !== 'string' || policy === '')
    return null
  const at = Date.parse(time)
  if (Number.isNaN(at) || !has(POLICY_CHECKS, check) || !has(REFUSED_BY, by))
    return null
  return {
    time,
    policy,
    check,
    by,
    ...(typeof session === 'string' && session !== '' ? { session } : {}),
    at,
  }
}

async function readAll(
  clone: string
): Promise<{ file: string | null; lines: string[] }> {
  const file = await gitPath(clone, REFUSALS_FILE)
  if (file === null) return { file, lines: [] }
  try {
    return { file, lines: (await readFile(file, 'utf8')).split('\n') }
  } catch {
    return { file, lines: [] }
  }
}

export interface RefusalWindow {
  /** Milliseconds since the epoch, inclusive. */
  since?: number
  /** Milliseconds since the epoch, inclusive. */
  until?: number
}

/**
 * The records of `clone` within a window, in the order they were written.
 * A line that is not a record is skipped; no record, no repository: none.
 */
export async function readRefusals(
  clone: string,
  { since, until }: RefusalWindow = {}
): Promise<Refusal[]> {
  const { lines } = await readAll(clone)
  const records: Refusal[] = []
  for (const line of lines) {
    const parsed = parseRecord(line)
    if (parsed === null) continue
    if (since !== undefined && parsed.at < since) continue
    if (until !== undefined && parsed.at > until) continue
    const { at: _at, ...record } = parsed
    records.push(record)
  }
  return records
}

/**
 * Drop the records older than `olderThanDays` before `now`, and the lines
 * that are no record; how many records went. Best effort: 0 when the file
 * cannot be read or written. A record appended while the file is rewritten
 * may be lost: accepted, the record is a trace, not a ledger.
 */
export async function pruneRefusals(
  clone: string,
  olderThanDays: number = REFUSALS_KEPT_DAYS,
  now: number = Date.now()
): Promise<number> {
  try {
    const { file, lines } = await readAll(clone)
    if (file === null || lines.length === 0) return 0
    const cut = now - olderThanDays * DAY
    const kept: string[] = []
    let dropped = 0
    let unread = 0
    for (const line of lines) {
      if (line === '') continue
      const parsed = parseRecord(line)
      if (parsed === null) unread += 1
      else if (parsed.at < cut) dropped += 1
      else kept.push(line)
    }
    if (dropped === 0 && unread === 0) return 0
    await writeFileAtomic(file, kept.length === 0 ? '' : `${kept.join('\n')}\n`)
    return dropped
  } catch {
    return 0
  }
}
