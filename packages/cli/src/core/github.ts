/** The public GitHub REST API; `--github-api` overrides it in tests. */
export const DEFAULT_GITHUB_API = 'https://api.github.com'

/** Guards against a server that always answers `rel="next"`. */
export const MAX_PAGES = 50
export const PER_PAGE = 100

const ADD_LATER = '; add repositories later with rness add <repo>'

export interface OrgRepository {
  name: string
  private: boolean
  archived: boolean
}

export interface RepositoryListing {
  repositories: OrgRepository[]
  /**
   * Which endpoint answered. `/users/<name>/repos` lists a personal account's
   * public repositories only, whatever the token; `self` is `/user/repos`, the
   * logged-in user's own account, private repositories included.
   */
  owner: 'org' | 'user' | 'self'
  /** `MAX_PAGES` stopped the listing while GitHub still announced a next page. */
  truncated: boolean
}

export interface ListRepositoriesOptions {
  /** Sent as `Authorization: Bearer <token>` when given; without it only public repositories are listed. */
  token?: string | undefined
  apiBase?: string
  /** Per request. */
  timeoutMs?: number
  /**
   * The login the token belongs to, asked only when `owner` turns out not to
   * be an organization: its own account is listed through `/user/repos`.
   */
  self?: () => Promise<string | null>
}

const NEXT = /<[^>]*>\s*;\s*rel="next"/

function isRepository(value: unknown): value is OrgRepository {
  if (value === null || typeof value !== 'object') return false
  const r = value as Record<string, unknown>
  return (
    typeof r['name'] === 'string' &&
    typeof r['private'] === 'boolean' &&
    typeof r['archived'] === 'boolean'
  )
}

function reason(e: unknown): string {
  // undici reports every network failure as `TypeError: fetch failed`; the
  // useful part (ECONNREFUSED, ENOTFOUND, …) is its cause.
  if (e instanceof Error && e.cause instanceof Error) return e.cause.message
  return e instanceof Error ? e.message : String(e)
}

interface Page {
  status: number
  headers: Headers
  body: unknown
}

async function getPage(
  url: string,
  headers: Record<string, string>,
  timeoutMs: number
): Promise<Page> {
  const signal = AbortSignal.timeout(timeoutMs)
  let res: Response
  try {
    res = await fetch(url, { headers, signal })
  } catch (e) {
    throw new Error(`cannot reach the GitHub API: ${reason(e)}`, { cause: e })
  }
  if (!res.ok) {
    // Drain the body so the connection is released; its content is not used.
    await res.body?.cancel().catch(() => undefined)
    return { status: res.status, headers: res.headers, body: undefined }
  }
  let text: string
  try {
    text = await res.text()
  } catch (e) {
    throw new Error(`cannot reach the GitHub API: ${reason(e)}`, { cause: e })
  }
  try {
    return { status: res.status, headers: res.headers, body: JSON.parse(text) }
  } catch (e) {
    throw new Error(
      `GitHub API answered invalid JSON for ${new URL(url).pathname}`,
      { cause: e }
    )
  }
}

function httpError(page: Page, path: string): Error {
  const cause = { status: page.status, path }
  if (page.status === 401)
    return new Error('GitHub rejected the token (401)', { cause })
  // GitHub signals a primary rate limit with 403 and no remaining requests,
  // a secondary one with 403 or 429 and `retry-after`.
  if (
    page.status === 429 ||
    (page.status === 403 &&
      (page.headers.get('x-ratelimit-remaining') === '0' ||
        page.headers.has('retry-after')))
  ) {
    return new Error(
      'GitHub API rate limit reached; set GITHUB_TOKEN or add repositories later with rness add',
      { cause }
    )
  }
  return new Error(
    `GitHub API answered ${page.status} for ${path}${ADD_LATER}`,
    { cause }
  )
}

