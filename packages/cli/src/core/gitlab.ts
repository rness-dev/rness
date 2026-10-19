import {
  type CreateRepositoryResult,
  MAX_PAGES,
  PER_PAGE,
  type RateWait,
  rateDelay,
  waitOut,
} from './github.ts'
import { HOSTS, webBase } from './hosts.ts'

// The GitLab REST API (spec 0037 §1): v4, the token in `Authorization:
// Bearer`, an OAuth token and a personal access token alike (plan 0049
// task 1). Paged by `x-next-page`; a `429` waited out by its `Retry-After`
// under the process's budget, as GitHub's rate limits are.

/** `https://gitlab.com/api/v4`, on the origin `RNESS_GITLAB_WEB` points at. */
export function defaultGitlabApi(): string {
  return `${webBase(HOSTS.gitlab)}/api/v4`
}

export interface GitlabApiOptions {
  /** Sent as `Authorization: Bearer`; absent or empty: anonymous, public projects only. */
  token?: string | undefined
  apiBase?: string | undefined
  timeoutMs?: number
  /** Rate-limit waits; default: this process's. */
  wait?: RateWait | undefined
}

/** A project as rness reads it off a listing. */
export interface GitlabProject {
  /** The last segment of the URL: what the directory and the key are made of. */
  path: string
  /** From the host's root: `acme/platform/mobile`. */
  fullPath: string
  visibility: string
  archived: boolean
  /** Deleted, kept by GitLab for days under a new path (plan 0049 task 1). */
  scheduledForDeletion: boolean
}

export interface GitlabProjects {
  projects: GitlabProject[]
  /** `MAX_PAGES` stopped the listing while GitLab still announced a next page. */
  truncated: boolean
}

const apiBase = (options: GitlabApiOptions): string =>
  (options.apiBase ?? defaultGitlabApi()).replace(/\/+$/, '')

/** The origin of the OAuth endpoints: the API base without `/api/v4`. */
const webOf = (options: GitlabApiOptions): string =>
  apiBase(options).replace(/\/api\/v4$/, '')

function reason(e: unknown): string {
  // undici reports every network failure as `TypeError: fetch failed`; the
  // useful part (ECONNREFUSED, ENOTFOUND, …) is its cause.
  if (e instanceof Error && e.cause instanceof Error) return e.cause.message
  if (e instanceof Error)
    return e.name === 'TimeoutError' ? 'timed out' : e.message
  return String(e)
}

export interface Answer {
  status: number
  headers: Headers
  body: unknown
}

async function request(
  method: 'GET' | 'POST' | 'PUT' | 'DELETE',
  url: string,
  options: GitlabApiOptions,
  payload?: unknown
): Promise<Answer> {
  const headers: Record<string, string> = {
    Accept: 'application/json',
    'User-Agent': 'rness-cli',
  }
  if (options.token !== undefined && options.token !== '')
    headers['Authorization'] = `Bearer ${options.token}`
  if (payload !== undefined) headers['Content-Type'] = 'application/json'
  for (;;) {
    let res: Response
    try {
      res = await fetch(url, {
        method,
        headers,
        ...(payload === undefined ? {} : { body: JSON.stringify(payload) }),
        signal: AbortSignal.timeout(options.timeoutMs ?? 15_000),
      })
    } catch (e) {
      throw new Error(`cannot reach the GitLab API: ${reason(e)}`, { cause: e })
    }
    const body: unknown = await res.json().catch(() => undefined)
    const answer = { status: res.status, headers: res.headers, body }
    // gitlab.com answers a rate limit with 429 and `Retry-After` (spec 0037
    // §1). A refused write was not made: asking again is safe.
    if (res.status === 429) {
      await waitOut(options, rateDelay(answer, Date.now()) ?? 60_000, 'GitLab')
      continue
    }
    return answer
  }
}

export function failure(answer: Answer, path: string): Error {
  const cause = { status: answer.status, path }
  if (answer.status === 401)
    return new Error('GitLab rejected the token (401)', { cause })
  // GitLab says why in `message`, a string or a field's list.
  const message = field(answer.body, 'message')
  const why =
    typeof message === 'string'
      ? message
      : message === undefined
        ? ''
        : JSON.stringify(message)
  return new Error(
    `GitLab API answered ${answer.status} for ${path}${why === '' ? '' : `: ${why}`}`,
    { cause }
  )
}

