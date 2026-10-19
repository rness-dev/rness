import { type ResolvedToken, resolveToken } from './auth.ts'
import type {
  CreateRepositoryResult,
  OrgRepository,
  RateWait,
  RepositoryListing,
} from './github.ts'
import {
  type GitlabApiOptions,
  type GitlabProjects,
  createProject,
  getUser,
  groupId,
  groupMembership,
  listGroupProjects,
  listTopLevelGroups,
  listUserProjects,
  tokenScopes,
} from './gitlab.ts'
import { HOSTS } from './hosts.ts'
import { contextRepo } from './manifest.ts'
import { rnessCommand } from './pm.ts'
import type {
  Board,
  GitCredentials,
  Organization,
  OrganizationAccess,
  Provider,
} from './provider.ts'

/** GitLab's access levels, as its UI names them (spec 0037 §4). */
const ROLES: Readonly<Record<number, string>> = {
  50: 'Owner',
  40: 'Maintainer',
  30: 'Developer',
  20: 'Reporter',
  15: 'Planner',
  10: 'Guest',
}

/** Said by the board and journal methods until plan 0049 tasks 5 and 6 bring them. */
const NOT_YET = (what: string): Error =>
  new Error(`${what} on GitLab are not available in this version of rness`)

/**
 * GitLab as a user (spec 0037): the token of `GITLAB_TOKEN` or `rness login
 * --provider gitlab`, or none, and then gitlab.com seen anonymously
 * (public projects).
 */
export class GitLabOAuthProvider implements Provider {
  readonly #token: ResolvedToken | null
  readonly #apiBase: string | undefined
  readonly #wait: RateWait | undefined
  #user: Promise<{ login: string; id: number | null } | null> | undefined
  readonly #standing = new Map<
    string,
    Promise<{ accessLevel: number } | 'not-member' | 'unknown'>
  >()

  get authenticated(): boolean {
    return this.#token !== null
  }

  constructor(options: {
    token: ResolvedToken | null
    apiBase?: string | undefined
    wait?: RateWait | undefined
  }) {
    this.#token = options.token
    this.#apiBase = options.apiBase
    this.#wait = options.wait
  }