/**
 * Every repository of the organization `owner` — or, when GitHub knows no
 * such organization, the public ones of the personal account — following the
 * `Link` header page by page, up to `MAX_PAGES`. Errors are one line, each
 * with its `cause`.
 */
export async function listRepositories(
  owner: string,
  options: ListRepositoriesOptions
): Promise<RepositoryListing> {
  const base = (options.apiBase ?? DEFAULT_GITHUB_API).replace(/\/+$/, '')
  const timeoutMs = options.timeoutMs ?? 15_000
  const headers: Record<string, string> = {
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'rness-cli',
  }
  if (options.token !== undefined && options.token !== '')
    headers['Authorization'] = `Bearer ${options.token}`

  const encoded = encodeURIComponent(owner)
  interface Kind {
    path: string
    query: string
    owner: RepositoryListing['owner']
  }
  const ORG: Kind = {
    path: `/orgs/${encoded}/repos`,
    query: 'type=all',
    owner: 'org',
  }
  const USER: Kind = {
    path: `/users/${encoded}/repos`,
    query: 'type=owner',
    owner: 'user',
  }
  const SELF: Kind = {
    path: '/user/repos',
    query: 'affiliation=owner',
    owner: 'self',
  }
  const url = (k: Kind, n: number): string =>
    `${base}${k.path}?${k.query}&per_page=${PER_PAGE}&page=${n}`
  let kind: Kind = ORG
  const repositories: OrgRepository[] = []
  for (let n = 1; n <= MAX_PAGES; n++) {
    let page = await getPage(url(kind, n), headers, timeoutMs)
    if (n === 1 && page.status === 404) {
      // Not an organization: a personal account answers on /users instead.
      const self = (await options.self?.()) ?? null
      kind = self?.toLowerCase() === owner.toLowerCase() ? SELF : USER
      page = await getPage(url(kind, n), headers, timeoutMs)
      if (page.status === 404) {
        throw new Error(
          `GitHub has no organization or user named "${owner}" (or it is not visible to you)${ADD_LATER}`,
          { cause: { status: 404, path: kind.path } }
        )
      }
    }
    if (page.status < 200 || page.status >= 300)
      throw httpError(page, kind.path)
    if (!Array.isArray(page.body) || !page.body.every(isRepository)) {
      throw new Error(
        `GitHub API answered an unexpected body for ${kind.path}`,
        {
          cause: page.body,
        }
      )
    }
    for (const r of page.body)
      repositories.push({
        name: r.name,
        private: r.private,
        archived: r.archived,
      })
    if (!NEXT.test(page.headers.get('link') ?? ''))
      return {
        repositories,
        owner: kind.owner,
        truncated: false,
      }
  }
  return {
    repositories,
    owner: kind.owner,
    truncated: true,
  }
}

export interface ApiOptions {
  token: string
  apiBase?: string
  timeoutMs?: number
}

function apiHeaders(token: string): Record<string, string> {
  return {
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'rness-cli',
    Authorization: `Bearer ${token}`,
  }
}

/** One authenticated GET whose error body is kept: GitHub explains a 403 there. */
async function getJson(
  path: string,
  options: ApiOptions
): Promise<{ status: number; body: unknown }> {
  const base = (options.apiBase ?? DEFAULT_GITHUB_API).replace(/\/+$/, '')
  let res: Response
  try {
    res = await fetch(`${base}${path}`, {
      headers: apiHeaders(options.token),
      signal: AbortSignal.timeout(options.timeoutMs ?? 15_000),
    })
  } catch (e) {
    throw new Error(`cannot reach the GitHub API: ${reason(e)}`, { cause: e })
  }
  const body: unknown = await res.json().catch(() => undefined)
  return { status: res.status, body }
}

