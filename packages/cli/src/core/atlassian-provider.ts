import type { Layout } from '../board/layout.ts'
import type { BoardItem, Placed, Step } from '../board/plan.ts'
import {
  type ResolvedToken,
  jiraLogin,
  resolveToken,
  storedHosts,
  tokenRefused,
} from './auth.ts'
import {
  type BitbucketApiOptions,
  TokenRefused,
  createRepository,
  getUser,
  listRepositories,
  listWorkspaces,
  pullRequestFor,
  workspacePermission,
} from './bitbucket.ts'
import type { JournalIssue } from './github-journal.ts'
import type {
  CreateRepositoryResult,
  OrgRepository,
  RateWait,
  RepositoryListing,
} from './github.ts'
import { HOSTS } from './hosts.ts'
import {
  JIRA_SITE,
  JIRA_SPACE,
  type JiraApiOptions,
  createSpace,
  keyFree,
  listSpaces,
  myself,
} from './jira.ts'
import { contextRepo } from './manifest.ts'
import { rnessCommand } from './pm.ts'
import type {
  Board,
  GitCredentials,
  MarkFields,
  Organization,
  OrganizationAccess,
  Provider,
  Tracker,
  TrackerSpace,
} from './provider.ts'

const NO_BOARDS = 'the boards on Jira are not implemented yet'
const NO_JOURNAL = 'the journal on Jira is not implemented yet'

/**
 * Atlassian as a user (spec 0039): Bitbucket for the repositories, with the
 * token of `BITBUCKET_TOKEN` or `rness login --provider atlassian`, or none,
 * and then bitbucket.org seen anonymously (public repositories). Jira's
 * boards and journal come with plan 0053 tasks 5 and 6.
 */
export class AtlassianProvider implements Provider {
  readonly #token: ResolvedToken | null
  readonly #apiBase: string | undefined
  readonly #wait: RateWait | undefined
  readonly #notify: ((line: string) => void) | undefined
  /** A refused stored token is cleared and said once, whatever asked. */
  #refusalSaid = false
  readonly #permission = new Map<string, Promise<string | null | 'unknown'>>()
  readonly tracker: Tracker

  get authenticated(): boolean {
    return this.#token !== null
  }

  constructor(options: {
    token: ResolvedToken | null
    apiBase?: string | undefined
    wait?: RateWait | undefined
    /** Where the line of a refused token goes; default stderr. */
    notify?: (line: string) => void
  }) {
    this.#token = options.token
    this.#apiBase = options.apiBase
    this.#wait = options.wait
    this.#notify = options.notify
    this.tracker = new JiraTracker(options.wait, options.notify)
  }

