import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const execFileP = promisify(execFile)

export const DEFAULT_HOST = 'https://github.com/'
export const SSH_HOST = 'git@github.com:'

/** `<host><org>/<repo>.git`; `host` ends with `/` (https, file) or `:` (ssh). */
export function repoUrl(host: string, org: string, repo: string): string {
  return `${host}${org}/${repo}.git`
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

export async function probeRemote(url: string): Promise<Probe> {
  try {
    await execFileP('git', ['ls-remote', '--exit-code', url, 'HEAD'], {
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
    })
    return { kind: 'found' }
  } catch (e) {
    const err = e as {
      code?: number | string
      stderr?: string
      message: string
    }
    const code = typeof err.code === 'number' ? err.code : 1
    return classifyProbe(url, code, err.stderr ?? err.message)
  }
}
