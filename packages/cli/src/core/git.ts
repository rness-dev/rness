import { execFile } from 'node:child_process'
import { dirname, resolve } from 'node:path'
import { promisify } from 'node:util'

import type { GitCredentials } from './provider.ts'

const execFileP = promisify(execFile)

// Answers git's `get` with what the environment holds. The token is never in
// an argument, a URL or a config file: only in the child's environment.
const ENV_HELPER =
  '!f() { test "$1" = get && printf "username=%s\\npassword=%s\\n" "$RNESS_GIT_USERNAME" "$RNESS_GIT_TOKEN"; }; f'

/**
 * How one git command is given credentials (spec 0004 §4): the helpers git
 * would otherwise consult are cleared, and one that lives for this command
 * only reads the child's environment. Nothing when there are none.
 */
export function withCredentials(
  credentials: GitCredentials | null | undefined
): {
  args: string[]
  env: Record<string, string>
} {
  if (credentials === null || credentials === undefined)
    return { args: [], env: {} }
  return {
    args: ['-c', 'credential.helper=', '-c', `credential.helper=${ENV_HELPER}`],
    env: {
      RNESS_GIT_USERNAME: credentials.username,
      RNESS_GIT_TOKEN: credentials.password,
    },
  }
}

async function git(
  args: readonly string[],
  cwd?: string,
  credentials?: GitCredentials | null
): Promise<string> {
  const auth = withCredentials(credentials)
  try {
    const { stdout } = await execFileP('git', [...auth.args, ...args], {
      ...(cwd === undefined ? {} : { cwd }),
      env: {
        ...process.env,
        ...auth.env,
        GIT_TERMINAL_PROMPT: '0',
        // Pin the command to `cwd` itself: without a ceiling, git walks up and
        // a plain directory under `org/` would report — or be pulled into —
        // whatever repository happens to sit above the workspace root. git
        // ignores a relative ceiling entry, hence the resolve().
        ...(cwd === undefined
          ? {}
          : { GIT_CEILING_DIRECTORIES: dirname(resolve(cwd)) }),
      },
      maxBuffer: 16 * 1024 * 1024,
    })
    return stdout
  } catch (e) {
    const err = e as { stderr?: string; message?: string }
    const text =
      err.stderr !== undefined && err.stderr !== ''
        ? err.stderr
        : (err.message ?? 'unknown error')
    const first =
      text.split('\n').find((l) => l.trim() !== '') ?? 'unknown error'
    throw new Error(`git ${args[0] ?? ''} failed: ${first.trim()}`, {
      cause: e,
    })
  }
}

/** Reject a value git could parse as an option (e.g. a `rness.json` URL starting with `-`). */
export function positional(value: string, what: string): string {
  if (value.startsWith('-'))
    throw new Error(`refusing suspicious ${what}: ${value}`)
  return value
}

/** `git clone <url> <dir>`; `dir` must not exist. */
export async function clone(
  url: string,
  dir: string,
  credentials?: GitCredentials | null
): Promise<void> {
  await git(
    [
      'clone',
      '--quiet',
      '--',
      positional(url, 'repository url'),
      positional(dir, 'directory'),
    ],
    undefined,
    credentials
  )
}

/**
 * True when `git status --porcelain` prints nothing, ignoring the paths in
 * `ignore` (rness-managed files such as `AGENTS.md`/`CLAUDE.md` that sync
 * itself writes into every clone and that should never veto an auto-pull).
 */
export async function isClean(
  dir: string,
  ignore: readonly string[] = []
): Promise<boolean> {
  const pathspec = ignore.map((p) => `:!${p}`)
  return (
    (
      await git(
        [
          'status',
          '--porcelain',
          ...(pathspec.length > 0 ? ['--', ...pathspec] : []),
        ],
        dir
      )
    ).trim() === ''
  )
}

export async function pullFastForward(
  dir: string,
  credentials?: GitCredentials | null
): Promise<void> {
  await git(['pull', '--ff-only', '--quiet'], dir, credentials)
}

/** The `origin` URL, or null when `dir` is not a clone with an origin. */
export async function originUrl(dir: string): Promise<string | null> {
  try {
    return (await git(['remote', 'get-url', 'origin'], dir)).trim()
  } catch {
    return null
  }
}

/** `git init -q -b main <dir>` (the directory must exist). */
export async function init(dir: string): Promise<void> {
  await git(['init', '-q', '-b', 'main'], dir)
}

/** `git add -A && git commit -q -m <message>` in `dir`. */
export async function commitAll(dir: string, message: string): Promise<void> {
  await git(['add', '-A'], dir)
  await git(['commit', '-q', '-m', message], dir)
}
