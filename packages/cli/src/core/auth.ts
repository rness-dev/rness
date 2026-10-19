import { chmod, mkdir, open, readFile, rm, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

import {
  RefreshRejected,
  type TokenSet,
  refreshTokenSet,
} from './device-flow.ts'
import { writeFileAtomic } from './fs.ts'
import { HOSTS, type HostSpec, providerFlag } from './hosts.ts'
import { rnessCommand } from './pm.ts'

// Where the logins live (spec 0004 §1, spec 0037 §3): one file, readable by
// its owner only, one entry per host. No keychain: that needs a native
// dependency.

export interface StoredLogin {
  login: string
  tokens: TokenSet
}

/** `$XDG_CONFIG_HOME/rness`, else `~/.config/rness`; `%APPDATA%\rness` on Windows. */
export function configDir(): string {
  const xdg = process.env['XDG_CONFIG_HOME']
  if (xdg !== undefined && xdg !== '') return join(xdg, 'rness')
  const appData = process.env['APPDATA']
  if (process.platform === 'win32' && appData !== undefined && appData !== '')
    return join(appData, 'rness')
  return join(homedir(), '.config', 'rness')
}

const authFile = (): string => join(configDir(), 'auth.json')
const lockFile = (): string => join(configDir(), 'auth.lock')

function isTokenSet(v: unknown): v is TokenSet {
  if (v === null || typeof v !== 'object') return false
  const t = v as Record<string, unknown>
  return typeof t['accessToken'] === 'string' && t['accessToken'] !== ''
}

/** Every entry of `auth.json`, by host; empty when there is none to read. */
async function readEntries(): Promise<Record<string, unknown>> {
  try {
    const parsed: unknown = JSON.parse(await readFile(authFile(), 'utf8'))
    return parsed !== null &&
      typeof parsed === 'object' &&
      !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {}
  } catch {
    return {}
  }
}

/** The login stored for `host`, or null. */
export async function readAuth(
  host: HostSpec = HOSTS.github
): Promise<StoredLogin | null> {
  try {
    const entry = (await readEntries())[host.host]
    if (entry === null || typeof entry !== 'object') return null
    const { login, tokens } = entry as Record<string, unknown>
    if (typeof login !== 'string' || !isTokenSet(tokens)) return null
    return {
      login,
      tokens: {
        accessToken: tokens.accessToken,
        expiresAt: tokens.expiresAt ?? null,
        refreshToken: tokens.refreshToken ?? null,
        refreshExpiresAt: tokens.refreshExpiresAt ?? null,
        scopes: tokens.scopes ?? '',
      },
    }
  } catch {
    return null
  }
}

async function writeEntries(entries: Record<string, unknown>): Promise<void> {
  const file = authFile()
  if (Object.keys(entries).length === 0) {
    await rm(file, { force: true })
    return
  }
  await mkdir(configDir(), { recursive: true, mode: 0o700 })
  await writeFileAtomic(file, `${JSON.stringify(entries, null, 2)}\n`)
  await chmod(file, 0o600)
}

/** Store the login for `host`; the other hosts' logins are kept. */
export async function writeAuth(
  login: StoredLogin,
  host: HostSpec = HOSTS.github
): Promise<void> {
  await writeEntries({ ...(await readEntries()), [host.host]: login })
}

/** Forget the login for `host`; the file goes with the last one. */
export async function clearAuth(host: HostSpec = HOSTS.github): Promise<void> {
  const { [host.host]: _gone, ...kept } = await readEntries()
  await writeEntries(kept)
}

export type TokenSource = 'GITHUB_TOKEN' | 'GH_TOKEN' | 'GITLAB_TOKEN' | 'login'

export interface ResolvedToken {
  token: string
  source: TokenSource
  /** Known for a stored login only. */
  login: string | null
}

/** The token the environment provides for `host`, which wins over the stored login (CI, scripts). */
export function envToken(host: HostSpec = HOSTS.github): ResolvedToken | null {
  for (const source of host.tokenEnv) {
    const token = process.env[source]
    if (token !== undefined && token !== '')
      return { token, source: source as TokenSource, login: null }
  }
  return null
}

/** Refresh when the access token has less than this left. */
const REFRESH_MARGIN_MS = 5 * 60_000
const LOCK_WAIT_MS = 10_000
const LOCK_STALE_MS = 30_000

export interface ResolveDeps {
  now?: () => number
  /** One line for the user when the login turns out to be over. */
  notify?: (line: string) => void
}

const fresh = (tokens: TokenSet, now: number): boolean =>
  tokens.expiresAt === null || tokens.expiresAt - now > REFRESH_MARGIN_MS

/**
 * Hold `auth.lock` while `work` runs. A refresh token is single-use and git
 * calls `rness git-credential` in parallel: two refreshes at once would
 * invalidate each other. Null when the lock could not be had in time.
 */
async function withLock<T>(work: () => Promise<T>): Promise<T | null> {
  await mkdir(configDir(), { recursive: true, mode: 0o700 })
  const file = lockFile()
  const deadline = Date.now() + LOCK_WAIT_MS
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
      else if (Date.now() > deadline) return null
      else await new Promise<void>((r) => setTimeout(r, 50))
    }
  }
  try {
    return await work()
  } finally {
    await rm(file, { force: true })
  }
}

/**
 * The token to act with on `host`: its variables (`GITHUB_TOKEN`, then
 * `GH_TOKEN`; `GITLAB_TOKEN`), then the stored login, refreshed when it is
 * about to expire. Null when there is none. A network failure during the
 * refresh never ends the login: an offline `git pull` must not log anyone
 * out.
 */
export async function resolveToken(
  deps: ResolveDeps = {},
  host: HostSpec = HOSTS.github
): Promise<ResolvedToken | null> {
  const env = envToken(host)
  if (env !== null) return env
  const now = deps.now ?? Date.now
  const stored = await readAuth(host)
  if (stored === null) return null
  const answer = (s: StoredLogin): ResolvedToken => ({
    token: s.tokens.accessToken,
    source: 'login',
    login: s.login,
  })
  if (fresh(stored.tokens, now())) return answer(stored)

  const refreshed = await withLock(async (): Promise<StoredLogin | null> => {
    // Another process may have renewed it while this one waited: a refresh
    // token is single-use, a second refresh with it is refused.
    const current = await readAuth(host)
    if (current === null) return null
    if (fresh(current.tokens, now())) return current
    if (current.tokens.refreshToken === null) return null
    try {
      const tokens = await refreshTokenSet(
        current.tokens.refreshToken,
        now,
        host
      )
      const next = { login: current.login, tokens }
      await writeAuth(next, host)
      return next
    } catch (e) {
      if (e instanceof RefreshRejected) {
        await clearAuth(host)
        ;(deps.notify ?? ((l) => process.stderr.write(`${l}\n`)))(
          `your ${host.label} login expired; run ${rnessCommand()} login${providerFlag(host)}`
        )
        return null
      }
      // Offline: keep the login, and the token while it is still valid.
      const expiresAt = current.tokens.expiresAt
      return expiresAt !== null && expiresAt > now() ? current : null
    }
  })
  return refreshed === null ? null : answer(refreshed)
}
