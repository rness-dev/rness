import { TokenRefused } from './bitbucket.ts'

// The Jira Cloud REST API (spec 0039 §1): v3, a classic API token in
// Basic `email:token`, on the site itself (`https://<site>.atlassian.net`).
// The login needs who the token belongs to; issues and boards come with
// plan 0053 tasks 5 and 6.

/** `https://<site>`, or what `RNESS_JIRA_WEB` points every site at in tests. */
export function jiraBase(site: string): string {
  return (process.env['RNESS_JIRA_WEB'] ?? `https://${site}`).replace(
    /\/+$/,
    ''
  )
}

/** A Jira site: `<name>.atlassian.net`. */
export const JIRA_SITE = /^[a-z0-9][a-z0-9-]*\.atlassian\.net$/

export interface JiraApiOptions {
  site: string
  email: string
  token: string
  timeoutMs?: number
}

const field = (body: unknown, key: string): unknown =>
  body !== null && typeof body === 'object'
    ? (body as Record<string, unknown>)[key]
    : undefined

/** Who the token belongs to on the site: the display name and the account id. */
export async function myself(
  o: JiraApiOptions
): Promise<{ login: string; accountId: string | null }> {
  let res: Response
  try {
    res = await fetch(`${jiraBase(o.site)}/rest/api/3/myself`, {
      headers: {
        Accept: 'application/json',
        'User-Agent': 'rness-cli',
        Authorization: `Basic ${Buffer.from(`${o.email}:${o.token}`).toString('base64')}`,
      },
      signal: AbortSignal.timeout(o.timeoutMs ?? 15_000),
    })
  } catch (e) {
    throw new Error(
      `cannot reach ${o.site}: ${e instanceof Error ? e.message : String(e)}`,
      { cause: e }
    )
  }
  const body: unknown = await res.json().catch(() => undefined)
  if (res.status === 401)
    throw new TokenRefused(`${o.site} refused this email and token (401)`)
  const name = field(body, 'displayName')
  if (res.status !== 200 || typeof name !== 'string')
    throw new Error(`${o.site} answered ${res.status} for /rest/api/3/myself`)
  const accountId = field(body, 'accountId')
  return {
    login: name,
    accountId: typeof accountId === 'string' ? accountId : null,
  }
}
