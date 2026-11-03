import { chmod, mkdir } from 'node:fs/promises'
import { join } from 'node:path'

import { PINNED_BIN } from './delegate.ts'
import { readOrNull, writeFileAtomic } from './fs.ts'
import { configValue, gitPath } from './git.ts'

/**
 * The exit code of a refusal. Not 1: a crashed or unparseable CLI exits 1
 * (Node's own codes are 1 to 14, 128+signal), and the hooks must tell the
 * two apart so that only a refusal blocks.
 */
export const POLICY_REFUSED_EXIT = 20

/** The hooks that carry the workspace's policies (spec 0040 4.2). */
export const HOOK_NAMES = ['pre-commit', 'commit-msg', 'pre-push'] as const
export type HookName = (typeof HOOK_NAMES)[number]

/** What marks a hook file as rness's: only such a file is ever rewritten. */
export const HOOK_MARKER =
  '# rness: policy hook, written by rness sync; edit .rness/policy/, not this file'

/** The pinned CLI of the workspace at `ws`, absolute. */
export function pinnedCliOf(ws: string): string {
  return join(ws, '.rness', ...PINNED_BIN.split('/'))
}

const quote = (s: string): string => `'${s.replaceAll("'", `'\\''`)}'`

/**
 * The text of one hook: locate the pinned CLI and run it, nothing more. Only
 * the CLI's refusal code blocks (exit 1); a missing `node` or CLI, or a CLI
 * that crashed, is said in one line and lets git go on (fail open). No
 * `exec`: the script reads the status; stdin is inherited, so pre-push still
 * reads git's lines.
 */
export function hookScript(hook: HookName, ws: string): string {
  return `#!/bin/sh
${HOOK_MARKER}
bin=${quote(pinnedCliOf(ws))}
if ! command -v node >/dev/null 2>&1; then
  echo "rness: policies not checked: node not found" >&2
  exit 0
fi
if [ ! -f "$bin" ]; then
  echo "rness: policies not checked: $bin not found" >&2
  exit 0
fi
node "$bin" policy check ${hook} "$@"
status=$?
if [ "$status" -eq ${POLICY_REFUSED_EXIT} ]; then
  exit 1
fi
if [ "$status" -ne 0 ]; then
  echo "rness: policies not checked: the rness CLI exited $status" >&2
fi
exit 0
`
}

/** The line a team's hook manager runs for `hook` when it owns `core.hooksPath`. */
export function hookManagerLine(hook: string, ws: string): string {
  return `node ${quote(pinnedCliOf(ws))} policy check ${hook} "$@"`
}

export interface HooksResult {
  /** Hooks created or rewritten. */
  written: HookName[]
  /** Hook files without the marker, left as they are. */
  foreign: HookName[]
  /** The value of `core.hooksPath` when set: nothing was written. */
  hooksPath: string | null
  /** True when `clone` is no git repository: nothing to do. */
  notARepository: boolean
}

/**
 * Write the three hooks in the hooks directory of `clone` (the main
 * repository's, for a linked worktree). A rness hook whose text differs is
 * rewritten; a file without the marker is left; a clone with
 * `core.hooksPath` is left whole. Hooks are written whatever the policies:
 * `rness policy check` passes through while none is enabled.
 */
export async function installHooks(
  clone: string,
  ws: string
): Promise<HooksResult> {
  const result: HooksResult = {
    written: [],
    foreign: [],
    hooksPath: null,
    notARepository: false,
  }
  const dir = await gitPath(clone, 'hooks')
  if (dir === null) return { ...result, notARepository: true }
  const hooksPath = await configValue(clone, 'core.hooksPath')
  if (hooksPath !== null) return { ...result, hooksPath }
  await mkdir(dir, { recursive: true })
  for (const hook of HOOK_NAMES) {
    const file = join(dir, hook)
    const text = hookScript(hook, ws)
    const existing = await readOrNull(file)
    if (existing !== null && !existing.includes(HOOK_MARKER)) {
      result.foreign.push(hook)
      continue
    }
    if (existing !== text) {
      await writeFileAtomic(file, text)
      result.written.push(hook)
    }
    // A rness hook that lost its execute bit is fixed even when its text is right.
    await chmod(file, 0o755)
  }
  return result
}
