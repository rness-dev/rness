import {
  type CreateRepositoryResult,
  MAX_PAGES,
  type RateWait,
  waitOut,
} from './github.ts'

// The Bitbucket Cloud REST API (spec 0039 §1): 2.0, the API token in
// `Authorization: Bearer` (since 2026-08-18), on api.bitbucket.org only
// (since 2026-05-04). Paged by `next`, an absolute URL; a 429 waited out by
// its `Retry-After` under the process's budget, as GitHub's and GitLab's
// rate limits are. What plan 0053 task 1 saw the real API answer is what the
// tests' fake answers.

/** `https://api.bitbucket.org`, or what `RNESS_BITBUCKET_API` points it at in tests. */
export function defaultBitbucketApi(): string {
  return (
    process.env['RNESS_BITBUCKET_API'] ?? 'https://api.bitbucket.org'
  ).replace(/\/+$/, '')
}

export interface BitbucketApiOptions {
  /** Sent as `Authorization: Bearer`; absent or empty: anonymous, public repositories only. */
  token?: string | undefined
  apiBase?: string | undefined
  timeoutMs?: number
  /** Rate-limit waits; default: this process's. */
  wait?: RateWait | undefined
}

/** Bitbucket refused the token (401): a login asks it again; elsewhere it is over. */
export class TokenRefused extends Error {}

/** Bitbucket's advice is none: a rate limit without `Retry-After` waits a minute. */
const DEFAULT_WAIT_MS = 60_000

function reason(e: unknown): string {
  // undici reports every network failure as `TypeError: fetch failed`; the
  // useful part (ECONNREFUSED, ENOTFOUND, …) is its cause.
  if (e instanceof Error && e.cause instanceof Error) return e.cause.message
  if (e instanceof Error)
    return e.name === 'TimeoutError' ? 'timed out' : e.message
  return String(e)
}

const field = (body: unknown, key: string): unknown =>
  body !== null && typeof body === 'object'
    ? (body as Record<string, unknown>)[key]
    : undefined

const str = (v: unknown): string | null => (typeof v === 'string' ? v : null)

/** The API's root, `…/2.0`, without a trailing slash. */
const rootOf = (o: BitbucketApiOptions): string =>
  `${(o.apiBase ?? defaultBitbucketApi()).replace(/\/+$/, '')}/2.0`

/** A path segment: a workspace or a repository slug. */
const segment = (name: string): string => encodeURIComponent(name)

interface Answer {
  status: number
  headers: Headers
  body: unknown
}

async function request(
  method: 'GET' | 'POST',
  url: string,
  o: BitbucketApiOptions,
  payload?: unknown
): Promise<Answer> {
  const headers: Record<string, string> = {
    Accept: 'application/json',
    'User-Agent': 'rness-cli',
  }
  if (o.token !== undefined && o.token !== '')
    headers['Authorization'] = `Bearer ${o.token}`
  if (payload !== undefined) headers['Content-Type'] = 'application/json'
  for (;;) {
    let res: Response
    try {
      res = await fetch(url, {
        method,
        headers,
        ...(payload === undefined ? {} : { body: JSON.stringify(payload) }),
        signal: AbortSignal.timeout(o.timeoutMs ?? 15_000),
      })
    } catch (e) {
      throw new Error(`cannot reach the Bitbucket API: ${reason(e)}`, {
        cause: e,
      })
    }
    const body: unknown = await res.json().catch(() => undefined)
    // A refused request was not made: asking again is safe.
    if (res.status === 429) {
      const after = (res.headers.get('retry-after') ?? '').trim()
      await waitOut(
        o,
        /^\d+$/.test(after) ? Number(after) * 1000 : DEFAULT_WAIT_MS,
        'Bitbucket'
      )
      continue
    }
    return { status: res.status, headers: res.headers, body }
  }
}

