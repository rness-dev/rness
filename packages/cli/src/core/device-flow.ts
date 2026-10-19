import {
  HOSTS,
  type HostSpec,
  clientIdOf,
  revokeUrl,
  webBase as webOf,
} from './hosts.ts'

// The OAuth device flow (spec 0004 §2; GitLab's, spec 0037 §3): no client
// secret, no redirect, and it works where there is no local browser.
// Refreshing a token obtained this way needs no secret either (GitHub
// documentation, read 2026-09-19; gitlab.com, plan 0049 task 1).

export const SCOPES = HOSTS.github.scopes
/** The extra scope boards need to read a GitHub Project. */
export const BOARD_SCOPE = 'project'

/** GitHub's client ID; `RNESS_GITHUB_CLIENT_ID` overrides it. */
export function clientId(): string {
  return clientIdOf(HOSTS.github)
}

/**
 * The OAuth app's page in the user's settings: where an owner approves rness
 * for an organization that restricts OAuth apps, a member asks for it, and
 * anyone revokes what `rness login` was granted (spec 0028 §3). Doing any of
 * it by API needs the client secret.
 */
export function approvalUrl(): string {
  return revokeUrl(HOSTS.github)
}

/** `https://github.com`; `RNESS_GITHUB_WEB` overrides it in tests. */
export function webBase(): string {
  return webOf(HOSTS.github)
}

export interface DeviceCode {
  deviceCode: string
  userCode: string
  verificationUri: string
  /** The same page with the code filled in, where the host gives one (GitLab). */
  verificationUriComplete?: string
  /** Seconds. */
  expiresIn: number
  interval: number
}

export interface TokenSet {
  accessToken: string
  /** Epoch milliseconds; null for a token that does not expire. */
  expiresAt: number | null
  refreshToken: string | null
  refreshExpiresAt: number | null
  scopes: string
}

/** The host said no: the message is one line for the user. */
export class LoginError extends Error {}
/** The host refused the refresh token: the login is over. Not a network error. */
export class RefreshRejected extends Error {}

function reason(e: unknown): string {
  if (e instanceof Error) {
    return e.name === 'TimeoutError' ? 'timed out' : e.message
  }
  return String(e)
}

async function post(
  host: HostSpec,
  path: string,
  params: Record<string, string>
): Promise<Record<string, unknown>> {
  let res: Response
  try {
    res = await fetch(`${webOf(host)}${path}`, {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/x-www-form-urlencoded',
        'User-Agent': 'rness-cli',
      },
      body: new URLSearchParams(params).toString(),
      signal: AbortSignal.timeout(15_000),
    })
  } catch (e) {
    throw new Error(`cannot reach ${host.host}: ${reason(e)}`, { cause: e })
  }
  // GitLab answers its OAuth errors with a 400 and a JSON body, GitHub with
  // a 200: the body decides, whatever the status.
  let body: unknown
  try {
    body = await res.json()
  } catch (e) {
    throw new Error(`${host.host} answered ${res.status} for ${path}`, {
      cause: e,
    })
  }
  if (body === null || typeof body !== 'object')
    throw new Error(`${host.host} answered an unexpected body for ${path}`)
  return body as Record<string, unknown>
}

const str = (v: unknown): string | null => (typeof v === 'string' ? v : null)
const num = (v: unknown): number | null =>
  typeof v === 'number' && Number.isFinite(v) ? v : null

function tokenSet(body: Record<string, unknown>, now: number): TokenSet | null {
  const accessToken = str(body['access_token'])
  if (accessToken === null) return null
  const expiresIn = num(body['expires_in'])
  const refreshIn = num(body['refresh_token_expires_in'])
  return {
    accessToken,
    expiresAt: expiresIn === null ? null : now + expiresIn * 1000,
    refreshToken: str(body['refresh_token']),
    refreshExpiresAt: refreshIn === null ? null : now + refreshIn * 1000,
    scopes: str(body['scope']) ?? '',
  }
}

export async function requestDeviceCode(
  host: HostSpec = HOSTS.github,
  scopes: string = host.scopes
): Promise<DeviceCode> {
  if (host.loginKind === 'token')
    throw new LoginError(
      `${host.label} logs in with an API token, not a device flow`
    )
  const id = clientIdOf(host)
  if (id === '')
    throw new LoginError(
      `rness has no ${host.label} client ID yet; set ${host.clientIdEnv}`
    )
  const body = await post(host, host.deviceCodePath, {
    client_id: id,
    scope: scopes,
  })
  const deviceCode = str(body['device_code'])
  const userCode = str(body['user_code'])
  const verificationUri = str(body['verification_uri'])
  if (deviceCode === null || userCode === null || verificationUri === null) {
    const error = str(body['error'])
    throw new LoginError(
      error === host.deviceFlowDisabled
        ? `the device flow is not enabled on the rness ${host.label} app`
        : `${host.host} refused to start the login${error === null ? '' : ` (${error})`}`
    )
  }
  const complete = str(body['verification_uri_complete'])
  return {
    deviceCode,
    userCode,
    verificationUri,
    ...(complete === null ? {} : { verificationUriComplete: complete }),
    expiresIn: num(body['expires_in']) ?? 900,
    interval: num(body['interval']) ?? 5,
  }
}

export interface PollDeps {
  sleep?: (ms: number) => Promise<void>
  now?: () => number
}

/** Ask every `interval` seconds until the user approved, refused, or the code expired. */
export async function pollForToken(
  code: DeviceCode,
  deps: PollDeps = {},
  host: HostSpec = HOSTS.github
): Promise<TokenSet> {
  const sleep =
    deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)))
  const now = deps.now ?? Date.now
  const deadline = now() + code.expiresIn * 1000
  let interval = code.interval
  for (;;) {
    await sleep(interval * 1000)
    const body = await post(host, host.tokenPath, {
      client_id: clientIdOf(host),
      device_code: code.deviceCode,
      grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
    })
    const tokens = tokenSet(body, now())
    if (tokens !== null) return tokens
    const error = str(body['error'])
    if (error === 'authorization_pending') {
      if (now() > deadline)
        throw new LoginError('the code expired before it was approved')
      continue
    }
    if (error === 'slow_down') {
      interval = (num(body['interval']) ?? interval) + 5
      continue
    }
    // gitlab.com drops a code left unapproved, then answers invalid_grant.
    if (error === 'expired_token' || error === 'invalid_grant')
      throw new LoginError('the code expired before it was approved')
    if (error === 'access_denied')
      throw new LoginError(`the login was cancelled on ${host.host}`)
    throw new LoginError(
      `${host.host} refused the login (${error ?? 'unknown'})`
    )
  }
}

/** A new token set for a refresh token. `RefreshRejected` when the host says the login is over. */
export async function refreshTokenSet(
  refreshToken: string,
  now: () => number = Date.now,
  host: HostSpec = HOSTS.github
): Promise<TokenSet> {
  const body = await post(host, host.tokenPath, {
    client_id: clientIdOf(host),
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
  })
  const tokens = tokenSet(body, now())
  if (tokens !== null) return tokens
  throw new RefreshRejected(str(body['error']) ?? 'refused')
}
