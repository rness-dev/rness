import { execFile } from 'node:child_process'
import { dirname, resolve } from 'node:path'
import { promisify } from 'node:util'

const execFileP = promisify(execFile)

async function git(args: readonly string[], cwd?: string): Promise<string> {
  try {
    const { stdout } = await execFileP('git', [...args], {
      ...(cwd === undefined ? {} : { cwd }),
      env: {
        ...process.env,
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
export async function clone(url: string, dir: string): Promise<void> {
  await git([
    'clone',
    '--quiet',
    '--',
    positional(url, 'repository url'),
    positional(dir, 'directory'),
  ])
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

export async function pullFastForward(dir: string): Promise<void> {
  await git(['pull', '--ff-only', '--quiet'], dir)
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