/** Bitbucket's own words for an error: `error.message`, with the scopes a 403 says are missing. */
function said(body: unknown): string {
  const error = field(body, 'error')
  const message = str(field(error, 'message')) ?? ''
  const required = field(field(error, 'detail'), 'required')
  const missing = Array.isArray(required)
    ? required.filter((s): s is string => typeof s === 'string')
    : []
  return missing.length === 0
    ? message
    : `${message} (missing ${missing.join(' ')})`
}

/** One line for an answer rness cannot use; `TokenRefused` for a 401. */
function failure(answer: Answer, path: string): Error {
  if (answer.status === 401)
    return new TokenRefused('Bitbucket refused this token (401)')
  const why = said(answer.body)
  return new Error(
    `Bitbucket API answered ${answer.status} for ${path}${why === '' ? '' : `: ${why}`}`,
    { cause: { status: answer.status, path } }
  )
}

/** A GET of `path` that must answer 200: its body. */
async function getJson(path: string, o: BitbucketApiOptions): Promise<unknown> {
  const answer = await request('GET', `${rootOf(o)}${path}`, o)
  if (answer.status !== 200) throw failure(answer, path)
  return answer.body
}

/**
 * Every value of a listing, page by page while `next` names one on the API
 * itself (it carries the token: another host is never asked), up to
 * `MAX_PAGES`. Null when the first page is a 404: no such workspace, or
 * not visible to the token.
 */
async function pages(
  path: string,
  o: BitbucketApiOptions
): Promise<{ values: unknown[]; truncated: boolean } | null> {
  const root = rootOf(o)
  const values: unknown[] = []
  let url: string | null = `${root}${path}?pagelen=100`
  for (let n = 1; n <= MAX_PAGES && url !== null; n++) {
    const answer = await request('GET', url, o)
    if (n === 1 && answer.status === 404) return null
    if (answer.status !== 200) throw failure(answer, path)
    const listed = field(answer.body, 'values')
    if (!Array.isArray(listed))
      throw new Error(`Bitbucket API answered an unexpected body for ${path}`)
    values.push(...(listed as unknown[]))
    const next = str(field(answer.body, 'next'))
    if (next === null) return { values, truncated: false }
    url = next.startsWith(`${root}/`) ? next : null
  }
  return { values, truncated: true }
}

/** Who a token belongs to: the Bitbucket `username` as `login` (else the display name), and the Atlassian account id. */
export async function getUser(
  o: BitbucketApiOptions
): Promise<{ login: string; accountId: string | null }> {
  const body = await getJson('/user', o)
  const login =
    str(field(body, 'username')) ?? str(field(body, 'display_name')) ?? null
  if (login === null)
    throw new Error('Bitbucket API answered an unexpected body for /user')
  return { login, accountId: str(field(body, 'account_id')) }
}

/** The account's primary email, the one Jira's Basic login takes; null when Bitbucket names none. */
export async function primaryEmail(
  o: BitbucketApiOptions
): Promise<string | null> {
  const values = field(await getJson('/user/emails', o), 'values')
  if (!Array.isArray(values)) return null
  const primary = values.find((v: unknown) => field(v, 'is_primary') === true)
  return str(field(primary, 'email'))
}

/**
 * The workspaces of the token's user, by slug, each with its name: the
 * listing gives none, so `GET /workspaces/<slug>` is asked for each (spec
 * 0039 §4); a name it will not give is null.
 */
export async function listWorkspaces(
  o: BitbucketApiOptions
): Promise<{ slug: string; name: string | null }[]> {
  const listed = await pages('/user/workspaces', o)
  const slugs = (listed?.values ?? [])
    .map((v) => str(field(field(v, 'workspace'), 'slug')))
    .filter((s): s is string => s !== null)
    .sort()
  return Promise.all(
    slugs.map(async (slug) => {
      const answer = await request(
        'GET',
        `${rootOf(o)}/workspaces/${segment(slug)}`,
        o
      )
      if (answer.status === 401) throw failure(answer, `/workspaces/${slug}`)
      const name =
        answer.status === 200 ? str(field(answer.body, 'name')) : null
      return { slug, name }
    })
  )
}

