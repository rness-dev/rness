import { TokenRefused } from './bitbucket.ts'
import { MAX_PAGES, type RateWait, waitOut } from './github.ts'

// The Jira Cloud REST API (spec 0039 §1): v3, a classic API token in
// Basic `email:token`, on the site itself (`https://<site>.atlassian.net`).
// A 429 waited out by its `Retry-After` under the process's budget. The
// login needs who the token belongs to, the wizard the spaces; issues and
// boards come with plan 0053 tasks 5 and 6.

/** `https://<site>`, or what `RNESS_JIRA_WEB` points every site at in tests. */
export function jiraBase(site: string): string {
  return (process.env['RNESS_JIRA_WEB'] ?? `https://${site}`).replace(
    /\/+$/,
    ''
  )
}

/** A Jira site: `<name>.atlassian.net`. */
export const JIRA_SITE = /^[a-z0-9][a-z0-9-]*\.atlassian\.net$/

/** A Jira space key: `RNESS` (spec 0039 §2). */
export const JIRA_SPACE = /^[A-Z][A-Z0-9]{1,9}$/

/** The template of a space rness makes: team-managed Kanban (plan 0053 task 1). */
const KANBAN_TEMPLATE =
  'com.pyxis.greenhopper.jira:gh-simplified-agility-kanban'

export interface JiraApiOptions {
  site: string
  email: string
  token: string
  timeoutMs?: number
  /** Rate-limit waits; default: this process's. */
  wait?: RateWait | undefined
}

/** A space as the wizard offers it. */
export interface JiraSpace {
  key: string
  name: string
}

const DEFAULT_WAIT_MS = 60_000

const field = (body: unknown, key: string): unknown =>
  body !== null && typeof body === 'object'
    ? (body as Record<string, unknown>)[key]
    : undefined

const str = (v: unknown): string | null => (typeof v === 'string' ? v : null)

function reason(e: unknown): string {
  if (e instanceof Error && e.cause instanceof Error) return e.cause.message
  if (e instanceof Error)
    return e.name === 'TimeoutError' ? 'timed out' : e.message
  return String(e)
}

interface Answer {
  status: number
  body: unknown
}

async function request(
  method: 'GET' | 'POST',
  path: string,
  o: JiraApiOptions,
  payload?: unknown
): Promise<Answer> {
  const headers: Record<string, string> = {
    Accept: 'application/json',
    'User-Agent': 'rness-cli',
    Authorization: `Basic ${Buffer.from(`${o.email}:${o.token}`).toString('base64')}`,
  }
  if (payload !== undefined) headers['Content-Type'] = 'application/json'
  for (;;) {
    let res: Response
    try {
      res = await fetch(`${jiraBase(o.site)}${path}`, {
        method,
        headers,
        ...(payload === undefined ? {} : { body: JSON.stringify(payload) }),
        signal: AbortSignal.timeout(o.timeoutMs ?? 15_000),
      })
    } catch (e) {
      throw new Error(`cannot reach ${o.site}: ${reason(e)}`, { cause: e })
    }
    const body: unknown = await res.json().catch(() => undefined)
    // A refused request was not made: asking again is safe.
    if (res.status === 429) {
      const after = (res.headers.get('retry-after') ?? '').trim()
      await waitOut(
        o,
        /^\d+$/.test(after) ? Number(after) * 1000 : DEFAULT_WAIT_MS,
        'Jira'
      )
      continue
    }
    if (res.status === 401)
      throw new TokenRefused(`${o.site} refused this email and token (401)`)
    return { status: res.status, body }
  }
}

/** Jira's own words for an error: `errorMessages`, then each field's. */
function said(body: unknown): string {
  const messages = field(body, 'errorMessages')
  const errors = field(body, 'errors')
  return [
    ...(Array.isArray(messages)
      ? messages.filter((m): m is string => typeof m === 'string')
      : []),
    ...(errors !== null && typeof errors === 'object'
      ? Object.values(errors).filter((m): m is string => typeof m === 'string')
      : []),
  ].join(' ')
}

function failure(o: JiraApiOptions, answer: Answer, path: string): Error {
  const why = said(answer.body)
  return new Error(
    `${o.site} answered ${answer.status} for ${path}${why === '' ? '' : `: ${why}`}`,
    { cause: { status: answer.status, path } }
  )
}

/** Who the token belongs to on the site: the display name and the account id. */
export async function myself(
  o: JiraApiOptions
): Promise<{ login: string; accountId: string | null }> {
  const path = '/rest/api/3/myself'
  const answer = await request('GET', path, o)
  const name = str(field(answer.body, 'displayName'))
  if (answer.status !== 200 || name === null)
    throw new Error(`${o.site} answered ${answer.status} for ${path}`)
  return { login: name, accountId: str(field(answer.body, 'accountId')) }
}

/**
 * The spaces the user can edit on the site (`action=edit`), sorted by key:
 * where rness may put its cards (spec 0039 §4). Paged by `startAt` until
 * `isLast`, up to `MAX_PAGES`.
 */
export async function listSpaces(o: JiraApiOptions): Promise<JiraSpace[]> {
  const path = '/rest/api/3/project/search'
  const spaces: JiraSpace[] = []
  let startAt = 0
  for (let n = 1; n <= MAX_PAGES; n++) {
    const q = new URLSearchParams({
      action: 'edit',
      maxResults: '100',
      startAt: String(startAt),
    })
    const answer = await request('GET', `${path}?${q}`, o)
    if (answer.status !== 200) throw failure(o, answer, path)
    const values = field(answer.body, 'values')
    const page = Array.isArray(values) ? values : []
    for (const v of page) {
      const key = str(field(v, 'key'))
      if (key !== null) spaces.push({ key, name: str(field(v, 'name')) ?? key })
    }
    if (field(answer.body, 'isLast') !== false || page.length === 0) break
    startAt += page.length
  }
  return spaces.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
}

/**
 * Whether no space of the site holds `key`, those the user cannot see
 * included: `projectvalidate/key` names an error on `projectKey` for a
 * taken one, in the site's language.
 */
export async function keyFree(
  key: string,
  o: JiraApiOptions
): Promise<boolean> {
  const path = `/rest/api/3/projectvalidate/key?key=${encodeURIComponent(key)}`
  const answer = await request('GET', path, o)
  if (answer.status !== 200)
    throw failure(o, answer, '/rest/api/3/projectvalidate/key')
  return str(field(field(answer.body, 'errors'), 'projectKey')) === null
}

/**
 * A team-managed Kanban space `key`, named `rness`, led by `leadAccountId`
 * (spec 0039 §4; the template as task 1 ran it, 201). A 400 on the key is
 * a taken one: the shape was checked before.
 */
export async function createSpace(
  key: string,
  leadAccountId: string,
  o: JiraApiOptions
): Promise<
  { kind: 'created' } | { kind: 'exists' } | { kind: 'refused'; reason: string }
> {
  const path = '/rest/api/3/project'
  const answer = await request('POST', path, o, {
    key,
    name: 'rness',
    leadAccountId,
    projectTypeKey: 'software',
    projectTemplateKey: KANBAN_TEMPLATE,
  })
  if (answer.status === 201 || answer.status === 200) return { kind: 'created' }
  if (
    answer.status === 400 &&
    str(field(field(answer.body, 'errors'), 'projectKey')) !== null
  )
    return { kind: 'exists' }
  const why = said(answer.body)
  return {
    kind: 'refused',
    reason:
      why === ''
        ? `Jira answered ${answer.status}`
        : `${why} (${answer.status})`,
  }
}
