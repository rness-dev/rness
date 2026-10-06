import { mkdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'

import { configDir } from './auth.ts'
import { writeFileAtomic } from './fs.ts'

/**
 * The Claude Code running a hook, and whether it can load the rness plugin's
 * mod (spec 0029 §3; plan 0041). An older one is told once per version, from
 * the session-start line: a band that says "update Claude Code" is a band
 * Claude Code already draws.
 */

/** The oldest Claude Code seen running the mod (plan 0040); 2.1.240 ignored it. */
export const MOD_FLOOR = '2.1.280'

// Set by the running Claude Code itself, never inherited from a parent
// session, unlike CLAUDE_CODE_VERSION (verified on 2.1.240 to 2.1.289). The
// suffix says who runs the command: `_harness` for a hook, `_agent` for the
// model's Bash tool; the version is the same.
const AGENT = /^claude-code_(\d+)-(\d+)-(\d+)_[a-z]+$/

/** `2.1.240` from `AI_AGENT=claude-code_2-1-240_harness`; null for another agent or another form. */
export function claudeCodeVersion(env: NodeJS.ProcessEnv): string | null {
  const m = AGENT.exec(env['AI_AGENT'] ?? '')
  return m === null ? null : `${m[1]}.${m[2]}.${m[3]}`
}

/** True when `version` (`major.minor.patch`) is older than `MOD_FLOOR`. */
export function belowModFloor(version: string): boolean {
  const have = version.split('.').map(Number)
  const floor = MOD_FLOOR.split('.').map(Number)
  for (let i = 0; i < 3; i++) {
    const a = have[i] ?? 0
    const b = floor[i] ?? 0
    if (a !== b) return a < b
  }
  return false
}

const noticeFile = (): string => join(configDir(), 'claude-code.json')

/** The versions already told; none when the file is missing or unreadable. */
async function shownVersions(): Promise<string[]> {
  try {
    const data: unknown = JSON.parse(await readFile(noticeFile(), 'utf8'))
    const shown =
      data !== null && typeof data === 'object'
        ? (data as Record<string, unknown>)['modNoticeShown']
        : undefined
    return Array.isArray(shown)
      ? shown.filter((v): v is string => typeof v === 'string')
      : []
  } catch {
    return []
  }
}

/**
 * The line for a Claude Code too old for the mod, once per version and
 * machine: the version is recorded in `claude-code.json` of the config
 * directory when the line is returned. Null without a version, at or above
 * the floor, in a session nobody watches (`CLAUDE_CODE_ENTRYPOINT=sdk-…`,
 * which would use up the one time), or once told. Never throws: a file that
 * cannot be written still gives the line, and nothing stops the hook.
 */
export async function takeModNotice(
  env: NodeJS.ProcessEnv
): Promise<string | null> {
  const version = claudeCodeVersion(env)
  if (version === null || !belowModFloor(version)) return null
  if ((env['CLAUDE_CODE_ENTRYPOINT'] ?? '').startsWith('sdk-')) return null
  const shown = await shownVersions()
  if (shown.includes(version)) return null
  try {
    await mkdir(configDir(), { recursive: true, mode: 0o700 })
    await writeFileAtomic(
      noticeFile(),
      `${JSON.stringify({ modNoticeShown: [...shown, version] })}\n`
    )
  } catch {
    // Not recorded: the line comes again next session, which beats silence.
  }
  return `rness: Claude Code ${version} shows no rness band, footer label or pane; ${MOD_FLOOR} or later does — claude update`
}