/** The user's permission in a workspace, in Bitbucket's word (`owner`, `collaborator`, `member`); null when not a member. */
export async function workspacePermission(
  slug: string,
  o: BitbucketApiOptions
): Promise<string | null> {
  const path = `/user/workspaces/${segment(slug)}/permission`
  const answer = await request('GET', `${rootOf(o)}${path}`, o)
  // Plan 0053 task 1: a workspace the user is not in answers 403.
  if (answer.status === 403 || answer.status === 404) return null
  if (answer.status !== 200) throw failure(answer, path)
  return str(field(answer.body, 'permission'))
}

/** A repository as rness reads it off a listing. */
export interface BitbucketRepository {
  /** Lowercase by Bitbucket's rule: the key, the directory and the URL. */
  slug: string
  private: boolean
  /** The name of the project that groups it in the workspace. */
  project: string | null
}

/**
 * The repositories of a workspace, sorted by slug (spec 0039 §5.1); null
 * when there is no such workspace, or it is not visible. Anonymous: the
 * public ones. The clone links are not read: they carry the old SSH host.
 */
export async function listRepositories(
  workspace: string,
  o: BitbucketApiOptions
): Promise<{
  repositories: BitbucketRepository[]
  truncated: boolean
} | null> {
  const listed = await pages(`/repositories/${segment(workspace)}`, o)
  if (listed === null) return null
  const repositories = listed.values
    .map((v): BitbucketRepository | null => {
      const slug = str(field(v, 'slug'))
      if (slug === null) return null
      return {
        slug,
        private: field(v, 'is_private') !== false,
        project: str(field(field(v, 'project'), 'name')),
      }
    })
    .filter((r): r is BitbucketRepository => r !== null)
    .sort((a, b) => (a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0))
  return { repositories, truncated: listed.truncated }
}

/**
 * The private repository `workspace/slug`, with no project: Bitbucket puts
 * it in the workspace's oldest one (spec 0039 §5.4). Task 1 saw a 200.
 */
export async function createRepository(
  workspace: string,
  slug: string,
  o: BitbucketApiOptions
): Promise<CreateRepositoryResult> {
  const path = `/repositories/${segment(workspace)}/${segment(slug)}`
  const answer = await request('POST', `${rootOf(o)}${path}`, o, {
    scm: 'git',
    is_private: true,
  })
  if (answer.status === 200 || answer.status === 201) return { kind: 'created' }
  if (answer.status === 401) throw failure(answer, path)
  const why = said(answer.body)
  if (answer.status === 400 && /already exists/i.test(why))
    return { kind: 'exists' }
  return {
    kind: 'refused',
    reason:
      why === ''
        ? `Bitbucket answered ${answer.status}`
        : `${why} (${answer.status})`,
  }
}

/**
 * The latest pull request whose source is `branch`, whatever its state:
 * its id and Bitbucket's state (`OPEN`, `MERGED`, …); null when there is
 * none. Bitbucket lists the open ones only unless asked for each state.
 */
export async function pullRequestFor(
  workspace: string,
  repo: string,
  branch: string,
  o: BitbucketApiOptions
): Promise<{ number: number; state: string } | null> {
  const path = `/repositories/${segment(workspace)}/${segment(repo)}/pullrequests`
  const q = new URLSearchParams({
    q: `source.branch.name="${branch.replaceAll('"', '\\"')}"`,
    pagelen: '50',
  })
  for (const state of ['OPEN', 'MERGED', 'DECLINED', 'SUPERSEDED'])
    q.append('state', state)
  const answer = await request('GET', `${rootOf(o)}${path}?${q}`, o)
  if (answer.status !== 200) throw failure(answer, path)
  const values = field(answer.body, 'values')
  let latest: { number: number; state: string } | null = null
  for (const v of Array.isArray(values) ? values : []) {
    const id = field(v, 'id')
    const state = str(field(v, 'state'))
    if (typeof id !== 'number' || state === null) continue
    if (latest === null || id > latest.number) latest = { number: id, state }
  }
  return latest
}
