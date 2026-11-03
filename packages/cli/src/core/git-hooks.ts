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

/** A policy file that says it is enabled, as `grep -E` reads it: quotes allowed. */
const ENABLED = `"^status:[[:space:]]*[\\"']?Enabled"`

/**
 * What every policy hook runs, once `rness_dir` (the workspace's `.rness`,
 * resolved) is set, empty when there is none to look for. Only the CLI's
 * refusal code blocks (exit 1, its words on stderr). Anything else lets git
 * go on and never ends the script, so a team's hook manager runs its own
 * lines after it: the CLI's words are shown when it exits 0, and replaced by
 * one line for any other status (a crash's stack, an older CLI's help).
 * A missing `node` or CLI is one line, said only while a policy of `.rness/`
 * is enabled, or when `.rness/` itself is not there. The CLI runs only from
 * a `.rness` that holds its `rness.json`, is the user's own and is not open
 * to all: a directory found by a path, not one anyone could plant above a
 * clone (`/tmp/.rness`). The output is held in a variable, not a file;
 * stdin is inherited, so pre-push still reads git's lines.
 */
function hookBody(hook: string): string {
  return `rness_bin="$rness_dir/${PINNED_BIN}"
rness_why=
if [ -z "$rness_dir" ]; then
  :
elif ! command -v node >/dev/null 2>&1; then
  rness_why='node not found'
elif [ ! -f "$rness_bin" ]; then
  rness_why="$rness_bin not found"
elif [ ! -f "$rness_dir/rness.json" ] || [ ! -O "$rness_dir" ] || [ -n "$(find "$rness_dir" -prune -perm -0002)" ]; then
  echo "rness: policies not checked: $rness_dir is no workspace .rness of yours alone" >&2
else
  rness_status=0
  rness_out=$(node "$rness_bin" policy check ${hook} "$@" 2>&1) || rness_status=$?
  if [ "$rness_status" -ne 0 ] && [ "$rness_status" -ne ${POLICY_REFUSED_EXIT} ]; then
    rness_out="rness: policies not checked: the rness CLI exited $rness_status"
  fi
  if [ -n "$rness_out" ]; then
    printf '%s\\n' "$rness_out" >&2
  fi
  if [ "$rness_status" -eq ${POLICY_REFUSED_EXIT} ]; then
    exit 1
  fi
fi
if [ -n "$rness_why" ] && { [ ! -d "$rness_dir" ] || grep -rqsE ${ENABLED} "$rness_dir/policy"; }; then
  echo "rness: policies not checked: $rness_why" >&2
fi
`
}

/**
 * The text of one hook in a clone's hooks directory: the body above, the
 * workspace's `.rness` by its absolute path, and exit 0 at its end. No
 * `exec`: the script reads the status.
 */
export function hookScript(hook: HookName, ws: string): string {
  const dir = quote(join(ws, '.rness'))
  return `#!/bin/sh
${HOOK_MARKER}
rness_dir=$(cd ${dir} 2>/dev/null && pwd -P) || rness_dir=${dir}
${hookBody(hook)}exit 0
`
}

/**
 * The lines a team's hook manager (husky, lefthook) runs for `hook` when it
 * owns `core.hooksPath`: the same body, the workspace found from the clone
 * (`org/<name>`, two levels under the workspace's root), so that the file a
 * team commits holds no path of one machine; nothing at all outside a work
 * tree. It never exits but to refuse: the team's own lines run after it.
 */
export function hookManagerSnippet(hook: string): string {
  return `rness_dir=
if rness_top=$(git rev-parse --show-toplevel 2>/dev/null); then
  rness_dir=$(cd "$rness_top/../../.rness" 2>/dev/null && pwd -P) || rness_dir="$rness_top/../../.rness"
fi
${hookBody(hook)}`
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
