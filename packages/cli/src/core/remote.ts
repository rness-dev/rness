import { spawn } from 'node:child_process'

import { positional, withCredentials } from './git.ts'
import { HOSTS } from './hosts.ts'
import type { GitCredentials } from './provider.ts'

/** GitHub's two bases (spec 0005); another host's are in its row of `HOSTS`. */
export const DEFAULT_HOST = HOSTS.github.https
export const SSH_HOST = HOSTS.github.ssh

/** `<host><org>/<repo>.git`; `host` ends with `/` (https, file) or `:` (ssh). */
export function repoUrl(host: string, org: string, repo: string): string {
  return `${host}${org}/${repo}.git`
}

/**
 * What names the repository in a remote URL: host and path, without the
 * scheme, a user or a token, a port, `.git` or a trailing slash, in
 * lowercase. `git@host:o/r.git`, `ssh://git@host/o/r` and `https://host/o/r`
 * give the same key; a `file://` URL gives its path.
 */
function remoteKey(url: string): string {
  let rest = url.trim()
  const scp = /^[^@/:]+@([^/:]+):(.*)$/.exec(rest)
  if (scp !== null) rest = `${scp[1]}/${scp[2]}`
  else {
    const full = /^[a-z][a-z0-9+.-]*:\/\/(?:[^@/]*@)?([^/]*)(.*)$/i.exec(rest)
    if (full !== null)
      rest = `${(full[1] ?? '').replace(/:\d+$/, '')}${full[2] ?? ''}`
  }
  return rest
    .replace(/\/+$/, '')
    .replace(/\.git$/i, '')
    .replace(/\/+$/, '')
    .toLowerCase()
}

/**
 * Whether two remote URLs reach the same repository. GitHub resolves owner
 * and repository names case-insensitively, and a clone made over HTTPS is the
 * same repository as the SSH URL `rness.json` holds.
 */
export function sameRemote(a: string, b: string): boolean {
  return remoteKey(a) === remoteKey(b)
}

export type Probe =
  { kind: 'found' } | { kind: 'not-found' } | { kind: 'error'; message: string }

const AUTH = [
  /authentication failed/i,
  /permission denied/i,
  /could not read username/i,
  /terminal prompts disabled/i,
]
const NOT_FOUND = [
  /repository .*not found/i,
  /does not appear to be a git repository/i,
]

function firstLine(text: string): string {
  return (
    text
      .split('\n')
      .find((l) => l.trim() !== '')
      ?.trim() ?? 'unknown error'
  )
}

/**
 * Interpret `git ls-remote --exit-code <url> HEAD`. Auth patterns win over
 * not-found ones: GitHub tells strangers a private repository does not exist,
 * so "not found" only counts when nothing points at a credentials problem.
 * Exit 2 is "no HEAD" — an empty repository that does exist.
 */
export function classifyProbe(
  url: string,
  exitCode: number,
  stderr: string
): Probe {
  if (exitCode === 0 || exitCode === 2) return { kind: 'found' }
  if (AUTH.some((r) => r.test(stderr)))
    return {
      kind: 'error',
      message: `cannot access ${url}: ${firstLine(stderr)}`,
    }
  if (NOT_FOUND.some((r) => r.test(stderr))) return { kind: 'not-found' }
  return { kind: 'error', message: `cannot reach ${url}: ${firstLine(stderr)}` }
}

/**
 * How long, after the child has exited, the stderr pipe may still deliver what
 * git wrote before exiting. `'exit'` can precede the last `'data'` event, and
 * an empty stderr would be classified as an unreachable remote — but a
 * grandchild (a credential helper) can hold the pipe open for as long as it
 * likes, so the wait is bounded and `'close'` is never awaited.
 */
const STDERR_FLUSH_MS = 200

/**
 * `git ls-remote --exit-code <url> HEAD`, classified (see `classifyProbe`).
 * Never hangs: the child is killed after `timeoutMs`, and the answer never
 * waits on `'close'`, so a credential helper left holding the stderr pipe
 * cannot keep the caller pending. The child stays in this process's group so
 * that Ctrl-C in the terminal reaches it too.
 */
export async function probeRemote(
  url: string,
  timeoutMs = 60_000,
  credentials?: GitCredentials | null
): Promise<Probe> {
  // Before anything spawns, and outside the promise: a url git would read as
  // an option must fail loudly rather than reach the command line.
  positional(url, 'repository url')
  return new Promise<Probe>((resolve) => {
    const auth = withCredentials(credentials)
    const child = spawn(
      'git',
      [...auth.args, 'ls-remote', '--exit-code', url, 'HEAD'],
      {
        stdio: ['ignore', 'ignore', 'pipe'],
        env: { ...process.env, ...auth.env, GIT_TERMINAL_PROMPT: '0' },
      }
    )
    const chunks: string[] = []
    child.stderr?.setEncoding('utf8')
    child.stderr?.on('data', (chunk: string) => chunks.push(chunk))

    let settled = false
    const settle = (probe: Probe): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      // Release the pipe: a grandchild still holding it open would otherwise
      // keep the event loop alive long after the answer is known.
      child.stderr?.destroy()
      resolve(probe)
    }
    const timer = setTimeout(() => {
      // Only the child git itself: a grandchild it orphaned is harmless, and
      // killing a whole process group would mean detaching from ours, which
      // costs the terminal's Ctrl-C.
      child.kill('SIGKILL')
      settle({
        kind: 'error',
        message: `cannot reach ${url}: timed out after ${Math.round(timeoutMs / 1000)}s`,
      })
    }, timeoutMs)

    child.on('error', (e: Error) => settle(classifyProbe(url, 1, e.message)))
    child.on('exit', (code) => {
      const finish = (): void =>
        settle(classifyProbe(url, code ?? 1, chunks.join('')))
      const stderr = child.stderr
      if (stderr === null || stderr.readableEnded || stderr.destroyed)
        return finish()
      const flush = setTimeout(finish, STDERR_FLUSH_MS)
      const done = (): void => {
        clearTimeout(flush)
        finish()
      }
      stderr.once('end', done)
      stderr.once('error', done)
    })
  })
}
