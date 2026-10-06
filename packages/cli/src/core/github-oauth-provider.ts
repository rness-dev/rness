import type { StatusUpdate } from '../pulse/collection.ts'
import type { Layout } from '../pulse/layout.ts'
import type { BoardItem, Placed, Step } from '../pulse/plan.ts'
import { type ResolvedToken, resolveToken } from './auth.ts'
import { approvalUrl } from './device-flow.ts'
import { GitHubBoards } from './github-board.ts'
import * as gj from './github-journal.ts'
import type { JournalIssue } from './github-journal.ts'
import {
  type ApiOptions,
  type CreateRepositoryResult,
  type RateWait,
  type RepositoryListing,
  createRepository,
  getOrgMembership,
  getScopes,
  getUser,
  listRepositories,
  listUserMemberships,
} from './github.ts'
import type {
  Board,
  GitCredentials,
  MarkFields,
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
  readonly #wait: RateWait | undefined
  #login: Promise<{ login: string } | null> | undefined
  #boardClient: GitHubBoards | undefined

  get authenticated(): boolean {
    return this.#token !== null
  }

  constructor(options: {
    token: ResolvedToken | null
    apiBase?: string
    wait?: RateWait
  }) {
    this.#token = options.token
    this.#apiBase = options.apiBase
    this.#wait = options.wait
  }

  #api(token: string): ApiOptions {
    return {
      token,
      ...(this.#apiBase === undefined ? {} : { apiBase: this.#apiBase }),
      ...(this.#wait === undefined ? {} : { wait: this.#wait }),
    }
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
    const memberships = await listUserMemberships(this.#api(this.#token.token))
    return memberships.map((m) => ({
      login: m.login,
      approved: true,
      canGrant: m.role === 'admin',
    }))
  }

  approvalUrl(): string | null {
    // The page approves rness, the OAuth app of `rness login`. A token from
    // the environment belongs to some other app (gh, a PAT): approving rness
    // would not end a wait for it, so there is no page to offer.
    return this.#token?.source === 'login' ? approvalUrl() : null
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
  async checkIssues(org: string): Promise<void> {
    return this.#boards().checkIssues(org)
  }

  async createBoard(org: string, title?: string): Promise<Board> {
    return this.#boards().createBoard(org, title)
  }

  async board(org: string, number: number): Promise<Board | null> {
    return this.#boards().board(org, number)
  }

  async ensureLayout(board: Board, layout: Layout): Promise<string[]> {
    return this.#boards().ensureLayout(board, layout)
  }

  async items(
    board: Board,
    options?: { bodies?: boolean }
  ): Promise<BoardItem[]> {
    return this.#boards().items(board, options)
  }

  async apply(board: Board, step: Step): Promise<Placed | null> {
    return this.#boards().apply(board, step)
  }

  async mark(
    board: Board,
    itemIds: readonly string[],
    session: string | null,
    fields?: MarkFields
  ): Promise<void> {
    return this.#boards().mark(board, itemIds, session, fields)
  }

  async describe(
    board: Board,
    text: { readme: string | null; description: string | null }
  ): Promise<string[]> {
    return this.#boards().describe(board, text)
  }

  async postUpdates(
    board: Board,
    updates: readonly StatusUpdate[]
  ): Promise<string[]> {
    return this.#boards().postUpdates(board, updates)
  }

  #journalApi(): ApiOptions {
    if (this.#token === null)
      throw new Error('the journal needs a GitHub login: run rness login')
    return this.#api(this.#token.token)
  }

  // The journal's methods are async so that a missing login rejects, never throws.
  async journalIssue(
    owner: string,
    repo: string,
    planPath: string
  ): Promise<JournalIssue | null> {
    return gj.journalIssue(owner, repo, planPath, this.#journalApi())
  }

  async createJournalIssue(
    owner: string,
    repo: string,
    planPath: string,
    issue: { title: string; body: string }
  ): Promise<JournalIssue> {
    return gj.createJournalIssue(
      owner,
      repo,
      planPath,
      issue,
      this.#journalApi()
    )
  }

  async issueOf(
    owner: string,
    repo: string,
    number: number
  ): Promise<{ id: string; number: number; open: boolean } | null> {
    return gj.issueOf(owner, repo, number, this.#journalApi())
  }

  async addSubIssue(parentId: string, childId: string): Promise<void> {
    return gj.addSubIssue(parentId, childId, this.#journalApi())
  }

  async comment(issueId: string, body: string): Promise<void> {
    return gj.comment(issueId, body, this.#journalApi())
  }

  async pullRequestFor(
    owner: string,
    repo: string,
    branch: string
  ): Promise<{ number: number; state: string } | null> {
    return gj.pullRequestFor(owner, repo, branch, this.#journalApi())
  }

  credentialsFor(url: string): GitCredentials | null {
    if (this.#token === null || !url.startsWith(GITHUB_HTTPS)) return null
    return { username: 'x-access-token', password: this.#token.token }
  }
}

/** The CLI's provider: whatever token this machine has, against `apiBase`. */
export async function githubProvider(
  apiBase?: string,
  wait?: RateWait
): Promise<Provider> {
  return new GitHubOAuthProvider({
    token: await resolveToken(),
    ...(apiBase === undefined ? {} : { apiBase }),
    ...(wait === undefined ? {} : { wait }),
  })
}
