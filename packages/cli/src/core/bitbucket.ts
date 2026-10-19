// The Bitbucket Cloud REST API (spec 0039 §1): 2.0, the API token in
// `Authorization: Bearer` (since 2026-08-18), on api.bitbucket.org only
// (since 2026-05-04). The login needs who the token belongs to; the
// provider's reads come with plan 0053 task 3.

/** `https://api.bitbucket.org`, or what `RNESS_BITBUCKET_API` points it at in tests. */
export function defaultBitbucketApi(): string {
  return (
    process.env['RNESS_BITBUCKET_API'] ?? 'https://api.bitbucket.org'
  ).replace(/\/+$/, '')
}

export interface BitbucketApiOptions {
  token: string
  apiBase?: string | undefined
  timeoutMs?: number
}

/** Bitbucket refused the token (401): a login asks it again; elsewhere it is over. */
export class TokenRefused extends Error {}

function reason(e: unknown): string {
  if (e instanceof Error && e.cause instanceof Error) return e.cause.message
  if (e instanceof Error)
    return e.name === 'TimeoutError' ? 'timed out' : e.message
  return String(e)
}

const field = (body: unknown, key: string): unknown =>
  body !== null && typeof body === 'object'
    ? (body as Record<string, unknown>)[key]
    : undefined

async function getJson(path: string, o: BitbucketApiOptions): Promise<unknown> {
  const base = (o.apiBase ?? defaultBitbucketApi()).replace(/\/+$/, '')
  let res: Response
  try {
    res = await fetch(`${base}/2.0${path}`, {
      headers: {
        Accept: 'application/json',
        'User-Agent': 'rness-cli',
        Authorization: `Bearer ${o.token}`,
      },
      signal: AbortSignal.timeout(o.timeoutMs ?? 15_000),
    })
  } catch (e) {
    throw new Error(`cannot reach the Bitbucket API: ${reason(e)}`, {
      cause: e,
    })
  }
  const body: unknown = await res.json().catch(() => undefined)
  if (res.status === 401)
    throw new TokenRefused('Bitbucket refused this token (401)')
  if (res.status !== 200)
    throw new Error(`Bitbucket API answered ${res.status} for ${path}`)
  return body
}

/** Who a token belongs to: the Bitbucket `username` as `login` (else the display name), and the Atlassian account id. */
export async function getUser(
  o: BitbucketApiOptions
): Promise<{ login: string; accountId: string | null }> {
  const body = await getJson('/user', o)
  const username = field(body, 'username')
  const shown = field(body, 'display_name')
  const login =
    typeof username === 'string'
      ? username
      : typeof shown === 'string'
        ? shown
        : null
  if (login === null)
    throw new Error('Bitbucket API answered an unexpected body for /user')
  const accountId = field(body, 'account_id')
  return {
    login,
    accountId: typeof accountId === 'string' ? accountId : null,
  }
}

/** The account's primary email, the one Jira's Basic login takes; null when Bitbucket names none. */
export async function primaryEmail(
  o: BitbucketApiOptions
): Promise<string | null> {
  const values = field(await getJson('/user/emails', o), 'values')
  if (!Array.isArray(values)) return null
  const primary = values.find((v: unknown) => field(v, 'is_primary') === true)
  const email = field(primary, 'email')
  return typeof email === 'string' ? email : null
}