export const field = (body: unknown, key: string): unknown =>
  body !== null && typeof body === 'object'
    ? (body as Record<string, unknown>)[key]
    : undefined

/**
 * Every item of a listing, page by page while `x-next-page` names one, up to
 * `MAX_PAGES`. Null when the first page is a 404: no such group or user, or
 * not visible to the token.
 */
export async function pages(
  path: string,
  query: Record<string, string>,
  options: GitlabApiOptions
): Promise<{ items: unknown[]; truncated: boolean } | null> {
  const items: unknown[] = []
  for (let n = 1; n <= MAX_PAGES; n++) {
    const q = new URLSearchParams({
      ...query,
      per_page: String(PER_PAGE),
      page: String(n),
    })
    const answer = await request(
      'GET',
      `${apiBase(options)}${path}?${q}`,
      options
    )
    if (n === 1 && answer.status === 404) return null
    if (answer.status !== 200) throw failure(answer, path)
    if (!Array.isArray(answer.body))
      throw new Error(`GitLab API answered an unexpected body for ${path}`, {
        cause: answer.body,
      })
    items.push(...(answer.body as unknown[]))
    if ((answer.headers.get('x-next-page') ?? '').trim() === '')
      return { items, truncated: false }
  }
  return { items, truncated: true }
}

function toProject(value: unknown): GitlabProject | null {
  const path = field(value, 'path')
  const fullPath = field(value, 'path_with_namespace')
  if (typeof path !== 'string' || typeof fullPath !== 'string') return null
  const visibility = field(value, 'visibility')
  const deletion = field(value, 'marked_for_deletion_on')
  return {
    path,
    fullPath,
    visibility: typeof visibility === 'string' ? visibility : 'private',
    archived: field(value, 'archived') === true,
    scheduledForDeletion: typeof deletion === 'string' && deletion !== '',
  }
}

const projectsOf = (
  listed: { items: unknown[]; truncated: boolean } | null
): GitlabProjects | null =>
  listed === null
    ? null
    : {
        projects: listed.items
          .map(toProject)
          .filter((p): p is GitlabProject => p !== null),
        truncated: listed.truncated,
      }

/** A group's or a project's path as one segment of an API path: `acme%2Frness`. */
export const segment = (path: string): string => encodeURIComponent(path)

/**
 * One call to the API: `path` under `/api/v4`, a JSON `payload` for a write.
 * The answer as it came; a 429 is waited out first.
 */
export function gitlabCall(
  method: 'GET' | 'POST' | 'PUT' | 'DELETE',
  path: string,
  options: GitlabApiOptions,
  payload?: unknown
): Promise<Answer> {
  return request(method, `${apiBase(options)}${path}`, options, payload)
}

/** The user a token belongs to: `username` as `login`, and the numeric id the membership call takes. */
export async function getUser(
  options: GitlabApiOptions
): Promise<{ login: string; id: number | null }> {
  const answer = await request('GET', `${apiBase(options)}/user`, options)
  const username = field(answer.body, 'username')
  if (answer.status === 401) throw failure(answer, '/user')
  if (answer.status !== 200 || typeof username !== 'string')
    throw failure(answer, '/user')
  const id = field(answer.body, 'id')
  return { login: username, id: typeof id === 'number' ? id : null }
}

/** The top-level groups the user belongs to, Guest and above (spec 0037 §4). */
export async function listTopLevelGroups(
  options: GitlabApiOptions
): Promise<{ path: string; name: string }[]> {
  const listed = await pages(
    '/groups',
    { min_access_level: '10', top_level_only: 'true' },
    options
  )
  if (listed === null)
    throw failure(
      { status: 404, headers: new Headers(), body: undefined },
      '/groups'
    )
  const groups: { path: string; name: string }[] = []
  for (const g of listed.items) {
    const path = field(g, 'path')
    const name = field(g, 'full_name') ?? field(g, 'name')
    if (typeof path === 'string')
      groups.push({ path, name: typeof name === 'string' ? name : path })
  }
  return groups
}