  #api(): BitbucketApiOptions {
    return {
      token: this.#token?.token,
      apiBase: this.#apiBase,
      wait: this.#wait,
    }
  }

  /**
   * A call to Bitbucket. A 401 on a stored token ends that login: cleared
   * and said once (spec 0039 §3). A refused `BITBUCKET_TOKEN` is the
   * caller's to fix: nothing stored is touched.
   */
  async #call<T>(work: (o: BitbucketApiOptions) => Promise<T>): Promise<T> {
    try {
      return await work(this.#api())
    } catch (e) {
      if (!(e instanceof TokenRefused) || this.#token === null) throw e
      if (this.#token.source !== 'login')
        throw new TokenRefused(
          `${this.#token.source} was refused by Bitbucket (401)`
        )
      if (!this.#refusalSaid) {
        this.#refusalSaid = true
        await tokenRefused(HOSTS.bitbucket.host, 'Bitbucket', this.#notify)
      }
      throw e
    }
  }

  async identity(): Promise<{ login: string } | null> {
    const t = this.#token
    if (t === null) return null
    // A stored login knows its name; an environment token has to be asked.
    if (t.login !== null) return { login: t.login }
    return { login: (await this.#call(getUser)).login }
  }

  async listOrganizations(): Promise<Organization[]> {
    if (this.#token === null) return []
    // A token is not approved per workspace (spec 0039 §4).
    return (await this.#call(listWorkspaces)).map((w) => ({
      login: w.slug,
      approved: true,
      canGrant: null,
      ...(w.name === null ? {} : { hint: w.name }),
    }))
  }

  approvalUrl(): string | null {
    return null
  }

  /** The permission call, once per workspace: the access and the role read the same answer. */
  #permissionIn(org: string): Promise<string | null | 'unknown'> {
    let permission = this.#permission.get(org)
    if (permission === undefined) {
      permission = (async () => {
        if (this.#token === null) return 'unknown' as const
        try {
          return await this.#call((o) => workspacePermission(org, o))
        } catch {
          return 'unknown' as const
        }
      })()
      this.#permission.set(org, permission)
    }
    return permission
  }

  async organizationAccess(org: string): Promise<OrganizationAccess> {
    const permission = await this.#permissionIn(org)
    if (permission === 'unknown') return 'unknown'
    return permission === null ? 'not-member' : 'member'
  }

  async organizationRole(org: string): Promise<string | null> {
    const permission = await this.#permissionIn(org)
    return permission === 'unknown' ? null : permission
  }

  async listRepositories(owner: string): Promise<RepositoryListing> {
    const listed = await this.#call((o) => listRepositories(owner, o))
    if (listed === null)
      throw new Error(
        `Bitbucket has no workspace named "${owner}" (or it is not visible to you); add repositories later with ${rnessCommand()} add <repo>`,
        { cause: { status: 404, path: `/repositories/${owner}` } }
      )
    const repositories: OrgRepository[] = listed.repositories
      .filter((r) => r.slug !== contextRepo('atlassian'))
      .map((r) => ({
        name: r.slug,
        private: r.private,
        archived: false,
        ...(r.project === null ? {} : { hint: r.project }),
      }))
    return { repositories, owner: 'org', truncated: listed.truncated }
  }

  async createRepository(
    owner: string,
    name: string
  ): Promise<CreateRepositoryResult> {
    if (this.#token === null)
      return { kind: 'refused', reason: 'not logged in' }
    return this.#call((o) => createRepository(owner, name, o))
  }

  /** Null: nothing rness asks of a provider's scopes applies to Bitbucket (spec 0039 §3). */
  async scopes(): Promise<string[] | null> {
    return null
  }

  credentialsFor(url: string): GitCredentials | null {
    if (this.#token === null || !url.startsWith(HOSTS.bitbucket.https))
      return null
    return { username: HOSTS.bitbucket.username, password: this.#token.token }
  }

  // The board and journal methods are async so that they reject, never throw.
  async createBoard(
    _org: string,
    _title?: string,
    _views?: readonly string[]
  ): Promise<Board> {
    throw new Error(NO_BOARDS)
  }

  async board(
    _org: string,
    _number: number,
    _ids?: Readonly<Record<string, number>> | null
  ): Promise<Board | null> {
    throw new Error(NO_BOARDS)
  }

  async checkIssues(_org: string): Promise<void> {
    throw new Error(NO_BOARDS)
  }

  async ensureLayout(_board: Board, _layout: Layout): Promise<string[]> {
    throw new Error(NO_BOARDS)
  }

  async items(
    _board: Board,
    _options?: { bodies?: boolean }
  ): Promise<BoardItem[]> {
    throw new Error(NO_BOARDS)
  }

  async apply(_board: Board, _step: Step): Promise<Placed | null> {
    throw new Error(NO_BOARDS)
  }

  async mark(
    _board: Board,
    _itemIds: readonly string[],
    _session: string | null,
    _fields?: MarkFields
  ): Promise<void> {
    throw new Error(NO_BOARDS)
  }

  // A README, a short description and status updates have no place on a
  // Jira board: nothing is written, as on GitLab.
  async describe(): Promise<string[]> {
    return []
  }

  async postUpdates(): Promise<string[]> {
    return []
  }

  async journalIssue(
    _owner: string,
    _repo: string,
    _planPath: string
  ): Promise<JournalIssue | null> {
    throw new Error(NO_JOURNAL)
  }

  async createJournalIssue(
    _owner: string,
    _repo: string,
    _planPath: string,
    _issue: { title: string; body: string }
  ): Promise<JournalIssue> {
    throw new Error(NO_JOURNAL)
  }

  async issueOf(
    _owner: string,
    _repo: string,
    _number: number
  ): Promise<{
    id: string
    number: number
    open: boolean
  } | null> {
    throw new Error(NO_JOURNAL)
  }

  async addSubIssue(_parentId: string, _childId: string): Promise<void> {
    throw new Error(NO_JOURNAL)
  }

  async comment(_issueId: string, _body: string): Promise<void> {
    throw new Error(NO_JOURNAL)
  }

  async pullRequestFor(
    owner: string,
    repo: string,
    branch: string
  ): Promise<{ number: number; state: string } | null> {
    return this.#call((o) => pullRequestFor(owner, repo, branch, o))
  }
}

/** The CLI's Atlassian provider: whatever Bitbucket token this machine has. */
export async function atlassianProvider(
  apiBase?: string,
  wait?: RateWait
): Promise<Provider> {
  return new AtlassianProvider({
    token: await resolveToken({}, HOSTS.bitbucket),
    apiBase,
    wait,
  })
}

/**
 * Jira as the wizard asks it (spec 0039 §4): the sites the login stored,
 * their spaces, a free key, a new space. Each call reads the site's
 * credentials (`JIRA_EMAIL` with `JIRA_API_TOKEN`, else the stored login);
 * a refused stored token is cleared and said once per site.
 */
class JiraTracker implements Tracker {
  readonly label = 'Jira'
  readonly keyPattern = JIRA_SPACE
  readonly keyRule = 'A to Z and digits, 2 to 10, a letter first'
  readonly kind = 'team-managed, Kanban'
  readonly declareLine =
    '# for the cards: add "jira": { "site": "<name>.atlassian.net", "space": "<KEY>" } to rness.json'

  manualSteps(site: string, key: string): string[] {
    return [
      `# create a team-managed Kanban space with the key ${key} on ${site}`,
      `# (Jira > Spaces > Create space > Kanban > Team-managed), then: ${rnessCommand()} board push`,
    ]
  }
  readonly #wait: RateWait | undefined
  readonly #notify: ((line: string) => void) | undefined
  readonly #said = new Set<string>()

  constructor(
    wait: RateWait | undefined,
    notify: ((line: string) => void) | undefined
  ) {
    this.#wait = wait
    this.#notify = notify
  }

  async #call<T>(
    site: string,
    work: (o: JiraApiOptions) => Promise<T>
  ): Promise<T> {
    const login = await jiraLogin(site)
    if (login === null)
      throw new Error(
        `no Jira login for ${site}: run ${rnessCommand()} login --provider atlassian`
      )
    try {
      return await work({
        site,
        email: login.email,
        token: login.token,
        wait: this.#wait,
      })
    } catch (e) {
      if (!(e instanceof TokenRefused)) throw e
      if (login.source !== 'login')
        throw new TokenRefused(`JIRA_API_TOKEN was refused by ${site} (401)`)
      if (!this.#said.has(site)) {
        this.#said.add(site)
        await tokenRefused(site, 'Jira', this.#notify)
      }
      throw e
    }
  }

  async sites(): Promise<string[]> {
    return (await storedHosts()).filter((h) => JIRA_SITE.test(h)).sort()
  }

  async spaces(site: string): Promise<TrackerSpace[]> {
    return this.#call(site, listSpaces)
  }

  async keyFree(site: string, key: string): Promise<boolean> {
    return this.#call(site, (o) => keyFree(key, o))
  }

  async createSpace(
    site: string,
    key: string
  ): Promise<CreateRepositoryResult> {
    return this.#call(site, async (o) => {
      const lead = (await myself(o)).accountId
      if (lead === null)
        return {
          kind: 'refused' as const,
          reason: `${site} did not say who you are`,
        }
      return createSpace(key, lead, o)
    })
  }
}
