// GitHub's OAuth device flow (spec 0004 §2): no client secret, no redirect,
// and it works where there is no local browser. Refreshing a token obtained
// this way needs no secret either (GitHub documentation, read 2026-09-19).

/** The OAuth App "Rness" of the rness-dev organization. Public by nature. */
const GITHUB_CLIENT_ID = 'Ov23liv1ia2UWeWttsOK'
const GITHUB_WEB = 'https://github.com'
export const SCOPES = 'repo read:org'

export function clientId(): string {
  return process.env['RNESS_GITHUB_CLIENT_ID'] ?? GITHUB_CLIENT_ID
}

/** `https://github.com`; `RNESS_GITHUB_WEB` overrides it in tests. */
export function webBase(): string {
  return (process.env['RNESS_GITHUB_WEB'] ?? GITHUB_WEB).replace(/\/+$/, '')
}

export interface DeviceCode {
  deviceCode: string
  userCode: string
  verificationUri: string
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

/** GitHub said no: the message is one line for the user. */
export class LoginError extends Error {}
/** GitHub refused the refresh token: the login is over. Not a network error. */
export class RefreshRejected extends Error {}

function reason(e: unknown): string {
  if (e instanceof Error) {
    return e.name === 'TimeoutError' ? 'timed out' : e.message
  }
  return String(e)
}

async function post(
  path: string,
  params: Record<string, string>
): Promise<Record<string, unknown>> {
  let res: Response
  try {
    res = await fetch(`${webBase()}${path}`, {
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
    throw new Error(`cannot reach github.com: ${reason(e)}`, { cause: e })
  }
  let body: unknown
  try {
    body = await res.json()
  } catch (e) {
    throw new Error(`github.com answered ${res.status} for ${path}`, {
      cause: e,
    })
  }
  if (body === null || typeof body !== 'object')
    throw new Error(`github.com answered an unexpected body for ${path}`)
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

export async function requestDeviceCode(): Promise<DeviceCode> {
  const id = clientId()
  if (id === '')
    throw new LoginError(
      'rness has no GitHub client ID yet; set RNESS_GITHUB_CLIENT_ID'
    )
  const body = await post('/login/device/code', {
    client_id: id,
    scope: SCOPES,
  })
  const deviceCode = str(body['device_code'])
  const userCode = str(body['user_code'])
  const verificationUri = str(body['verification_uri'])
  if (deviceCode === null || userCode === null || verificationUri === null) {
    const error = str(body['error'])
    throw new LoginError(
      error === 'device_flow_disabled'
        ? 'the device flow is not enabled on the rness GitHub app'
        : `github.com refused to start the login${error === null ? '' : ` (${error})`}`
    )
  }
  return {
    deviceCode,
    userCode,
    verificationUri,
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
  deps: PollDeps = {}
): Promise<TokenSet> {
  const sleep =
    deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)))
  const now = deps.now ?? Date.now
  const deadline = now() + code.expiresIn * 1000
  let interval = code.interval
  for (;;) {
    await sleep(interval * 1000)
    const body = await post('/login/oauth/access_token', {
      client_id: clientId(),
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
    if (error === 'expired_token')
      throw new LoginError('the code expired before it was approved')
    if (error === 'access_denied')
      throw new LoginError('the login was cancelled on github.com')
    throw new LoginError(`github.com refused the login (${error ?? 'unknown'})`)
  }
}

/** A new token set for a refresh token. `RefreshRejected` when GitHub says the login is over. */
export async function refreshTokenSet(
  refreshToken: string,
  now: () => number = Date.now
): Promise<TokenSet> {
  const body = await post('/login/oauth/access_token', {
    client_id: clientId(),
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
  })
  const tokens = tokenSet(body, now())
  if (tokens !== null) return tokens
  throw new RefreshRejected(str(body['error']) ?? 'refused')
}
