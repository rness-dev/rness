import { chmod, mkdir, open, readFile, rm, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

import {
  RefreshRejected,
  type TokenSet,
  refreshTokenSet,
} from './device-flow.ts'
import { writeFileAtomic } from './fs.ts'

// Where the GitHub login lives (spec 0004 §1): one file, readable by its
// owner only. No keychain: that needs a native dependency.

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

export async function readAuth(): Promise<StoredLogin | null> {
  try {
    const parsed: unknown = JSON.parse(await readFile(authFile(), 'utf8'))
    const entry =
      parsed !== null && typeof parsed === 'object'
        ? (parsed as Record<string, unknown>)['github.com']
        : undefined
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

export async function writeAuth(login: StoredLogin): Promise<void> {
  const dir = configDir()
  await mkdir(dir, { recursive: true, mode: 0o700 })
  const file = authFile()
  await writeFileAtomic(
    file,
    `${JSON.stringify({ 'github.com': login }, null, 2)}\n`
  )
  await chmod(file, 0o600)
}

export async function clearAuth(): Promise<void> {
  await rm(authFile(), { force: true })
}

export type TokenSource = 'GITHUB_TOKEN' | 'GH_TOKEN' | 'login'

export interface ResolvedToken {
  token: string
  source: TokenSource
  /** Known for a stored login only. */
  login: string | null
}

/** The token the environment provides, which wins over the stored login (CI, scripts). */
export function envToken(): ResolvedToken | null {
  for (const source of ['GITHUB_TOKEN', 'GH_TOKEN'] as const) {
    const token = process.env[source]
    if (token !== undefined && token !== '')
      return { token, source, login: null }
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
 * The GitHub token to act with: `GITHUB_TOKEN`, then `GH_TOKEN`, then the
 * stored login — refreshed when it is about to expire. Null when there is
 * none. A network failure during the refresh never ends the login: an
 * offline `git pull` must not log anyone out.
 */
export async function resolveToken(
  deps: ResolveDeps = {}
): Promise<ResolvedToken | null> {
  const env = envToken()
  if (env !== null) return env
  const now = deps.now ?? Date.now
  const stored = await readAuth()
  if (stored === null) return null
  const answer = (s: StoredLogin): ResolvedToken => ({
    token: s.tokens.accessToken,
    source: 'login',
    login: s.login,
  })
  if (fresh(stored.tokens, now())) return answer(stored)

  const refreshed = await withLock(async (): Promise<StoredLogin | null> => {
    // Another process may have renewed it while this one waited.
    const current = await readAuth()
    if (current === null) return null
    if (fresh(current.tokens, now())) return current
    if (current.tokens.refreshToken === null) return null
    try {
      const tokens = await refreshTokenSet(current.tokens.refreshToken, now)
      const next = { login: current.login, tokens }
      await writeAuth(next)
      return next
    } catch (e) {
      if (e instanceof RefreshRejected) {
        await clearAuth()
        ;(deps.notify ?? ((l) => process.stderr.write(`${l}\n`)))(
          'your GitHub login expired; run rness login'
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