/**
 * The projects of a group and of its subgroups, its own only (no project
 * shared with it), archived ones left out by GitLab, sorted by path (spec
 * 0037 §5.1). Null: no such group, or not visible.
 */
export async function listGroupProjects(
  group: string,
  options: GitlabApiOptions
): Promise<GitlabProjects | null> {
  return projectsOf(
    await pages(
      `/groups/${segment(group)}/projects`,
      {
        include_subgroups: 'true',
        with_shared: 'false',
        archived: 'false',
        order_by: 'path',
        sort: 'asc',
      },
      options
    )
  )
}

/** The projects a user owns in their own namespace. Null: no such user. */
export async function listUserProjects(
  username: string,
  options: GitlabApiOptions
): Promise<GitlabProjects | null> {
  return projectsOf(
    await pages(
      `/users/${segment(username)}/projects`,
      { owned: 'true', archived: 'false', order_by: 'path', sort: 'asc' },
      options
    )
  )
}

/**
 * The user's standing in a group, inherited memberships included: the
 * access level of a member (50 Owner … 10 Guest), `not-member` on a 404
 * (plan 0049 task 1), `unknown` for any other answer.
 */
export async function groupMembership(
  group: string,
  userId: number,
  options: GitlabApiOptions
): Promise<{ accessLevel: number } | 'not-member' | 'unknown'> {
  const answer = await request(
    'GET',
    `${apiBase(options)}/groups/${segment(group)}/members/all/${userId}`,
    options
  )
  if (answer.status === 404) return 'not-member'
  const level = field(answer.body, 'access_level')
  if (answer.status === 200 && typeof level === 'number')
    return { accessLevel: level }
  return 'unknown'
}

/** A group's numeric id, which `POST /projects` takes as `namespace_id`; null when GitLab knows no such group. */
export async function groupId(
  group: string,
  options: GitlabApiOptions
): Promise<number | null> {
  const path = `/groups/${segment(group)}`
  const answer = await request('GET', `${apiBase(options)}${path}`, options)
  if (answer.status === 404) return null
  const id = field(answer.body, 'id')
  if (answer.status !== 200 || typeof id !== 'number')
    throw failure(answer, path)
  return id
}

/**
 * The private project `name`, its name and path the same word, in the group
 * `namespaceId`, or in the user's own namespace when null (spec 0037 §5.4).
 */
export async function createProject(
  name: string,
  namespaceId: number | null,
  options: GitlabApiOptions
): Promise<CreateRepositoryResult> {
  const answer = await request(
    'POST',
    `${apiBase(options)}/projects`,
    options,
    {
      name,
      path: name,
      ...(namespaceId === null ? {} : { namespace_id: namespaceId }),
      visibility: 'private',
    }
  )
  if (answer.status === 201) return { kind: 'created' }
  const message = field(answer.body, 'message')
  const said =
    typeof message === 'string'
      ? message
      : message === undefined
        ? ''
        : JSON.stringify(message)
  if (answer.status === 400 && said.includes('has already been taken'))
    return { kind: 'exists' }
  return {
    kind: 'refused',
    reason:
      said === ''
        ? `GitLab answered ${answer.status}`
        : `${said} (${answer.status})`,
  }
}

const words = (value: unknown): string[] | null =>
  Array.isArray(value)
    ? value.filter((s): s is string => typeof s === 'string')
    : typeof value === 'string'
      ? value.split(/\s+/).filter((s) => s !== '')
      : null

/**
 * The scopes a token holds: an OAuth token's (`/oauth/token/info`), else a
 * personal access token's (`/personal_access_tokens/self`), else null.
 * Rejects when GitLab cannot be asked or refuses the token: that is not a
 * missing scope.
 */
export async function tokenScopes(
  options: GitlabApiOptions
): Promise<string[] | null> {
  const info = await request(
    'GET',
    `${webOf(options)}/oauth/token/info`,
    options
  )
  if (info.status === 200) return words(field(info.body, 'scope'))
  const path = '/personal_access_tokens/self'
  const self = await request('GET', `${apiBase(options)}${path}`, options)
  if (self.status === 200) return words(field(self.body, 'scopes'))
  if (self.status === 401) throw failure(self, path)
  return null
}
