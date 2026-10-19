import { HOSTS, webBase } from './hosts.ts'

// The GitLab REST API (spec 0037 §1): v4, the token in `Authorization:
// Bearer`, an OAuth token and a personal access token alike (plan 0049
// task 1). The login needs who the user is; the provider's reads come with
// plan 0049 task 3.

/** `https://gitlab.com/api/v4`, on the origin `RNESS_GITLAB_WEB` points at. */
export function defaultGitlabApi(): string {
  return `${webBase(HOSTS.gitlab)}/api/v4`
}

export interface GitlabApiOptions {
  token: string
  apiBase?: string
  timeoutMs?: number
}

function reason(e: unknown): string {
  if (e instanceof Error)
    return e.name === 'TimeoutError' ? 'timed out' : e.message
  return String(e)
}

async function getJson(
  path: string,
  options: GitlabApiOptions
): Promise<{ status: number; body: unknown }> {
  const base = (options.apiBase ?? defaultGitlabApi()).replace(/\/+$/, '')
  let res: Response
  try {
    res = await fetch(`${base}${path}`, {
      headers: {
        Accept: 'application/json',
        'User-Agent': 'rness-cli',
        Authorization: `Bearer ${options.token}`,
      },
      signal: AbortSignal.timeout(options.timeoutMs ?? 15_000),
    })
  } catch (e) {
    throw new Error(`cannot reach the GitLab API: ${reason(e)}`, { cause: e })
  }
  const body: unknown = await res.json().catch(() => undefined)
  return { status: res.status, body }
}

/** The username a token belongs to, as `login`. */
export async function getUser(
  options: GitlabApiOptions
): Promise<{ login: string }> {
  const { status, body } = await getJson('/user', options)
  if (status === 401) throw new Error('GitLab rejected the token (401)')
  const username =
    body !== null && typeof body === 'object'
      ? (body as Record<string, unknown>)['username']
      : undefined
  if (status !== 200 || typeof username !== 'string')
    throw new Error(`GitLab API answered ${status} for /user`)
  return { login: username }
}