/** The login a token belongs to. */
export async function getUser(options: ApiOptions): Promise<{ login: string }> {
  const { status, body } = await getJson('/user', options)
  if (status === 401) throw new Error('GitHub rejected the token (401)')
  const login =
    body !== null && typeof body === 'object'
      ? (body as Record<string, unknown>)['login']
      : undefined
  if (status !== 200 || typeof login !== 'string')
    throw new Error(`GitHub API answered ${status} for /user`)
  return { login }
}

/** The organizations the token's user belongs to (`read:org`), first page of 100. */
export async function listUserOrganizations(
  options: ApiOptions
): Promise<string[]> {
  const { status, body } = await getJson(
    `/user/orgs?per_page=${PER_PAGE}`,
    options
  )
  if (status !== 200 || !Array.isArray(body))
    throw new Error(`GitHub API answered ${status} for /user/orgs`)
  return body
    .map((o: unknown) =>
      o !== null && typeof o === 'object'
        ? (o as Record<string, unknown>)['login']
        : undefined
    )
    .filter((l): l is string => typeof l === 'string')
}

export type OrgMembership = 'member' | 'not-member' | 'restricted' | 'unknown'

/**
 * The user's standing in `org`. `restricted`: the organization limits OAuth
 * apps and has not approved this one, so its private repositories are hidden
 * from the token — GitHub says so in the body of a 403.
 */
export async function getOrgMembership(
  org: string,
  options: ApiOptions
): Promise<OrgMembership> {
  const { status, body } = await getJson(
    `/user/memberships/orgs/${encodeURIComponent(org)}`,
    options
  )
  if (status === 200) {
    const state =
      body !== null && typeof body === 'object'
        ? (body as Record<string, unknown>)['state']
        : undefined
    return state === 'active' ? 'member' : 'not-member'
  }
  if (status === 404) return 'not-member'
  if (status === 403) {
    const message =
      body !== null && typeof body === 'object'
        ? String((body as Record<string, unknown>)['message'] ?? '')
        : ''
    if (/OAuth App access restrictions/i.test(message)) return 'restricted'
  }
  return 'unknown'
}

export type CreateRepositoryResult =
  | { kind: 'created' }
  /** GitHub said the name is taken (422). */
  | { kind: 'exists' }
  /** Not allowed, in GitHub's words. */
  | { kind: 'refused'; reason: string }

/**
 * Create the private repository `owner/name`: in the organization `owner`,
 * or — when GitHub knows no such organization and `owner` is the token's own
 * account (`self`) — under the user.
 */
export async function createRepository(
  owner: string,
  name: string,
  options: ApiOptions & { self?: string | null }
): Promise<CreateRepositoryResult> {
  const base = (options.apiBase ?? DEFAULT_GITHUB_API).replace(/\/+$/, '')
  const post = async (
    path: string
  ): Promise<{ status: number; message: string }> => {
    let res: Response
    try {
      res = await fetch(`${base}${path}`, {
        method: 'POST',
        headers: {
          ...apiHeaders(options.token),
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ name, private: true }),
        signal: AbortSignal.timeout(options.timeoutMs ?? 15_000),
      })
    } catch (e) {
      throw new Error(`cannot reach the GitHub API: ${reason(e)}`, { cause: e })
    }
    const body: unknown = await res.json().catch(() => undefined)
    const message =
      body !== null && typeof body === 'object'
        ? String((body as Record<string, unknown>)['message'] ?? '')
        : ''
    return { status: res.status, message }
  }
  let answer = await post(`/orgs/${encodeURIComponent(owner)}/repos`)
  if (
    answer.status === 404 &&
    options.self !== undefined &&
    options.self !== null &&
    options.self.toLowerCase() === owner.toLowerCase()
  )
    answer = await post('/user/repos')
  if (answer.status === 201) return { kind: 'created' }
  if (answer.status === 422) return { kind: 'exists' }
  return {
    kind: 'refused',
    reason:
      answer.message === ''
        ? `GitHub answered ${answer.status}`
        : `${answer.message} (${answer.status})`,
  }
}
