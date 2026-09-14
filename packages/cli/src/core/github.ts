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
   * public repositories only, whatever the token.
   */
  owner: 'org' | 'user'
  /** `MAX_PAGES` stopped the listing while GitHub still announced a next page. */
  truncated: boolean
}

export interface ListRepositoriesOptions {
  /** Sent as `Authorization: Bearer <token>` when given; without it only public repositories are listed. */
  token?: string | undefined
  apiBase?: string
  /** Per request. */
  timeoutMs?: number
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
  const kinds = [
    { path: `/orgs/${encoded}/repos`, type: 'all' },
    { path: `/users/${encoded}/repos`, type: 'owner' },
  ] as const
  type Kind = (typeof kinds)[number]
  const url = (k: Kind, n: number): string =>
    `${base}${k.path}?type=${k.type}&per_page=${PER_PAGE}&page=${n}`
  let kind: Kind = kinds[0]
  const repositories: OrgRepository[] = []
  for (let n = 1; n <= MAX_PAGES; n++) {
    let page = await getPage(url(kind, n), headers, timeoutMs)
    if (n === 1 && page.status === 404) {
      // Not an organization: a personal account answers on /users instead.
      kind = kinds[1]
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
        owner: kind === kinds[0] ? 'org' : 'user',
        truncated: false,
      }
  }
  return {
    repositories,
    owner: kind === kinds[0] ? 'org' : 'user',
    truncated: true,
  }
}