  #api(): GitlabApiOptions {
    return {
      token: this.#token?.token,
      apiBase: this.#apiBase,
      wait: this.#wait,
    }
  }

  /** `GET /user`, once: the membership call needs the numeric id a stored login does not keep. */
  #me(): Promise<{ login: string; id: number | null } | null> {
    this.#user ??= (async () => {
      if (this.#token === null) return null
      try {
        return await getUser(this.#api())
      } catch {
        return null
      }
    })()
    return this.#user
  }

  async identity(): Promise<{ login: string } | null> {
    const t = this.#token
    if (t === null) return null
    // A stored login knows its name; an environment token has to be asked.
    if (t.login !== null) return { login: t.login }
    const me = await this.#me()
    return me === null ? null : { login: me.login }
  }

  async listOrganizations(): Promise<Organization[]> {
    if (this.#token === null) return []
    // GitLab has no per-group approval of an OAuth application (spec 0037 §4).
    return (await listTopLevelGroups(this.#api())).map((g) => ({
      login: g.path,
      approved: true,
      canGrant: null,
    }))
  }

  approvalUrl(): string | null {
    return null
  }

  /** The membership call, once per group: the access and the role read the same answer. */
  #standingIn(
    org: string
  ): Promise<{ accessLevel: number } | 'not-member' | 'unknown'> {
    let standing = this.#standing.get(org)
    if (standing === undefined) {
      standing = (async () => {
        if (this.#token === null) return 'unknown' as const
        try {
          const id = (await this.#me())?.id ?? null
          if (id === null) return 'unknown' as const
          return await groupMembership(org, id, this.#api())
        } catch {
          return 'unknown' as const
        }
      })()
      this.#standing.set(org, standing)
    }
    return standing
  }

  async organizationAccess(org: string): Promise<OrganizationAccess> {
    const standing = await this.#standingIn(org)
    return typeof standing === 'object' ? 'member' : standing
  }

  async organizationRole(org: string): Promise<string | null> {
    const standing = await this.#standingIn(org)
    return typeof standing === 'object'
      ? (ROLES[standing.accessLevel] ?? null)
      : null
  }

  async listRepositories(owner: string): Promise<RepositoryListing> {
    const group = await listGroupProjects(owner, this.#api())
    if (group !== null) return listing(owner, group, 'org')
    const self = (await this.identity())?.login ?? null
    const user = await listUserProjects(owner, this.#api())
    if (user === null)
      throw new Error(
        `GitLab has no group or user named "${owner}" (or it is not visible to you); add repositories later with ${rnessCommand()} add <repo>`,
        { cause: { status: 404, path: `/groups/${owner}/projects` } }
      )
    const mine = self !== null && self.toLowerCase() === owner.toLowerCase()
    return listing(owner, user, mine ? 'self' : 'user')
  }

  async createRepository(
    owner: string,
    name: string
  ): Promise<CreateRepositoryResult> {
    if (this.#token === null)
      return { kind: 'refused', reason: 'not logged in' }
    const id = await groupId(owner, this.#api())
    if (id !== null) return createProject(name, id, this.#api())
    const self = (await this.identity())?.login ?? null
    if (self !== null && self.toLowerCase() === owner.toLowerCase())
      return createProject(name, null, this.#api())
    return {
      kind: 'refused',
      reason: `GitLab has no group ${owner} (or it is not visible to you)`,
    }
  }

  async scopes(): Promise<string[] | null> {
    if (this.#token === null) return null
    return tokenScopes(this.#api())
  }

  credentialsFor(url: string): GitCredentials | null {
    if (this.#token === null || !url.startsWith(HOSTS.gitlab.https)) return null
    return { username: HOSTS.gitlab.username, password: this.#token.token }
  }

  // The boards (plan 0049 task 6) and the journal (task 5) come later; the
  // methods reject, never throw.
  async createBoard(): Promise<Board> {
    throw NOT_YET('boards')
  }
  async board(): Promise<Board | null> {
    throw NOT_YET('boards')
  }
  async checkIssues(): Promise<void> {
    throw NOT_YET('boards')
  }
  async ensureLayout(): Promise<string[]> {
    throw NOT_YET('boards')
  }
  async items(): Promise<never[]> {
    throw NOT_YET('boards')
  }
  async apply(): Promise<null> {
    throw NOT_YET('boards')
  }
  async mark(): Promise<void> {
    throw NOT_YET('boards')
  }
  async describe(): Promise<string[]> {
    throw NOT_YET('boards')
  }
  async postUpdates(): Promise<string[]> {
    throw NOT_YET('boards')
  }
  async journalIssue(): Promise<null> {
    throw NOT_YET('the journal issues')
  }
  async createJournalIssue(): Promise<never> {
    throw NOT_YET('the journal issues')
  }
  async issueOf(): Promise<null> {
    throw NOT_YET('the journal issues')
  }
  async addSubIssue(): Promise<void> {
    throw NOT_YET('the journal issues')
  }
  async comment(): Promise<void> {
    throw NOT_YET('the journal issues')
  }
  async pullRequestFor(): Promise<null> {
    throw NOT_YET('the journal issues')
  }
}

/**
 * What the wizard offers (spec 0037 §5.1): each project by its path, the
 * subgroup and `internal` as hints, `private` and `internal` padlocked;
 * left out, the context project, archived projects and those scheduled for
 * deletion; a second project with a path already offered, said once.
 */
function listing(
  owner: string,
  listed: GitlabProjects,
  kind: RepositoryListing['owner']
): RepositoryListing {
  const repositories: OrgRepository[] = []
  const notes: string[] = []
  const offered = new Map<string, string>()
  const relative = (fullPath: string): string =>
    fullPath.slice(owner.length + 1)
  for (const p of listed.projects) {
    if (p.archived || p.scheduledForDeletion) continue
    if (p.path.toLowerCase() === contextRepo('gitlab')) continue
    const key = p.path.toLowerCase()
    const first = offered.get(key)
    if (first !== undefined) {
      notes.push(
        `${relative(first)} and ${relative(p.fullPath)} share the name ${key}: ${relative(p.fullPath)} is left out`
      )
      continue
    }
    offered.set(key, p.fullPath)
    const hints = [
      ...(relative(p.fullPath).includes('/') ? [relative(p.fullPath)] : []),
      ...(p.visibility === 'internal' ? ['internal'] : []),
    ]
    repositories.push({
      name: p.path,
      private: p.visibility !== 'public',
      archived: false,
      path: p.fullPath,
      ...(hints.length === 0 ? {} : { hint: hints.join(', ') }),
    })
  }
  return {
    repositories,
    owner: kind,
    truncated: listed.truncated,
    ...(notes.length === 0 ? {} : { notes }),
  }
}

/** The CLI's GitLab provider: whatever token this machine has for gitlab.com. */
export async function gitlabProvider(
  apiBase?: string,
  wait?: RateWait
): Promise<Provider> {
  return new GitLabOAuthProvider({
    token: await resolveToken({}, HOSTS.gitlab),
    apiBase,
    wait,
  })
}
