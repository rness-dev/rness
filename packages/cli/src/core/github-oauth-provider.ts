import type { Layout } from '../pulse/layout.ts'
import type { BoardItem, Step } from '../pulse/plan.ts'
import { type ResolvedToken, resolveToken } from './auth.ts'
import { GitHubBoards } from './github-board.ts'
import {
  type CreateRepositoryResult,
  type RepositoryListing,
  createRepository,
  getOrgMembership,
  getScopes,
  getUser,
  listRepositories,
  listUserOrganizations,
} from './github.ts'
import type {
  Board,
  GitCredentials,
  Organization,
  OrganizationAccess,
  Provider,
} from './provider.ts'

const GITHUB_HTTPS = 'https://github.com/'

/**
 * GitHub as a user: the token of `GITHUB_TOKEN`, `GH_TOKEN` or `rness login`
 * — or none, and then it is GitHub seen anonymously (public repositories).
 */
export class GitHubOAuthProvider implements Provider {
  readonly #token: ResolvedToken | null
  readonly #apiBase: string | undefined
  #login: Promise<{ login: string } | null> | undefined
  #boardClient: GitHubBoards | undefined

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

  async createRepository(
    owner: string,
    name: string
  ): Promise<CreateRepositoryResult> {
    if (this.#token === null)
      return { kind: 'refused', reason: 'not logged in' }
    return createRepository(owner, name, {
      ...this.#api(this.#token.token),
      self: (await this.identity())?.login ?? null,
    })
  }

  async scopes(): Promise<string[] | null> {
    if (this.#token === null) return null
    return getScopes(this.#api(this.#token.token))
  }

  #boards(): GitHubBoards {
    if (this.#token === null)
      throw new Error('the pulse needs a GitHub login: run rness login')
    this.#boardClient ??= new GitHubBoards(this.#api(this.#token.token))
    return this.#boardClient
  }

  // The board methods are async so that a missing login rejects, never throws.
  async createBoard(org: string): Promise<Board> {
    return this.#boards().createBoard(org)
  }

  async board(org: string, number: number): Promise<Board | null> {
    return this.#boards().board(org, number)
  }

  async ensureLayout(board: Board, layout: Layout): Promise<string[]> {
    return this.#boards().ensureLayout(board, layout)
  }

  async items(board: Board): Promise<BoardItem[]> {
    return this.#boards().items(board)
  }

  async apply(board: Board, step: Step): Promise<void> {
    return this.#boards().apply(board, step)
  }

  async mark(
    board: Board,
    itemIds: readonly string[],
    session: string | null
  ): Promise<void> {
    return this.#boards().mark(board, itemIds, session)
  }

  credentialsFor(url: string): GitCredentials | null {
    if (this.#token === null || !url.startsWith(GITHUB_HTTPS)) return null
    return { username: 'x-access-token', password: this.#token.token }
  }
}

/** The CLI's provider: whatever token this machine has, against `apiBase`. */
export async function githubProvider(apiBase?: string): Promise<Provider> {
  return new GitHubOAuthProvider({
    token: await resolveToken(),
    ...(apiBase === undefined ? {} : { apiBase }),
  })
}
