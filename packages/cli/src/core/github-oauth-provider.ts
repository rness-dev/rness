import { type ResolvedToken, resolveToken } from './auth.ts'
import {
  type RepositoryListing,
  getOrgMembership,
  getUser,
  listRepositories,
  listUserOrganizations,
} from './github.ts'
import type {
  GitCredentials,
  GitProvider,
  Organization,
  OrganizationAccess,
} from './provider.ts'

const GITHUB_HTTPS = 'https://github.com/'

/**
 * GitHub as a user: the token of `GITHUB_TOKEN`, `GH_TOKEN` or `rness login`
 * — or none, and then it is GitHub seen anonymously (public repositories).
 */
export class GitHubOAuthProvider implements GitProvider {
  readonly #token: ResolvedToken | null
  readonly #apiBase: string | undefined
  #login: Promise<{ login: string } | null> | undefined

  get authenticated(): boolean {
    return this.#token !== null
  }

  constructor(options: { token: ResolvedToken | null; apiBase?: string }) {
    this.#token = options.token
    this.#apiBase = options.apiBase
  }

  #api(token: string): { token: string; apiBase?: string } {
    return this.#apiBase === undefined
      ? { token }
      : { token, apiBase: this.#apiBase }
  }

  identity(): Promise<{ login: string } | null> {
    this.#login ??= (async () => {
      const t = this.#token
      if (t === null) return null
      // A stored login knows its name; an environment token has to be asked.
      if (t.login !== null) return { login: t.login }
      try {
        return await getUser(this.#api(t.token))
      } catch {
        return null
      }
    })()
    return this.#login
  }

  async listOrganizations(): Promise<Organization[]> {
    if (this.#token === null) return []
    const logins = await listUserOrganizations(this.#api(this.#token.token))
    return logins.map((login) => ({ login }))
  }

  async organizationAccess(org: string): Promise<OrganizationAccess> {
    if (this.#token === null) return 'unknown'
    try {
      return await getOrgMembership(org, this.#api(this.#token.token))
    } catch {
      return 'unknown'
    }
  }

  async listRepositories(owner: string): Promise<RepositoryListing> {
    return listRepositories(owner, {
      token: this.#token?.token,
      ...(this.#apiBase === undefined ? {} : { apiBase: this.#apiBase }),
      self: async () => (await this.identity())?.login ?? null,
    })
  }

  credentialsFor(url: string): GitCredentials | null {
    if (this.#token === null || !url.startsWith(GITHUB_HTTPS)) return null
    return { username: 'x-access-token', password: this.#token.token }
  }
}

/** The CLI's provider: whatever token this machine has, against `apiBase`. */
export async function githubProvider(apiBase?: string): Promise<GitProvider> {
  return new GitHubOAuthProvider({
    token: await resolveToken(),
    ...(apiBase === undefined ? {} : { apiBase }),
  })
}
